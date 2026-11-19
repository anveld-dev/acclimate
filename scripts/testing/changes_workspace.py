#!/usr/bin/env python3
"""Qualify Changes against disposable PostgreSQL/OIDC and a frozen console build.

Run after building the console; never configures a model provider or uses a user workspace.
"""
import argparse
import json
import re
import sys
from pathlib import Path
from types import SimpleNamespace
from urllib.parse import parse_qs, urlsplit

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT))
from playwright.sync_api import expect
from scripts.bdd.run import pg_bin
from scripts.bdd.world import World
from scripts.bdd.layout import capture_layout
from scripts.testing.compact_console import visit
from scripts.testing.desktop_layouts import build_fingerprint


def run(args):
    output = args.output.resolve()
    output.mkdir(parents=True, exist_ok=False, mode=0o700)
    before = build_fingerprint()
    class Checks(list):
        def append(self, item):
            super().append(item)
            print('PASS ' + item, flush=True)
    checks, widths = Checks(), []
    world = World(pg_bin(args.pg_bin))
    try:
        world.start()
        world.fresh_scenario(SimpleNamespace(effective_tags=[]))
        files = [dict(path='AGENTS.md', kind='instruction', text='Follow the retry policy.'),
                 dict(path='skills/triage/SKILL.md', kind='skill', text='Check receipts.'),
                 dict(path='memory/gateway.md', kind='memory', text='Do not reuse expired keys.')]
        world.publish_initial('', files=files)
        drafts = [world.call('POST', world.channel + '/drafts', dict(
            baseVersionId=world.original['version']['id'], baseRevision=world.original['revision'],
            payload=dict(schemaVersion=1, files=[dict(f, text=f['text'] + f'\nCandidate {i}.') for f in files])))
            for i in (1, 2)]
        versions = [d['snapshotVersion'] for d in drafts]
        cases = [dict(caseId=f'receipt-{i:02}', repetition=0) for i in range(60)]

        def create(index):
            version = versions[index % 2]
            settings = dict(parentVersionId=world.original['version']['id'],
                parentDigest=world.original['version']['digest'], candidateVersionId=version['id'],
                candidateDigest=version['digest'], datasetRevision=f'workspace-round-{index:03}',
                graderRevision='workspace-grader-v1', runtime=dict(source='simulated-example', model='none'),
                expectedCases=cases)
            return world.call('POST', world.bundle + '/evaluation-requests',
                              dict(settings, requireBoundEvidence=True)), settings

        def finish(request, settings, partial=False):
            attempt = 'workspace-fixture-attempt'
            path = world.bundle + '/evaluation-requests/' + request['id']
            world.call('POST', path + '/start', dict(attemptId=attempt), actor='evaluator')
            def outcome(reward):
                return dict(executionStatus='completed', gradingStatus='scored', reward=reward,
                            usage=dict(costUsd=0))
            results = [dict(case, parent=outcome(0 if i % 3 == 0 else 1),
                            candidate=outcome(1 if i % 3 != 1 else 0))
                       for i, case in enumerate(cases)]
            if partial:
                results[0]['parent'] = outcome(-1)
                results[0]['candidate'] = dict(executionStatus='task_failed', gradingStatus='scored',
                                                reward=-1.5, usage=dict(costUsd=0), error='Fixture task failure')
                results[1]['candidate'] = dict(executionStatus='infrastructure_failed', gradingStatus='missing',
                                                reward=None, usage=None, error='Fixture infrastructure failure')
                results.pop()
            report = world.call('POST', world.bundle + '/comparisons', dict(settings,
                evaluation=dict(requestId=request['id'], attemptId=attempt), results=results), actor='evaluator')
            world.call('POST', path + '/finish', dict(attemptId=attempt, comparisonId=report['id']), actor='evaluator')
            return report

        requests = [create(i) for i in range(102)]
        full = finish(*requests[-2])
        partial = finish(*requests[-1], partial=True)
        oldest, oldest_settings = requests[0]
        browser = world.browser()
        world.sign_in('viewer', 'changes-read-only-person')
        world.call('PUT', world.root + '/memberships/' + world.sessions['viewer']['userId'],
                   dict(role='viewer'), actor='_browser-operator')
        empty = world.call('POST', world.root + '/bundle-setups', dict(
            name='Empty history fixture', origin='created', channel='stable',
            payload=dict(schemaVersion=1, files=files), reason='Disposable empty history fixture.'))
        page = browser.page
        route = lambda **kw: browser.bundle_path('changes', **kw)
        visit(page, browser, route())
        ledger = page.locator('.evaluation-ledger')
        expect(ledger).to_contain_text('20 loaded requests across bundle channels')
        expect(ledger.locator('.evaluation-ledger-trigger')).to_have_count(20)
        checks.append('default overview displays the first 20 persisted bundle-wide requests')
        row = ledger.get_by_role('button', name=re.compile('workspace-round-101'))
        row.focus()
        page.keyboard.press('Enter')
        expect(row).to_be_focused()
        expect(row).to_have_attribute('aria-expanded', 'true')
        detail = ledger.locator('.evaluation-ledger-detail')
        expect(detail).to_contain_text('not comparable')
        expect(detail).to_contain_text('task_failed')
        expect(detail).to_contain_text('grading scored')
        expect(ledger).to_contain_text('partial')
        expect(detail.locator('.evaluation-ledger-provenance')).to_be_hidden()
        sides = detail.locator('.evaluation-ledger-case-sides').first
        assert sides.evaluate("e => getComputedStyle(e).gridTemplateColumns.split(' ').length") == 2
        expect(sides.get_by_role('heading', name=re.compile('Parent'))).to_be_visible()
        expect(sides.get_by_role('heading', name=re.compile('Candidate'))).to_be_visible()
        capture_layout(page, output, 'ledger-expanded-desktop')
        page.set_viewport_size(dict(width=390, height=1000))
        page.wait_for_function("() => getComputedStyle(document.querySelector('.evaluation-ledger-case-sides')).gridTemplateColumns.split(' ').length === 1")
        scroller = ledger.get_by_role('region', name='Evaluation history table')
        scroller.focus()
        page.keyboard.press('ArrowRight')
        page.wait_for_function("() => document.querySelector('.evaluation-ledger-scroll').scrollLeft > 0")
        def assert_detail_fits():
            bounds = detail.evaluate("e => { const a=e.getBoundingClientRect(), b=e.closest('.evaluation-ledger-scroll').getBoundingClientRect(); return {left:a.left,right:a.right,outerLeft:b.left,outerRight:b.right,width:e.clientWidth,scroll:e.scrollWidth}; }")
            assert bounds['left'] >= bounds['outerLeft'] - 1 and bounds['right'] <= bounds['outerRight'] + 1, bounds
            assert bounds['scroll'] <= bounds['width'] + 1, bounds
        assert ledger.locator('.evaluation-ledger-table tbody tr:not(.evaluation-ledger-detail-row) td:nth-child(2)').evaluate_all("cells => cells.every(e => getComputedStyle(e).whiteSpace === 'nowrap' && e.scrollWidth <= e.clientWidth + 1)")
        assert_detail_fits()
        assert page.evaluate('document.documentElement.scrollWidth <= innerWidth + 1')
        capture_layout(page, output, 'ledger-expanded-390')
        for width in (320, 390):
            page.set_viewport_size(dict(width=width, height=1000))
            for extreme, key in [('right', 'ArrowRight'), ('left', 'ArrowLeft')]:
                scroller.focus()
                for _ in range(20):
                    page.keyboard.press(key)
                page.wait_for_function("right => {const e=document.querySelector('.evaluation-ledger-scroll');return right ? e.scrollLeft >= e.scrollWidth-e.clientWidth-1 : e.scrollLeft <= 1;}", arg=extreme == 'right')
                assert_detail_fits()
                capture_layout(page, output, f'ledger-expanded-{width}-{extreme}')
        page.set_viewport_size(dict(width=1440, height=1000))
        page.wait_for_function("() => getComputedStyle(document.querySelector('.evaluation-ledger-case-sides')).gridTemplateColumns.split(' ').length === 2")
        checks.append('paired outcomes align on desktop and stack in narrow containers; named table region scrolls by keyboard')
        detail.get_by_role('button', name='Run details').click()
        expect(detail).to_contain_text('workspace-grader-v1')
        expect(detail).to_contain_text(requests[-1][0]['id'])
        page.set_viewport_size(dict(width=320, height=1000))
        assert_detail_fits()
        capture_layout(page, output, 'run-details-320')
        page.set_viewport_size(dict(width=1440, height=1000))
        detail.get_by_role('button', name='Copy run details').click()
        assert requests[-1][0]['id'] in page.evaluate('navigator.clipboard.readText()')
        detail.get_by_role('button', name='Close evaluation details').click()
        expect(row).to_be_focused()
        expect(row).to_have_attribute('aria-expanded', 'false')
        page.keyboard.press('Space')
        expect(row).to_have_attribute('aria-expanded', 'true')
        page.keyboard.press('Space')
        expect(row).to_have_attribute('aria-expanded', 'false')
        capture_layout(page, output, 'ledger-desktop')
        checks.append('keyboard expansion, focus return, partial signed/task-failure evidence, provenance and clipboard')

        visit(page, browser, route(history=1, request=oldest['id']))
        expect(ledger).to_contain_text('10 loaded requests for this version')
        expect(ledger).to_contain_text('Selected outside loaded history')
        expect(ledger).to_contain_text('No comparison reported')
        expect(ledger.get_by_role('button', name=re.compile('workspace-round-000'))).to_have_count(1)
        page.reload(wait_until='networkidle')
        expect(ledger).to_contain_text('Selected outside loaded history')
        effective_selector = page.get_by_label('Evaluation version')
        expect(effective_selector).to_have_value(oldest['candidateVersionId'])
        direct_url = page.url
        effective_selector.select_option(oldest['candidateVersionId'])
        assert page.url == direct_url, 'Reselecting current version must preserve the direct request'
        checks.append('direct oldest request without comparison is pinned without inflating loaded count and survives reload')
        for _ in range(5):
            ledger.get_by_role('button', name='Load older evaluations').click()
        expect(ledger).to_contain_text('51 loaded requests for this version')
        old_row = ledger.get_by_role('button', name=re.compile('workspace-round-000'))
        expect(old_row).to_have_count(1)
        finish(oldest, oldest_settings)
        expect(old_row.locator('xpath=ancestor::tr')).to_contain_text('completed', timeout=45000)
        expect(old_row).to_have_count(1)
        checks.append('pagination merges the pinned oldest request and refresh retains its completed backend status')
        visit(page, browser, route(history=1, request=requests[-1][0]['id'], candidate=versions[0]['id']))
        expect(page.get_by_role('alert')).to_contain_text('does not match')
        visit(page, browser, route(history=1, request=requests[-1][0]['id'], comparison=full['id']))
        expect(page.get_by_role('alert')).to_contain_text('does not match')
        checks.append('candidate and comparison mismatches produce actionable errors')

        visit(page, browser, route(history=1, candidate=versions[1]['id'], tab='files', path='missing.md'))
        files_view = page.get_by_role('region', name='Saved version files')
        expect(files_view).to_contain_text('creation base')
        expect(files_view.get_by_role('alert')).to_contain_text('missing.md')
        files_view.get_by_role('button', name='Show the first file').click()
        expect(files_view.locator('.content-diff')).to_be_visible()
        assert 'missing.md' not in page.url
        page.go_back(wait_until='networkidle')
        expect(files_view.get_by_role('alert')).to_contain_text('missing.md')
        page.go_forward(wait_until='networkidle')
        page.reload(wait_until='networkidle')
        expect(files_view.locator('.content-diff')).to_be_visible()
        tree = files_view.get_by_role('tree', name='Files')
        expect(tree).to_be_visible()
        tree.get_by_role('treeitem', name='Open AGENTS.md').click()
        expect(files_view.locator('.content-diff')).to_contain_text('AGENTS.md')
        visit(page, browser, route(history=1, candidate=world.original['version']['id'], tab='files'))
        expect(files_view).to_contain_text('no creation base')
        expect(page.get_by_label('Evaluation version')).to_have_value(world.original['version']['id'])
        expect(page.get_by_label('Evaluation version').locator('option').filter(has_text='Selected outside loaded history')).to_have_count(1)
        expect(files_view.get_by_label('Saved content of AGENTS.md')).to_be_visible()
        checks.append('Files uses creation base, recovers missing paths, restores navigation and shows root content')
        tabs = page.get_by_role('tablist', name='Selected version view')
        tabs.get_by_role('tab', name=re.compile('Files')).focus()
        page.keyboard.press('ArrowLeft')
        expect(tabs.get_by_role('tab', name='Evaluations', exact=True)).to_have_attribute('aria-selected', 'true')
        page.keyboard.press('ArrowRight')
        expect(files_view).to_be_visible()
        capture_layout(page, output, 'files-desktop')
        checks.append('tab arrow keys change the active view and preserve the selected version')

        visit(page, browser, route(history=1))
        selector = page.get_by_label('Evaluation version')
        expect(page.get_by_role('region',name='Change pipeline')).to_have_count(0)
        selector.focus()
        for width in (1024, 390, 320, 1440):
            page.set_viewport_size(dict(width=width, height=1000))
            expect(selector).to_be_focused()
        checks.append('Evaluation history has its own route and selector focus survives reflow')

        selector.select_option(versions[1]['id'])
        expect(selector).to_have_value(versions[1]['id'])
        selected_url = page.url
        ledger.get_by_role('button', name='Load older evaluations').click()
        expect(selector).to_have_value(versions[1]['id'])
        assert page.url == selected_url
        selector.select_option('')
        query = parse_qs(urlsplit(page.url).query)
        assert not any(key in query for key in ('candidate', 'request', 'comparison', 'path', 'tab'))
        page.go_back(wait_until='networkidle')
        expect(selector).to_have_value(versions[1]['id'])
        checks.append('version selection survives paging, clears route fields and restores on Back')
        selector.select_option('')
        selector.select_option(versions[1]['id'])
        selected_tabs = page.get_by_role('tablist', name='Selected version view')
        files_tab = selected_tabs.get_by_role('tab', name=re.compile('Files'))
        files_tab.click()
        expect(files_view).to_be_visible()
        files_tab.focus()
        page.go_back(wait_until='networkidle')
        page.go_back(wait_until='networkidle')
        expect(selector).to_have_value('')
        expect(page.get_by_role('heading', name='Changes', exact=True)).to_be_focused()
        checks.append('Back removing a focused candidate Files tab returns focus to the stable Changes heading')
        selector.select_option(versions[1]['id'])
        page.get_by_role('tablist', name='Selected version view').get_by_role('tab', name=re.compile('Files')).click()
        files_view.get_by_role('treeitem', name='Open AGENTS.md').focus()
        page.go_back(wait_until='networkidle')
        page.go_back(wait_until='networkidle')
        expect(selector).to_have_value('')
        expect(page.get_by_role('heading', name='Changes', exact=True)).to_be_focused()
        checks.append('Back removing a focused Files tree control returns focus to the stable Changes heading')


        # Keep the open count scoped to the loaded draft records, including an all-closed page.
        for draft in drafts:
            world.call('POST', world.channel + '/drafts/' + draft['id'] + '/discard',
                       dict(expectedGeneration=draft['generation']))
        visit(page, browser, route())
        board=page.get_by_role('region',name='Change pipeline')
        cards=board.locator('[data-change-kind=draft]')
        include=board.get_by_role('button',name='Include closed drafts',exact=True)
        expect(cards).to_have_count(0)
        include.click();expect(cards).to_have_count(2)
        capture_layout(page, output, 'closed-drafts-count-and-filter')
        include.click();expect(cards).to_have_count(0)
        # Restore a new open draft for the later discard-dialog workflow.
        replacement = world.call('POST', world.channel + '/drafts', dict(
            baseVersionId=world.original['version']['id'], baseRevision=world.original['revision'],
            payload=dict(schemaVersion=1, files=files)))
        drafts[0] = replacement
        checks.append('Open count and loaded inventory remain distinct when every loaded draft is closed')


        visit(page, browser, route(history=1))
        for width in (1024, 1180, 1280, 1440, 1920, 320, 390):
            page.set_viewport_size(dict(width=width, height=1000))
            overview = page.locator('.changes-overview')
            expect(ledger).to_be_visible()
            geometry = overview.evaluate('e => ({width:e.getBoundingClientRect().width, queueColumns:getComputedStyle(e.querySelector(".changes-overview-grid")).gridTemplateColumns.split(" ").length})')
            assert geometry['queueColumns'] == 1, geometry
            assert page.evaluate('document.documentElement.scrollWidth <= innerWidth + 1'), width
            widths.append(dict(viewport=width, **geometry))
            capture_layout(page, output, f'changes-overview-{width}')
        page.emulate_media(reduced_motion='reduce')
        capture_layout(page, output, 'changes-reduced-motion-390')
        assert page.evaluate('document.documentElement.scrollWidth <= innerWidth + 1')
        checks.append('overview and outer overflow at seven widths and reduced motion')

        page.set_viewport_size(dict(width=1440, height=1000))
        # Browser zoom reduces the CSS viewport; a 720px CSS viewport exercises
        # the same reflow width as 200% zoom on a 1440px desktop.
        page.set_viewport_size(dict(width=720, height=500))
        expect(ledger).to_be_visible()
        assert page.evaluate('document.documentElement.scrollWidth <= innerWidth + 1')
        capture_layout(page, output, 'changes-200-percent-reflow')
        checks.append('200 percent equivalent desktop reflow avoids outer-page overflow')
        page.set_viewport_size(dict(width=1440, height=1000))
        pending, pending_settings = requests[1]
        visit(page, browser, route(request=pending['id']))
        expect(page.locator('.evaluation-request').filter(has_text=pending['id'])).to_be_visible()
        pending_report = finish(pending, pending_settings)
        page.get_by_role('tab',name='Details',exact=True).click()
        expect(page.locator('.comparison-evidence')).to_be_visible(timeout=45000)
        expect(page.locator('.comparison-evidence')).to_contain_text('workspace-round-001')
        checks.append('full review directly selected older pending request receives bound evidence automatically')
        visit(page, browser, route(candidate=versions[0]['id'], request=requests[-2][0]['id'], comparison=full['id']))
        page.get_by_role('tab',name='Evaluation runs',exact=False).click()
        evidence = page.locator('.comparison-evidence')
        expect(page.locator('.evaluation-request')).to_have_count(5)
        page.get_by_role('button', name='Show all 10 loaded results', exact=True).click()
        expect(page.locator('.evaluation-request')).to_have_count(10)
        page.get_by_role('button', name='Show fewer results', exact=True).click()
        expect(page.locator('.evaluation-request')).to_have_count(5)
        page.get_by_role('tab',name='Details',exact=True).click()
        expect(evidence.get_by_role('region', name='Case reward changes')).to_be_visible()
        expect(evidence.locator('.evaluation-case-tile')).to_have_count(60)
        evidence.get_by_role('radio', name='Lower reward 20', exact=True).click()
        expect(evidence.locator('.evaluation-pair-summary')).to_have_count(20)
        evidence.get_by_role('radio', name='All 60', exact=True).click()
        evidence.get_by_label('Search evaluation cases', exact=True).fill('receipt-59')
        expect(evidence.locator('.evaluation-pair-summary')).to_have_count(1)
        evidence.get_by_label('Search evaluation cases', exact=True).fill('not-present')
        expect(evidence).to_contain_text('No cases match this view.')
        evidence.get_by_label('Search evaluation cases', exact=True).fill('')
        tile = evidence.get_by_role('button', name='receipt-00 / 0: Higher reward. Parent 0 → candidate 1', exact=True)
        tile.hover()
        expect(page.get_by_role('tooltip')).to_contain_text('receipt-00 / 0')
        tile.focus()
        page.keyboard.press('ArrowRight')
        page.keyboard.press('Enter')
        expect(evidence.locator('.evaluation-pair-summary')).to_contain_text('receipt-01 / 0')
        evidence.get_by_role('button', name='Show all pairs', exact=True).click()
        evidence.get_by_role('button', name='Next cases', exact=True).click()
        expect(evidence).to_contain_text('26–50 of 60 pairs')
        page.get_by_role('tab', name='Files changed', exact=False).click()
        artifacts = page.get_by_role('region', name='Changed artifact map')
        artifacts.get_by_role('button', name='Changed: skills/triage/SKILL.md', exact=True).click()
        expect(page.locator('.content-diff h3')).to_contain_text('skills/triage/SKILL.md')
        page.get_by_role('button', name='Show all file changes', exact=True).click()
        expect(page.locator('.content-diff h3')).to_have_count(3)
        checks.append('full review retains result folding, case hover/keyboard selection, filters, search, paging and artifact maps')
        world.call('POST', world.channel + '/promotions', dict(versionId=versions[1]['id'],
            expectedRevision=world.original['revision'], unevaluatedReason='Advance disposable fixture channel.'))
        visit(page, browser, route(candidate=versions[0]['id'], comparison=full['id']))
        page.get_by_role('tab',name='Details',exact=True).click()
        expect(page.get_by_role('region', name='Observed paired rewards')).to_be_visible()
        expect(page.get_by_role('button', name='Review release with this evidence')).to_be_disabled()
        checks.append('historical score remains visible and release with stale evidence is blocked')

        visit(page, browser, browser.bundle_path('changes', bundle_id=empty['bundle']['id']))
        expect(page.get_by_role('region',name='Evaluating',exact=True)).to_contain_text('No evaluations in progress.')
        viewer = browser.browser.new_context(ignore_https_errors=True, viewport=dict(width=1440, height=1000))
        try:
            browser.sign_in(viewer, 'changes-read-only-person')
            viewer_page = viewer.new_page()
            viewer_page.on('pageerror', lambda error: browser.errors.append(str(error)))
            visit(viewer_page, browser, route(history=1))
            expect(viewer_page.get_by_text('Read-only access', exact=False).first).to_be_visible()
            expect(viewer_page.get_by_role('link', name='New draft')).to_have_count(0)
            expect(viewer_page.locator('.evaluation-ledger')).to_contain_text('loaded requests')
        finally:
            viewer.close()
        checks.append('empty history and read-only bundle overview')

        # The dialog is deliberately exercised on a persisted, clean draft: it is
        # distinct from the pending-changes dialog for unsaved browser text.
        visit(page, browser, route(draft=drafts[0]['id']))
        disclosure = page.get_by_role('button', name='Discard draft', exact=True)
        if disclosure.is_visible():
            disclosure.click()
        discard = page.get_by_role('button', name='Discard saved draft', exact=True)
        discard.click()
        dialog = page.get_by_role('alertdialog')
        expect(dialog).to_be_visible()
        expect(dialog.get_by_role('button', name='Keep draft', exact=True)).to_be_focused()
        capture_layout(page, output, 'discard-dialog-desktop')
        page.keyboard.press('Escape')
        expect(dialog).to_be_hidden()
        expect(discard).to_be_focused()
        discard.click()
        expect(dialog).to_be_visible()
        dialog.get_by_role('button', name=re.compile('Cancel|Keep', re.I)).click()
        expect(dialog).to_be_hidden()
        discard.click()
        expect(dialog).to_be_visible()
        dialog.get_by_role('button', name=re.compile('Discard', re.I)).click()
        expect(dialog).to_be_hidden()
        checks.append('saved draft discard confirmation cancels via Escape and cancel, then succeeds')

        assert not browser.errors, browser.errors
        after = build_fingerprint()
        assert before == after, 'Production build changed during qualification'
        result = dict(passed=True, checks=checks, widths=widths, browserErrors=browser.errors,
                      paidModelCalls=0, fixtureOnly=True, sourceBuildSha256=before,
                      omissions=['Saved discard failure recovery and the distinct unsaved-edit guard are not exercised.',
                        'Backend outage/recovery is not exercised. Browser zoom is checked via equivalent CSS viewport reflow.'])
        (output / 'summary.json').write_text(json.dumps(result, indent=2) + '\n')
        print(json.dumps(result, indent=2))
    except BaseException as error:
        if getattr(world, 'browser_fixture', None):
            current_page = world.browser_fixture.page
            if not current_page.is_closed():
                current_page.screenshot(path=str(output / 'failure.png'), full_page=True)
                (output / 'failure-accessibility.txt').write_text(current_page.locator('main').aria_snapshot())
        (output / 'failure.json').write_text(json.dumps(dict(checks=checks, error=str(error)), indent=2) + '\n')
        raise
    finally:
        world.close()


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--pg-bin')
    parser.add_argument('--output', required=True, type=Path)
    run(parser.parse_args())
