#!/usr/bin/env python3
"""Focused navigation lifecycle checks against a disposable real browser/service.

Recovery records below are synthetic sessionStorage envelopes: they do not
represent submitted operations. No screenshots or successful writes are made.
"""
import argparse
import json
import sys
import uuid
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT))
from playwright.sync_api import expect
from scripts.bdd.run import pg_bin
from scripts.bdd.world import World
from scripts.testing.compact_console import visit
from scripts.testing.desktop_layouts import build_fingerprint
from scripts.testing.navigation_chrome import seed


def visible_focus(page):
    assert page.evaluate("""() => {
      const e = document.activeElement;
      return !!e && e !== document.body && e.getClientRects().length > 0 &&
        getComputedStyle(e).visibility !== 'hidden';
    }""")


def run(args):
    out = args.output.resolve()
    out.mkdir(parents=True, exist_ok=False, mode=0o700)
    world = World(pg_bin(args.pg_bin))
    before = build_fingerprint()
    checks = []
    try:
        browser, _ = seed(world, True)
        page = browser.page
        page.set_viewport_size({'width': 1440, 'height': 900})
        visit(page, browser, browser.workspace_path())
        account = page.get_by_role('button', name='Account', exact=True).filter(visible=True).first
        account.hover()
        expect(page.get_by_role('tooltip').filter(has_text='Account')).to_be_visible()
        account.click()
        dialog = page.get_by_role('dialog', name='Your account', exact=True)
        expect(dialog).to_be_visible()
        expect(page.get_by_role('tooltip').filter(has_text='Account')).to_have_count(0)
        page.set_viewport_size({'width': 390, 'height': 900})
        page.keyboard.press('Escape')
        expect(dialog).to_have_count(0)
        expect(page.get_by_role('button',name='Open navigation',exact=True)).to_be_focused()
        visible_focus(page)
        checks.append('Desktop account popup closes to visible navigation after resizing to mobile')

        page.get_by_role('button', name='Open navigation', exact=True).click()
        sheet = page.get_by_role('dialog', name='Acclimate', exact=True)
        sheet.get_by_role('button', name='Account', exact=True).click()
        expect(dialog).to_be_visible()
        page.set_viewport_size({'width': 1440, 'height': 900})
        page.keyboard.press('Escape')
        expect(dialog).to_have_count(0)
        visible_focus(page)
        checks.append('Mobile account dialog closes to visible focus after resizing to desktop')

        visit(page, browser, browser.workspace_path())
        trigger = page.get_by_role('button', name='Workspaces')
        trigger.click()
        menu = page.get_by_role('menu')
        expect(menu).to_be_visible()
        # Account's tooltip must stay suppressed while the workspace menu is open.
        expect(page.get_by_role('tooltip').filter(has_text='Account')).to_have_count(0)
        page.set_viewport_size({'width': 390, 'height': 900})
        expect(menu).to_have_count(0)
        expect(page.get_by_role('button', name='Open navigation', exact=True)).to_be_focused()
        visible_focus(page)
        checks.append('Workspace menu closes on mobile resize, focuses navigation, and suppresses Account tooltip')

        page.set_viewport_size({'width': 1440, 'height': 900})
        visit(page, browser, browser.workspace_path())
        trigger = page.get_by_role('button', name='Workspaces')
        trigger.click()
        page.get_by_role('menu').get_by_role('menuitem', name='New workspace').click()
        creation = page.get_by_role('dialog', name='Create a workspace', exact=True)
        expect(creation).to_be_visible()
        page.keyboard.press('Escape')
        expect(creation).to_have_count(0)
        expect(trigger).to_be_focused()
        trigger.click()
        page.get_by_role('menu').get_by_role('menuitem', name='New workspace').click()
        expect(creation).to_be_visible()
        page.set_viewport_size({'width': 390, 'height': 900})
        page.keyboard.press('Escape')
        expect(creation).to_have_count(0)
        expect(page.get_by_role('button', name='Open navigation', exact=True)).to_be_focused()
        visible_focus(page)
        checks.append('Creation handoff returns focus to workspace trigger or mobile navigation after resize')

        page.set_viewport_size({'width': 1440, 'height': 900})
        visit(page, browser, browser.workspace_path())
        page.get_by_role('button', name='Workspaces').click()
        page.get_by_role('menuitem', name='New workspace', exact=True).click()
        creation=page.get_by_role('dialog',name='Create a workspace',exact=True)
        creation.get_by_label('Workspace name',exact=True).fill('Held request fixture')
        held=[]
        def hold(route):
            if route.request.method=='POST': held.append(route)
            else: route.continue_()
        page.route('**/*',hold)
        try:
            with page.expect_request(lambda r:r.method=='POST'):
                creation.get_by_role('button',name='Create workspace',exact=True).click()
            expect(creation.locator('form')).to_have_attribute('aria-busy','true')
            page.keyboard.press('Escape');expect(creation).to_be_visible()
            expect(creation.get_by_role('button',name='Close',exact=True)).to_have_count(0)
            page.screenshot(path=str(out/'creation-pending.png'))
            assert held
            for route in held: route.abort('failed')
            expect(creation.get_by_text('Could not confirm creation.',exact=False)).to_be_visible()
            expect(creation.locator('form')).to_have_attribute('aria-busy','false')
            page.screenshot(path=str(out/'creation-unconfirmed.png'))
        finally:
            page.unroute('**/*',hold)
        page.keyboard.press('Escape');expect(creation).to_have_count(0)
        checks.append('Held creation cannot close via Escape or X; aborted response exposes uncertainty and restores closing')

        # Seed the same valid envelope separately in two same-origin tabs. The
        # normal sign-out form must broadcast purge across their session stores.
        page.set_viewport_size({'width': 1440, 'height': 900})
        visit(page, browser, browser.workspace_path())
        other = page.context.new_page()
        visit(other, browser, browser.workspace_path())
        scope = {'owner': 'improvement', 'actorScope': 'synthetic-actor', 'projectId': world.h.project,
                 'serviceIdentity': 'synthetic-service'}
        record = {'version': 1, 'scope': scope,
                  'action': '/v1/projects/' + world.h.project + '/proposals',
                  'key': str(uuid.uuid4()), 'createdAt': 1,
                  'body': '{"synthetic":"private"}',
                  'disclosure': {'consent': True, 'wholeParentBundle': True,
                                 'authorizedEvidence': ['synthetic']}}
        key = 'acclimate:operation:v1:' + json.dumps([scope['actorScope'],scope['serviceIdentity'],scope['projectId'],None,None,scope['owner']], separators=(',', ':'))
        for tab in (page, other):
            tab.evaluate('([k,v]) => sessionStorage.setItem(k, JSON.stringify(v))', [key, record])
        page.get_by_role('button', name='Account', exact=True).filter(visible=True).first.click()
        page.get_by_role('dialog', name='Your account').get_by_role('button', name='Sign out', exact=True).click()
        # Logout redirects to the provider; return this tab to a same-origin static document before inspecting its session storage.
        page.goto(browser.base+'/favicon.svg',wait_until='domcontentloaded')
        for index,tab in enumerate((page, other)):
            print('purge-state',index,tab.url,tab.evaluate('k => {const r=JSON.parse(sessionStorage.getItem(k));return {present:!!r,body:!!r?.body,disclosure:!!r?.disclosure,keys:sessionStorage.length}}',key),flush=True)
            tab.wait_for_function("k => { const r=JSON.parse(sessionStorage.getItem(k)); return r && !('body' in r) && !('disclosure' in r); }", arg=key)
            stored = tab.evaluate('k => JSON.parse(sessionStorage.getItem(k))', key)
            assert stored['scope'] == scope and stored['key'] == record['key'] and stored['action'] == record['action']
        checks.append('Actual sign-out purges synthetic recovery text in both tabs while retaining identity metadata')
        browser.sign_in(page.context,'operator')
        visit(page,browser,browser.workspace_path())
        page.evaluate('([k,v]) => sessionStorage.setItem(k,JSON.stringify(v))',[key,record])
        world.sign_in('changed-user','changed-user')
        world.call('PUT',world.root+'/memberships/'+world.sessions['changed-user']['userId'],dict(role='viewer'),actor='_browser-operator')
        browser.sign_in(page.context,'changed-user')
        page.reload(wait_until='networkidle')
        page.wait_for_function("k => { const r=JSON.parse(sessionStorage.getItem(k)); return r && !('body' in r) && !('disclosure' in r); }",arg=key)
        stored=page.evaluate('k => JSON.parse(sessionStorage.getItem(k))',key)
        assert stored['scope']==scope and stored['key']==record['key']
        checks.append('Real OIDC account change clears previous account text while retaining scoped uncertainty')
        other.close()
        assert before == build_fingerprint()
        assert not browser.errors, browser.errors
        (out / 'summary.json').write_text(json.dumps({'passed': True, 'checks': checks,
            'sourceBuildSha256': before, 'modelCalls': 0,
            'limits': ['Recovery envelopes are synthetic; logout and account change are real app actions. Creation response was deliberately held then aborted before any service write.', 'Native screen readers, arbitrary provider identity lengths and server-side creation commit followed by response loss were not exercised.']}, indent=2) + '\n')
    finally:
        world.close()


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('--pg-bin')
    parser.add_argument('--output', required=True, type=Path)
    run(parser.parse_args())
