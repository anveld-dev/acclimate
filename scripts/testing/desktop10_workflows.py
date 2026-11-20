#!/usr/bin/env python3
"""Focused v10 published-search, release, and evaluation browser workflows.

Use an already frozen production build with private PostgreSQL, real service,
OIDC and TLS. No builds, providers, models, interception, DOM/storage/focus
injection, or external writes. One explicitly reviewed app-owned evaluation
request is created; synthetic bound evidence records no model execution.
"""
import re
import argparse
from datetime import datetime
import json
from pathlib import Path
import sys
import tempfile
import traceback
from types import SimpleNamespace
from urllib.parse import parse_qs, urlsplit

ROOT=Path(__file__).resolve().parents[2]
sys.path.insert(0,str(ROOT))
from playwright.sync_api import expect
from scripts.bdd.run import pg_bin
from scripts.bdd.world import World
from scripts.bdd.layout import inspect_layout, tab_to
from scripts.bdd.interactions import open_details, open_files
from scripts.testing.compact_console import FILES, visit, server_function_action
from scripts.testing.desktop_layouts import Evidence, build_fingerprint
from scripts.test_console_native_zoom import capture_native


def activate(p,target):
    tab_to(p,target);expect(target).to_be_focused();p.keyboard.press('Enter')


def capture(e,p,name,*,cdp=None,coarse=False):
    if cdp:
        p.evaluate('''async()=>{await document.fonts.ready;await Promise.all(document.getAnimations().filter(a=>a.playState==='running'&&Number.isFinite(a.effect.getComputedTiming().endTime)).map(a=>a.finished.catch(()=>{})));await new Promise(requestAnimationFrame);await new Promise(requestAnimationFrame)}''');p.wait_for_timeout(500)
        metric=capture_native(p,cdp,e.output,name);after=inspect_layout(p);keys=('viewport','viewportHeight','width','scrollY','visualViewportOffsetTop')
        assert {k:metric[k] for k in keys}=={k:after[k] for k in keys},'Native screenshot changed route geometry'
        metric['capture']=dict(method='CDP Page.captureScreenshot',dpr=p.evaluate('devicePixelRatio'),before={k:metric[k] for k in keys},after={k:after[k] for k in keys})
    else:
        metric=e.capture(p,name,coarse=coarse);assert not metric['violations'],metric['violations']
    metric['workflows']=p.evaluate('''()=>{
      const box=e=>{if(!e||!e.getClientRects().length)return null;const r=e.getBoundingClientRect();return {x:r.x,y:r.y,width:r.width,height:r.height,right:r.right,bottom:r.bottom}};
      const visible=e=>e.getClientRects().length&&getComputedStyle(e).visibility!=='hidden';
      return {viewport:{width:innerWidth,height:innerHeight,dpr:devicePixelRatio},
        search:{input:box(document.querySelector('#file-search')),submit:box(document.querySelector('.file-search-submit')),rail:box(document.querySelector('.file-navigator')),group:box(document.querySelector('#file-search')?.closest('[data-slot=input-group]'))},
        releases:{history:box(document.querySelector('.release-history')),parent:box(document.querySelector('.release-history')?.parentElement),rows:[...document.querySelectorAll('.release-row')].map(e=>({bounds:box(e),summary:box(e.querySelector('.release-summary')),actions:box(e.querySelector('.release-actions')),metadata:[...e.querySelectorAll('dl > div')].map(row=>({term:row.querySelector('dt')?.textContent,dt:box(row.querySelector('dt')),dd:box(row.querySelector('dd'))}))}))},
        evaluation:{review:box(document.querySelector('.review-workspace')),setup:box(document.querySelector('.evaluation-setup')),requests:[...document.querySelectorAll('.evaluation-request')].map(box)},
        dialogs:[...document.querySelectorAll('[role=dialog]')].filter(visible).map(e=>({bounds:box(e),close:[...e.querySelectorAll('button')].filter(b=>b.textContent.trim()==='Close').map(box)}))};
    }''')
    (e.output/(name+'.json')).write_text(json.dumps(metric,indent=2)+'\n');return metric['workflows']


def save_candidate(w,label):
    current=w.call('GET',w.channel)
    payload=dict(schemaVersion=1,files=[dict(f,text=f['text']+'\n'+label+'\n' if f['path']=='AGENTS.md' else f['text']) for f in FILES])
    draft=w.call('POST',w.channel+'/drafts',dict(baseVersionId=current['version']['id'],baseRevision=current['revision'],payload=payload))
    return draft,payload


def fixtures(w):
    w.publish_initial('',files=FILES)
    first=w.call('GET',w.channel);second_draft,_=save_candidate(w,'Desktop10 manually reviewed second release.')
    w.call('POST',w.channel+'/releases',dict(versionId=second_draft['snapshotVersion']['id'],expectedRevision=first['revision'],unevaluatedReason='Explicit desktop10 second release with a preserved reason and immutable content.'))
    w.original=w.call('GET',w.channel);w.draft,_=save_candidate(w,'Desktop10 evidence-bound third release.');w.draft_path=w.channel+'/drafts/'+w.draft['id']
    w.request_evaluation();w.start_attempt();w.comparison();w.finish();w.publish_evidence()
    history=w.call('GET',w.channel+'/releases')['items'];assert len(history)==3
    w.original=w.call('GET',w.channel);draft,payload=save_candidate(w,'Desktop10 saved candidate awaiting its app-owned evaluation.')
    return dict(history=history,draft=draft,payload=payload,initialRequests=w.call('GET',w.bundle+'/evaluation-requests')['items'])


def assert_query(p,expected):
    query=parse_qs(urlsplit(p.url).query);assert query=={key:[value] for key,value in expected.items()},query


def published_search(w,b,e,p,prefix,*,cdp=None,coarse=False):
    route=b.bundle_path('content',path='AGENTS.md');visit(p,b,route);open_files(p)
    field=p.get_by_label('Published content',exact=True);submit=p.get_by_role('button',name='Search published paths or content',exact=True)
    expect(field).to_be_visible();expect(submit).to_be_visible();expect(field).to_have_attribute('placeholder','Search files…');expect(field).to_have_attribute('aria-description','Search published paths or content')
    submit.hover();expect(p.get_by_role('tooltip',name='Search published paths or content',exact=True)).to_be_visible();p.keyboard.press('Escape')
    before=p.url;field.fill('references/checks');assert p.url==before,'Typing alone changed URL'
    field.press('Enter');expect(p).to_have_url(b.base+b.bundle_path('content',path='AGENTS.md',q='references/checks'));assert_query(p,dict(path='AGENTS.md',q='references/checks'))
    expect(p.locator('.content-file-button')).to_have_count(2)
    expect(p.get_by_text('isn’t in these search results',exact=False)).to_be_visible()
    p.get_by_label('Entry type',exact=True).select_option('skill');expect(p).to_have_url(b.base+b.bundle_path('content',kind='skill',q='references/checks'));assert_query(p,dict(kind='skill',q='references/checks'))
    target=p.get_by_role('link',name='Open skills/review/references/checks.md',exact=True);activate(p,target)
    expect(p.get_by_test_id('entry-content')).to_have_text(FILES[2]['text']);assert_query(p,dict(path='skills/review/references/checks.md',kind='skill',q='references/checks'))
    narrow=p.get_by_role('button',name='Files (2)',exact=True);is_narrow=narrow.is_visible()
    if is_narrow:expect(narrow).to_have_attribute('aria-expanded','false');expect(narrow).to_be_focused()
    open_files(p);g=capture(e,p,prefix+'-published-search-filtered',cdp=cdp,coarse=coarse)
    assert g['search']['input']['x']>=g['search']['rail']['x'] and g['search']['submit']['right']<=g['search']['rail']['right']+1,g
    assert g['search']['group'] and g['search']['submit']['x']>=g['search']['group']['x'] and g['search']['submit']['right']<=g['search']['group']['right']+1,g
    p.get_by_role('button',name='Clear filters',exact=True).click();expect(field).to_have_value('');expect(p.get_by_label('Entry type',exact=True)).to_have_value('');assert_query(p,{})
    expect(p.locator('.content-file-button')).to_have_count(4)
    field.fill('desktop10-no-match');submit.click();expect(p.locator('.content-file-button')).to_have_count(0);expect(p.get_by_text('No matching entries. Clear filters to see all content.',exact=True)).to_be_visible()
    p.get_by_role('button',name='Clear filters',exact=True).click();expect(p.locator('.content-file-button')).to_have_count(4);assert_query(p,{})
    capture(e,p,prefix+'-published-search-cleared',cdp=cdp,coarse=coarse)
    return dict(typedWithoutNavigation=True,enterSubmitted=True,searchPreservedPath=True,typeFilterClearedPath=True,selectionPreservedQueryAndKind=True,clearRemovedFilters=True,noMatchesVisible=True,narrowSelectionReturnsFocus=is_narrow)


def search_matrix(w,b,e):
    results=[]
    for width in (1440,1920,1024):
        b.page.set_viewport_size(dict(width=width,height=1000));results.append(dict(width=width,facts=published_search(w,b,e,b.page,str(width))))
    context=b.browser.new_context(ignore_https_errors=True,viewport=dict(width=390,height=844),has_touch=True,storage_state=b.context.storage_state())
    try:
        p=context.new_page();p.set_default_timeout(10000);p.on('pageerror',lambda error:b.errors.append(str(error)))
        results.append(dict(width=390,coarse=True,facts=published_search(w,b,e,p,'390',coarse=True)))
    finally:context.close()
    return results


def release_row(p,revision):
    return p.get_by_test_id('release-decision').filter(has=p.get_by_role('heading',name='Revision '+revision,exact=True))


def release_facts(p,history):
    expect(p.get_by_test_id('release-decision')).to_have_count(len(history))
    for item in history:
        row=release_row(p,item['revision']);utc=datetime.fromisoformat(item['createdAt'].replace('Z','+00:00')).strftime('%Y-%m-%d %H:%M:%S UTC');expect(row.locator('time')).to_have_text(utc)
        if item.get('unevaluatedReason'):expect(row).to_contain_text(item['unevaluatedReason'])
        details=row.get_by_role('button',name=re.compile(r'^Release details for revision '))
        if details.get_attribute('aria-expanded')!='true':details.click()
        for value in (item['id'],item['version']['id'],item['version']['digest'],item['reviewer'],item.get('previousVersionId') or 'None'):
            expect(row).to_contain_text(value)
        if item.get('comparisonId'):expect(row).to_contain_text(item['comparisonId'])
    for item in history:expect(release_row(p,item['revision']).get_by_role('button',name=re.compile(r'^Release details for revision '))).to_have_attribute('aria-expanded','true')


def release_dialogs(w,b,e,p,f,prefix,*,cdp=None):
    old=f['history'][-1];row=release_row(p,old['revision']);inspect=row.get_by_role('button',name=re.compile(r'^Inspect content for revision '));activate(p,inspect)
    dialog=p.get_by_role('dialog',name='Version content',exact=True);expect(dialog.get_by_text('Loading version…',exact=True)).to_have_count(0)
    expect(dialog.get_by_label('Content of AGENTS.md',exact=True)).to_have_text(FILES[0]['text']);open_details(p,'Version details')
    for value in (old['version']['id'],old['version']['digest']):expect(dialog).to_contain_text(value)
    capture(e,p,prefix+'-historical-version-inspector',cdp=cdp);p.keyboard.press('Escape');expect(dialog).to_have_count(0);expect(inspect).to_be_focused()
    restore=row.get_by_role('button',name=re.compile(r'^Restore revision '));activate(p,restore);dialog=p.get_by_role('dialog',name='Restore revision '+old['revision']+'?',exact=True);expect(dialog).to_be_visible()
    expect(dialog.get_by_role('button',name='Restore version',exact=True)).to_be_disabled()
    reason=dialog.get_by_label('Reason for restoring',exact=True);reason.fill('Reviewing a historical version without changing the release.')
    expect(dialog.get_by_role('button',name='Restore version',exact=True)).to_be_enabled()
    for value in ('BDD bundle','stable',w.original['revision'],old['version']['id']):expect(dialog).to_contain_text(value)
    capture(e,p,prefix+'-restore-review-dialog',cdp=cdp);p.keyboard.press('Escape');expect(dialog).to_have_count(0);expect(restore).to_be_focused()
    return dict(inspectedVersion=old['version']['id'],fullVersionAndDigest=True,restoreReasonRequired=True,escapedWithoutRestore=True,keyboardReturn=True)


def releases(w,b,e,f):
    p=b.page;results=[]
    for width in (1440,1920,1024):
        p.set_viewport_size(dict(width=width,height=1000));visit(p,b,b.bundle_path('releases'));capture(e,p,str(width)+'-release-history-overview')
        release_facts(p,f['history']);g=capture(e,p,str(width)+'-release-history-independent-details')
        assert g['releases']['history']['width']<=1024+1,g
        for row in g['releases']['rows']:
            for item in row['metadata']:
                if item['dt'] and item['dd']:assert item['dd']['x']>=item['dt']['right'],item
        results.append(dict(width=width,historyBounds=g['releases']['history'],releaseIds=[item['id'] for item in f['history']],utcTimes=True,detailsIndependent=True))
    results.append(release_dialogs(w,b,e,p,f,'1024'))
    return results


def review_route(b,f):
    draft=f['draft'];return b.bundle_path('changes',draft=draft['id'],candidate=draft['snapshotVersion']['id'],generation=draft['generation'])


def manual_review(w,e,p,f,prefix,*,cdp=None):
    open_details(p,'Publish without evaluation');reason=p.get_by_label('Manual release reason',exact=True);reason.fill('Explicit desktop10 manual release review; no evaluation support is claimed.')
    trigger=p.get_by_role('button',name='Review manual release',exact=True);activate(p,trigger);dialog=p.get_by_role('dialog',name='Publish to stable?',exact=True)
    for value in ('No evaluation supports this release.',reason.input_value(),w.original['version']['id'],f['draft']['snapshotVersion']['id']):expect(dialog).to_contain_text(value)
    capture(e,p,prefix+'-manual-release-review',cdp=cdp);p.keyboard.press('Escape');expect(dialog).to_have_count(0);expect(trigger).to_be_focused()


def complete_request(w,request):
    path=w.bundle+'/evaluation-requests/'+request['id'];attempt='desktop10-explicit-fixture-attempt'
    w.call('POST',path+'/start',dict(attemptId=attempt),actor='evaluator')
    fields=('parentVersionId','parentDigest','candidateVersionId','candidateDigest','datasetRevision','runtime','graderRevision','expectedCases')
    report={key:request[key] for key in fields};report['evaluation']=dict(requestId=request['id'],attemptId=attempt)
    report['results']=[dict(**key,parent=dict(executionStatus='completed',gradingStatus='scored',reward=0,usage=dict(costUsd=0),outputRef='Parent fixture output',error=None),candidate=dict(executionStatus='completed',gradingStatus='scored',reward=1,usage=dict(costUsd=0),outputRef='Candidate fixture output',error=None)) for key in request['expectedCases']]
    result=w.call('POST',w.bundle+'/comparisons',report,actor='evaluator');w.call('POST',path+'/finish',dict(attemptId=attempt,comparisonId=result['id']),actor='evaluator');return result


def loaded_evidence(w,b,e,p,f,prefix,*,cdp=None):
    visit(p,b,review_route(b,f));request=p.locator('.evaluation-request').filter(has=p.locator('#evaluation-request-'+f['request']['id']))
    expect(request).to_contain_text('App reported completed');activate(p,request.get_by_role('link',name=re.compile(r'^Inspect evidence for ')))
    p.get_by_role('tab',name='Details',exact=True).click();evidence=p.get_by_role('region',name='Evidence and release decision',exact=True)
    expect(evidence.get_by_role('table')).to_be_visible();expect(evidence).to_contain_text('Complete inventory');expect(evidence.get_by_role('row')).to_have_count(len(f['request']['expectedCases'])+1)
    for value in (f['report']['parentVersionId'],f['report']['candidateVersionId'],f['request']['id']):expect(evidence).to_contain_text(value)
    p.locator('.comparison-evidence').scroll_into_view_if_needed();capture(e,p,prefix+'-completed-loaded-evidence',cdp=cdp)
    release=evidence.get_by_role('button',name='Review release with this evidence',exact=True);activate(p,release);dialog=p.get_by_role('dialog',name='Publish to stable?',exact=True)
    for value in (f['report']['id'],f['report']['parentVersionId'],f['report']['candidateVersionId'],w.original['revision']):expect(dialog).to_contain_text(value)
    expect(dialog.get_by_role('button',name='Publish with selected evidence',exact=True)).to_be_enabled();capture(e,p,prefix+'-evidenced-release-review',cdp=cdp);p.keyboard.press('Escape');expect(dialog).to_have_count(0);expect(release).to_be_focused()


def evaluations(w,b,e,f):
    p=b.page;route=review_route(b,f);baseline=w.call('GET',w.bundle+'/evaluation-requests')['items']
    for width in (1440,1920,1024):
        p.set_viewport_size(dict(width=width,height=1000));visit(p,b,route)
        expect(p.get_by_role('button',name='Set up evaluation request',exact=True)).to_have_attribute('aria-expanded','true')
        expect(p.get_by_role('region',name='Evaluation requests',exact=True)).to_have_count(0)
        expect(p.get_by_role('heading',name='Evaluation results',exact=True)).to_have_count(0)
        expect(p.get_by_role('heading',name='Evaluation request',exact=True)).to_have_count(0)
        capture(e,p,str(width)+'-evaluation-first-use')
    p.set_viewport_size(dict(width=1440,height=1000));visit(p,b,route);p.get_by_label('Public evaluator configuration (JSON)',exact=True).filter(visible=True).fill(json.dumps(dict(datasetRevision='saved-tasks',graderRevision='grader-v1',runtime=dict(configId='app',configRevision='1'),expectedCases=[dict(caseId='review',repetition=0)])))
    activate(p,p.get_by_role('tab',name='Files changed',exact=False))
    expect(p.get_by_role('region',name='Review file changes',exact=True)).to_be_visible()
    activate(p,p.get_by_role('tab',name='Details',exact=True));open_details(p,'Saved snapshot details')
    expect(p.get_by_role('button',name='Saved snapshot details',exact=True)).to_have_attribute('aria-expanded','true')
    manual_review(w,e,p,f,'1440-first-use')
    assert w.call('GET',w.bundle+'/evaluation-requests')['items']==baseline,'Disclosures created evaluation work'
    activate(p,p.get_by_role('tab',name='Evaluation runs',exact=False))
    create=p.get_by_role('button',name='Create evaluation request',exact=True);activate(p,create)
    expect(p.get_by_role('button',name='Create another evaluation request',exact=True)).to_have_attribute('aria-expanded','false')
    items=w.call('GET',w.bundle+'/evaluation-requests')['items'];added=[item for item in items if item['id'] not in {row['id'] for row in baseline}];assert len(added)==1,added
    request=added[0];assert request['status']=='requested' and request['candidateVersionId']==f['draft']['snapshotVersion']['id'];f['request']=request
    expect(p.locator('#evaluation-request-'+request['id'])).to_be_focused()
    for width in (1440,1024):
        p.set_viewport_size(dict(width=width,height=1000));visit(p,b,route);handoff=p.locator('.evaluation-request').filter(has=p.locator('#evaluation-request-'+request['id']))
        expect(handoff).to_contain_text('Request created · run in your app');expect(handoff.get_by_role('button',name='Copy request ID',exact=True)).to_be_visible();expect(handoff.get_by_role('button',name='Copy request JSON',exact=True)).to_be_visible()
        open_details(p,'Request details');expect(handoff).to_contain_text(request['id']);expect(p.get_by_role('button',name='Create another evaluation request',exact=True)).to_have_attribute('aria-expanded','false')
        handoff.scroll_into_view_if_needed();capture(e,p,str(width)+'-evaluation-requested-handoff')
    f['report']=complete_request(w,request)
    for width in (1440,1920,1024):
        p.set_viewport_size(dict(width=width,height=1000));loaded_evidence(w,b,e,p,f,str(width))
    manual_review(w,e,p,f,'1024-completed')
    return dict(createdRequests=1,requestId=request['id'],comparisonId=f['report']['id'],expectedCases=len(request['expectedCases']),firstUse=True,requestedHandoff=True,completedEvidenceLoaded=True,independentDisclosures=True,manualAndEvidencedDialogsEscaped=True,noProviderOrModelExecution=True)


def cursor_branch(w,b,e,f):
    # Real newer requests for a different immutable candidate create a genuine
    # zero-match first page and next cursor; nothing is intercepted or injected.
    older_target=f['request']['id'];ids=[]
    for _ in range(51):
        request=w.call('POST',w.bundle+'/evaluation-requests',dict(**w.settings,requireBoundEvidence=True));ids.append(request['id'])
    f['cursorFixtureRequests']=ids;p=b.page;p.set_viewport_size(dict(width=1440,height=1000));visit(p,b,review_route(b,f))
    section=p.get_by_role('region',name='Evaluation requests',exact=True);expect(section).to_be_visible()
    expect(section).to_contain_text('No matching requests on the loaded pages. Check older requests for this saved change.')
    expect(section.get_by_role('button',name='Load older requests',exact=True)).to_be_visible()
    expect(p.get_by_role('heading',name='Evaluation results',exact=True)).to_be_visible()
    capture(e,p,'1440-zero-matching-requests-with-real-cursor')
    target=p.locator('#evaluation-request-'+older_target);pages=0
    def requests_response(response):
        try:return response.request.method=='POST' and server_function_action(response.request.post_data_json)=='requests'
        except Exception:return False
    while target.count()==0 and pages<5:
        with p.expect_response(requests_response) as response:
            section.get_by_role('button',name='Load older requests',exact=True).click()
        response.value.finished();pages+=1
        # Actual async read must finish before deciding whether to paginate again.
        # Use the same two paint frames +500ms settling interval as screenshots.
        p.evaluate('async()=>{await new Promise(requestAnimationFrame);await new Promise(requestAnimationFrame)}');p.wait_for_timeout(500)
    expect(target).to_be_visible();expect(target).to_contain_text('App reported completed')
    request=p.locator('.evaluation-request').filter(has=target);activate(p,request.get_by_role('link',name=re.compile(r'^Inspect evidence for ')));expect(p.get_by_role('region',name='Evaluation case comparison',exact=True)).to_be_visible()
    p.get_by_role('tab',name='Details',exact=True).click()
    expect(p.locator('.comparison-evidence')).to_contain_text(f['report']['candidateVersionId']);capture(e,p,'1440-cursor-loaded-older-matching-evidence')
    return dict(realOtherCandidateFixtureRequests=51,initialMatchingRequests=0,cursorBranchVisible=True,olderPagesLoaded=pages,targetRequestId=older_target,matchingEvidenceLoaded=True,modelCalls=0)


def native(w,b,e,f):
    with tempfile.TemporaryDirectory(prefix='acclimate-desktop10-native-') as profile:
        context=b.playwright.chromium.launch_persistent_context(profile,channel='chrome',headless=True,no_viewport=True,ignore_https_errors=True,args=['--window-size=1280,900'])
        try:
            b.sign_in(context);p=context.pages[0];p.set_default_timeout(10000);p.on('pageerror',lambda error:b.errors.append(str(error)))
            visit(p,b,b.bundle_path('content'));before=p.evaluate('({width:innerWidth,dpr:devicePixelRatio})');p.goto('chrome://settings/appearance',wait_until='domcontentloaded');p.evaluate('chrome.settingsPrivate.setDefaultZoom(2)')
            visit(p,b,b.bundle_path('content'));p.wait_for_function('w=>Math.abs(innerWidth-w)<2',arg=before['width']/2);assert p.evaluate('devicePixelRatio')==before['dpr']*2;cdp=context.new_cdp_session(p)
            try:
                search=published_search(w,b,e,p,'native200',cdp=cdp)
                visit(p,b,b.bundle_path('releases'));capture(e,p,'native200-release-history-overview',cdp=cdp);release_facts(p,f['history']);capture(e,p,'native200-release-history-details',cdp=cdp);release_dialogs(w,b,e,p,f,'native200',cdp=cdp)
                loaded_evidence(w,b,e,p,f,'native200',cdp=cdp)
            finally:cdp.detach()
            return dict(nativeZoom=2,baseline=before,dpr=p.evaluate('devicePixelRatio'),cssViewport=p.evaluate('({width:innerWidth,height:innerHeight})'),search=search,historyAndDialogs=True,fullyLoadedEvidence=True)
        finally:context.close()


def native_tooltip_focus(w,b,e):
    with tempfile.TemporaryDirectory(prefix='acclimate-desktop10-tooltip-native-') as profile:
        context=b.playwright.chromium.launch_persistent_context(profile,channel='chrome',headless=True,no_viewport=True,ignore_https_errors=True,args=['--window-size=1280,900'])
        try:
            b.sign_in(context);p=context.pages[0];p.set_default_timeout(10000);p.on('pageerror',lambda error:b.errors.append(str(error)))
            visit(p,b,b.bundle_path('content'));before=p.evaluate('({width:innerWidth,dpr:devicePixelRatio})');p.goto('chrome://settings/appearance',wait_until='domcontentloaded');p.evaluate('chrome.settingsPrivate.setDefaultZoom(2)')
            visit(p,b,b.bundle_path('content'));p.wait_for_function('w=>Math.abs(innerWidth-w)<2',arg=before['width']/2);assert p.evaluate('devicePixelRatio')==before['dpr']*2
            open_files(p);submit=p.get_by_role('button',name='Search published paths or content',exact=True);tip=p.get_by_role('tooltip',name='Search published paths or content',exact=True);cdp=context.new_cdp_session(p)
            try:
                submit.hover();expect(tip).to_be_visible();capture(e,p,'native200-submit-tooltip-hover',cdp=cdp);p.keyboard.press('Escape');expect(tip).to_have_count(0)
                p.mouse.move(1,1);tab_to(p,submit);expect(submit).to_be_focused();expect(tip).to_be_visible();capture(e,p,'native200-submit-tooltip-keyboard-focus',cdp=cdp)
                p.keyboard.press('Escape');expect(tip).to_have_count(0);expect(submit).to_be_focused();g=capture(e,p,'native200-submit-tooltip-escape-retains-focus',cdp=cdp)
                assert g['search']['submit']['width']>=35.5 and g['search']['submit']['height']>=35.5,g
                assert g['search']['submit']['right']<=g['search']['group']['right']+1,g
            finally:cdp.detach()
            return dict(actualChromeZoom=2,hoverTooltip=True,nativeTabFocusTooltip=True,escapeClosesTooltip=True,escapeRetainsFocusedSubmit=True,submit=g['search']['submit'],group=g['search']['group'])
        finally:context.close()


def main():
    parser=argparse.ArgumentParser(description=__doc__);parser.add_argument('--pg-bin');parser.add_argument('--expected-build-hash');parser.add_argument('--tooltip-focus-only',action='store_true');parser.add_argument('--output',type=Path,default=ROOT/'artifacts/desktop10-workflows');args=parser.parse_args()
    output=args.output.resolve();output.mkdir(parents=True,exist_ok=False,mode=0o700);e=Evidence(output,False);before=build_fingerprint();w=World(pg_bin(args.pg_bin));unchanged=False
    try:
        if args.expected_build_hash:assert before==args.expected_build_hash,'Frozen build hash differs from GO'
        w.start();w.fresh_scenario(SimpleNamespace(effective_tags=[]));f=fixtures(w);b=w.browser();p=b.page
        initial=dict(release=w.call('GET',w.channel),history=w.call('GET',w.channel+'/releases')['items'],drafts=w.call('GET',w.channel+'/drafts?status=all')['items'])
        if args.tooltip_focus_only:e.run('native200-submit-tooltip-keyboard-focus',p,lambda:native_tooltip_focus(w,b,e))
        else:
            e.run('published-search-url-filter-and-narrow-rail',p,lambda:search_matrix(w,b,e))
            e.run('multi-release-facts-and-dialog-keyboard-return',p,lambda:releases(w,b,e,f))
            e.run('evaluation-first-use-requested-completed-review',p,lambda:evaluations(w,b,e,f))
            if 'report' in f:e.run('actual-native200-published-releases-and-evidence',p,lambda:native(w,b,e,f))
            if 'report' in f:e.run('zero-match-request-cursor-with-real-pagination',p,lambda:cursor_branch(w,b,e,f))
        final=dict(release=w.call('GET',w.channel),history=w.call('GET',w.channel+'/releases')['items'],drafts=w.call('GET',w.channel+'/drafts?status=all')['items'])
        assert final==initial,'Browser review changed saved content or release history'
        all_requests=w.call('GET',w.bundle+'/evaluation-requests?limit=100')['items'];assert len(all_requests)==len(f['initialRequests'])+(0 if args.tooltip_focus_only else 1)+len(f.get('cursorFixtureRequests',[])),'Unexpected number of evaluation requests'
        if not args.tooltip_focus_only:assert any(row['id']==f['request']['id'] and row['candidateVersionId']==f['draft']['snapshotVersion']['id'] for row in all_requests)
        assert not b.errors,b.errors;unchanged=True
    except Exception as error:e.failures.append(dict(check='fixture-or-invariants',error=str(error),traceback=traceback.format_exc()))
    finally:
        after=build_fingerprint();w.close()
        if before!=after:e.failures.append(dict(check='frozen-build',error='Production .output changed'))
        writes='No browser mutations.' if args.tooltip_focus_only else 'Exactly one real UI evaluation request; one bound fixture comparison/finish; 51 API fixture requests for another candidate to establish real pagination. No publishing or restoring during browser validation.'
        summary=dict(passed=not e.failures and not e.geometry,checks=e.checks,failures=e.failures,geometryViolations=e.geometry,capturedStates=len(list(output.glob('*.png'))),sourceBuildBeforeSha256=before,sourceBuildAfterSha256=after,sourceBuildFingerprint='SHA256 of all sorted .output relative paths and bytes',savedContentAndReleaseHistoryUnchanged=unchanged,allowedWrites=writes,paidModelCalls=0,externalWrites=0,domMutation=False,focusInjection=False,storageInjection=False,fixture='Private PostgreSQL + real service + frozen production console + real OIDC/TLS',limits=['Synthetic bound outcomes prove UI state and provenance, not actual evaluation quality.','No manufactured recovery failures, provider execution, or model consumption claims.'])
        (output/'summary.json').write_text(json.dumps(summary,indent=2)+'\n');print(json.dumps(summary,indent=2),flush=True)
    return 0 if summary['passed'] else 1


if __name__=='__main__':raise SystemExit(main())
