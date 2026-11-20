#!/usr/bin/env python3
"""Disposable workspace/account navigation evidence; no model calls."""
import argparse,json,sys,uuid
from pathlib import Path
from types import SimpleNamespace
ROOT=Path(__file__).resolve().parents[2];sys.path.insert(0,str(ROOT))
from playwright.sync_api import expect
from scripts.bdd.run import pg_bin
from scripts.bdd.world import World
from scripts.testing.compact_console import FILES,visit
from scripts.testing.desktop_layouts import build_fingerprint
from scripts.bdd.editor import expect_editor_value


def seed(w, verify=False):
    w.start();w.fresh_scenario(SimpleNamespace(effective_tags=[]));w.publish_initial('',files=FILES)
    w.h.identity().next_token_claims={'name':'Morgan Lee'}
    b=w.browser();extra=[]
    for i,name in enumerate(['Research team','Payment operations','Research team','Support production','Code review','Background agents','A very long workspace name for engineering and reliability teams'] + (['Scrolling workspace '+str(n) for n in range(12)] if verify else [])):
        extra.append(w.call('POST','/v1/workspaces',dict(id='nav-'+str(i)+'-'+uuid.uuid4().hex[:8],name=name),actor='_browser-operator'))
    if verify:
        w.sign_in('role-admin','role-admin')
        w.call('PUT','/v1/workspaces/'+extra[2]['id']+'/memberships/'+w.sessions['role-admin']['userId'],dict(role='admin'),actor='_browser-operator')
        w.call('PUT','/v1/workspaces/'+extra[2]['id']+'/memberships/'+w.sessions['_browser-operator']['userId'],dict(role='editor'),actor='_browser-operator')
    return b,extra


def capture(page,path):
    page.evaluate("""async () => { await Promise.all(document.getAnimations().filter(a => a.playState==='running' && Number.isFinite(a.effect.getComputedTiming().endTime)).map(a => a.finished.catch(()=>{}))); }""")
    page.screenshot(path=str(path))


def verify(w,b,extra,out,checks):
    p=b.page
    user=w.sessions['_browser-operator']['userId']
    identity={'ID':user,'subject':'operator','issuer':b.identity.issuer}
    projects=w.personal_projects('_browser-operator')
    by_id={item['id']:item for item in projects}
    duplicates=[item['id'] for item in extra if item['name']=='Research team']
    assert len(duplicates)==2
    for width in (1440,1024,390,320):
        p.set_viewport_size(dict(width=width,height=900));visit(p,b,b.workspace_path())
        mobile=width<=1000
        if mobile: p.get_by_role('button',name='Open navigation',exact=True).click()
        account=p.get_by_role('button',name='Account',exact=True).filter(visible=True).first
        account.click();dialog=p.get_by_role('dialog',name='Your account',exact=True)
        expect(dialog).to_be_visible()
        expect(dialog.get_by_text('Morgan Lee',exact=True)).to_be_visible()
        expect(dialog).to_have_attribute('aria-modal','false')
        if not mobile:
            expect(p.locator('[data-slot=dialog-overlay]')).to_have_count(0)
            rect=dialog.bounding_box();anchor=account.bounding_box()
            assert rect['x']>=anchor['x']+anchor['width'],dict(popup=rect,anchor=anchor)
        for value in identity.values(): expect(dialog.get_by_text(value,exact=True)).not_to_be_visible()
        capture(p,out/f'account-{width}.png')
        dialog.get_by_role('button',name='Sign-in details',exact=True).click()
        for label,value in identity.items():
            field=dialog.get_by_text(value,exact=True);expect(field).to_be_visible()
            assert field.inner_text()==value
            button=dialog.get_by_role('button',name='Copy '+label,exact=True)
            button.click()
            expect(button.locator('..').get_by_role('status')).to_have_text('Copied.')
            assert p.evaluate('navigator.clipboard.readText()')==value
        capture(p,out/f'account-details-{width}.png')
        p.keyboard.press('Escape');expect(dialog).to_have_count(0);expect(account).to_be_focused()
        if mobile:
            # Closing the nested dialog must leave the navigation sheet active.
            sheet=p.get_by_role('dialog',name='Acclimate',exact=True)
            expect(sheet).to_be_visible()
            select=sheet.get_by_label('Workspace',exact=True)
            for workspace_id in duplicates:
                expect(select.locator('option').filter(has_text=workspace_id)).to_have_count(1)
            p.keyboard.press('Escape');expect(sheet).to_have_count(0)
            expect(p.get_by_role('button',name='Open navigation',exact=True)).to_be_focused()
        else:
            trigger=p.get_by_role('button',name='Workspaces');trigger.click()
            menu=p.get_by_role('menu');expect(menu).to_be_visible()
            for workspace_id in duplicates:
                item=menu.locator('[data-workspace-id="'+workspace_id+'"]')
                expect(item).to_contain_text(workspace_id)
            for workspace_id,project in by_id.items():
                item=menu.locator('[data-workspace-id="'+workspace_id+'"]')
                expect(item).to_contain_text(project['name'])
                expect(item).to_contain_text({'admin':'Administrator','editor':'Editor','viewer':'Viewer'}[project['role']])
            current=menu.locator('[data-workspace-id="'+w.h.project+'"]')
            expect(current).to_have_attribute('aria-checked','true')
            # The membership region, not the operator action, owns overflow.
            create=menu.get_by_role('menuitem',name='New workspace')
            expect(create).to_be_visible()
            group=menu.get_by_role('group',name='Workspaces')
            geometry=group.evaluate("e => ({height:e.clientHeight, scroll:e.scrollHeight, overflow:getComputedStyle(e).overflowY})")
            assert geometry['scroll']>geometry['height'] and geometry['overflow'] in ('auto','scroll'),geometry
            capture(p,out/f'workspaces-{width}.png')
            p.keyboard.press('End');expect(create).to_be_focused()
            p.keyboard.press('ArrowUp');expect(group.get_by_role('menuitemradio').last).to_be_focused()
            assert group.evaluate('e=>e.scrollTop')>0
            p.keyboard.press('Home');expect(current).to_be_focused()
            p.keyboard.press('Escape');expect(trigger).to_be_focused()
        checks.append(f'Account identity, copy and focus at {width}px; workspace choices at {width}px')

    p.set_viewport_size(dict(width=320,height=420));visit(p,b,b.workspace_path())
    p.get_by_role('button',name='Open navigation',exact=True).click()
    p.get_by_role('button',name='Account',exact=True).filter(visible=True).click()
    dialog=p.get_by_role('dialog',name='Your account',exact=True)
    dialog.get_by_role('button',name='Sign-in details',exact=True).click()
    dialog.get_by_role('button',name='Sign out',exact=True).scroll_into_view_if_needed()
    bounds=dialog.bounding_box();assert bounds['y']>=0 and bounds['y']+bounds['height']<=420
    expect(dialog.get_by_role('button',name='Sign out',exact=True)).to_be_in_viewport()
    capture(p,out/'account-low-height.png');p.keyboard.press('Escape');p.keyboard.press('Escape')
    checks.append('Expanded account popup scrolls within a320x420 viewport with Sign out reachable; menu keyboard End/Home reaches both regions')

    p.set_viewport_size(dict(width=1440,height=900));visit(p,b,b.workspace_path())
    p.get_by_role('button',name='Account',exact=True).click()
    popup=p.get_by_role('dialog',name='Your account',exact=True)
    p.get_by_role('heading',name='Bundles',exact=True).click()
    expect(popup).to_have_count(0)
    checks.append('Anchored nonmodal account has no overlay and dismisses on outside interaction')

    # Exercise the browser failure path without changing the real identity source.
    p.set_viewport_size(dict(width=1440,height=900));visit(p,b,b.workspace_path())
    p.get_by_role('button',name='Account',exact=True).click()
    dialog=p.get_by_role('dialog',name='Your account',exact=True)
    dialog.get_by_role('button',name='Sign-in details',exact=True).click()
    cdp=p.context.new_cdp_session(p)
    cid=cdp.send('Target.getTargetInfo')['targetInfo']['browserContextId']
    permission=dict(permission=dict(name='clipboard-write'),origin=b.base,browserContextId=cid)
    cdp.send('Browser.setPermission',dict(permission,setting='denied'))
    for label,value in identity.items():
        button=dialog.get_by_role('button',name='Copy '+label,exact=True);button.click()
        expect(button.locator('..').get_by_role('status')).to_have_text('Clipboard unavailable. Select and copy the text instead.')
        field=dialog.get_by_text(value,exact=True)
        assert field.evaluate("e => getComputedStyle(e).userSelect") != 'none'
        assert field.evaluate("e => { const r=document.createRange(); r.selectNodeContents(e); const s=getSelection(); s.removeAllRanges(); s.addRange(r); return s.toString(); }")==value
    capture(p,out/'clipboard-denied.png')
    cdp.send('Browser.setPermission',dict(permission,setting='granted'));cdp.detach()
    checks.append('Native clipboard denial reports manual copy and all three complete values are selectable')
    p.keyboard.press('Escape')

    # Selecting the current item does not add history; switching does and Back restores it.
    trigger=p.get_by_role('button',name='Workspaces');trigger.click()
    menu=p.get_by_role('menu');current=menu.locator('[data-workspace-id="'+w.h.project+'"]')
    original=p.url;history=p.evaluate('history.length');current.click()
    assert p.url==original and p.evaluate('history.length')==history
    trigger.click();p.get_by_role('menu').locator('[data-workspace-id="'+duplicates[0]+'"]').click()
    expect(p).to_have_url(b.base+b.workspace_path(workspace_id=duplicates[0]))
    trigger.click();expect(p.get_by_role('menu').locator('[data-workspace-id="'+duplicates[0]+'"]')).to_have_attribute('aria-checked','true')
    p.keyboard.press('Escape');p.go_back(wait_until='networkidle');expect(p).to_have_url(original)
    trigger.click();expect(p.get_by_role('menu').locator('[data-workspace-id="'+w.h.project+'"]')).to_have_attribute('aria-checked','true')
    p.get_by_role('menu').get_by_role('menuitem',name='New workspace').click()
    expect(p.get_by_role('dialog',name='Create a workspace')).to_be_visible()
    checks.append('Current selection is inert; switching, Back, checked state and creation handoff work')

    p.keyboard.press('Escape')
    visit(p,b,b.bundle_path('content'))
    p.get_by_role('link',name='Edit entry',exact=True).click()
    editor=p.get_by_role('textbox',name='Content',exact=True);editor.fill('Unsaved native workspace notes.')
    p.set_viewport_size(dict(width=390,height=900))
    p.get_by_role('button',name='Open navigation',exact=True).click()
    select=p.get_by_role('combobox',name='Workspace',exact=True)
    select.select_option(duplicates[0])
    expect(p.get_by_role('heading',name='Leave current edits?',exact=True)).to_be_visible()
    p.get_by_role('button',name='Keep editing',exact=True).click()
    expect(select).to_have_value(w.h.project)
    p.keyboard.press('Escape');expect_editor_value(editor,'Unsaved native workspace notes.')
    p.get_by_role('button',name='Open navigation',exact=True).click()
    p.get_by_role('combobox',name='Workspace',exact=True).select_option(duplicates[0])
    p.get_by_role('button',name='Leave editor',exact=True).click()
    expect(p).to_have_url(b.base+b.workspace_path(workspace_id=duplicates[0]))
    checks.append('Cancelled native switch restores original choice and unsaved text; confirmed switch navigates')

    # A fresh OIDC login with no name claim uses the neutral fallback.
    context=b.browser.new_context(ignore_https_errors=True,viewport={'width':1440,'height':900})
    try:
        b.sign_in(context,'operator');page=context.new_page()
        visit(page,b,b.workspace_path());page.get_by_role('button',name='Account',exact=True).click()
        expect(page.get_by_role('dialog',name='Your account').get_by_text('Signed in',exact=True)).to_be_visible()
    finally: context.close()
    checks.append('Fresh OIDC login without name uses Signed in fallback')

def run(a):
    out=a.output.resolve();out.mkdir(parents=True,exist_ok=False,mode=0o700);w=World(pg_bin(a.pg_bin));before=build_fingerprint();checks=[]
    try:
        b,extra=seed(w,a.verify);p=b.page
        if a.verify:
            verify(w,b,extra,out,checks)
        else:
          for width in (1440,1024,390):
              p.set_viewport_size(dict(width=width,height=900));visit(p,b,b.workspace_path())
              if width<=1000:p.get_by_role('button',name='Open navigation',exact=True).click()
              account=p.get_by_role('button',name='Account',exact=True).filter(visible=True).first;account.click()
              dialog=p.get_by_role('dialog',name='Your account',exact=True);expect(dialog).to_be_visible();p.screenshot(path=str(out/f'account-{width}.png'),full_page=True)
              dialog.get_by_role('button',name='Sign-in details',exact=True).click();p.screenshot(path=str(out/f'account-details-{width}.png'),full_page=True)
              p.keyboard.press('Escape');expect(account).to_be_focused()
              if width<=1000:p.keyboard.press('Escape')
              else:
                  p.get_by_role('button',name='Workspaces').click();expect(p.get_by_role('menu')).to_be_visible();p.screenshot(path=str(out/f'workspaces-{width}.png'),full_page=True);p.keyboard.press('Escape')
              checks.append(f'Account and workspace baseline at {width}px')
        assert before==build_fingerprint();assert not b.errors,b.errors
        (out/'summary.json').write_text(json.dumps(dict(passed=True,checks=checks,sourceBuildSha256=before,modelCalls=0,limits=(['Desktop dirty navigation and operator/member gates are in the targeted BDD; logout/account change, creation pending/failure and resize are in navigation_lifecycle.py. Native screen readers and arbitrary identity lengths are untested.'] if a.verify else ['Baseline captures only; final behavior qualification not yet implemented.'])),indent=2)+'\n')
    finally:w.close()

if __name__=='__main__':
    p=argparse.ArgumentParser();p.add_argument('--pg-bin');p.add_argument('--output',required=True,type=Path);p.add_argument('--verify',action='store_true');run(p.parse_args())
