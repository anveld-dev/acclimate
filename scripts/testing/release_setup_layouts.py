#!/usr/bin/env python3
"""Real release/setup captures on disposable PostgreSQL/OIDC; no model calls."""
import argparse
import json
import sys
from pathlib import Path
from types import SimpleNamespace

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT))
from playwright.sync_api import expect
from scripts.bdd.run import pg_bin
from scripts.bdd.world import World
from scripts.bdd.layout import capture_layout
from scripts.testing.compact_console import FILES, visit, sdk_acceptance
from scripts.testing.desktop_layouts import build_fingerprint


def run(args):
    output = args.output.resolve()
    output.mkdir(parents=True, exist_ok=False, mode=0o700)
    world = World(pg_bin(args.pg_bin))
    before = build_fingerprint()
    checks = []
    try:
        world.start()
        world.fresh_scenario(SimpleNamespace(effective_tags=[]))
        world.publish_initial('', files=FILES)
        candidate = dict(schemaVersion=1, files=[dict(f, text=f['text'] + '\nCheck operation identity before retrying.\n') for f in FILES])
        world.draft = world.call('POST', world.channel + '/drafts', dict(baseVersionId=world.original['version']['id'], baseRevision=world.original['revision'], payload=candidate))
        world.draft_path = world.channel + '/drafts/' + world.draft['id']
        world.request_evaluation(); world.start_attempt(); world.comparison(); world.finish(); world.publish_evidence()
        current = world.call('GET', world.channel)
        next_payload = dict(schemaVersion=1, files=[dict(f, text=f['text'] + '\nKeep the reviewed receipt with each operation.\n') for f in FILES])
        draft = world.call('POST', world.channel + '/drafts', dict(baseVersionId=current['version']['id'], baseRevision=current['revision'], payload=next_payload))
        world.call('POST', world.channel + '/releases', dict(versionId=draft['snapshotVersion']['id'], expectedRevision=current['revision'], unevaluatedReason='Manual policy clarification. No evaluation is claimed for this revision.'))
        browser = world.browser()
        page = browser.page
        routes = dict(releases=browser.bundle_path('releases'), setup=browser.bundle_path('connect'))
        for width in (1024, 1280, 1440, 1920, 390, 320):
            page.set_viewport_size(dict(width=width, height=1000))
            for name, route in routes.items():
                visit(page, browser, route)
                if name == 'releases':
                    expect(page.get_by_test_id('release-decision')).to_have_count(3)
                else:
                    expect(page.get_by_label('TypeScript delivery recipe', exact=True)).to_be_visible()
                assert page.evaluate('document.documentElement.scrollWidth <= innerWidth + 1'), (width, name)
                capture_layout(page, output, f'{name}-{width}')
            checks.append(f'Release history and App setup fit {width}px')
        if args.verify:
            page.set_viewport_size(dict(width=1440, height=1000))
            visit(page, browser, routes['setup'])
            failures = []
            sdk_acceptance(page, failures, output, 'desktop')
            assert not failures, failures
            checks.append('SDK install, both languages, required environment, private directories and expected output remain discoverable')
            # Copy exact selectable source, including lines hidden by local scrolling.
            for language in ('TypeScript', 'Python'):
                page.get_by_role('radio', name=language, exact=True).click()
                expect(page.get_by_role('radio', name=language, exact=True)).to_be_checked()
                expect(page.get_by_role('radio', name=language, exact=True)).to_have_css('font-weight', '700')
                for kind, button in (('delivery', 'Copy recipe'), ('reporting', 'Copy reporting recipe')):
                    if kind == 'reporting':
                        trigger = page.get_by_role('button', name='Optional delivery reports', exact=True)
                        if trigger.get_attribute('aria-expanded') != 'true': trigger.click()
                    code = page.get_by_label(f'{language} {kind} recipe', exact=True)
                    source = code.text_content()
                    page.get_by_role('button', name=button, exact=True).click()
                    expect(page.get_by_role('button', name=button, exact=True)).to_contain_text('Copied')
                    assert page.evaluate('navigator.clipboard.readText()') == source
                    assert code.evaluate("e => getComputedStyle(e).whiteSpace") == 'pre'
                    code.focus()
                    assert code.evaluate('e => e === document.activeElement')
                capture_layout(page, output, f'setup-{language.lower()}-reporting')
            page.set_viewport_size(dict(width=390, height=1000))
            code = page.get_by_label('Python reporting recipe', exact=True)
            code.focus(); code.press('End')
            expect(code).to_be_focused()
            assert code.evaluate('e => e.scrollWidth > e.clientWidth')
            code.press('ArrowRight')
            page.wait_for_function("document.querySelector('.sdk-reporting-code').scrollLeft > 0")
            capture_layout(page, output, 'setup-reporting-keyboard-scroll-390')
            checks.append('Both languages copy exact delivery/reporting source and recipes support local keyboard scrolling')
            cdp = page.context.new_cdp_session(page)
            permission = dict(permission=dict(name='clipboard-write'), origin=browser.base, browserContextId=cdp.send('Target.getTargetInfo')['targetInfo']['browserContextId'])
            try:
                cdp.send('Browser.setPermission', dict(permission, setting='denied'))
                page.get_by_role('button', name='Copy recipe', exact=True).click()
                expect(page.get_by_role('status').filter(has_text='Clipboard unavailable.')).to_be_visible()
                assert page.get_by_label('Python delivery recipe', exact=True).text_content()
                capture_layout(page, output, 'setup-copy-denied-390')
            finally:
                cdp.send('Browser.setPermission', dict(permission, setting='granted'))
                cdp.detach()
            checks.append('Native clipboard permission denial gives visible selectable-source fallback')
            page.goto('about:blank')
            visit(page, browser, routes['setup'] + '#sdk-local-install')
            expect(page.get_by_role('button', name='Install from this checkout', exact=True)).to_have_attribute('aria-expanded', 'true')
            page.evaluate("location.hash = 'reporting'")
            expect(page.get_by_role('button', name='Optional delivery reports', exact=True)).to_have_attribute('aria-expanded', 'true')
            checks.append('Initial disclosure hash and subsequent hash changes open the requested setup section')
            page.set_viewport_size(dict(width=1440, height=1000))
            visit(page, browser, routes['releases'])
            expect(page.get_by_role('button', name='Restore revision 3', exact=True)).to_have_count(0)
            expect(page.get_by_role('link', name='Inspect evidence for revision 2', exact=True)).to_be_visible()
            expect(page.get_by_role('link', name='Inspect evidence for revision 3', exact=True)).to_have_count(0)
            details = page.get_by_role('button', name='Release details for revision 3', exact=True)
            details.hover()
            expect(page.get_by_role('tooltip')).to_contain_text('Release details for revision 3')
            details.click()
            dialog = page.get_by_role('dialog', name='Release details', exact=True)
            expect(dialog).to_contain_text('Manual policy clarification.')
            capture_layout(page, output, 'release-details-dialog')
            page.keyboard.press('Escape'); expect(details).to_be_focused()
            restore = page.get_by_role('button', name='Restore revision 1', exact=True)
            restore.click()
            expect(page.get_by_role('button', name='Restore version', exact=True)).to_be_disabled()
            expect(page.get_by_role('dialog')).to_contain_text('without inheriting evaluation support')
            capture_layout(page, output, 'release-restore-dialog')
            page.keyboard.press('Escape'); expect(restore).to_be_focused()
            checks.append('Revision-specific actions, evidence availability, details tooltip/dialog focus and empty-reason restore guard')
            # Repeated immutable content remains a distinct channel decision; page through all.
            current = world.call('GET', world.channel)
            for index in range(49):
                version = world.original['version']['id'] if index % 2 == 0 else draft['snapshotVersion']['id']
                current = world.call('POST', world.channel + '/releases', dict(versionId=version, expectedRevision=str(3 + index), unevaluatedReason='Repeated-content history fixture. ' + ('Long policy rationale. ' * 30 if index == 47 else '')))
            visit(page, browser, routes['releases'])
            expect(page.get_by_test_id('release-decision')).to_have_count(20)
            page.get_by_role('button', name='Load older releases', exact=True).click()
            expect(page.get_by_test_id('release-decision')).to_have_count(40)
            page.get_by_role('button', name='Load older releases', exact=True).click()
            expect(page.get_by_test_id('release-decision')).to_have_count(52)
            expect(page.get_by_role('button', name='Load older releases', exact=True)).to_have_count(0)
            assert len(set(page.get_by_test_id('release-decision').evaluate_all('els => els.map(e=>e.getAttribute("aria-label"))'))) == 52
            historical = page.get_by_test_id('release-decision').filter(has=page.get_by_role('heading', name='Revision 51', exact=True)).locator('.release-reason')
            expect(historical).to_contain_text('Long policy rationale. ' * 30)
            assert historical.evaluate('e => e.scrollHeight <= e.clientHeight + 1')
            for width in (1024, 1440, 390):
                page.set_viewport_size(dict(width=width, height=1000))
                page.evaluate('scrollTo(0,0)')
                assert historical.evaluate('e => e.scrollHeight <= e.clientHeight + 1')
                assert page.evaluate('document.documentElement.scrollWidth <= innerWidth + 1')
                capture_layout(page, output, f'release-history-stress-{width}')
            checks.append('52 decisions paginate without duplicate revisions, repeated versions remain distinct, long reasons reflow')
            world.sign_in('viewer', 'release-read-only-person')
            world.call('PUT', world.root + '/memberships/' + world.sessions['viewer']['userId'], dict(role='viewer'), actor='_browser-operator')
            viewer = browser.browser.new_context(ignore_https_errors=True, viewport=dict(width=1024, height=1000))
            try:
                browser.sign_in(viewer, 'release-read-only-person')
                read_page = viewer.new_page()
                visit(read_page, browser, routes['releases'])
                expect(read_page.get_by_text('Read only', exact=True)).to_be_visible()
                expect(read_page.get_by_role('button', name='Restore', exact=False)).to_have_count(0)
                visit(read_page, browser, routes['setup'])
                expect(read_page.get_by_role('link', name='Manage app credentials', exact=True)).to_have_count(0)
                expect(read_page.get_by_text('Ask a workspace admin for a content-read credential', exact=False)).to_be_visible()
                capture_layout(read_page, output, 'setup-read-only-1024')
            finally:
                viewer.close()
            checks.append('Read-only releases offer no restore; non-admin setup gives truthful credential guidance')
            coarse = browser.browser.new_context(ignore_https_errors=True, viewport=dict(width=1024, height=1000), has_touch=True, storage_state=browser.context.storage_state())
            try:
                touch = coarse.new_page()
                assert touch.evaluate('matchMedia("(pointer: coarse)").matches')
                for name, route in routes.items():
                    visit(touch, browser, route)
                    controls = touch.locator('.release-actions button, .release-actions a') if name == 'releases' else touch.locator('.sdk-setup button')
                    assert controls.evaluate_all('els => els.filter(e=>e.getBoundingClientRect().height).every(e=>{const r=e.getBoundingClientRect();return r.height>=43.5 && r.width>=43.5})'), name
                    capture_layout(touch, output, name + '-coarse-1024')
            finally:
                coarse.close()
            checks.append('Actual coarse-pointer context keeps release and setup controls at least 44px')
        assert not browser.errors, browser.errors
        assert before == build_fingerprint(), 'Build changed during qualification'
        summary = dict(passed=True, checks=checks, browserErrors=browser.errors, paidModelCalls=0, fixtureOnly=True, sourceBuildSha256=before, limits=['Simulated evaluation records, no provider/model calls.', 'Only listed interactions were tested; viewport reflow is not native zoom.'])
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
