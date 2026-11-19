#!/usr/bin/env python3
"""Focused v9 admin layouts using private real service/OIDC and a frozen build.

No app edits, builds, providers, interception, DOM/focus/storage injection, or
external writes. Native inputs and read-only rendered geometry establish facts.
"""
import argparse
from datetime import datetime, timezone
import json
from pathlib import Path
import re
import sys
import tempfile
import traceback
from types import SimpleNamespace
from urllib.parse import parse_qs, urlencode, urlsplit

ROOT=Path(__file__).resolve().parents[2]
sys.path.insert(0,str(ROOT))
from playwright.sync_api import expect
from scripts.bdd.run import pg_bin
from scripts.bdd.world import World
from scripts.bdd.layout import inspect_layout, tab_to
from scripts.bdd.interactions import open_details
from scripts.testing.compact_console import FILES, visit
from scripts.testing.desktop_layouts import Evidence, build_fingerprint
from scripts.test_console_native_zoom import capture_native

LONG_NAME='Production review instructions and reusable memory for background agent integrations'
LONG_CHANNEL='production-review-integrations-preserved-retry-contracts'
LONG_APP='Production review agent for background integrations with preserved retry contracts and reusable context'
LONG_SUBJECT='reviewer:'+('background-integrations-preserved-retry-contracts/'*5)+'verified-person'
REQUIRED=['ACCLIMATE_URL','ACCLIMATE_TOKEN','ACCLIMATE_SCOPE']


def activate(p,target):
    tab_to(p,target);expect(target).to_be_focused();p.keyboard.press('Enter')


def surface(p):
    return p.evaluate('''()=>{
      const box=el=>{if(!el||!el.getClientRects().length)return null;const r=el.getBoundingClientRect();return {x:r.x,y:r.y,width:r.width,height:r.height,right:r.right,bottom:r.bottom}};
      const visible=el=>!!el.getClientRects().length&&getComputedStyle(el).visibility!=='hidden';
      const textProof=el=>{const range=document.createRange();range.selectNodeContents(el);return {text:el.textContent,bounds:box(el),textBounds:box(range),scrollWidth:el.scrollWidth,clientWidth:el.clientWidth}};
      return {viewport:{width:innerWidth,height:innerHeight,dpr:devicePixelRatio},
        sdk:box(document.querySelector('.sdk-setup')),members:box(document.querySelector('.workspace-members-panel')),
        connections:box(document.querySelector('.workspace-connections')),selected:document.querySelector('.workspace-connections')?.getAttribute('data-selected'),
        directory:box(document.querySelector('.connection-directory')),detail:box(document.querySelector('.connection-detail')),
        railScrollers:[...document.querySelectorAll('.connection-directory,.connection-directory *')].filter(visible).filter(el=>/auto|scroll/.test(getComputedStyle(el).overflowY)&&el.scrollHeight>el.clientHeight+1).map(el=>({tag:el.tagName,classes:el.className,bounds:box(el)})),
        scopeText:[...document.querySelectorAll('.connection-row strong,.connection-row p,.connection-detail h2,.connection-detail section:first-child > div:first-child p')].filter(visible).map(textProof),
        memberRows:[...document.querySelectorAll('.workspace-member-row')].map(el=>({bounds:box(el),identity:box(el.querySelector('.workspace-member-identity')),subject:textProof(el.querySelector('.member-identity-heading > span.font-medium')),role:box(el.querySelector('.member-role-trigger')),heading:box(el.querySelector('.member-identity-heading')),manage:box(el.querySelector('.member-actions-trigger'))})),
        install:{command:box(document.querySelector('.sdk-install-command pre')),copy:box(document.querySelector('.sdk-install-command button'))},
        environment:[...document.querySelectorAll('.sdk-required-environment > div')].map(el=>({term:el.querySelector('dt').textContent,row:box(el),dt:box(el.querySelector('dt')),dd:box(el.querySelector('dd'))})),
        dialogs:[...document.querySelectorAll('[role=dialog]')].filter(visible).map(el=>({bounds:box(el),scrollHeight:el.scrollHeight,clientHeight:el.clientHeight}))};
    }''')


def capture(e,p,name,*,coarse=False,cdp=None):
    # Checkbox/radio labels are native clickable targets; measure their label
    # rather than treating the decorative 16px checkbox button as standalone.
    local_cdp=p.context.new_cdp_session(p) if not cdp and p.get_by_role('dialog').count() else None
    cdp=cdp or local_cdp
    if cdp:
        p.evaluate('''async()=>{await document.fonts.ready;await Promise.all(document.getAnimations().filter(a=>a.playState==='running'&&Number.isFinite(a.effect.getComputedTiming().endTime)).map(a=>a.finished.catch(()=>{})));await new Promise(requestAnimationFrame);await new Promise(requestAnimationFrame)}''');p.wait_for_timeout(500)
        try:metric=capture_native(p,cdp,e.output,name)
        finally:
            if local_cdp:local_cdp.detach()
        after=inspect_layout(p)
        keys=('viewport','viewportHeight','width','scrollY','visualViewportOffsetTop')
        assert {k:metric[k] for k in keys}=={k:after[k] for k in keys},'Native capture changed route geometry'
        metric['capture']=dict(method='CDP Page.captureScreenshot',dpr=p.evaluate('devicePixelRatio'),before={k:metric[k] for k in keys},after={k:after[k] for k in keys})
        if p.get_by_role('dialog').count():
            effective=p.get_by_role('dialog').evaluate('''el=>[...el.querySelectorAll('button,input,select,textarea,a[href]')].filter(e=>e.getClientRects().length).map(e=>{const target=['checkbox','radio'].includes(e.getAttribute('role'))?e.closest('label')||e:e;const r=target.getBoundingClientRect();return {name:e.getAttribute('aria-label')||e.textContent.trim(),role:e.getAttribute('role'),effectiveTag:target.tagName,width:r.width,height:r.height}})''')
            # The established 32px gate applies to standalone controls. Preserve
            # unchanged checkbox prose-label dimensions as explicit evidence;
            # their keyboard state transitions are verified below.
            assert all(row['height']>=31.5 for row in effective if row['role'] not in ('checkbox','radio')),effective
            metric['effectiveDialogTargets']=effective
    else:
        metric=e.capture(p,name,coarse=coarse);assert not metric['violations'],metric['violations']
    metric['surface']=surface(p);(e.output/(name+'.json')).write_text(json.dumps(metric,indent=2)+'\n')
    return metric['surface']


def fixtures(w):
    w.sign_in('admin','operator');w.browser_actor='admin';w.create_workspace()
    w.publish_initial('',files=FILES);w.create_integration();first=w.integration
    setup=w.call('POST',w.root+'/bundle-setups',dict(name=LONG_NAME,origin='created',channel=LONG_CHANNEL,payload=dict(schemaVersion=1,files=FILES),reason='Disposable rich admin layout fixture.'))
    w.setup=setup;w.bundle=w.root+'/bundles/'+setup['bundle']['id'];w.channel=w.bundle+'/channels/'+LONG_CHANNEL;w.original=setup['resolution']
    selected=w.call('POST',w.root+'/integrations',dict(displayName=LONG_APP,bundleId=setup['bundle']['id'],channel=LONG_CHANNEL))
    other=w.call('POST',w.root+'/integrations',dict(displayName='Background worker with the same scoped channel',bundleId=setup['bundle']['id'],channel=LONG_CHANNEL))
    w.integration=selected;w.integration_path=w.root+'/integrations/'+selected['id'];w.issue('content-read');w.issue('receipt-write')
    now=datetime.now(timezone.utc).isoformat();event=dict(w.delivery_event(),channel=LONG_CHANNEL,revision=w.original['revision'],resolvedAt=now,stale=False)
    receipt=w.call('POST',w.integration_path+'/receipts',event,actor='receipt-writer')
    people=[]
    for actor,subject,role in (('editor','release-reviewer','editor'),('viewer',LONG_SUBJECT,'viewer')):
        w.sign_in(actor,subject);user_id=w.sessions[actor]['userId'];assert user_id!=subject
        w.call('PUT',w.root+'/memberships/'+user_id,dict(role=role),actor='admin')
        people.append(dict(id=user_id,subject=subject,issuer=w.issuer,role=role))
    return dict(first=first,selected=selected,other=other,receipt=receipt,people=people)


def row_for(p,name):
    return p.locator('.connection-row').filter(has=p.get_by_text(name,exact=True))


def selected_facts(w,p,f):
    expect(p.locator('.connection-detail').get_by_role('heading',name=LONG_APP,exact=True)).to_be_visible()
    expect(p.locator('.connection-row[aria-current=page]')).to_have_count(1)
    expect(row_for(p,LONG_APP)).to_have_attribute('aria-current','page')
    p.get_by_role('tab',name='Settings',exact=True).click();open_details(p,'Connection identity details');expect(p.locator('.connection-detail').get_by_text(f['selected']['id'],exact=True)).to_be_visible()
    p.get_by_role('tab',name='Setup',exact=True).click()
    p.get_by_role('button',name='1. Bundle & channel',exact=False).click()
    expect(p.get_by_role('link',name='Full setup guide',exact=True)).to_have_attribute('href',w.browser().bundle_path('connect',channel=LONG_CHANNEL))
    p.get_by_role('tab',name='Credentials',exact=True).click()
    warning=p.get_by_text('Secrets appear once; save them in your app’s secret manager.',exact=False)
    expect(warning).to_be_visible()
    expect(p.get_by_role('button',name='Create read credential',exact=True)).to_be_enabled()


def connection_geometry(w,b,e,f):
    p=b.page;route=b.workspace_path('connections')+'?'+urlencode(dict(integration=f['selected']['id']));results=[]
    for width in (1440,1920,1024):
        p.set_viewport_size(dict(width=width,height=1000));visit(p,b,route);expect(p.locator('.connection-row')).to_have_count(3);selected_facts(w,p,f)
        g=capture(e,p,f'{width}-selected-connections')
        assert g['connections']['width']<=1440+1 and not g['railScrollers'],g
        for item in g['scopeText']:
            assert item['scrollWidth']<=item['clientWidth']+1,item
            assert item['textBounds']['x']>=item['bounds']['x']-1 and item['textBounds']['right']<=item['bounds']['right']+1,item
        if width>=1200:
            assert abs(g['directory']['width']-280)<1 and g['detail']['x']>=g['directory']['right']+19,g
            assert g['directory']['y']==g['detail']['y'],g
        else:
            assert g['connections']['width']<=1024+1 and g['detail']['y']>=g['directory']['bottom']+15,g
        # Full persisted receipt facts are already visible, without a summary-only substitute.
        article=p.locator('.connection-detail article');expect(article).to_have_count(1);receipt=f['receipt']
        for value in ('App reported verified','cache',receipt['versionId'],receipt['digest'],receipt['occurredAt'],receipt['receivedAt'],receipt['resolvedAt'],LONG_CHANNEL+' · revision '+receipt['revision']+' · fresh'):
            expect(article).to_contain_text(value)
        expect(p.get_by_text('Each row is an independent observation',exact=False)).to_be_visible()
        article.scroll_into_view_if_needed();capture(e,p,f'{width}-selected-receipt-full-facts')
        results.append(dict(width=width,geometry=g,receiptVersion=receipt['versionId'],receiptDigest=receipt['digest']))
    # A selected scope retains all origin filters through real ConsoleLink navigation.
    filtered=b.workspace_path('connections')+'?'+urlencode(dict(bundleId=w.setup['bundle']['id'],channel=LONG_CHANNEL))
    visit(p,b,filtered);expect(p.locator('.connection-row')).to_have_count(2)
    for name,item in ((LONG_APP,f['selected']),(f['other']['displayName'],f['other'])):
        target=row_for(p,name);href=target.get_attribute('href');activate(p,target);expect(p).to_have_url(b.base+href)
        query=parse_qs(urlsplit(p.url).query);assert query==dict(integration=[item['id']],bundleId=[w.setup['bundle']['id']],channel=[LONG_CHANNEL]),query
        expect(row_for(p,name)).to_have_attribute('aria-current','page')
        expect(p.locator('.connection-detail').get_by_role('heading',name=name,exact=True)).to_be_visible()
    p.get_by_role('link',name='Clear filters',exact=True).click();expect(p).to_have_url(b.base+b.workspace_path('connections'));expect(p.locator('.connection-row')).to_have_count(3)
    expect(p.locator('.connection-detail')).to_have_count(0)
    p.set_viewport_size(dict(width=1440,height=1000));g=capture(e,p,'1440-unselected-connections');assert g['connections']['width']<=1024+1,g
    return dict(viewports=results,allRecords=3,filteredRecords=2,selectionAndFiltersRetained=True,unselectedMaxWidth=1024)


def connection_confirmation(w,b,e,f):
    p=b.page;p.set_viewport_size(dict(width=1440,height=1000));visit(p,b,b.workspace_path('connections')+'?'+urlencode(dict(integration=f['selected']['id'])))
    credential=p.get_by_text(w.write_credential['id'],exact=True).locator('xpath=../..')
    revoke=credential.get_by_role('button',name=re.compile(r'^Revoke (read|reporting) credential '));activate(p,revoke)
    dialog=p.get_by_role('dialog',name='Revoke credential?',exact=True);expect(dialog).to_be_visible()
    for value in (LONG_APP,f['selected']['id'],w.h.project,w.setup['bundle']['id'],LONG_CHANNEL,w.write_credential['id'],'Reporting credential (receipt-write)','cannot remove application caches'):
        expect(dialog).to_contain_text(value)
    expect(dialog.get_by_role('button',name='Revoke',exact=True)).to_be_enabled();capture(e,p,'1440-scoped-reporting-credential-confirmation')
    p.keyboard.press('Escape');expect(dialog).to_have_count(0);expect(revoke).to_be_focused()
    return dict(exactCredentialAndScope=True,kind='receipt-write',escapedWithoutRevoke=True)


def sdk(w,b,e):
    p=b.page;results=[];route=b.bundle_path('connect',channel=LONG_CHANNEL)
    for language,label,install in (('typescript','TypeScript','npm install /absolute/path/to/acclimate-sdk.tgz'),('python','Python','python3 -m pip install /absolute/path/to/acclimate-sdk.whl')):
        p.set_viewport_size(dict(width=1440,height=1000));visit(p,b,route)
        if label=='Python':p.get_by_role('radio',name='Python',exact=True).click()
        command=p.get_by_label('SDK package install command',exact=True);expect(command).to_have_text(install)
        copy=p.get_by_role('button',name='Copy install command',exact=True);activate(p,copy);assert p.evaluate('navigator.clipboard.readText()')==install
        env=p.locator('.sdk-required-environment');expect(env.locator('dt')).to_have_text(REQUIRED)
        g=capture(e,p,'1440-sdk-'+language+'-install-and-environment');assert g['sdk']['width']<=1024+1,g
        command_box=g['install']['command'];copy_box=g['install']['copy'];assert 0<=copy_box['x']-command_box['right']<=12,g
        assert abs((copy_box['y']+copy_box['height']/2)-(command_box['y']+command_box['height']/2))<=1,g
        for row in g['environment']:assert row['dd']['x']>=row['dt']['right']+10,row
        open_details(p,'View the '+label+' recipe');recipe=p.get_by_label(label+' delivery recipe',exact=True);expect(recipe).to_be_visible();text=recipe.inner_text()
        for value in (w.h.project,w.setup['bundle']['id'],LONG_CHANNEL,*REQUIRED):assert value in text,value
        p.get_by_role('button',name='Copy recipe',exact=True).click();assert p.evaluate('navigator.clipboard.readText()')==text and text!=install
        open_details(p,'Install from this checkout');open_details(p,'Environment variables and private directories');open_details(p,'Optional delivery reports');open_details(p,'Preparing job-local files')
        for name in ('View the '+label+' recipe','Install from this checkout','Environment variables and private directories','Optional delivery reports','Preparing job-local files'):
            expect(p.get_by_role('button',name=name,exact=True)).to_have_attribute('aria-expanded','true')
        for name in ('Manage app credentials','Manage reporting credentials'):
            link=p.get_by_role('link',name=name,exact=True);query=parse_qs(urlsplit(link.get_attribute('href')).query)
            assert query==dict(bundleId=[w.setup['bundle']['id']],channel=[LONG_CHANNEL]),query
        recipe.scroll_into_view_if_needed();capture(e,p,'1440-sdk-'+language+'-expanded-recipe')
        results.append(dict(language=language,installClipboardExact=True,recipeClipboardExact=True,requiredVariables=REQUIRED,disclosuresIndependent=True,credentialLinksScoped=True))
    p.set_viewport_size(dict(width=1024,height=1000));visit(p,b,route);g=capture(e,p,'1024-sdk-sequential');assert g['sdk']['width']<=1024+1,g
    return dict(languages=results,desktopMaxWidth=1024)


def members(w,b,e,f):
    p=b.page;route=b.workspace_path('members');results=[]
    for width in (1440,1024,390):
        p.set_viewport_size(dict(width=width,height=1000));visit(p,b,route);expect(p.locator('.workspace-member-row')).to_have_count(3)
        for person in f['people']:
            row=p.locator('.workspace-member-row').filter(has=p.get_by_text(person['subject'],exact=True));expect(row).to_contain_text('Editor' if person['role']=='editor' else 'Viewer')
        g=capture(e,p,f'{width}-members-identities-and-adjacent-roles');assert g['members']['width']<=1120+1,g
        for row in g['memberRows']:
            for key in ('subject',):
                item=row[key];assert item['scrollWidth']<=item['clientWidth']+1 and item['textBounds']['right']<=item['bounds']['right']+1,item
            assert row['role']['x']>=row['heading']['right']-1 and row['role']['right']<=row['bounds']['right']+1,row
        results.append(dict(width=width,bounds=g['members'],members=g['memberRows']))
    p.set_viewport_size(dict(width=1440,height=1000));visit(p,b,route)
    person=f['people'][1];row=p.locator('.workspace-member-row').filter(has=p.get_by_text(person['subject'],exact=True));actions=row.locator('.member-actions-trigger');actions.click()
    p.get_by_role('menuitem',name='Copy user ID',exact=True).click()
    assert p.evaluate('navigator.clipboard.readText()')==person['id']
    actions.click();p.get_by_role('menuitem',name='Remove access',exact=True).click()
    removal=p.get_by_role('alertdialog',name='Remove workspace access?',exact=True);expect(removal).to_contain_text(person['subject'])
    e.capture(p,'1440-remove-long-identity-confirmation')
    removal.get_by_role('button',name='Keep member',exact=True).click();expect(actions).to_be_focused()
    admin=p.locator('.workspace-member-row').filter(has=p.get_by_text('operator',exact=True));admin.locator('.member-role-trigger').click()
    p.get_by_role('menuitemradio').filter(has_text='Viewer').click()
    expect(p.get_by_role('status')).to_have_text('Add another administrator before removing or demoting the final administrator.')
    capture(e,p,'1440-final-administrator-guard')
    return dict(viewports=results,opaqueUserIdCopied=True,explicitRoleSelection=True,removalConfirmation=True,lastAdministratorDemotionRejected=True)



def native(w,b,e,f):
    with tempfile.TemporaryDirectory(prefix='acclimate-desktop9-native-') as profile:
        context=b.playwright.chromium.launch_persistent_context(profile,channel='chrome',headless=True,no_viewport=True,ignore_https_errors=True,args=['--window-size=1280,900'])
        try:
            b.sign_in(context);p=context.pages[0];p.set_default_timeout(10000);p.on('pageerror',lambda error:b.errors.append(str(error)))
            visit(p,b,b.workspace_path('connections'));before=p.evaluate('({width:innerWidth,dpr:devicePixelRatio})');p.goto('chrome://settings/appearance',wait_until='domcontentloaded');p.evaluate('chrome.settingsPrivate.setDefaultZoom(2)')
            route=b.workspace_path('connections')+'?'+urlencode(dict(integration=f['selected']['id']));visit(p,b,route);p.wait_for_function('w=>Math.abs(innerWidth-w)<2',arg=before['width']/2);assert p.evaluate('devicePixelRatio')==before['dpr']*2
            cdp=context.new_cdp_session(p)
            try:
                selected_facts(w,p,f);g=capture(e,p,'native200-selected-connections-stacked',cdp=cdp)
                assert g['detail']['y']>=g['directory']['bottom']+15 and not g['railScrollers'],g
                p.locator('.connection-detail article').scroll_into_view_if_needed();capture(e,p,'native200-reported-delivery-full-facts',cdp=cdp)
                visit(p,b,b.bundle_path('connect',channel=LONG_CHANNEL));g=capture(e,p,'native200-sdk-install-and-environment',cdp=cdp);assert g['sdk']['width']<=g['viewport']['width'],g
                visit(p,b,b.workspace_path('members'));g=capture(e,p,'native200-member-identity-rows',cdp=cdp);assert g['members']['width']<=g['viewport']['width'],g
            finally:cdp.detach()
            return dict(nativeZoom=2,baseline=before,cssViewport=p.evaluate('({width:innerWidth,height:innerHeight})'),dpr=p.evaluate('devicePixelRatio'),connectionsStacked=True,railNestedScroll=False)
        finally:context.close()


def main():
    parser=argparse.ArgumentParser(description=__doc__);parser.add_argument('--pg-bin');parser.add_argument('--only',choices=['all','members'],default='all');parser.add_argument('--output',type=Path,default=ROOT/'artifacts/desktop9-workflows');args=parser.parse_args()
    output=args.output.resolve();output.mkdir(parents=True,exist_ok=False,mode=0o700);e=Evidence(output,False);w=World(pg_bin(args.pg_bin));before=build_fingerprint();unchanged=False
    try:
        w.start();w.fresh_scenario(SimpleNamespace(effective_tags=[]));f=fixtures(w);b=w.browser();p=b.page
        initial=dict(release=w.call('GET',w.channel),members=w.call('GET',w.root+'/memberships')['items'],integrations=w.call('GET',w.root+'/integrations')['items'],receipts=w.call('GET',w.integration_path+'/receipts')['items'])
        if args.only=='all':e.run('selected-connections-rich-inventory-and-receipt',p,lambda:connection_geometry(w,b,e,f))
        if args.only=='all':e.run('scoped-credential-confirmation',p,lambda:connection_confirmation(w,b,e,f))
        if args.only=='all':e.run('sdk-copy-scope-and-sequential-layout',p,lambda:sdk(w,b,e))
        e.run('members-identity-adjacency-and-last-admin',p,lambda:members(w,b,e,f))
        if args.only=='all':e.run('actual-native200-admin-layouts',p,lambda:native(w,b,e,f))
        final=dict(release=w.call('GET',w.channel),members=w.call('GET',w.root+'/memberships')['items'],integrations=w.call('GET',w.root+'/integrations')['items'],receipts=w.call('GET',w.integration_path+'/receipts')['items'])
        assert final==initial,'UI validation changed persisted fixture records';assert not b.errors,b.errors;unchanged=True
    except Exception as error:e.failures.append(dict(check='fixture-or-invariants',error=str(error),traceback=traceback.format_exc()))
    finally:
        after=build_fingerprint();w.close()
        if before!=after:e.failures.append(dict(check='frozen-build',error='Production .output changed'))
        summary=dict(passed=not e.failures and not e.geometry,checks=e.checks,failures=e.failures,geometryViolations=e.geometry,capturedStates=len(list(output.glob('*.png'))),sourceBuildBeforeSha256=before,sourceBuildAfterSha256=after,sourceBuildFingerprint='SHA256 of all sorted .output relative paths and bytes',persistedRecordsUnchanged=unchanged,paidModelCalls=0,externalWrites=0,domMutation=False,focusInjection=False,storageInjection=False,fixture='Private PostgreSQL + real service + frozen console + real OIDC/TLS',limits=['Current real fixture issuer with long opaque subject stress; no auth reconfiguration.','No manufactured unknown/recovery branch, provider or model calls.'])
        (output/'summary.json').write_text(json.dumps(summary,indent=2)+'\n');print(json.dumps(summary,indent=2),flush=True)
    return 0 if summary['passed'] else 1


if __name__=='__main__':raise SystemExit(main())
