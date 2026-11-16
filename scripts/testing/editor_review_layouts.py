#!/usr/bin/env python3
"""Capture and qualify editor/review layouts on disposable PostgreSQL/OIDC."""
import argparse
import json
import re
import sys
from pathlib import Path
from types import SimpleNamespace

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT))
from playwright.sync_api import expect
from scripts.bdd.run import pg_bin
from scripts.bdd.world import World
from scripts.bdd.layout import capture_layout
from scripts.bdd.editor import expect_editor_value
from scripts.testing.compact_console import FILES, visit, keyboard_workflow, reset_editor_view
from scripts.testing.desktop_layouts import build_fingerprint


def run(args):
    output = args.output.resolve()
    output.mkdir(parents=True, exist_ok=False, mode=0o700)
    before = build_fingerprint()
    world = World(pg_bin(args.pg_bin))
    checks, layouts = [], []
    try:
        world.start()
        world.fresh_scenario(SimpleNamespace(effective_tags=[]))
        world.publish_initial('', files=FILES)
        candidate = dict(schemaVersion=1, files=[dict(f, text=f['text'] + '\nKeep the original operation key.\n') for f in FILES])
        world.draft = world.call('POST', world.channel + '/drafts', dict(baseVersionId=world.original['version']['id'], baseRevision=world.original['revision'], payload=candidate))
        world.draft_path = world.channel + '/drafts/' + world.draft['id']
        world.request_evaluation()
        world.start_attempt()
        world.comparison()
        world.finish()
        run_ids = [world.evaluation['id']]
        world.request_evaluation()
        world.start_attempt()
        world.comparison()
        world.finish()
        run_ids.append(world.evaluation['id'])
        browser = world.browser()
        page = browser.page
        routes = dict(content=browser.bundle_path('content'), draft=browser.bundle_path('changes', draft=world.draft['id'], path='AGENTS.md'), review=browser.bundle_path('changes', draft=world.draft['id'], candidate=world.draft['snapshotVersion']['id'], generation=world.draft['generation'], request=world.evaluation['id'], comparison=world.report['id']))
        for width in (931, 933, 990, 1000, 1024, 1280, 1440, 1920, 390, 320):
            page.set_viewport_size(dict(width=width, height=1000))
            for name, route in routes.items():
                visit(page, browser, route)
                if name == 'draft':
                    expect(page.get_by_role('textbox', name='Content', exact=True)).to_be_visible()
                if name == 'review':
                    expect(page.get_by_role('region', name='Observed paired rewards')).to_be_visible()
                    geometry = page.locator('.evaluation-workspace').evaluate("e => { const b=e.querySelector('.evaluation-board'); return {width:e.getBoundingClientRect().width,columns:getComputedStyle(b).gridTemplateColumns.split(' ').length}; }")
                    assert geometry['columns'] == (2 if geometry['width'] >= 900 else 1), geometry
                    details = page.locator('.evaluation-board').evaluate("e => {const r=e.querySelector('.evaluation-request-row'), t=r?.querySelector('[data-slot=disclosure-trigger]'), a=r?.querySelector('[aria-label^=\"Inspect evidence for \"]'), d=e.querySelector('.evaluation-result-detail'), c=e.querySelector('.evaluation-coverage'); return {requestWidth:e.querySelector('.evaluation-run-sidebar').getBoundingClientRect().width,evidenceWidth:d.getBoundingClientRect().width,coverageColumns:getComputedStyle(c).gridTemplateColumns.split(' ').length,actionsAligned:Math.abs(t.getBoundingClientRect().top-a.getBoundingClientRect().top)<2};}")
                    assert details['actionsAligned'], details
                    layouts.append(dict(viewport=width, **geometry, **details))
                assert page.evaluate('document.documentElement.scrollWidth <= innerWidth + 1'), (width, name)
                capture_layout(page, output, f'{name}-{width}')
            checks.append(f'Content, draft and full review fit {width}px without page overflow')
        if args.verify:
            visit(page, browser, routes['review'])
            evidence_links = page.get_by_role('link', name=re.compile('^Inspect evidence for '))
            expect(evidence_links).to_have_count(2)
            names = evidence_links.evaluate_all("items => items.map(e => e.getAttribute('aria-label'))")
            assert len(set(names)) == 2 and all(any(run_id in name for name in names) for run_id in run_ids), names
            assert page.locator('.evaluation-request a[aria-current="true"]').count() == 1
            checks.append('Repeated datasets have distinct full request action names and one explicit bound-evidence selection')
            for width in (931, 933):
                page.set_viewport_size(dict(width=width, height=1000))
                visit(page, browser, routes['review'])
                request_details = page.locator('.evaluation-request').get_by_role('button', name='Request details', exact=True).first
                request_details.click()
                setup = page.get_by_role('button', name='Create another evaluation request', exact=True)
                setup.click()
                profile = page.get_by_label('Evaluation configuration', exact=True)
                original_profile = profile.input_value()
                profile.select_option('custom')
                config = page.get_by_label('Public evaluator configuration (JSON)', exact=True)
                original_config = config.input_value()
                config.fill('{')
                expect(page.get_by_role('button', name='Create evaluation request', exact=True)).to_be_disabled()
                assert page.evaluate('document.documentElement.scrollWidth <= innerWidth + 1')
                capture_layout(page, output, f'expanded-setup-error-{width}')
                setup.click()
                expect(config).to_be_hidden()
                setup.focus()
                page.keyboard.press('Tab')
                assert not config.evaluate('e => e === document.activeElement')
                setup.click()
                expect(config).to_have_value('{')
                config.fill(original_config)
                profile.select_option(original_profile)
            checks.append('Actual 899/901px board transition with expanded request/setup, invalid JSON, hidden controls and retained form values')
            page.set_viewport_size(dict(width=1440, height=1000))
            visit(page, browser, routes['draft'])
            editor = page.get_by_role('textbox', name='Content', exact=True)
            edited = candidate['files'][0]['text'] + '\nUnsaved browser refinement.\n'
            editor.fill(edited)
            expect(page.locator('.draft-status')).to_contain_text('Evaluation uses saved generation 1')
            page.get_by_role('button', name='Review changes', exact=True).click()
            diff = page.get_by_role('region', name='Review changes from the creation base')
            expect(diff).to_contain_text('unsaved edits')
            expect(diff.locator('.content-diff h3')).to_have_count(4)
            capture_layout(page, output, 'whole-draft-dirty-diff')
            page.get_by_role('button', name='Edit entries', exact=True).click()
            expect_editor_value(editor, edited)
            capture_layout(page, output, 'draft-dirty-1440')
            editor.fill(candidate['files'][0]['text'])
            expect(page.get_by_role('button', name='Save draft', exact=True)).to_be_disabled()
            details = page.get_by_role('button', name='Draft details', exact=True)
            details.focus()
            expect(page.get_by_role('tooltip')).to_contain_text('Draft details')
            page.keyboard.press('Escape')
            page.keyboard.press('Enter')
            dialog = page.get_by_role('dialog', name='Draft details', exact=True)
            expect(dialog).to_be_visible()
            capture_layout(page, output, 'draft-details-modal')
            for _ in range(12):
                page.keyboard.press('Tab')
                assert dialog.evaluate('e => e.contains(document.activeElement)')
            page.keyboard.press('Escape')
            expect(details).to_be_focused()
            import_action = page.get_by_role('button', name='Import files into this draft', exact=True)
            import_action.click()
            import_dialog = page.get_by_role('dialog', name='Import files into this draft', exact=True)
            expect(import_dialog).to_be_visible()
            for _ in range(12):
                page.keyboard.press('Tab')
                assert import_dialog.evaluate('e => e.contains(document.activeElement)')
            page.keyboard.press('Escape')
            expect(import_action).to_be_focused()
            visit(page, browser, routes['review'])
            release = page.get_by_role('button', name='Review release with this evidence', exact=True)
            release.click()
            release_dialog = page.get_by_role('dialog', name='Publish to stable?', exact=True)
            expect(release_dialog).to_be_visible()
            for _ in range(10):
                page.keyboard.press('Tab')
                assert release_dialog.evaluate('e => e.contains(document.activeElement)')
            page.keyboard.press('Escape')
            expect(release).to_be_focused()
            checks.append('Import and release dialog focus containment, Escape cancellation and focus restoration without publishing')
            checks.append('Dirty evaluation boundary, whole-draft creation-base diff, source retention and focus tooltip/details dialog')
            keyboard_workflow(world, browser)
            checks.append('Keyboard file selection, actions, rename, source edit, save, focus handoff and evaluation configuration retention')
            # Stress the same real layout with long identity, signed extremes,
            # incomplete grades, unknown usage and a long application error.
            settings = dict(world.settings, datasetRevision='review-fixture-' + 'long-revision-name-' * 4)
            request = world.call('POST', world.bundle + '/evaluation-requests', dict(settings, requireBoundEvidence=True))
            request_path = world.bundle + '/evaluation-requests/' + request['id']
            attempt = 'layout-stress-attempt'
            world.call('POST', request_path + '/start', dict(attemptId=attempt), actor='evaluator')
            def scored(value):
                return dict(executionStatus='completed', gradingStatus='scored', reward=value, usage=dict(costUsd=0))
            application_error = 'Application fixture error: ' + 'unbroken-context-' * 16
            report = world.call('POST', world.bundle + '/comparisons', dict(settings,
                evaluation=dict(requestId=request['id'], attemptId=attempt), results=[
                    dict(settings['expectedCases'][0], parent=scored(-1e100), candidate=scored(1e100)),
                    dict(settings['expectedCases'][1], parent=scored(0), candidate=dict(executionStatus='infrastructure_failed', gradingStatus='missing', reward=None, usage=None, error=application_error))]), actor='evaluator')
            world.call('POST', request_path + '/finish', dict(attemptId=attempt, comparisonId=report['id']), actor='evaluator')
            stress_route = browser.bundle_path('changes', candidate=world.draft['snapshotVersion']['id'], request=request['id'], comparison=report['id'])
            for width in (931, 933, 1024, 1440):
                page.set_viewport_size(dict(width=width, height=1000))
                visit(page, browser, stress_route)
                scorecard = page.get_by_role('region', name='Observed paired rewards')
                expect(scorecard).to_contain_text('Partial evidence')
                expect(scorecard).to_contain_text('-1.00e+100')
                expect(scorecard).to_contain_text('Unknown')
                expect(page.locator('.comparison-evidence')).to_contain_text(application_error)
                assert page.evaluate('document.documentElement.scrollWidth <= innerWidth + 1')
                capture_layout(page, output, f'stress-review-{width}')
            checks.append('Long dataset identity, extreme signed means, partial grades, unknown cost and long errors fit threshold and desktop layouts')
        assert not browser.errors, browser.errors
        assert before == build_fingerprint(), 'Build changed during qualification'
        summary = dict(passed=True, checks=checks, layouts=layouts, browserErrors=browser.errors, paidModelCalls=0, fixtureOnly=True, sourceBuildSha256=before, limits=['Simulated evaluation evidence, no live provider or model.', 'Viewport reflow, not native browser zoom.', 'Only the explicitly listed interactions are browser-tested.'])
        (output / 'summary.json').write_text(json.dumps(summary, indent=2) + '\n')
        print(json.dumps(summary, indent=2), flush=True)
    except BaseException as error:
        if getattr(world, 'browser_fixture', None):
            page = world.browser_fixture.page
            if not page.is_closed():
                page.screenshot(path=str(output / 'failure.png'), full_page=True)
                (output / 'failure-accessibility.txt').write_text(page.locator('main').aria_snapshot())
        (output / 'failure.json').write_text(json.dumps(dict(checks=checks, error=str(error)), indent=2) + '\n')
        raise
    finally:
        world.close()


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--pg-bin')
    parser.add_argument('--output', required=True, type=Path)
    parser.add_argument('--verify', action='store_true')
    run(parser.parse_args())
