#!/usr/bin/env python3
"""Focused v8 workflows on a frozen production build and private real services.

Native browser inputs only. No providers, models, interception, DOM mutation,
storage injection, focus injection, publishing, or production build commands.
"""
import argparse
import json
from pathlib import Path
import re
import sys
import tempfile
import traceback
from types import SimpleNamespace
from urllib.parse import unquote

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT))
from playwright.sync_api import expect
from scripts.bdd.run import pg_bin
from scripts.bdd.world import World
from scripts.bdd.layout import tab_to
from scripts.bdd.interactions import open_files, open_details
from scripts.testing.compact_console import FILES, visit
from scripts.testing.desktop_layouts import Evidence, build_fingerprint
from scripts.test_console_native_zoom import capture_native
from scripts.bdd.layout import inspect_layout


def keyboard_activate(page, target):
    tab_to(page, target)
    expect(target).to_be_focused()
    page.keyboard.press('Enter')


def dialog_metrics(page):
    return page.get_by_role('dialog').evaluate('''el => {
      const box=e=>{const r=e.getBoundingClientRect();return {x:r.x,y:r.y,width:r.width,height:r.height,right:r.right,bottom:r.bottom}};
      const visible=e=>!!e.getClientRects().length&&getComputedStyle(e).visibility!=='hidden';
      return {bounds:box(el),viewport:{width:innerWidth,height:innerHeight},
        scrollers:[el,...el.querySelectorAll('*')].filter(visible).filter(e=>/auto|scroll/.test(getComputedStyle(e).overflowY)&&e.scrollHeight>e.clientHeight+1).map(e=>({tag:e.tagName,classes:e.className,...box(e)})),
        close:[...el.querySelectorAll('button')].filter(e=>e.textContent.trim()==='Close').map(box),
        focused:el.contains(document.activeElement)};
    }''')


def import_dialog(page):
    trigger=page.get_by_role('button', name='Import files into this draft', exact=True)
    trigger.click()
    dialog=page.get_by_role('dialog', name='Import files into this draft', exact=True)
    expect(dialog).to_be_visible()
    return trigger,dialog


def imports(w,b,e,draft_route,candidate):
    p=b.page;p.set_viewport_size(dict(width=1440,height=900));visit(p,b,draft_route)
    saved=w.call('GET',w.draft_path);release=w.call('GET',w.channel)
    trigger,dialog=import_dialog(p)
    dialog.get_by_label('Individual files',exact=True).set_input_files(dict(name='desktop8-import.md',mimeType='text/markdown',buffer=b'# Browser import\nRetained preview and browser edits.\n'))
    expect(dialog.get_by_role('heading',name='Ready to add · 1 file',exact=True)).to_be_visible()
    expect(dialog.get_by_text('desktop8-import.md',exact=True)).to_be_visible()
    e.capture(p,'1440-import-preview')
    p.keyboard.press('Escape');expect(dialog).to_have_count(0);expect(trigger).to_be_focused()
    trigger.click();expect(dialog.get_by_text('desktop8-import.md',exact=True)).to_be_visible()
    expect(dialog.get_by_role('button',name='Add 1 file to draft',exact=True)).to_be_enabled()
    e.capture(p,'1440-import-preview-reopened')
    # Close immediately after a real large file read starts. The pending read is
    # application-owned; no artificial timing, interception, or state mutation.
    dialog.get_by_label('Individual files',exact=True).set_input_files([
        dict(name=f'pending-read-{n}.md',mimeType='text/markdown',buffer=('# Native pending read\n'+'x'*240000).encode()) for n in range(3)
    ])
    reading_observed=dialog.get_by_role('status').filter(has_text='Reading and checking your files…').is_visible()
    p.keyboard.press('Escape');expect(dialog).to_have_count(0);trigger.click()
    expect(dialog.get_by_role('heading',name='Ready to add · 3 files',exact=True)).to_be_visible()
    for n in range(3):expect(dialog.get_by_text(f'pending-read-{n}.md',exact=True)).to_be_visible()
    e.capture(p,'1440-import-read-completed-after-reopen')
    # A new real file selection rejects an existing path atomically.
    dialog.get_by_label('Individual files',exact=True).set_input_files(dict(name='AGENTS.md',mimeType='text/markdown',buffer=b'Collision must not overwrite the existing file.'))
    expect(dialog.get_by_role('alert')).to_contain_text('Path collision: AGENTS.md')
    expect(dialog.get_by_role('alert')).to_contain_text('Nothing was imported.')
    expect(dialog.get_by_role('button',name='Add 1 file to draft',exact=True)).to_have_count(0)
    p.keyboard.press('Escape');trigger.click()
    expect(dialog.get_by_role('alert')).to_contain_text('Nothing was imported.')
    e.capture(p,'1440-import-collision-reopened')
    assert w.call('GET',w.draft_path)==saved and w.call('GET',w.channel)==release
    dialog.get_by_label('Individual files',exact=True).set_input_files(dict(name='desktop8-import.md',mimeType='text/markdown',buffer=b'# Browser import\nRetained preview and browser edits.\n'))
    expect(dialog.get_by_role('button',name='Add 1 file to draft',exact=True)).to_be_enabled()
    dialog.get_by_role('button',name='Add 1 file to draft',exact=True).click()
    expect(dialog).to_have_count(0)
    expect(p.get_by_role('button',name='Save draft',exact=True)).to_be_enabled()
    open_files(p);p.get_by_role('button',name='Open desktop8-import.md',exact=True).click()
    expect(p.get_by_label('Content',exact=True)).to_have_value('# Browser import\nRetained preview and browser edits.\n')
    assert w.call('GET',w.draft_path)==saved,'Import Add unexpectedly saved the candidate'
    assert w.call('GET',w.channel)==release,'Import Add unexpectedly published'
    e.capture(p,'1440-import-browser-edits-only')
    # Folder upload uses real directory input, retaining a full skill package.
    folder=w.h.dir/'desktop8-skill';(folder/'references').mkdir(parents=True)
    (folder/'SKILL.md').write_text('---\nname: desktop8-skill\ndescription: Native folder import fixture.\n---\n# Fixture skill\nRead references/checks.md.\n')
    (folder/'references'/'checks.md').write_text('# Nested reference\nPreserve this relative path.\n')
    trigger,dialog=import_dialog(p);dialog.get_by_label('Bundle folder',exact=True).set_input_files(str(folder))
    expect(dialog.get_by_role('heading',name='Ready to add · 2 files',exact=True)).to_be_visible()
    for path in ('skills/desktop8-skill/SKILL.md','skills/desktop8-skill/references/checks.md'):
        expect(dialog.get_by_text(path,exact=True)).to_be_visible()
    e.capture(p,'1440-import-skill-package-preview')
    dialog.get_by_role('button',name='Add 2 files to draft',exact=True).click();expect(dialog).to_have_count(0)
    open_files(p);p.get_by_role('button',name='Open skills/desktop8-skill/references/checks.md',exact=True).click()
    expect(p.get_by_label('Content',exact=True)).to_have_value('# Nested reference\nPreserve this relative path.\n')
    assert w.call('GET',w.draft_path)==saved and w.call('GET',w.channel)==release
    # Use the application's explicit navigation discard guard to clear browser edits.
    p.reload(wait_until='networkidle')
    expect(p.get_by_role('button',name='Open desktop8-import.md',exact=True)).to_have_count(0)
    expect(p.get_by_label('Content',exact=True)).to_have_value(candidate['files'][0]['text'])
    # History and details stay inline and do not open utility dialogs.
    inline=[]
    for name in ('Saved snapshot history','Draft details'):
        controls=p.locator('[data-slot=disclosure-trigger]').filter(has_text=re.compile(r'^\s*'+name+r'\s*$'))
        if controls.count():
            controls.click();expect(controls).to_have_attribute('aria-expanded','true');expect(p.get_by_role('dialog')).to_have_count(0)
            inline.append(name);controls.click()
    assert set(inline)=={'Saved snapshot history','Draft details'},inline
    return dict(previewRetained=True,closedImmediatelyAfterNativeUpload=True,readingStatusObserved=reading_observed,previewAvailableAfterReopen=True,collisionRetained=True,addCloses=True,addSaved=False,releaseUnchanged=True,folderPathsRetained=True,inline=inline)


def bounded_import(w,b,e,draft_route):
    p=b.page;results=[]
    for width,height in ((1024,500),(390,844)):
        context=None
        if width==390:
            context=b.browser.new_context(ignore_https_errors=True,viewport=dict(width=width,height=height),has_touch=True,storage_state=b.context.storage_state())
            p=context.new_page();p.set_default_timeout(10000)
        else:p.set_viewport_size(dict(width=width,height=height))
        try:
            visit(p,b,draft_route);trigger,dialog=import_dialog(p)
            dialog.get_by_label('Individual files',exact=True).set_input_files(dict(name='bounded-import.md',mimeType='text/markdown',buffer=b'# Small dialog preview\n'))
            expect(dialog.get_by_role('button',name='Add 1 file to draft',exact=True)).to_be_enabled()
            e.capture(p,f'{width}-import-preview',coarse=width==390)
            measured=dialog_metrics(p)
            assert measured['bounds']['x']>=-1 and measured['bounds']['right']<=width+1,measured
            assert measured['bounds']['y']>=-1 and measured['bounds']['bottom']<=height+1,measured
            assert len(measured['scrollers'])<=1,measured
            assert measured['close'] and measured['close'][0]['y']>=0 and measured['close'][0]['bottom']<=height,measured
            p.keyboard.press('Escape');expect(dialog).to_have_count(0);expect(trigger).to_be_focused()
            results.append(dict(viewport=[width,height],dialog=measured,escapeRestoredTrigger=True))
        finally:
            if context:context.close()
    return results


def native_import(w,b,e,draft_route):
    with tempfile.TemporaryDirectory(prefix='acclimate-desktop8-native-') as profile:
        context=b.playwright.chromium.launch_persistent_context(profile,channel='chrome',headless=True,no_viewport=True,ignore_https_errors=True,args=['--window-size=1280,800'])
        try:
            b.sign_in(context);p=context.pages[0];p.set_default_timeout(10000)
            p.on('pageerror',lambda error:b.errors.append(str(error)))
            visit(p,b,draft_route);before=p.evaluate('({width:innerWidth,dpr:devicePixelRatio})')
            p.goto('chrome://settings/appearance',wait_until='domcontentloaded');p.evaluate('chrome.settingsPrivate.setDefaultZoom(2)')
            visit(p,b,draft_route);p.wait_for_function('w=>Math.abs(innerWidth-w)<2',arg=before['width']/2)
            assert p.evaluate('devicePixelRatio')==before['dpr']*2
            trigger,dialog=import_dialog(p)
            dialog.get_by_label('Individual files',exact=True).set_input_files(dict(name='native200-import.md',mimeType='text/markdown',buffer=b'# Native zoom import\n'))
            add=dialog.get_by_role('button',name='Add 1 file to draft',exact=True);expect(add).to_be_enabled()
            measured=dialog_metrics(p);viewport=measured['viewport'];bounds=measured['bounds']
            assert bounds['x']>=0 and bounds['right']<=viewport['width']+1 and bounds['y']>=0 and bounds['bottom']<=viewport['height']+1,measured
            assert len(measured['scrollers'])==1,measured
            assert measured['close'] and measured['close'][0]['y']>=0 and measured['close'][0]['bottom']<=viewport['height'],measured
            cdp=context.new_cdp_session(p)
            captures=[]
            try:
                for name,scroll in (('native200-import-preview-top',False),('native200-import-preview-add',True)):
                    if scroll:add.scroll_into_view_if_needed()
                    p.evaluate('async()=>{await document.fonts.ready;await new Promise(requestAnimationFrame);await new Promise(requestAnimationFrame)}');p.wait_for_timeout(500)
                    metric=capture_native(p,cdp,e.output,name);after=inspect_layout(p)
                    stable=('viewport','viewportHeight','width','editor','scrollY','visualViewportOffsetTop')
                    assert {k:metric[k] for k in stable}=={k:after[k] for k in stable},'Native screenshot changed route geometry'
                    metric['dialog']=dialog_metrics(p);metric['capture']=dict(method='CDP Page.captureScreenshot at actual Chrome 200% zoom',before={k:metric[k] for k in stable},after={k:after[k] for k in stable})
                    (e.output/(name+'.json')).write_text(json.dumps(metric,indent=2)+'\n');captures.append(name)
            finally:cdp.detach()
            p.keyboard.press('Escape');expect(dialog).to_have_count(0);expect(trigger).to_be_focused()
            trigger.click();expect(dialog.get_by_text('native200-import.md',exact=True)).to_be_visible();p.keyboard.press('Escape')
            return dict(nativeZoom=2,baseline=before,cssViewport=viewport,dpr=p.evaluate('devicePixelRatio'),dialog=measured,captures=captures,previewRetained=True,escapeRestoredTrigger=True)
        finally:context.close()


def library_fixtures(w):
    setups=[]
    for name in ('Review library alpha','Review library beta'):
        setups.append(w.call('POST',w.root+'/bundle-setups',dict(name=name,origin='created',channel='stable',payload=dict(schemaVersion=1,files=FILES),reason='Disposable library inventory fixture.')))
    w.call('POST',w.bundle+'/channels/preview/promotions',dict(versionId=w.original['version']['id'],expectedRevision='0',unevaluatedReason='Disposable second channel fixture.'))
    empty=w.call('POST',w.root+'/bundles',dict(name='Review library no channels'))
    expected={w.setup['bundle']['id']:('BDD bundle',['stable','preview']),**{s['bundle']['id']:(s['bundle']['name'],['stable']) for s in setups},empty['id']:('Review library no channels',[])}
    return expected


def library(w,b,e,expected):
    p=b.page;results=[]
    for width in (1440,1024):
        p.set_viewport_size(dict(width=width,height=900));visit(p,b,b.workspace_path())
        expect(p.get_by_role('heading',name='Bundles',exact=True)).to_be_visible()
        expect(p.get_by_label('Find a bundle',exact=True)).to_be_visible()
        rows=p.locator('.bundle-library-row');expect(rows).to_have_count(len(expected))
        actual={}
        for bundle_id,(name,channels) in expected.items():
            row=rows.filter(has=p.get_by_role('heading',name=name,exact=True));expect(row).to_have_count(1)
            more=row.get_by_role('button',name=re.compile('Other channels'))
            if more.count():
                more.click()
            hrefs=row.get_by_role('link').evaluate_all('els=>els.map(el=>({text:el.textContent.trim(),href:el.getAttribute("href")}))')
            expected_links={c:b.bundle_path('content',bundle_id=bundle_id,channel=c) for c in channels}
            for channel,href in expected_links.items():
                expect(row.get_by_role('link',name=channel,exact=True)).to_have_attribute('href',href)
            if not channels:
                expect(row.get_by_role('link')).to_have_count(0);expect(row.get_by_text('No published channels',exact=True)).to_be_visible()
            else:
                for channel in channels:
                    revision=row.get_by_role('link',name=f'Revision 1 on {channel} for {name}',exact=True)
                    expect(revision).to_have_attribute('href',b.bundle_path('releases',bundle_id=bundle_id,channel=channel)+'#revision-1')
                assert len(hrefs)==len(channels)*2+1,hrefs
                assert row.get_by_role('link',name=name,exact=True).get_attribute('href') in expected_links.values()
            actual[name]=hrefs
        metrics=e.capture(p,f'{width}-library-inventory')
        bounds=p.locator('.bundle-library').evaluate('''el=>{const r=el.getBoundingClientRect(),h=el.querySelector('h1').getBoundingClientRect();return {x:r.x,width:r.width,right:r.right,headingX:h.x}}''')
        assert 0<=bounds['x']<bounds['right']<=width+1,bounds
        assert abs(bounds['x']-bounds['headingX'])<2,bounds
        assert not metrics['violations'],metrics['violations']
        p.get_by_label('Find a bundle',exact=True).fill('no channels');expect(rows).to_have_count(1)
        expect(rows.get_by_role('heading',name='Review library no channels',exact=True)).to_be_visible()
        p.get_by_label('Find a bundle',exact=True).fill('nothing matches desktop8')
        expect(rows).to_have_count(0);expect(p.get_by_text('No bundles match “nothing matches desktop8”.',exact=True)).to_be_visible()
        results.append(dict(width=width,bounds=bounds,links=actual,searchPassed=True))
    return results


def comparison_fixture(w,complete):
    settings=dict(parentVersionId=w.original['version']['id'],parentDigest=w.original['version']['digest'],candidateVersionId=w.draft['snapshotVersion']['id'],candidateDigest=w.draft['snapshotVersion']['digest'],datasetRevision='desktop8-paired-cases-v1',runtime=dict(executor='fixture',model='none'),graderRevision='desktop8-grader-v1',expectedCases=[dict(caseId=case,repetition=0) for case in ('zero-to-one','one-to-zero','missing-or-complete')])
    request=w.call('POST',w.bundle+'/evaluation-requests',dict(**settings,requireBoundEvidence=True))
    request_path=w.bundle+'/evaluation-requests/'+request['id'];attempt='desktop8-'+('complete' if complete else 'incomplete')
    w.call('POST',request_path+'/start',dict(attemptId=attempt),actor='evaluator')
    def outcome(arm,case,reward,failed=False,known=True):
        return dict(executionStatus='task_failed' if failed else 'completed',gradingStatus='failed' if failed else 'scored',reward=None if failed else reward,outputRef=f'{arm} output for {case}',error=f'{arm} explicit fixture failure for {case}' if failed else None,usage=dict(costUsd=0) if known else None)
    results=[]
    for index,key in enumerate(settings['expectedCases']):
        if not complete and index==2:continue
        results.append(dict(**key,parent=outcome('Parent',key['caseId'],0 if index==0 else 1),candidate=outcome('Candidate',key['caseId'],1 if index==0 else 0,failed=not complete and index==1,known=complete or index!=1)))
    report=w.call('POST',w.bundle+'/comparisons',dict(**settings,evaluation=dict(requestId=request['id'],attemptId=attempt),results=results),actor='evaluator')
    w.call('POST',request_path+'/finish',dict(attemptId=attempt,comparisonId=report['id']),actor='evaluator')
    return dict(request=request,comparison=report,settings=settings,attempt=attempt,complete=complete)


def comparison(w,b,e,fixture):
    p=b.page;p.set_viewport_size(dict(width=1440,height=1000))
    route=b.bundle_path('changes',draft=w.draft['id'],candidate=w.draft['snapshotVersion']['id'],generation=w.draft['generation'])
    visit(p,b,route)
    # Scope by the request disclosure's actual id, then follow its real link.
    request=p.locator('.evaluation-request').filter(has=p.locator('#evaluation-request-'+fixture['request']['id']))
    keyboard_activate(p,request.get_by_role('link',name=re.compile(r'^Inspect evidence for ')))
    expect(p.get_by_role('heading',name='Reported evidence',exact=True)).to_be_visible()
    evidence=p.get_by_role('region',name='Evidence and release decision',exact=True)
    expect(evidence.locator('.comparison-evidence-summary')).to_be_visible();expect(evidence.get_by_role('table')).to_be_visible()
    expect(p.locator('.comparison-evidence-summary')).to_have_count(1)
    report=fixture['comparison'];rows=evidence.get_by_role('row');expect(rows).to_have_count(4)
    for key in fixture['settings']['expectedCases']:expect(evidence.get_by_role('cell',name=key['caseId']+' / 0',exact=True)).to_be_visible()
    for raw in (report['parentVersionId'],report['candidateVersionId'],fixture['request']['id'],fixture['attempt']):expect(evidence).to_contain_text(raw)
    expect(rows.nth(1).get_by_role('cell').nth(1)).to_contain_text('Reward 0 · cost $0')
    expect(rows.nth(1).get_by_role('cell').nth(2)).to_contain_text('Reward 1 · cost $0')
    release=evidence.get_by_role('button',name='Review release with this evidence',exact=True)
    if fixture['complete']:
        expect(evidence).to_contain_text('Complete inventory');expect(evidence).to_contain_text('3 scored pairs / 3 expected pairs');expect(release).to_be_enabled()
    else:
        expect(evidence).to_contain_text('Incomplete evidence; not a win');expect(evidence).to_contain_text('1 scored pairs / 3 expected pairs')
        expect(rows.nth(2).get_by_role('cell').nth(2)).to_contain_text('Reward missing · cost unknown')
        expect(rows.nth(3).get_by_role('cell').nth(1)).to_contain_text('Missing outcome · grade missing · cost unknown')
        expect(rows.nth(3).get_by_role('cell').nth(2)).to_contain_text('Missing outcome · grade missing · cost unknown')
        expect(evidence.locator('.comparison-evidence-summary')).to_contain_text('unknown')
        expect(release).to_be_disabled();expect(evidence.get_by_text('Complete evidence is required before this release can be reviewed.',exact=True)).to_be_visible()
    output_facts=[]
    for index,pair in enumerate(report['results']):
        for arm in ('parent','candidate'):
            cell=rows.nth(index+1).get_by_role('cell').nth(1 if arm=='parent' else 2)
            toggle=cell.get_by_role('button',name='Output / error',exact=True)
            keyboard_activate(p,toggle);expect(toggle).to_have_attribute('aria-expanded','true')
            expect(cell.get_by_text(pair[arm]['outputRef'],exact=True)).to_be_visible()
            if pair[arm]['error']:expect(cell.get_by_text(pair[arm]['error'],exact=True)).to_be_visible()
            if pair[arm]['error']:e.capture(p,'1440-incomplete-candidate-output-error-expanded')
            output_facts.append(dict(case=pair['caseId'],arm=arm,error=bool(pair[arm]['error'])))
            p.keyboard.press('Enter');expect(toggle).to_have_attribute('aria-expanded','false')
    name='complete' if fixture['complete'] else 'incomplete'
    evidence.get_by_role('heading',name='Reported evidence',exact=True).scroll_into_view_if_needed()
    e.capture(p,'1440-'+name+'-loaded-evidence')
    p.set_viewport_size(dict(width=1024,height=900));evidence.get_by_role('heading',name='Reported evidence',exact=True).scroll_into_view_if_needed()
    e.capture(p,'1024-'+name+'-loaded-evidence')
    p.set_viewport_size(dict(width=1440,height=1000))
    if fixture['complete']:
        keyboard_activate(p,release);dialog=p.get_by_role('dialog',name='Publish to stable?',exact=True);expect(dialog).to_be_visible()
        for raw in ('BDD bundle','stable',w.original['revision'],report['parentVersionId'],report['candidateVersionId'],report['id'],str(w.draft['generation'])):expect(dialog).to_contain_text(raw)
        expect(dialog.get_by_role('button',name='Publish with selected evidence',exact=True)).to_be_enabled()
        e.capture(p,'1440-complete-evidence-publish-decision');p.keyboard.press('Escape');expect(dialog).to_have_count(0);expect(release).to_be_focused()
    return dict(complete=fixture['complete'],expectedPairs=3,outputDisclosures=output_facts,parent=report['parentVersionId'],candidate=report['candidateVersionId'],request=fixture['request']['id'],attempt=fixture['attempt'],releasePublished=False)


def native_capture(e,p,cdp,name):
    p.evaluate('''async()=>{await document.fonts.ready;await Promise.all(document.getAnimations().filter(a=>a.playState==='running'&&Number.isFinite(a.effect.getComputedTiming().endTime)).map(a=>a.finished.catch(()=>{})));await new Promise(requestAnimationFrame);await new Promise(requestAnimationFrame)}''')
    p.wait_for_timeout(500);metric=capture_native(p,cdp,e.output,name);after=inspect_layout(p)
    stable=('viewport','viewportHeight','width','editor','scrollY','visualViewportOffsetTop')
    assert {k:metric[k] for k in stable}=={k:after[k] for k in stable},'Native screenshot changed route geometry'
    metric['capture']=dict(method='CDP Page.captureScreenshot at actual Chrome 200% zoom',before={k:metric[k] for k in stable},after={k:after[k] for k in stable})
    metric['evidence']=p.locator('.comparison-evidence').evaluate('''el=>{const box=e=>{const r=e.getBoundingClientRect();return {x:r.x,y:r.y,width:r.width,height:r.height,right:r.right,bottom:r.bottom}};return {bounds:box(el),summary:el.querySelector('.comparison-evidence-summary').textContent,rows:[...el.querySelectorAll('tr')].map(row=>({bounds:box(row),cells:[...row.querySelectorAll('th,td')].map(cell=>({text:cell.textContent,bounds:box(cell)}))}))}}''')
    (e.output/(name+'.json')).write_text(json.dumps(metric,indent=2)+'\n')
    return metric


def loaded_native_evidence(w,b,e,fixture):
    with tempfile.TemporaryDirectory(prefix='acclimate-desktop8-evidence-native-') as profile:
        context=b.playwright.chromium.launch_persistent_context(profile,channel='chrome',headless=True,no_viewport=True,ignore_https_errors=True,args=['--window-size=1280,900'])
        try:
            b.sign_in(context);p=context.pages[0];p.set_default_timeout(10000);p.on('pageerror',lambda error:b.errors.append(str(error)))
            route=b.bundle_path('changes',draft=w.draft['id'],candidate=w.draft['snapshotVersion']['id'],generation=w.draft['generation'])
            visit(p,b,route);before=p.evaluate('({width:innerWidth,dpr:devicePixelRatio})')
            p.goto('chrome://settings/appearance',wait_until='domcontentloaded');p.evaluate('chrome.settingsPrivate.setDefaultZoom(2)')
            visit(p,b,route);p.wait_for_function('w=>Math.abs(innerWidth-w)<2',arg=before['width']/2)
            assert p.evaluate('devicePixelRatio')==before['dpr']*2
            request=p.locator('.evaluation-request').filter(has=p.locator('#evaluation-request-'+fixture['request']['id']))
            keyboard_activate(p,request.get_by_role('link',name=re.compile(r'^Inspect evidence for ')))
            expect(p.get_by_role('heading',name='Reported evidence',exact=True)).to_be_visible()
            evidence=p.get_by_role('region',name='Evidence and release decision',exact=True)
            expect(evidence.get_by_role('table')).to_be_visible();expect(evidence.locator('.comparison-evidence-summary')).to_contain_text('Incomplete evidence; not a win')
            expect(evidence.locator('.comparison-evidence-summary')).to_contain_text('1 scored pairs / 3 expected pairs')
            expect(evidence.locator('.comparison-evidence-summary')).to_contain_text('unknown')
            expect(p.locator('.comparison-evidence-summary')).to_have_count(1)
            cdp=context.new_cdp_session(p);captures=[];cell_facts=[]
            try:
                evidence.get_by_role('heading',name='Reported evidence',exact=True).scroll_into_view_if_needed()
                captures.append(native_capture(e,p,cdp,'native200-incomplete-loaded-summary')['nativeScreenshotPixels'])
                rows=evidence.get_by_role('row');expect(rows).to_have_count(4)
                for index,key in enumerate(fixture['settings']['expectedCases']):
                    row=rows.nth(index+1);row.scroll_into_view_if_needed()
                    cells=row.get_by_role('cell');expect(cells.nth(0)).to_have_text(key['caseId']+' / 0')
                    for arm in (1,2):
                        cell=cells.nth(arm);expect(cell).to_be_in_viewport()
                        bounds=cell.bounding_box();viewport=p.evaluate('({width:innerWidth,height:innerHeight})')
                        assert bounds['x']>=-1 and bounds['x']+bounds['width']<=viewport['width']+1,dict(bounds=bounds,viewport=viewport)
                        assert bounds['y']>=-1 and bounds['y']+bounds['height']<=viewport['height']+1,dict(bounds=bounds,viewport=viewport)
                    if index==0:
                        expect(cells.nth(1)).to_contain_text('Reward 0 · cost $0');expect(cells.nth(2)).to_contain_text('Reward 1 · cost $0')
                    elif index==1:
                        expect(cells.nth(2)).to_contain_text('Reward missing · cost unknown');expect(cells.nth(2)).to_contain_text('task_failed')
                    else:
                        for arm in (1,2):expect(cells.nth(arm)).to_have_text('Missing outcome · grade missing · cost unknown')
                    cell_facts.append(dict(case=key['caseId'],bothArmsWithinViewport=True))
                    native_capture(e,p,cdp,'native200-incomplete-pair-'+str(index))
                # Every reported arm's real disclosure is reached through Tab/Enter.
                for index,pair in enumerate(fixture['comparison']['results']):
                    for arm in ('parent','candidate'):
                        cell=rows.nth(index+1).get_by_role('cell').nth(1 if arm=='parent' else 2)
                        toggle=cell.get_by_role('button',name='Output / error',exact=True);keyboard_activate(p,toggle)
                        expect(toggle).to_have_attribute('aria-expanded','true')
                        output=cell.get_by_text(pair[arm]['outputRef'],exact=True);output.scroll_into_view_if_needed();expect(output).to_be_in_viewport()
                        if pair[arm]['error']:
                            error=cell.get_by_text(pair[arm]['error'],exact=True);expect(error).to_be_in_viewport()
                        native_capture(e,p,cdp,'native200-output-'+str(index)+'-'+arm)
                        # Real keyboard focus remains on its disclosure trigger.
                        expect(toggle).to_be_focused();p.keyboard.press('Enter');expect(toggle).to_have_attribute('aria-expanded','false')
                release=evidence.get_by_role('button',name='Review release with this evidence',exact=True)
                release.scroll_into_view_if_needed();expect(release).to_be_disabled();expect(release).to_be_in_viewport()
                why=evidence.get_by_text('Complete evidence is required before this release can be reviewed.',exact=True);expect(why).to_be_in_viewport()
                native_capture(e,p,cdp,'native200-incomplete-disabled-release-and-why')
                for raw in (fixture['comparison']['parentVersionId'],fixture['comparison']['candidateVersionId'],fixture['request']['id'],fixture['attempt']):expect(evidence).to_contain_text(raw)
            finally:cdp.detach()
            return dict(nativeZoom=2,baseline=before,cssViewport=p.evaluate('({width:innerWidth,height:innerHeight})'),dpr=p.evaluate('devicePixelRatio'),expectedPairs=3,cellFacts=cell_facts,outputDisclosures=4,candidateErrorVisible=True,incompleteReleaseDisabled=True,whyVisible=True,parent=fixture['comparison']['parentVersionId'],candidate=fixture['comparison']['candidateVersionId'],request=fixture['request']['id'],attempt=fixture['attempt'],releasePublished=False)
        finally:context.close()


def expanded_diff(w,b,e,candidate,fixture):
    p=b.page;p.set_viewport_size(dict(width=1440,height=1000))
    route=b.bundle_path('changes',draft=w.draft['id'],candidate=w.draft['snapshotVersion']['id'],generation=w.draft['generation'])
    visit(p,b,route)
    request=p.locator('.evaluation-request').filter(has=p.locator('#evaluation-request-'+fixture['request']['id']))
    keyboard_activate(p,request.get_by_role('link',name=re.compile(r'^Inspect evidence for ')));expect(p.get_by_role('heading',name='Reported evidence',exact=True)).to_be_visible()
    open_details(p,'Review file changes');diff=p.locator('.content-diff');expect(diff).to_be_visible()
    expect(diff.get_by_role('heading',name='Changed: AGENTS.md',exact=True)).to_be_visible()
    expect(diff.get_by_label('Changed lines in AGENTS.md',exact=True)).to_contain_text('+ Desktop8 saved candidate.')
    before=json.loads(unquote(diff.get_by_role('link',name='Download original entry JSON',exact=True).get_attribute('href').split(',',1)[1]))
    after=json.loads(unquote(diff.get_by_role('link',name='Download current entry JSON',exact=True).get_attribute('href').split(',',1)[1]))
    assert before==FILES[0] and after==candidate['files'][0],'Diff before/after download binding changed'
    diff.scroll_into_view_if_needed();metric=e.capture(p,'1440-expanded-review-file-changes')
    bounds=diff.evaluate('''el=>{const box=e=>{const r=e.getBoundingClientRect();return {x:r.x,y:r.y,width:r.width,height:r.height,right:r.right,bottom:r.bottom}};return {diff:box(el),workspace:box(el.closest('.review-workspace')),pre:box(el.querySelector('pre'))}}''')
    assert bounds['workspace']['width']==1200 and bounds['diff']['width']>=1100,bounds
    assert bounds['diff']['x']>=bounds['workspace']['x'] and bounds['diff']['right']<=bounds['workspace']['right'],bounds
    assert not metric['violations'],metric['violations']
    metric['expandedDiff']=bounds;(e.output/'1440-expanded-review-file-changes.json').write_text(json.dumps(metric,indent=2)+'\n')
    return dict(bounds=bounds,beforeMatchesPublished=True,afterMatchesSavedCandidate=True,correctAddedLinesVisible=True)


def main():
    parser=argparse.ArgumentParser(description=__doc__);parser.add_argument('--pg-bin');parser.add_argument('--native-evidence-only',action='store_true');parser.add_argument('--output',type=Path,default=ROOT/'artifacts/desktop8-workflows')
    args=parser.parse_args();output=args.output.resolve();output.mkdir(parents=True,exist_ok=False,mode=0o700)
    e=Evidence(output,False);w=World(pg_bin(args.pg_bin));b=None;before=build_fingerprint();unchanged=False
    try:
        w.start();w.fresh_scenario(SimpleNamespace(effective_tags=[]));w.publish_initial('',files=FILES)
        candidate=dict(schemaVersion=1,files=[dict(file,text=file['text']+'\nDesktop8 saved candidate.\n' if file['path']=='AGENTS.md' else file['text']) for file in FILES])
        w.draft=w.call('POST',w.channel+'/drafts',dict(baseVersionId=w.original['version']['id'],baseRevision=w.original['revision'],payload=candidate));w.draft_path=w.channel+'/drafts/'+w.draft['id']
        inventory=library_fixtures(w);complete=comparison_fixture(w,True);incomplete=comparison_fixture(w,False)
        release_before=w.call('GET',w.channel);draft_before=w.call('GET',w.draft_path);requests_before=w.call('GET',w.bundle+'/evaluation-requests')['items']
        b=w.browser();p=b.page;draft_route=b.bundle_path('changes',draft=w.draft['id'],path='AGENTS.md')
        if args.native_evidence_only:
            e.run('native200-loaded-incomplete-evidence',p,lambda:loaded_native_evidence(w,b,e,incomplete))
            e.run('expanded-desktop-review-file-changes',p,lambda:expanded_diff(w,b,e,candidate,incomplete))
        else:
            e.run('import-state-and-browser-only-apply',p,lambda:imports(w,b,e,draft_route,candidate))
            e.run('bounded-dialog-small-and-coarse',p,lambda:bounded_import(w,b,e,draft_route))
            e.run('native200-import-dialog',p,lambda:native_import(w,b,e,draft_route))
            e.run('library-bound-inventory-and-search',p,lambda:library(w,b,e,inventory))
            for fixture in (incomplete,complete):e.run(('complete' if fixture['complete'] else 'incomplete')+'-loaded-paired-evidence',p,lambda fixture=fixture:comparison(w,b,e,fixture))
        assert w.call('GET',w.channel)==release_before,'Release changed'
        assert w.call('GET',w.draft_path)==draft_before,'Saved candidate changed'
        assert w.call('GET',w.bundle+'/evaluation-requests')['items']==requests_before,'Browser created evaluation work'
        assert not b.errors,b.errors;unchanged=True
    except Exception as error:e.failures.append(dict(check='fixture-or-invariants',error=str(error),traceback=traceback.format_exc()))
    finally:
        after=build_fingerprint();w.close()
        if after!=before:e.failures.append(dict(check='frozen-build',error='Production .output changed'))
        scope='native-evidence-and-expanded-diff' if args.native_evidence_only else 'import-library-and-paired-evidence'
        limits=['No provider or model execution. Reports use explicit bound fixture attempts.']
        limits+=['Actual Chrome200% loaded incomplete evidence and desktop1440 expanded diff.'] if args.native_evidence_only else ['Desktop1440/1024, real coarse390 and actual Chrome200% import dialog; native focus fallback covered by separate desktop suite.','Large native upload closes immediately; transient Reading status may finish before observation. No artificial delays or interception.']
        summary=dict(passed=not e.failures and not e.geometry,testScope=scope,checks=e.checks,failures=e.failures,geometryViolations=e.geometry,capturedStates=len(list(output.glob('*.png'))),sourceBuildBeforeSha256=before,sourceBuildAfterSha256=after,sourceBuildFingerprint='SHA256 of sorted .output relative paths and file bytes',candidateAndReleaseUnchanged=unchanged,paidModelCalls=0,externalWrites=0,domMutation=False,focusInjection=False,fixture='Private PostgreSQL + real service + frozen console build + OIDC/TLS',limits=limits)
        (output/'summary.json').write_text(json.dumps(summary,indent=2)+'\n');print(json.dumps(summary,indent=2),flush=True)
    return 0 if summary['passed'] else 1


if __name__=='__main__':raise SystemExit(main())
