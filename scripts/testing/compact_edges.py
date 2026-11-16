#!/usr/bin/env python3
"""Exercise compact-layout edge states against the existing production console build."""
import argparse
import json
import re
import sys
import traceback
from pathlib import Path
from types import SimpleNamespace
from urllib.parse import parse_qs, urlparse

ROOT = Path(__file__).resolve().parents[2]
if sys.version_info < (3, 11):
    sys.exit('Use .venv-bdd/bin/python (Python 3.11+) with scripts/bdd/requirements.txt installed.')
sys.path.insert(0, str(ROOT))
from playwright.sync_api import expect
from scripts.bdd.run import pg_bin
from scripts.bdd.world import World
from scripts.bdd.interactions import draft_action, open_files
from scripts.bdd.layout import capture_layout, tab_to
from scripts.testing.compact_console import FILES, visit


class Evidence:
    def __init__(self, output):
        self.output = output
        self.checks = []
        self.failures = []

    def capture(self, page, name, coarse=False):
        try:
            return capture_layout(page, self.output, name, coarse=coarse)
        except AssertionError as error:
            self.failures.append(dict(check=name, error=str(error)))
            print('FAIL ' + name + ': ' + str(error), flush=True)
            return json.loads((self.output / (name + '.json')).read_text())

    def run(self, name, page, action):
        print('CHECK ' + name, flush=True)
        previous_failures = len(self.failures)
        try:
            details = action()
            passed = len(self.failures) == previous_failures
            self.checks.append(dict(check=name, passed=passed, details=details))
            print(('PASS ' if passed else 'FAIL ') + name, flush=True)
        except Exception as error:
            self.failures.append(dict(check=name, error=str(error), traceback=traceback.format_exc()))
            self.checks.append(dict(check=name, passed=False))
            print('FAIL ' + name + ': ' + str(error), flush=True)
            if not page.is_closed():
                page.screenshot(path=str(self.output / (name + '-failure.png')))
                (self.output / (name + '-failure.html')).write_text(page.content())


def activate(page, target, reverse=False):
    if not target.evaluate('el => el === document.activeElement'):
        tab_to(page, target, reverse=reverse)
    page.keyboard.press('Enter')


def append(page, text):
    editor = page.get_by_label('Content', exact=True)
    if not editor.evaluate('el => el === document.activeElement'):
        tab_to(page, editor)
    page.keyboard.press('ControlOrMeta+A')
    page.keyboard.press('ArrowRight')
    page.keyboard.insert_text(text)


def choose_file(page, path):
    toggle = page.get_by_role('button', name=re.compile(r'^Files \(\d+\)$'))
    activate(page, toggle, reverse=True)
    expect(toggle).to_have_attribute('aria-expanded', 'true')
    activate(page, page.get_by_role('button', name='Open ' + path, exact=True))
    expect(toggle).to_have_attribute('aria-expanded', 'false')
    expect(toggle).to_be_focused()


def save(page):
    control = page.get_by_role('button', name='Save draft', exact=True)
    if not control.evaluate('el => el === document.activeElement'):
        tab_to(page, control, reverse=True)
    with page.expect_response(lambda response: response.request.method == 'POST'):
        page.keyboard.press('Enter')
    page.wait_for_load_state('networkidle')
    next_action = page.get_by_role('link', name='Continue to evaluation', exact=True)
    expect(next_action).to_be_visible()
    expect(next_action).to_be_focused()


def long_identity(w, b, page, evidence):
    path = 'memory/release-guidelines/production-retry-contracts/provider-specific-evidence/retained-context.md'
    name = 'Production review instructions and reusable memory for background agent integrations'
    channel = 'production-review-integrations-preserved-retry-contracts'
    setup = w.call('POST', w.root + '/bundle-setups', dict(
        name=name, origin='created', channel=channel,
        payload=dict(schemaVersion=1, files=[dict(path=path, kind='memory', text='# Long path fixture\nKeep full paths readable without hover.\n')]),
        reason='Disposable compact edge layout fixture.'))
    assert w.setup['bundle']['name'] == 'BDD bundle', 'Long fixture overwrote the stable World bundle'
    widths = [1024, 900, 768, 600, 390, 320]
    for width in widths:
        page.set_viewport_size(dict(width=width, height=900))
        visit(page, b, b.bundle_path('content', bundle_id=setup['bundle']['id'], channel=channel, path=path))
        expect(page.get_by_role('heading', name=name, exact=True)).to_be_visible()
        expect(page.get_by_label('Channel', exact=True)).to_have_value(channel)
        expect(page.locator('.selected-file-path')).to_have_text(path)
        expect(page.locator('.selected-file-path')).to_be_visible()
        evidence.capture(page, 'long-' + str(width) + '-content', coarse=True)
        open_files(page)
        evidence.capture(page, 'long-' + str(width) + '-files', coarse=True)
        activate(page, page.get_by_role('link', name='Edit entry', exact=True))
        expect(page.get_by_label('Content', exact=True)).to_be_visible()
        expect(page.get_by_label('Channel', exact=True)).to_have_value(channel)
        expect(page.locator('.selected-file-path')).to_have_text(path)
        evidence.capture(page, 'long-' + str(width) + '-draft', coarse=True)
    assert w.call('GET', w.channel)['version'] == w.original['version']
    return dict(widths=widths, channel=channel, fullPath=path, stableWorldRetained=True)


def responsive_focus(b, desktop, mobile, evidence):
    mobile.set_viewport_size(dict(width=390, height=844))
    visit(mobile, b, b.workspace_path())
    trigger = mobile.get_by_role('button', name='Open navigation', exact=True)
    activate(mobile, trigger)
    expect(mobile.get_by_role('dialog')).to_be_visible()
    evidence.capture(mobile, 'mobile-navigation-open', coarse=True)
    mobile.keyboard.press('Escape')
    expect(mobile.get_by_role('dialog')).to_have_count(0)
    expect(trigger).to_be_focused()
    activate(mobile, trigger)
    expect(mobile.get_by_role('dialog')).to_be_visible()
    mobile.set_viewport_size(dict(width=1100, height=844))
    expect(mobile.get_by_role('dialog')).to_have_count(0)
    expect(mobile.get_by_role('main')).to_be_focused()
    evidence.capture(mobile, 'navigation-resized-desktop', coarse=True)
    desktop.set_viewport_size(dict(width=1100, height=900))
    visit(desktop, b, b.bundle_path('content'))
    entry = desktop.get_by_role('link', name='Open memory/team.md', exact=True)
    tab_to(desktop, entry)
    expect(entry).to_be_focused()
    desktop.set_viewport_size(dict(width=899, height=900))
    toggle = desktop.get_by_role('button', name='Files (4)', exact=True)
    expect(toggle).to_have_attribute('aria-expanded', 'false')
    expect(toggle).to_be_focused()
    expect(entry).not_to_be_visible()
    evidence.capture(desktop, 'file-rail-resized-narrow')
    return dict(sheetEscape=True, sheetResizeMainFocus=True, fileResizeTriggerFocus=True)


def mobile_workflow(w, b, page, evidence):
    page.set_viewport_size(dict(width=390, height=844))
    before_requests = w.call('GET', w.bundle + '/evaluation-requests')['items']
    visit(page, b, b.bundle_path('content', path='memory/team.md'))
    activate(page, page.get_by_role('link', name='Edit entry', exact=True))
    memory = FILES[-1]['text'] + '\nMemory edit retained across file selection.\n'
    agents = FILES[0]['text'] + '\nInstruction edit retained across file selection.\n'
    append(page, '\nMemory edit retained across file selection.\n')
    expect(page.get_by_label('Content', exact=True)).to_have_value(memory)
    choose_file(page, 'AGENTS.md')
    append(page, '\nInstruction edit retained across file selection.\n')
    expect(page.get_by_label('Content', exact=True)).to_have_value(agents)
    choose_file(page, 'memory/team.md')
    expect(page.get_by_label('Content', exact=True)).to_have_value(memory)
    expect(page.locator('.draft-status')).to_contain_text('Unsaved changes')
    evidence.capture(page, 'mobile-new-two-files', coarse=True)
    save(page)
    expect(page.locator('.draft-status')).to_contain_text('Generation 1 saved')
    evidence.capture(page, 'mobile-clean-generation1', coarse=True)
    drafts = w.call('GET', w.channel + '/drafts')['items']
    draft = next(row for row in drafts if row['id'] in page.url)
    assert draft['generation'] == 1, draft

    def verify_payload(saved, memory_text):
        payload = w.call('GET', w.bundle + '/versions/' + saved['snapshotVersion']['id'] + '/payload')
        actual = {file['path']: file['text'] for file in payload['files']}
        assert actual['AGENTS.md'] == agents, 'Saved instruction text differs from browser edits'
        assert actual['memory/team.md'] == memory_text, 'Saved memory text differs from browser edits'

    verify_payload(draft, memory)
    second = '\nSecond saved generation retains both files.\n'
    append(page, second)
    memory += second
    save(page)
    expect(page.locator('.draft-status')).to_contain_text('Generation 2 saved')
    evidence.capture(page, 'mobile-clean-generation2', coarse=True)
    saved = w.call('GET', w.channel + '/drafts/' + draft['id'])
    assert saved['generation'] == 2, saved
    verify_payload(saved, memory)
    unsaved = '\nUnsaved generation-two browser edit.\n'
    append(page, unsaved)
    dirty_memory = memory + unsaved
    expect(page.locator('.draft-status')).to_contain_text('Generation 2 saved')
    expect(page.locator('.draft-status')).to_contain_text('Unsaved changes')
    trigger = page.get_by_role('button', name='Draft actions', exact=True)

    def request_saved_evaluation():
        item = draft_action(page, 'Evaluate saved generation 2')
        # Opening the shared menu is real input; selection uses keyboard, with
        # no forced focus or DOM state changes.
        for _ in range(8):
            if item.evaluate('el => el === document.activeElement'):
                break
            page.keyboard.press('ArrowDown')
        expect(item).to_be_focused()
        page.keyboard.press('Enter')
        expect(page.get_by_role('alertdialog')).to_be_visible()
        expect(page.get_by_role('alertdialog')).to_contain_text('Unsaved text will be lost')

    request_saved_evaluation()
    evidence.capture(page, 'mobile-dirty-evaluation-confirm', coarse=True)
    activate(page, page.get_by_role('button', name='Keep editing', exact=True))
    expect(page.get_by_role('alertdialog')).to_have_count(0)
    expect(trigger).to_be_focused()
    expect(page.get_by_label('Content', exact=True)).to_have_value(dirty_memory)
    choose_file(page, 'AGENTS.md')
    expect(page.get_by_label('Content', exact=True)).to_have_value(agents)
    choose_file(page, 'memory/team.md')
    expect(page.get_by_label('Content', exact=True)).to_have_value(dirty_memory)
    request_saved_evaluation()
    page.keyboard.press('Escape')
    expect(page.get_by_role('alertdialog')).to_have_count(0)
    expect(trigger).to_be_focused()
    expect(page.get_by_label('Content', exact=True)).to_have_value(dirty_memory)
    evidence.capture(page, 'mobile-dirty-cancelled', coarse=True)
    request_saved_evaluation()
    activate(page, page.get_by_role('button', name='Leave editor', exact=True))
    expect(page.get_by_label('Saved change review', exact=True)).to_contain_text('Generation 2 saved')
    expect(page.get_by_role('main')).to_be_focused()
    query = parse_qs(urlparse(page.url).query)
    assert query['candidate'] == [saved['snapshotVersion']['id']], query
    assert str(json.loads(query['generation'][0])) == '2', query
    assert query['draft'] == [saved['id']], query
    verify_payload(saved, memory)
    assert w.call('GET', w.channel)['version'] == w.original['version'], 'Navigation unexpectedly changed the published channel'
    assert w.call('GET', w.bundle + '/evaluation-requests')['items'] == before_requests, 'Navigation unexpectedly created or executed evaluation work'
    evidence.capture(page, 'mobile-exact-generation2-review', coarse=True)
    return dict(twoFileEditsPreserved=True, firstSaveFocus=True, secondSaveFocus=True,
                keepEditingFocus=True, escapeFocus=True, exactCandidate=saved['snapshotVersion']['id'],
                mainFocus=True, releaseUnchanged=True, evaluationRequestsUnchanged=True)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--pg-bin')
    parser.add_argument('--only', choices=['all', 'workflow'], default='all')
    parser.add_argument('--output', type=Path, default=ROOT / 'artifacts/layout2-edges')
    args = parser.parse_args()
    output = args.output.resolve()
    output.mkdir(parents=True, mode=0o700, exist_ok=False)
    evidence = Evidence(output)
    world = World(pg_bin(args.pg_bin))
    browser = touch = None
    try:
        world.start()
        world.fresh_scenario(SimpleNamespace(effective_tags=[]))
        world.publish_initial('', files=FILES)
        browser = world.browser()
        touch = browser.browser.new_context(ignore_https_errors=True, viewport=dict(width=390, height=844),
            has_touch=True, storage_state=browser.context.storage_state())
        mobile = touch.new_page()
        mobile.set_default_timeout(10000)
        mobile.on('pageerror', lambda error: browser.errors.append(str(error)))
        if args.only == 'all':
            evidence.run('long-identities', mobile, lambda: long_identity(world, browser, mobile, evidence))
            evidence.run('responsive-focus', browser.page, lambda: responsive_focus(browser, browser.page, mobile, evidence))
        evidence.run('mobile-workflow', mobile, lambda: mobile_workflow(world, browser, mobile, evidence))
        assert not browser.errors, browser.errors
    except Exception as error:
        evidence.failures.append(dict(check='fixture-or-browser', error=str(error), traceback=traceback.format_exc()))
    finally:
        for name, resource in [('touch-context', touch), ('world', world)]:
            if resource is not None:
                try:
                    resource.close()
                except Exception as error:
                    evidence.failures.append(dict(check=name + '-cleanup', error=str(error)))
        summary = dict(passed=not evidence.failures, checks=evidence.checks, failures=evidence.failures,
            capturedStates=len(list(output.glob('*.png'))), browserErrors=browser.errors if browser else [],
            fixture='disposable PostgreSQL + real service, built console, OIDC and TLS', paidModelCalls=0)
        (output / 'summary.json').write_text(json.dumps(summary, indent=2) + '\n')
        print(json.dumps(summary, indent=2), flush=True)
    return 0 if summary['passed'] else 1


if __name__ == '__main__':
    sys.exit(main())
