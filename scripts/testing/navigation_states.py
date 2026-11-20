#!/usr/bin/env python3
"""Real navigation/entry acceptance on disposable PG, built console and OIDC.

Does not build, inject DOM/focus/storage, intercept responses, or call providers.
The offline recovery case uses Chromium's real network disconnection; the app
itself writes and reopens its pending operation, then closes it and publishes a fresh reviewed request.
"""
import argparse
import base64
import struct
import json
import sys
import tempfile
import traceback
import uuid
from pathlib import Path
from types import SimpleNamespace

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT))
from playwright.sync_api import expect
from scripts.bdd.run import pg_bin
from scripts.bdd.world import World
from scripts.bdd.layout import inspect_layout, tab_to
from scripts.bdd.interactions import open_details
from scripts.testing.compact_console import FILES, visit

NAME = 'Production agent instructions and reusable skills for distributed engineering teams'
SOURCE_ONLY = [
    dict(state='Workspace creation/adoption server pending, unknown outcome, rejection and immutable adoption outcome', reason='Review and confirmation are exercised; no workspace adoption is submitted. Rare service faults are not manufactured.'),
    dict(state='Prehydration disabled controls and loading refresh', reason='Transient production timing, source inventory only; screenshots do not claim deterministic coverage.'),
    dict(state='No-workspace noncreator, sign-in/access failures, read-only library, bundles without channels', reason='Separate permission/session/data fixtures are outside this navigation run; implementation is inventoried in navigation.md.'),
    dict(state='Native multi-workspace select popup', reason='Real persisted second workspace is created and the native select is asserted; platform option popup appearance is not a screenshot claim.'),
    dict(state='Recovery storage failure and body expiry', reason='Real app-written pending operation survives reload, can forget its body, and closes; storage failure/expiry are not injected.'),
]


class Evidence:
    def __init__(self, output):
        self.output, self.states, self.checks, self.failures = output, [], [], []

    def check(self, name, passed, detail=None):
        row = dict(check=name, passed=bool(passed), detail=detail)
        self.checks.append(row)
        if not passed:
            self.failures.append(row)
            print('FAIL ' + name, flush=True)

    def capture(self, p, name, coarse=False):
        p.evaluate("""async () => { await Promise.all(document.getAnimations().filter(a => a.playState==='running' && Number.isFinite(a.effect.getComputedTiming().endTime)).map(a=>a.finished.catch(()=>{}))); }""")
        m = inspect_layout(p, coarse=coarse)
        m['navigation'] = p.evaluate("""() => {
          const visible=e=>e.getClientRects().length && getComputedStyle(e).visibility!=='hidden' && !e.closest('[aria-hidden=true]');
          const rect=e=>{const r=e.getBoundingClientRect();return {left:r.left,right:r.right,top:r.top,bottom:r.bottom,width:r.width,height:r.height}};
          const dialogs=[...document.querySelectorAll('[role=dialog]')].filter(visible);
          const surface=dialogs.at(-1)||document;
          const controls=[...surface.querySelectorAll('button,a[href],input:not([type=hidden]),select,textarea')].filter(visible).filter(e=>!e.classList.contains('skip-link'));
          const effective=e=>(['radio','checkbox'].includes(e.getAttribute('role')) ? e.closest('label')||document.querySelector('label[for="'+e.id+'"]')||e : e);
          return {dpr:devicePixelRatio,focus:{tag:document.activeElement?.tagName,text:document.activeElement?.textContent?.trim().slice(0,90),focusVisible:document.activeElement?.matches(':focus-visible')},
            controls:controls.map(e=>({name:e.getAttribute('aria-label')||e.textContent.trim().slice(0,90)||e.id,font:parseFloat(getComputedStyle(e).fontSize),role:e.getAttribute('role'),bounds:rect(effective(e))})),
            dialogs:dialogs.map(e=>({kind:e.getAttribute('data-slot'),bounds:rect(e),scrollHeight:e.scrollHeight,clientHeight:e.clientHeight})),
            workspace:[...document.querySelectorAll('.workspace-switcher-name')].filter(visible).map(e=>({name:e.textContent,title:e.getAttribute('title'),whiteSpace:getComputedStyle(e).whiteSpace,bounds:rect(e),scrollWidth:e.scrollWidth,clientWidth:e.clientWidth})),
            headingOverlaps:[...document.querySelectorAll('.page-heading h1')].filter(visible).flatMap(h=>[...h.closest('.page-heading').querySelectorAll('.page-actions button,.page-actions a')].filter(visible).filter(b=>{const x=rect(h),y=rect(b);return Math.min(x.right,y.right)-Math.max(x.left,y.left)>1&&Math.min(x.bottom,y.bottom)-Math.max(x.top,y.top)>1}).map(b=>b.textContent))}; }""")
        (self.output / (name + '.json')).write_text(json.dumps(m, indent=2) + '\n')
        sensitive=p.locator('[data-sensitive=true], [aria-label="One-time credential secret"]')
        if name.startswith('native200'):
            # Chrome's native zoom needs the full compositor bitmap. Playwright's
            # viewport screenshot crops the physical bitmap at CSS dimensions.
            assert not sensitive.filter(visible=True).count(), 'Native capture cannot contain a credential'
            cdp=p.context.new_cdp_session(p)
            try:bitmap=base64.b64decode(cdp.send('Page.captureScreenshot',dict(format='png',fromSurface=True))['data'])
            finally:cdp.detach()
            pixels=struct.unpack('>II',bitmap[16:24])
            assert pixels[0]==round(m['viewport']*m['navigation']['dpr'])
            m['nativeScreenshotPixels']=list(pixels)
            (self.output/(name+'.png')).write_bytes(bitmap)
            (self.output/(name+'.json')).write_text(json.dumps(m,indent=2)+'\n')
        else:
            p.screenshot(path=str(self.output / (name + '.png')), full_page=False,mask=[sensitive])
        self.states.append(dict(name=name, width=m['viewport'], height=m['viewportHeight'], coarse=coarse, dpr=m['navigation']['dpr']))
        self.check(name+'-no-overflow', m['width'] <= m['viewport']+1)
        self.check(name+'-heading-actions-contained', not m['navigation']['headingOverlaps'], m['navigation']['headingOverlaps'])
        controls=m['navigation']['controls']
        self.check(name+'-control-text14', not [c for c in controls if c['font']<14], [c for c in controls if c['font']<14])
        if coarse:
            self.check(name+'-coarse-context',m['pointerCoarse'])
            bad=[c for c in controls if c['bounds']['height']<43.9 or c['bounds']['width']<43.9]
            self.check(name+'-targets44',not bad,bad)
        for d in m['navigation']['dialogs']:
            r=d['bounds']
            self.check(name+'-dialog-width',d['kind']=='sheet-content' or r['left']>=15 and r['right']<=m['viewport']-15,r)
            self.check(name+'-dialog-height',r['top']>=-1 and r['bottom']<=m['viewportHeight']+1,r)
        print('CAPTURE '+name,flush=True)
        return m

    def run(self,name,p,fn):
        try:
            fn()
        except Exception as error:
            self.failures.append(dict(check=name,error=str(error),traceback=traceback.format_exc()))
            print('ERROR '+name+': '+str(error),flush=True)
            try:self.capture(p,name+'-interrupted')
            except Exception:pass


def menu(p):
    trigger=p.get_by_role('button',name='Open navigation',exact=True)
    if trigger.is_visible() and not p.get_by_role('dialog').count():
        trigger.click()
        expect(p.get_by_role('dialog')).to_be_visible()
    return trigger


def visible(p,role,name):
    return p.get_by_role(role,name=name,exact=True).filter(visible=True).first


def account(p,e,prefix,coarse=False,collapsed=False,clipboard=False):
    menu(p)
    trigger=visible(p,'button','Account')
    tab_to(p,trigger);p.keyboard.press('Enter')
    dialog=p.get_by_role('dialog',name='Your account',exact=True)
    expect(dialog).to_be_visible()
    if collapsed:e.capture(p,prefix+'-account-open',coarse)
    details=p.get_by_role('button',name='Sign-in details',exact=True)
    tab_to(p,details);p.keyboard.press('Enter')
    expect(details).to_have_attribute('aria-expanded','true')
    if prefix=='native200':tab_to(p,p.get_by_role('button',name='Sign out',exact=True))
    e.capture(p,prefix+'-account-details',coarse)
    if clipboard:
        cdp=p.context.new_cdp_session(p)
        cid=cdp.send('Target.getTargetInfo')['targetInfo']['browserContextId']
        perm=dict(permission=dict(name='clipboard-write'),origin=p.evaluate('location.origin'),browserContextId=cid)
        try:
            cdp.send('Browser.setPermission',dict(perm,setting='denied'))
            p.get_by_role('button',name='Copy ID',exact=True).click()
            expect(dialog.get_by_role('status').filter(has_text='Clipboard unavailable.')).to_have_text('Clipboard unavailable. Select and copy the text instead.')
            e.check(prefix+'-id-selectable',dialog.locator('code').first.evaluate("e=>getComputedStyle(e).userSelect!=='none'"))
        finally:
            cdp.send('Browser.setPermission',dict(perm,setting='granted'));cdp.detach()
    p.keyboard.press('Escape');expect(dialog).to_have_count(0);expect(trigger).to_be_focused()
    # Sheet remains underneath the account dialog on phones.
    if p.get_by_role('dialog').count():
        p.keyboard.press('Escape')
        expect(p.get_by_role('dialog')).to_have_count(0)


def workspace(p,e,prefix,coarse=False,adopt=False):
    menu(p)
    if p.get_by_role('button',name='Workspaces').is_visible():
        p.get_by_role('button',name='Workspaces').click()
        p.get_by_role('menuitem',name='New workspace',exact=True).click()
    else: visible(p,'button','New workspace').click()
    dialog=p.get_by_role('dialog',name='Create a workspace',exact=True)
    expect(dialog).to_be_visible()
    name=p.get_by_label('Workspace name',exact=True);name.fill('Review engineering team')
    wid=p.get_by_label('Workspace ID',exact=True)
    expect(wid).to_have_value('review-engineering-team')
    help_id=wid.get_attribute('aria-describedby')
    expect(p.locator('[id="'+help_id+'"]')).to_contain_text('Use letters, numbers, dots, hyphens or underscores')
    expect(p.locator('[id="'+help_id+'"]')).to_be_visible()
    if prefix=='native200':tab_to(p,p.get_by_role('button',name='Create workspace',exact=True))
    e.capture(p,prefix+'-workspace-create-syntax',coarse)
    if adopt:
        open_details(p,'Adopt an existing workspace')
        p.get_by_label('Workspace ID to adopt',exact=True).fill('operator-review-existing-workspace')
        p.get_by_label('Reason for adoption',exact=True).fill('Review the workspace and verified operator identity before permanent membership adoption.')
        p.get_by_role('button',name='Review adoption',exact=True).click()
        action=p.get_by_role('button',name='Adopt workspace',exact=True)
        expect(action).to_be_disabled()
        p.get_by_role('heading',name='Review workspace adoption',exact=True).scroll_into_view_if_needed()
        e.capture(p,prefix+'-adoption-review',coarse)
        p.get_by_role('checkbox',name='I confirm this workspace and my verified identity.',exact=True).check()
        expect(action).to_be_enabled()
        p.get_by_label('Reason for adoption',exact=True).fill('A changed reason invalidates the previously confirmed review.')
        expect(action).to_have_count(0)
        e.check(prefix+'-adoption-edit-invalidates-review',True)
    p.keyboard.press('Escape');expect(dialog).to_have_count(0)
    if visible(p,'button','Open navigation').is_visible():expect(visible(p,'button','Open navigation')).to_be_focused()


def singleton(p,b,e,prefix,coarse=False,tooltip=False):
    visit(p,b,b.workspace_path());menu(p)
    link=p.locator('.workspace-switcher-name').filter(visible=True).first
    desktop=p.get_by_role('button',name='Workspaces')
    if desktop.is_visible():
        desktop.hover();expect(p.get_by_role('tooltip')).to_contain_text(NAME)
        e.capture(p,prefix+'-singleton-hover')
        p.keyboard.press('Escape');p.mouse.move(1000,500)
        tab_to(p,desktop);p.keyboard.press('Enter')
        expect(p.get_by_role('menuitemradio')).to_contain_text(NAME)
        expect(p.get_by_role('menuitemradio')).to_have_attribute('aria-checked','true')
        e.capture(p,prefix+'-singleton-selected')
        p.keyboard.press('Escape');expect(desktop).to_be_focused()
        return
    expect(link).to_have_text(NAME)
    e.check(prefix+'-no-native-title',link.get_attribute('title') is None)
    if coarse:
        m=e.capture(p,prefix+'-singleton-sheet',True)
        row=m['navigation']['workspace'][0]
        e.check(prefix+'-full-name-without-tooltip',row['whiteSpace']!='nowrap' and row['scrollWidth']<=row['clientWidth']+1,row)
        p.keyboard.press('Escape');expect(p.get_by_role('dialog')).to_have_count(0)
    else:
        e.capture(p,prefix+'-singleton-closed')
    if tooltip:
        link.hover();expect(p.get_by_role('tooltip')).to_be_visible()
        expect(p.get_by_role('tooltip')).to_have_text(NAME)
        e.capture(p,prefix+'-singleton-hover')
        p.keyboard.press('Escape');expect(p.get_by_role('tooltip')).to_have_count(0)
        p.mouse.move(1000,500)
        tab_to(p,link);expect(p.get_by_role('tooltip')).to_be_visible()
        e.capture(p,prefix+'-singleton-keyboard')
        p.keyboard.press('Escape');expect(p.get_by_role('tooltip')).to_have_count(0);expect(link).to_be_focused()


def sources(w,b,p,e):
    visit(p,b,b.workspace_path())
    p.get_by_role('button',name='Create your first bundle',exact=True).click()
    p.get_by_label('Bundle name',exact=True).fill('Real persisted navigation acceptance bundle')
    p.get_by_label('Instructions',exact=True).fill('# Instructions\nKeep complete identities visible and review consequential changes.')
    e.capture(p,'desktop-create-manual')
    open_details(p,'Publishing settings')
    e.capture(p,'desktop-create-settings')
    p.get_by_role('radio',name='Import files',exact=True).click()
    p.get_by_label('Individual files',exact=True).set_input_files(dict(name='AGENTS.md',mimeType='text/markdown',buffer=b'# Imported fixture\nReview the real imported file.'))
    expect(p.get_by_role('button',name='Clear imported files',exact=True)).to_be_visible()
    p.get_by_role('button',name='AGENTS.md · instruction',exact=True).click()
    p.get_by_role('heading',name='Import preview · generic',exact=True).scroll_into_view_if_needed()
    expect(p.get_by_role('button',name='Import and publish',exact=True)).to_be_disabled()
    e.capture(p,'desktop-create-file-preview')
    p.get_by_role('radio',name='Import JSON',exact=True).click()
    p.get_by_label('Bundle JSON',exact=True).fill('{invalid')
    expect(p.get_by_role('alert')).to_have_text('Enter valid bundle JSON.')
    e.capture(p,'desktop-create-json-invalid')
    p.get_by_label('Bundle JSON',exact=True).fill(json.dumps(dict(schemaVersion=1,files=FILES)))
    p.get_by_role('button',name='AGENTS.md · instruction',exact=True).click()
    p.get_by_role('checkbox',name='Confirm these entries for import',exact=True).check()
    expect(p.get_by_role('button',name='Import and publish',exact=True)).to_be_enabled()
    p.get_by_role('heading',name='Import preview · generic',exact=True).scroll_into_view_if_needed()
    e.capture(p,'desktop-create-json-confirmed-preview')
    p.get_by_role('radio',name='Write instructions',exact=True).click()
    # Real connection loss leaves the app-written frozen operation unresolved.
    p.context.set_offline(True)
    try:
        p.get_by_role('button',name='Create and publish',exact=True).click()
        expect(p.get_by_role('button',name='Check result',exact=True)).to_be_visible()
        expect(p.get_by_role('status').filter(has_text='Check the bundle JSON.')).to_be_visible()
    finally:p.context.set_offline(False)
    # Reopening proves persistence came from the app, with no storage injection.
    p.reload(wait_until='networkidle')
    expect(p.get_by_role('button',name='Check result',exact=True)).to_be_visible()
    open_details(p,'Creation recovery details')
    e.capture(p,'desktop-persisted-recovery-with-body')
    p.get_by_role('button',name='Forget submitted text',exact=True).click()
    e.capture(p,'desktop-persisted-recovery-without-body')
    expect(p.get_by_role('button',name='Retry exact submitted creation',exact=True)).to_have_count(0)
    p.get_by_role('button',name='Close unresolved creation',exact=True).click()
    expect(p.get_by_role('button',name='Check result',exact=True)).to_have_count(0)
    e.check('app-written-pending-survives-reload-forget-close',True)
    # Finally publish through the app, then verify actual persisted payload.
    visit(p,b,b.workspace_path());p.get_by_role('button',name='Create your first bundle',exact=True).click()
    p.get_by_label('Bundle name',exact=True).fill('Persisted through the real console')
    p.get_by_label('Instructions',exact=True).fill('# Persisted navigation acceptance\nNo model execution.')
    p.get_by_role('button',name='Create and publish',exact=True).click()
    expect(p.get_by_test_id('entry-content')).to_have_text('# Persisted navigation acceptance\nNo model execution.')
    rows=w.call('GET',w.root+'/bundles',actor='admin')['items']
    assert len(rows)==1 and rows[0]['name']=='Persisted through the real console',rows
    e.check('real-console-published-exactly-one-bundle',True)


def create_workspace(w,b,p,e):
    visit(p,b,b.workspace_path());menu(p)
    if p.get_by_role('button',name='Workspaces').is_visible():
        p.get_by_role('button',name='Workspaces').click()
        p.get_by_role('menuitem',name='New workspace',exact=True).click()
    else: visible(p,'button','New workspace').click()
    p.get_by_label('Workspace name',exact=True).fill('Navigation acceptance second workspace')
    project='navigation-'+uuid.uuid4().hex
    p.get_by_label('Workspace ID',exact=True).fill(project)
    p.get_by_role('button',name='Create workspace',exact=True).click()
    expect(p).to_have_url(b.base+b.workspace_path(workspace_id=project))
    p.get_by_role('button',name='Workspaces').click()
    expect(p.locator('[data-workspace-id="'+project+'"]')).to_have_attribute('aria-checked','true')
    p.keyboard.press('Escape')
    projects=w.personal_projects('admin')
    e.check('workspace-create-persisted-admin-membership',any(x['id']==project and x['role']=='admin' for x in projects))


def main():
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--pg-bin');parser.add_argument('--output',type=Path,required=True)
    parser.add_argument('--chrome-channel',default='chrome')
    args=parser.parse_args();output=args.output.resolve();output.mkdir(parents=True,exist_ok=False,mode=0o700)
    e=Evidence(output);w=World(pg_bin(args.pg_bin));b=touch=None
    try:
        w.start();w.fresh_scenario(SimpleNamespace(effective_tags=[]))
        w.sign_in('admin','operator');w.browser_actor='admin'
        project='navigation-singleton-'+uuid.uuid4().hex
        w.call('POST','/v1/workspaces',dict(id=project,name=NAME),actor='admin')
        w.h.project=project;w.root='/v1/workspaces/'+project
        b=w.browser();p=b.page;p.set_viewport_size(dict(width=1440,height=900))
        e.check('fresh-singleton-membership',len(w.personal_projects('admin'))==1)
        e.run('desktop-singleton',p,lambda:singleton(p,b,e,'desktop',tooltip=True))
        e.run('desktop-account',p,lambda:account(p,e,'desktop',collapsed=True,clipboard=True))
        e.run('desktop-workspace',p,lambda:workspace(p,e,'desktop',adopt=True))
        touch=b.browser.new_context(ignore_https_errors=True,viewport=dict(width=320,height=844),has_touch=True,storage_state=b.context.storage_state())
        phone=touch.new_page();phone.set_default_timeout(10000);phone.on('pageerror',lambda error:b.errors.append(str(error)))
        for width in [320,390]:
            phone.set_viewport_size(dict(width=width,height=844));prefix='mobile'+str(width)
            e.run(prefix+'-singleton',phone,lambda prefix=prefix:singleton(phone,b,e,prefix,True))
            e.run(prefix+'-account',phone,lambda prefix=prefix:account(phone,e,prefix,True))
            e.run(prefix+'-workspace',phone,lambda prefix=prefix,width=width:workspace(phone,e,prefix,True,adopt=width==320))
        with tempfile.TemporaryDirectory(prefix='acclimate-layout5-nav-native-') as profile:
            native=b.playwright.chromium.launch_persistent_context(profile,channel=args.chrome_channel,headless=True,no_viewport=True,ignore_https_errors=True,args=['--window-size=1280,800'])
            try:
                b.sign_in(native);zoom=native.pages[0];zoom.set_default_timeout(10000)
                visit(zoom,b,b.workspace_path());before=zoom.evaluate('({width:innerWidth,dpr:devicePixelRatio})')
                zoom.goto('chrome://settings/appearance',wait_until='domcontentloaded');zoom.evaluate('chrome.settingsPrivate.setDefaultZoom(2)')
                visit(zoom,b,b.workspace_path());zoom.wait_for_function('w=>Math.abs(innerWidth-w)<2',arg=before['width']/2)
                e.check('native200-real-browser-zoom',zoom.evaluate('devicePixelRatio')==before['dpr']*2)
                e.run('native200-account',zoom,lambda:account(zoom,e,'native200',collapsed=True))
                e.run('native200-workspace',zoom,lambda:workspace(zoom,e,'native200'))
            finally:native.close()
        e.run('desktop-create-sources-and-recovery',p,lambda:sources(w,b,p,e))
        e.run('persisted-workspace-create',p,lambda:create_workspace(w,b,p,e))
        e.check('no-browser-errors',not b.errors,b.errors)
    except Exception as error:
        e.failures.append(dict(check='fixture',error=str(error),traceback=traceback.format_exc()))
    finally:
        if touch:touch.close()
        w.close()
        summary=dict(passed=not e.failures,capturedStates=len(e.states),states=e.states,checks=e.checks,failures=e.failures,
                     fixture='Disposable PostgreSQL + real service + existing production console + OIDC/TLS',
                     mutations='Only disposable fixture API and real app controls; no live stack writes',
                     evidencePolicy='Read-only DOM metrics; real keyboard/pointer input; no state/focus/storage injection or fake responses. Every screenshot masks sensitive credential locators; no credentials issued or raw DOM saved.',
                     sourceOnly=SOURCE_ONLY,paidModelCalls=0)
        (output/'summary.json').write_text(json.dumps(summary,indent=2)+'\n')
        print(json.dumps(dict(passed=summary['passed'],capturedStates=len(e.states),failures=len(e.failures)),indent=2),flush=True)
    return 0 if summary['passed'] else 1

if __name__=='__main__':raise SystemExit(main())
