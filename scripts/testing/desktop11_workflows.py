#!/usr/bin/env python3
"""Private real-service v11 library, creation, changes and suggestion evidence.

No app edits/builds, paid models, external writes, interception, or injected DOM,
focus or storage. The existing localhost provider fixture exercises real proposal
processing. One explicit UI creation and one authorized UI suggestion are allowed.
"""
import argparse
from scripts.bdd.provider import proposal_prompt
import base64
import json
from pathlib import Path
import struct
import sys
import tempfile
import time
import traceback
from types import SimpleNamespace
from urllib.parse import parse_qs, urlsplit

ROOT=Path(__file__).resolve().parents[2];sys.path.insert(0,str(ROOT))
from playwright.sync_api import expect
from scripts.bdd.run import pg_bin
from scripts.bdd.world import World
from scripts.bdd.layout import inspect_layout, tab_to
from scripts.bdd.interactions import open_details
from scripts.testing.compact_console import FILES, visit
from scripts.testing.desktop_layouts import Evidence, build_fingerprint

LONG_PATH='memory/release-guidelines/production-retry-contracts/provider-specific-evidence/retained-context.md'
LONG_NAME='Production review instructions and reusable memory for background agent integrations'
CREATED_NAME='Desktop11 real initial publication'
CREATED_TEXT='# Desktop11 published instructions\nKeep the chosen compatibility target and channel explicit.\n'


def activate(p,target):
    tab_to(p,target);expect(target).to_be_focused();p.keyboard.press('Enter')


def capture(e,p,name,*,coarse=False):
    p.evaluate('''async()=>{await document.fonts.ready;await Promise.all(document.getAnimations().filter(a=>a.playState==='running'&&Number.isFinite(a.effect.getComputedTiming().endTime)).map(a=>a.finished.catch(()=>{})));await new Promise(requestAnimationFrame);await new Promise(requestAnimationFrame)}''');p.wait_for_timeout(500)
    metric=inspect_layout(p,coarse=coarse)
    metric['focusedWorkflows']=p.evaluate('''()=>{
      const visible=e=>!!e.getClientRects().length&&getComputedStyle(e).visibility!=='hidden';
      const box=e=>{if(!e||!visible(e))return null;const r=e.getBoundingClientRect();return {x:r.x,y:r.y,width:r.width,height:r.height,right:r.right,bottom:r.bottom}};
      const target=e=>['checkbox','radio','switch'].includes(e.getAttribute('role'))?e.closest('label')||e:e;
      const main=document.querySelector('main');
      return {dpr:devicePixelRatio,library:box(document.querySelector('.bundle-library')),creation:box(document.querySelector('.bundle-create-form')),changes:box(document.querySelector('.change-lists')),proposal:box(document.querySelector('.proposal-page')),
        controls:[...document.querySelectorAll('button,a[href],input:not([type=hidden]),select,textarea,[role=menuitem]')].filter(visible).map(e=>({text:(e.getAttribute('aria-label')||e.textContent).trim().slice(0,120),role:e.getAttribute('role'),tag:e.tagName,inline:e.tagName==='A'&&!e.hasAttribute('data-slot')&&!e.closest('nav'),bounds:box(target(e))})),
        editLabels:[...document.querySelectorAll('.proposal-workspace fieldset label')].filter(visible).map(e=>{const range=document.createRange();range.selectNodeContents(e);const r=range.getBoundingClientRect();return {text:e.textContent.trim(),bounds:box(e),textRight:r.right,scrollWidth:e.scrollWidth,clientWidth:e.clientWidth}}),
        detailFields:[...document.querySelectorAll('.change-detail-fields > div')].filter(visible).map(e=>({term:e.querySelector('dt')?.textContent,dt:box(e.querySelector('dt')),dd:box(e.querySelector('dd'))})),
        focus:{tag:document.activeElement.tagName,role:document.activeElement.getAttribute('role'),text:(document.activeElement.getAttribute('aria-label')||document.activeElement.textContent).trim().slice(0,120)},
        dialogs:[...document.querySelectorAll('[role=dialog],[role=alertdialog]')].filter(visible).map(e=>({bounds:box(e),title:e.querySelector('h2')?.textContent})),h1:[...main.querySelectorAll('h1')].filter(visible).map(e=>e.textContent)};
    }''')
    assert metric['width']<=metric['viewport']+1,'Page overflow'
    assert not metric['smallText'] and not metric['smallReadingText'],dict(smallText=metric['smallText'],smallReadingText=metric['smallReadingText'])
    assert metric['focusedWorkflows']['h1'],'Missing visible h1'
    if coarse:assert metric['pointerCoarse'],'Coarse capture requires real coarse context'
    for row in metric['focusedWorkflows']['controls']:
        if row['inline'] or (not coarse and row['role'] in ('checkbox','radio','switch')):continue
        minimum=44 if coarse else 32
        assert row['bounds']['height']>=minimum-.5,dict(target=row,minimum=minimum)
    for row in metric['focusedWorkflows']['editLabels']:
        assert row['scrollWidth']<=row['clientWidth']+1 and row['textRight']<=row['bounds']['right']+1,row
    cdp=p.context.new_cdp_session(p)
    try:bitmap=base64.b64decode(cdp.send('Page.captureScreenshot',dict(format='png',fromSurface=True))['data'])
    finally:cdp.detach()
    (e.output/(name+'.png')).write_bytes(bitmap);after=inspect_layout(p,coarse=coarse);keys=('viewport','viewportHeight','width','scrollY','visualViewportOffsetTop')
    assert {k:metric[k] for k in keys}=={k:after[k] for k in keys},'Screenshot changed route geometry'
    pixels=list(struct.unpack('>II',bitmap[16:24]));assert pixels[0]==round(metric['viewport']*metric['focusedWorkflows']['dpr']),pixels
    metric['capture']=dict(method='CDP Page.captureScreenshot',pixels=pixels,before={k:metric[k] for k in keys},after={k:after[k] for k in keys})
    (e.output/(name+'.json')).write_text(json.dumps(metric,indent=2)+'\n');return metric['focusedWorkflows']


def terminal(w,proposal):
    deadline=time.monotonic()+15
    while time.monotonic()<deadline:
        value=w.call('GET',w.bundle+'/proposals/'+proposal['id'])
        if value['status'] in ('succeeded','failed'):return value
        time.sleep(.05)
    raise AssertionError('Local provider proposal did not settle')


def fixtures(w):
    w.sign_in('admin','operator');w.browser_actor='admin';w.create_workspace();w.publish_initial('',files=FILES)
    assert urlsplit(w.provider.url).hostname=='127.0.0.1','Only localhost provider fixture is allowed'
    preview=w.call('POST',w.bundle+'/versions',dict(parentVersionId=w.original['version']['id'],payload=dict(schemaVersion=1,files=[dict(f,text=f['text']+'\nPreview scope.\n' if f['path']=='AGENTS.md' else f['text']) for f in FILES])))
    w.call('POST',w.bundle+'/channels/preview/promotions',dict(versionId=preview['id'],expectedRevision='0',unevaluatedReason='Explicit alternate-channel fixture.'))
    beta=w.call('POST',w.root+'/bundle-setups',dict(name='Desktop11 library beta',origin='created',channel='stable',payload=dict(schemaVersion=1,files=FILES),reason='Explicit library fixture.'))
    long=w.call('POST',w.root+'/bundle-setups',dict(name=LONG_NAME,origin='created',channel='stable',payload=dict(schemaVersion=1,files=FILES+[dict(path=LONG_PATH,kind='memory',text='# Approved long-path reusable context\nRetain the full path.\n')]),reason='Explicit long path fixture.'))
    empty=w.call('POST',w.root+'/bundles',dict(name='Desktop11 without channels'))
    drafts=[]
    for index in range(22):drafts.append(w.call('POST',w.channel+'/drafts',dict(baseVersionId=w.original['version']['id'],baseRevision=w.original['revision'],payload=dict(schemaVersion=1,files=FILES))))
    ordered=sorted(drafts,key=lambda item:item['id'],reverse=True);closed=[]
    for draft in ordered[:20]:closed.append(w.call('POST',w.channel+'/drafts/'+draft['id']+'/discard',dict(expectedGeneration=draft['generation'])))
    preview_draft=w.call('POST',w.bundle+'/channels/preview/drafts',dict(baseVersionId=preview['id'],baseRevision='1',payload=dict(schemaVersion=1,files=FILES)))
    proposals=[]
    for parent,mode in ((w.original['version']['id'],'valid'),(preview['id'],'valid'),(w.original['version']['id'],'outside-paths')):
        w.provider.mode=mode;proposal=w.call('POST',w.bundle+'/proposals',dict(parentVersionId=parent,allowedPaths=['AGENTS.md'],hypothesis='Review the scoped retry contract.',evidence=['Explicit authorized synthetic fixture evidence.']));proposals.append(terminal(w,proposal))
    w.provider.mode='valid';assert [p['status'] for p in proposals]==['succeeded','succeeded','failed'],proposals
    w.sign_in('viewer','desktop11-read-only-person');w.call('PUT',w.root+'/memberships/'+w.sessions['viewer']['userId'],dict(role='viewer'),actor='admin')
    return dict(beta=beta,long=long,empty=empty,preview=preview,previewDraft=preview_draft,openDrafts=ordered[20:],closedDrafts=closed,proposals=proposals,library={w.setup['bundle']['id']:('BDD bundle',['stable','preview']),beta['bundle']['id']:(beta['bundle']['name'],['stable']),long['bundle']['id']:(LONG_NAME,['stable']),empty['id']:(empty['name'],[])})


def snapshot(w,f):
    return dict(stable=w.call('GET',w.channel),preview=w.call('GET',w.bundle+'/channels/preview'),stablePromotions=w.call('GET',w.channel+'/promotions')['items'],previewPromotions=w.call('GET',w.bundle+'/channels/preview/promotions')['items'],drafts=w.call('GET',w.channel+'/drafts?status=all&limit=100')['items'],previewDrafts=w.call('GET',w.bundle+'/channels/preview/drafts?status=all&limit=100')['items'],bundles={item['id']:item for item in w.call('GET',w.root+'/bundles?limit=100')['items']})


def library(w,b,e,f):
    p=b.page;results=[]
    for width in (1440,1920,1024):
        p.set_viewport_size(dict(width=width,height=1000));visit(p,b,b.workspace_path());rows=p.locator('.bundle-library-row');expect(rows).to_have_count(4);expect(p.get_by_label('Find a bundle',exact=True)).to_be_visible()
        for bundle_id,(name,channels) in f['library'].items():
            row=rows.filter(has=p.get_by_role('heading',name=name,exact=True));expect(row).to_have_count(1)
            for channel in channels:expect(row.get_by_role('link',name=channel,exact=True)).to_have_attribute('href',b.bundle_path('content',bundle_id=bundle_id,channel=channel))
            if not channels:expect(row.get_by_role('link')).to_have_count(0);expect(row).to_contain_text('No published channels')
        g=capture(e,p,f'{width}-library-four-real-bundles');assert g['library']['width']<=1024+1,g;results.append(dict(width=width,bounds=g['library']))
    p.get_by_label('Find a bundle',exact=True).fill('without channels');expect(p.locator('.bundle-library-row')).to_have_count(1);capture(e,p,'1024-library-filtered-no-channel')
    p.get_by_label('Find a bundle',exact=True).fill('desktop11-no-match');expect(p.locator('.bundle-library-row')).to_have_count(0);expect(p.get_by_text('No bundles match “desktop11-no-match”.',exact=True)).to_be_visible();p.get_by_label('Find a bundle',exact=True).fill('')
    return dict(viewports=results,realBundles=4,queryAndNoMatch=True,exactChannelLinks=True,noChannelHasNoOpenLink=True)


def creation(w,b,e,f):
    p=b.page;p.set_viewport_size(dict(width=1440,height=1000));visit(p,b,b.workspace_path());p.get_by_role('button',name='New bundle',exact=True).click();form=p.get_by_role('region',name='Create a bundle',exact=True)
    expect(form).to_be_visible();expect(p.get_by_role('dialog')).to_have_count(0);form.get_by_label('Bundle name',exact=True).fill('Desktop11 browser-only name');form.get_by_label('Instructions',exact=True).fill('# Browser-only instructions\nPreserve these while cancelling.\n');capture(e,p,'1440-create-write-instructions')
    form.get_by_role('button',name='Cancel',exact=True).click();guard=p.get_by_role('alertdialog',name='Leave current edits?',exact=True);expect(guard).to_be_visible();capture(e,p,'1440-create-dirty-cancel-guard');p.keyboard.press('Escape');expect(guard).to_have_count(0);expect(form.get_by_label('Bundle name',exact=True)).to_have_value('Desktop11 browser-only name')
    form.get_by_role('radio',name='Import files',exact=True).click();form.get_by_label('Individual files',exact=True).set_input_files(dict(name='AGENTS.md',mimeType='text/markdown',buffer=b'# Native imported instructions\nReview this file before import.\n'))
    expect(form.get_by_role('heading',name='Import preview · generic',exact=True)).to_be_visible();publish=form.get_by_role('button',name='Import and publish',exact=True);expect(publish).to_be_disabled();form.get_by_role('button',name='AGENTS.md · instruction',exact=True).click()
    confirm=form.get_by_role('checkbox',name='Confirm these entries for import',exact=True);tab_to(p,confirm);p.keyboard.press('Space');expect(confirm).to_be_checked();expect(publish).to_be_enabled();capture(e,p,'1440-create-files-preview-confirmed')
    form.get_by_role('radio',name='Import JSON',exact=True).click();form.get_by_label('Bundle JSON',exact=True).fill('{invalid');expect(form.get_by_role('alert')).to_have_text('Enter valid bundle JSON.');expect(publish).to_be_disabled()
    form.get_by_label('Bundle JSON',exact=True).fill(json.dumps(dict(schemaVersion=1,files=FILES[:1]+FILES[-1:])));expect(publish).to_be_disabled();form.get_by_role('button',name='AGENTS.md · instruction',exact=True).click();form.get_by_role('button',name='memory/team.md · memory',exact=True).click();confirm.check();expect(publish).to_be_enabled();capture(e,p,'1440-create-json-preview-independent-confirmed')
    expect(form.get_by_role('radiogroup',name='Bundle source').get_by_role('radio')).to_have_count(3)
    form.get_by_role('radio',name='Write instructions',exact=True).click();expect(form.get_by_label('Instructions',exact=True)).to_contain_text('Browser-only instructions')
    form.get_by_role('button',name='Cancel',exact=True).click();expect(guard).to_be_visible();guard.get_by_role('button',name='Leave editor',exact=True).click();expect(form).to_have_count(0)
    assert len(w.call('GET',w.root+'/bundles')['items'])==4,'Source-mode review published unexpectedly'
    p.get_by_role('button',name='New bundle',exact=True).click();expect(form.get_by_label('Bundle name',exact=True)).to_have_value('');expect(form.get_by_label('Instructions',exact=True)).to_have_value('')
    form.get_by_label('Bundle name',exact=True).fill(CREATED_NAME);form.get_by_label('Instructions',exact=True).fill(CREATED_TEXT);open_details(p,'Publishing settings');form.get_by_label('Initial channel',exact=True).fill('review');form.get_by_label('Compatibility target',exact=True).select_option('codex')
    summary=form.get_by_label('Initial publication summary',exact=True);expect(summary).to_contain_text('Publishes 1 entry to review.');expect(summary).to_contain_text('Target: codex, fixed for this bundle.');expect(summary).to_contain_text('No evaluation is run.');capture(e,p,'1440-initial-publication-summary-immutable-target')
    form.get_by_role('button',name='Create and publish',exact=True).click();expect(p.get_by_test_id('entry-content')).to_have_text(CREATED_TEXT);expect(p.get_by_role('heading',name=CREATED_NAME,exact=True)).to_be_visible()
    bundles=w.call('GET',w.root+'/bundles')['items'];created=[item for item in bundles if item['name']==CREATED_NAME];assert len(created)==1 and created[0]['compatibilityTarget']=='codex',created;f['createdBundle']=created[0]
    base=w.root+'/bundles/'+created[0]['id'];resolution=w.call('GET',base+'/channels/review');assert resolution['revision']=='1';payload=w.call('GET',base+'/versions/'+resolution['version']['id']+'/payload');assert payload['files']==[dict(path='AGENTS.md',kind='instruction',text=CREATED_TEXT)],payload
    assert len(w.call('GET',base+'/channels/review/promotions')['items'])==1;capture(e,p,'1440-real-created-bundle-fixed-codex-target')
    return dict(sourceModes=['Write instructions','Import files','Import JSON'],inline=True,dirtyCancelPreservedThenDiscarded=True,filesAndJsonRequireConfirmation=True,independentImportPreviews=True,exactlyOneUiBundleCreated=created[0]['id'],fixedTarget='codex',initialChannel='review',initialRevision='1')


def changes(w,b,e,f):
    p=b.page;p.set_viewport_size(dict(width=1440,height=1000));visit(p,b,b.bundle_path('changes'))
    drafting=p.get_by_role('region',name='Drafting',exact=True)
    drafts=drafting.locator('[data-change-kind=draft]');suggestions=drafting.locator('[data-change-kind=suggestion]')
    include=p.get_by_role('button',name='Include closed drafts',exact=True)
    more=drafting.get_by_role('button',name='Load more drafts',exact=True)
    expect(more).to_be_visible();expect(drafts).to_have_count(0);capture(e,p,'1440-changes-closed-first-page-has-older-open-cursor')
    include.click();expect(drafts).to_have_count(20);expect(include).to_have_attribute('aria-pressed','true');capture(e,p,'1440-changes-twenty-real-discarded-rows')
    more.click();expect(drafts).to_have_count(22);include.click();expect(drafts).to_have_count(2)
    for draft in f['openDrafts']:
        action=drafts.get_by_role('link',name='Open Draft '+draft['id'][:8],exact=True)
        expect(action).to_have_attribute('href',b.bundle_path('changes',draft=draft['id']))
        drafts.get_by_role('button',name='Draft details for '+draft['id'],exact=True).click()
        dialog=p.get_by_role('dialog')
        for value in (draft['id'],draft['baseVersionId'],draft['snapshotVersion']['id']):expect(dialog).to_contain_text(value)
        p.keyboard.press('Escape')
    expect(drafts.get_by_role('link',name='Open Draft '+f['previewDraft']['id'][:8],exact=True)).to_have_count(0)
    expect(suggestions).to_have_count(3)
    for proposal in f['proposals']:
        suggestions.get_by_role('button',name='Suggestion details for '+proposal['id'],exact=True).click()
        dialog=p.get_by_role('dialog')
        for value in (proposal['id'],proposal['parentVersionId'],proposal['status']):expect(dialog).to_contain_text(value)
        if proposal.get('error'):expect(dialog).to_contain_text(proposal['error'])
        p.keyboard.press('Escape')
    for width in (1440,1920,1024):
        p.set_viewport_size(dict(width=width,height=1000));capture(e,p,f'{width}-changes-pipeline')
        expect(p.get_by_role('region',name='Change pipeline',exact=True)).to_be_visible()
    include.click();expect(drafts).to_have_count(22);include.click();expect(drafts).to_have_count(2)
    visit(p,b,b.bundle_path('changes',channel='preview'));expect(drafts).to_have_count(1);expect(drafts).to_contain_text('Draft '+f['previewDraft']['id'][:8]);expect(suggestions).to_have_count(3);capture(e,p,'1024-preview-drafts-scope-suggestions-all-channels')
    return dict(closedFirstPage=20,olderOpenDrafts=2,allDrafts=22,paginationReal=True,toggleBothWays=True,draftChannelScope=True,suggestionsAllChannels=True,terminalSuggestionStatuses=[proposal['status'] for proposal in f['proposals']],naturalRejectedWritePathError=True,fullIdsAndIndependentDetails=True)


def proposal_form(w,b,e,p,route,prefix):
    visit(p,b,route);form=p.locator('.proposal-workspace');expect(form).to_be_visible();open_details(p,'Source release details');expect(form).to_contain_text('Editable paths restrict changes, not reading.');expect(form).to_contain_text('whole parent bundle, including reusable memory')
    request=form.get_by_role('button',name='Request suggestion',exact=True);expect(request).to_be_disabled();form.get_by_label('Hypothesis',exact=True).fill('Review retry identity while preserving the selected write scope.');form.get_by_label('Authorized evidence (one item per line)',exact=True).fill('Explicit authorized synthetic acceptance evidence.')
    expect(request).to_be_disabled();consent=form.get_by_role('checkbox',name='Authorize bundle disclosure',exact=True);consent.check();expect(request).to_be_disabled()
    form.get_by_role('checkbox',name='AGENTS.md',exact=True).check();expect(request).to_be_enabled();consent.uncheck();expect(request).to_be_disabled();consent.check();expect(request).to_be_enabled()
    g=capture(e,p,prefix+'-suggest-whole-bundle-consent-and-write-paths');assert g['proposal'] and g['proposal']['width']<=768+1,g
    return form


def suggestions(w,b,e,f):
    p=b.page;p.set_viewport_size(dict(width=1440,height=1000));form=proposal_form(w,b,e,p,b.bundle_path('changes',proposal='new'),'1440-normal')
    for file in FILES:
        box=form.get_by_role('checkbox',name=file['path'],exact=True)
        if file['path']=='AGENTS.md':box.check()
        else:box.uncheck()
    expect(form.get_by_role('button',name='Request suggestion',exact=True)).to_be_enabled();before={item['id'] for item in w.call('GET',w.bundle+'/proposals')['items']};activate(p,form.get_by_role('button',name='Request suggestion',exact=True))
    p.wait_for_function("new URL(location.href).searchParams.get('proposal') && new URL(location.href).searchParams.get('proposal')!=='new'")
    submitted_id=parse_qs(urlsplit(p.url).query)['proposal'][0];assert submitted_id not in before
    submitted=terminal(w,w.call('GET',w.bundle+'/proposals/'+submitted_id));assert submitted['status']=='succeeded',submitted;f['uiProposal']=submitted
    visit(p,b,b.bundle_path('changes',proposal=submitted_id));expect(p.get_by_role('region',name='Saved change review',exact=True)).to_be_visible();capture(e,p,'1440-real-local-provider-suggestion-result')
    prompt=proposal_prompt(w.provider.requests[-1]);assert prompt['request']['allowedPaths']==['AGENTS.md'];assert {entry['path'] for entry in prompt['parent']['files']}=={entry['path'] for entry in FILES};assert any(entry['path']=='memory/team.md' for entry in prompt['parent']['files'])
    long_route=b.bundle_path('changes',bundle_id=f['long']['bundle']['id'],proposal='new')
    for width in (1440,1024):
        p.set_viewport_size(dict(width=width,height=1000));form=proposal_form(w,b,e,p,long_route,str(width)+'-long-path');expect(form.get_by_role('checkbox',name=LONG_PATH,exact=True)).to_be_visible();expect(form).to_contain_text(f['long']['version']['id'])
    context=b.browser.new_context(ignore_https_errors=True,viewport=dict(width=1024,height=900))
    try:
        b.sign_in(context,'desktop11-read-only-person');page=context.new_page();page.set_default_timeout(10000);visit(page,b,long_route);expect(page.get_by_role('alert')).to_have_text('You have read-only access. Open an existing suggestion to inspect it.');expect(page.get_by_role('button',name='Request suggestion',exact=True)).to_have_count(0);capture(e,page,'1024-read-only-suggestion-route-guard')
    finally:context.close()
    return dict(uiProposalId=submitted['id'],status=submitted['status'],writePaths=['AGENTS.md'],providerReceivedWholeParentPaths=[file['path'] for file in FILES],consentRequired=True,longPath=LONG_PATH,readOnlyRouteBlocked=True,paidModels=0)


def native(w,b,e,f):
    with tempfile.TemporaryDirectory(prefix='acclimate-desktop11-native-') as profile:
        context=b.playwright.chromium.launch_persistent_context(profile,channel='chrome',headless=True,no_viewport=True,ignore_https_errors=True,args=['--window-size=1280,900'])
        try:
            b.sign_in(context);p=context.pages[0];p.set_default_timeout(10000);p.on('pageerror',lambda error:b.errors.append(str(error)));visit(p,b,b.workspace_path());before=p.evaluate('({width:innerWidth,dpr:devicePixelRatio})');p.goto('chrome://settings/appearance',wait_until='domcontentloaded');p.evaluate('chrome.settingsPrivate.setDefaultZoom(2)');visit(p,b,b.workspace_path());p.wait_for_function('w=>Math.abs(innerWidth-w)<2',arg=before['width']/2);assert p.evaluate('devicePixelRatio')==before['dpr']*2
            p.get_by_role('button',name='New bundle',exact=True).click();form=p.get_by_role('region',name='Create a bundle',exact=True);form.get_by_label('Bundle name',exact=True).fill('Native browser-only fixture');form.get_by_label('Instructions',exact=True).fill('# Native creation draft\n');capture(e,p,'native200-inline-creation-source-modes');form.get_by_role('button',name='Cancel',exact=True).click();guard=p.get_by_role('alertdialog');p.keyboard.press('Escape');expect(guard).to_have_count(0);expect(form.get_by_label('Bundle name',exact=True)).to_have_value('Native browser-only fixture');form.get_by_role('button',name='Cancel',exact=True).click();guard.get_by_role('button',name='Leave editor',exact=True).click()
            proposal_form(w,b,e,p,b.bundle_path('changes',bundle_id=f['long']['bundle']['id'],proposal='new'),'native200-long-path')
            visit(p,b,b.bundle_path('changes'));drafts=p.get_by_role('region',name='Drafting',exact=True);expect(drafts.get_by_role('button',name='Load more drafts',exact=True)).to_be_visible();expect(drafts.locator('[data-change-kind=draft]')).to_have_count(0);capture(e,p,'native200-closed-first-page-older-open-cursor')
            return dict(nativeZoom=2,baseline=before,dpr=p.evaluate('devicePixelRatio'),cssViewport=p.evaluate('({width:innerWidth,height:innerHeight})'),inlineCreation=True,dirtyCancelRetains=True,longPathAndConsent=True,realClosedPagination=True)
        finally:context.close()


def coarse_proposal_only(args,output):
    e=Evidence(output,False);w=World(pg_bin(args.pg_bin));before=build_fingerprint();initial=final=None;labels={};unchanged=False;b=None
    def facts():
        resolution=w.call('GET',w.channel);version=resolution['version']
        return dict(resolution=resolution,payload=w.call('GET',w.bundle+'/versions/'+version['id']+'/payload'),promotions=w.call('GET',w.channel+'/promotions')['items'],proposals=w.call('GET',w.bundle+'/proposals')['items'],versionCount=int(w.h.sql("SELECT count(*) FROM versions WHERE project_id='"+w.h.project+"'")))
    try:
        assert before==args.expected_build_hash,'Frozen build differs from GO';w.start();w.fresh_scenario(SimpleNamespace(effective_tags=[]));w.publish_initial('',files=FILES[:1]+[dict(path=LONG_PATH,kind='memory',text='# Private coarse fixture\nApproved reusable context.\n')]);b=w.browser();initial=facts()
        context=b.browser.new_context(ignore_https_errors=True,viewport=dict(width=390,height=844),has_touch=True,storage_state=b.context.storage_state())
        try:
            p=context.new_page();p.set_default_timeout(10000);p.on('pageerror',lambda error:b.errors.append(str(error)));visit(p,b,b.bundle_path('changes',proposal='new'));form=p.locator('.proposal-workspace')
            path=form.get_by_role('checkbox',name=LONG_PATH,exact=True);tab_to(p,path);expect(path).to_be_focused();p.keyboard.press('Space');expect(path).to_be_checked();capture(e,p,'390-native-keyboard-long-path-checked',coarse=True);p.keyboard.press('Space');expect(path).not_to_be_checked();expect(path).to_be_focused()
            consent=form.get_by_role('checkbox',name='Authorize bundle disclosure',exact=True);tab_to(p,consent);expect(consent).to_be_focused();p.keyboard.press('Space');expect(consent).to_be_checked();capture(e,p,'390-native-keyboard-whole-bundle-consent-checked',coarse=True);p.keyboard.press('Space');expect(consent).not_to_be_checked();expect(consent).to_be_focused();capture(e,p,'390-native-keyboard-consent-unchecked',coarse=True)
            for name,control in (('longPath',path),('wholeBundleConsent',consent)):
                label=control.locator('xpath=ancestor::label[1]');value=label.evaluate('''el=>{const r=el.getBoundingClientRect(),range=document.createRange();range.selectNodeContents(el);const text=range.getBoundingClientRect();return {text:el.textContent.trim(),x:r.x,width:r.width,height:r.height,right:r.right,textRight:text.right,scrollWidth:el.scrollWidth,clientWidth:el.clientWidth,lineHeight:parseFloat(getComputedStyle(el).lineHeight)}}''')
                assert value['width']>=44 and value['height']>=44 and value['height']>value['lineHeight']*1.5,value
                assert value['x']>=0 and value['right']<=390 and value['textRight']<=value['right']+1 and value['scrollWidth']<=value['clientWidth']+1,value;labels[name]=value
            expect(form.get_by_role('button',name='Request suggestion',exact=True)).to_be_disabled();assert p.evaluate("matchMedia('(pointer: coarse)').matches")
        finally:context.close()
        final=facts();assert initial==final,'Checkbox input changed persisted proposal/version/promotion state';assert not b.errors,b.errors;unchanged=True
        e.checks.append(dict(check='390-coarse-native-keyboard-path-and-whole-bundle-consent',passed=True,details=dict(pathSpaceCheckedAndUnchecked=True,consentSpaceCheckedAndUnchecked=True,nativeTabFocusVerified=True,wrappingLabels=labels,noSubmission=True)))
    except Exception as error:e.failures.append(dict(check='coarse-proposal-or-invariants',error=str(error),traceback=traceback.format_exc()))
    finally:
        after=build_fingerprint();w.close()
        if before!=after:e.failures.append(dict(check='frozen-build',error='Production .output changed'))
        def brief(value):
            return None if value is None else dict(versionCount=value['versionCount'],versionId=value['resolution']['version']['id'],digest=value['resolution']['version']['digest'],promotionIds=[item['id'] for item in value['promotions']],proposalIds=[item['id'] for item in value['proposals']])
        summary=dict(passed=not e.failures,checks=e.checks,failures=e.failures,capturedStates=len(list(output.glob('*.png'))),sourceBuildBeforeSha256=before,sourceBuildAfterSha256=after,sourceBuildFingerprint='SHA256 of all sorted .output relative paths and bytes',actualViewport=dict(width=390,height=844,coarse=True),wrappingLabels=labels,persistedFactsBefore=brief(initial),persistedFactsAfter=brief(final),proposalsVersionsAndPromotionsUnchanged=unchanged,providerConfigured=False,submissions=0,paidModelCalls=0,externalWrites=0,domMutation=False,focusInjection=False,storageInjection=False,limits=['Private real PostgreSQL/service/OIDC/TLS; no provider configured and no submission.','Version count uses read-only disposable PostgreSQL query; parent payload, resolution, promotions and proposals use real service reads.'])
        (output/'summary.json').write_text(json.dumps(summary,indent=2)+'\n');print(json.dumps(summary,indent=2),flush=True)
    return 0 if summary['passed'] else 1


def main():
    parser=argparse.ArgumentParser(description=__doc__);parser.add_argument('--pg-bin');parser.add_argument('--expected-build-hash',required=True);parser.add_argument('--coarse-proposal-only',action='store_true');parser.add_argument('--output',type=Path,default=ROOT/'artifacts/desktop11-workflows');args=parser.parse_args();output=args.output.resolve();output.mkdir(parents=True,exist_ok=False,mode=0o700)
    if args.coarse_proposal_only:return coarse_proposal_only(args,output)
    e=Evidence(output,False);w=World(pg_bin(args.pg_bin));before=build_fingerprint();unchanged=False
    try:
        assert before==args.expected_build_hash,'Frozen build differs from GO';w.start();w.fresh_scenario(SimpleNamespace(effective_tags=['provider_fixture']));f=fixtures(w);b=w.browser();p=b.page;initial=snapshot(w,f)
        e.run('library-four-real-bundles-query-and-channel-links',p,lambda:library(w,b,e,f))
        e.run('inline-creation-three-sources-cancel-and-initial-publication',p,lambda:creation(w,b,e,f))
        e.run('changes-real-closed-pagination-and-all-channel-suggestions',p,lambda:changes(w,b,e,f))
        e.run('suggestion-consent-write-scope-long-path-and-readonly',p,lambda:suggestions(w,b,e,f))
        e.run('actual-native200-open-creation-changes-and-suggest',p,lambda:native(w,b,e,f))
        final=snapshot(w,f)
        for key in initial:
            if key=='bundles':assert all(final[key].get(id)==item for id,item in initial[key].items()),'Existing bundle changed'
            else:assert final[key]==initial[key],f'Persisted fixture {key} changed'
        assert len(final['bundles'])==5 and 'createdBundle' in f,'Expected one UI-created bundle'
        assert len(w.call('GET',w.bundle+'/proposals')['items'])==4 and 'uiProposal' in f,'Expected one UI suggestion'
        assert not b.errors,b.errors;unchanged=True
    except Exception as error:e.failures.append(dict(check='fixture-or-invariants',error=str(error),traceback=traceback.format_exc()))
    finally:
        after=build_fingerprint();provider_requests=len(w.provider.requests) if getattr(w,'provider',None) else 0;w.close()
        if before!=after:e.failures.append(dict(check='frozen-build',error='Production .output changed'))
        summary=dict(passed=not e.failures and not e.geometry,checks=e.checks,failures=e.failures,geometryViolations=e.geometry,capturedStates=len(list(output.glob('*.png'))),sourceBuildBeforeSha256=before,sourceBuildAfterSha256=after,sourceBuildFingerprint='SHA256 of all sorted .output relative paths and bytes',existingContentPromotionsAndDraftsUnchanged=unchanged,localSyntheticProviderRequests=provider_requests,paidModelCalls=0,externalWrites=0,domMutation=False,focusInjection=False,storageInjection=False,allowedWrites='Private fixture setup, one explicit UI bundle publication, and one consented UI suggestion to the localhost synthetic provider.',limits=['No queued/running state is artificially held; terminal success and naturally rejected out-of-scope edit are real fixture outcomes.','Current real OIDC issuer and private TLS; no external provider/model service qualification.'])
        (output/'summary.json').write_text(json.dumps(summary,indent=2)+'\n');print(json.dumps(summary,indent=2),flush=True)
    return 0 if summary['passed'] else 1


if __name__=='__main__':raise SystemExit(main())
