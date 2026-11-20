#!/usr/bin/env python3
"""Isolated baseline/C/D geometry experiment on a frozen real application.

EXPERIMENT ONLY: page.add_style_tag and the reviewed D style-variable/listener
helper are explicitly allowed. No application DOM node moves, content/focus or
storage injection, interception, providers/models, browser saves or publication.
"""
import re
import argparse
import base64
import hashlib
import json
from pathlib import Path
import struct
import sys
import tempfile
import time
from types import SimpleNamespace

ROOT=Path(__file__).resolve().parents[2];sys.path.insert(0,str(ROOT))
from playwright.sync_api import expect
from scripts.bdd.run import pg_bin
from scripts.bdd.world import World
from scripts.bdd.interactions import open_details, open_files
from scripts.testing.compact_console import FILES, visit
from scripts.testing.desktop_layouts import build_fingerprint
from scripts.bdd.layout import inspect_layout

WORKSPACE_NAME='Production review engineering workspace for background agent integrations and preserved retry contracts'
BUNDLE_NAME='Production review instructions and reusable memory for background agent integrations'
CHANNEL='production-review-integrations-preserved-retry-contracts'
PROTOTYPES=ROOT/'docs/design/desktop-layouts-v12/experiments'


def fixture(w):
    w.sign_in('admin','operator');w.browser_actor='admin';project='desktop12-'+w.h.project.removeprefix('bdd-')
    w.call('POST','/v1/workspaces',dict(id=project,name=WORKSPACE_NAME),actor='admin');w.h.project=project;w.root='/v1/workspaces/'+project;w.actor='admin'
    files=FILES+[dict(path=f'memory/release-guidelines/production-retry-contracts/provider-specific-evidence/fixture-{i:02d}.md',kind='memory',text=f'# Fixture {i:02d}\nPreserve real file selection and browser-only review.\n') for i in range(5,25)]
    setup=w.call('POST',w.root+'/bundle-setups',dict(name=BUNDLE_NAME,origin='created',channel=CHANNEL,payload=dict(schemaVersion=1,files=files),reason='Explicit disposable v12 geometry fixture.'))
    w.setup=setup;w.bundle=w.root+'/bundles/'+setup['bundle']['id'];w.channel=w.bundle+'/channels/'+CHANNEL;w.original=setup['resolution']
    candidate=dict(schemaVersion=1,files=[dict(f,text=f['text']+'\nDesktop12 candidate change.\n' if f['path'] in ('AGENTS.md',files[19]['path']) else f['text']) for f in files])
    draft=w.call('POST',w.channel+'/drafts',dict(baseVersionId=w.original['version']['id'],baseRevision=w.original['revision'],payload=candidate));path=w.channel+'/drafts/'+draft['id']
    settings=dict(parentVersionId=w.original['version']['id'],parentDigest=w.original['version']['digest'],candidateVersionId=draft['snapshotVersion']['id'],candidateDigest=draft['snapshotVersion']['digest'],datasetRevision='desktop12-isolated-fixture',runtime=dict(executor='fixture',model='none'),graderRevision='desktop12-fixture-grader',expectedCases=[dict(caseId=name,repetition=0) for name in ('zero-to-one','failed-candidate','missing-pair')])
    request=w.call('POST',w.bundle+'/evaluation-requests',dict(**settings,requireBoundEvidence=True));request_path=w.bundle+'/evaluation-requests/'+request['id'];attempt='desktop12-isolated-attempt';w.call('POST',request_path+'/start',dict(attemptId=attempt),actor='admin')
    good=dict(executionStatus='completed',gradingStatus='scored',reward=0,usage=dict(costUsd=0),outputRef='Parent fixture output',error=None)
    report=w.call('POST',w.bundle+'/comparisons',dict(**settings,evaluation=dict(requestId=request['id'],attemptId=attempt),results=[dict(caseId='zero-to-one',repetition=0,parent=good,candidate=dict(good,reward=1,outputRef='Candidate fixture output')),dict(caseId='failed-candidate',repetition=0,parent=good,candidate=dict(executionStatus='task_failed',gradingStatus='failed',reward=None,usage=None,outputRef='Candidate failure output',error='Explicit synthetic fixture failure.'))]),actor='admin')
    w.call('POST',request_path+'/finish',dict(attemptId=attempt,comparisonId=report['id']),actor='admin')
    return dict(files=files,candidate=candidate,draft=draft,draftPath=path,report=report,request=request,attempt=attempt)


class Experiment:
    def __init__(self,output):
        self.output=output;self.results=[];self.inputs={}
        folder=output/'inputs';folder.mkdir()
        self.manifest=json.loads((PROTOTYPES/'manifest.json').read_text());(folder/'manifest.json').write_text(json.dumps(self.manifest,indent=2)+'\n')
        for name in ('c.css','d.css','d-layout.js','source-size.js'):
            text=(PROTOTYPES/name).read_text();self.inputs[name]=text;(folder/name).write_text(text)
        self.hashes={key:hashlib.sha256(value.encode()).hexdigest() for key,value in self.inputs.items()}
        assert self.hashes==self.manifest['files'],'Prototype inputs differ from frozen manifest'
        self.style=None;self.extraStyle=None;self.sensitivityHash=None

    def cleanup(self,p):
        # Remove only experiment-owned style/listener variables, never app nodes.
        p.evaluate('()=>window.__desktopExperimentDCleanup?.()')
        p.evaluate('()=>window.__desktopExperimentSourceCleanup?.()')
        if self.extraStyle:
            try:self.extraStyle.evaluate('el=>el.remove()')
            except Exception:pass
            self.extraStyle=None
        if self.style:
            try:self.style.evaluate('el=>el.remove()')
            except Exception:pass
            self.style=None
        assert p.evaluate("!['--d-scope-top','--d-files-top','--d-footer-height','--d-files-available','--experiment-source-height'].some(k=>document.documentElement.style.getPropertyValue(k))")

    def apply(self,p,mode):
        self.cleanup(p)
        if mode!='baseline':self.style=p.add_style_tag(content=self.inputs[mode+'.css'])
        if mode=='d':p.evaluate(self.inputs['d-layout.js'])
        if mode!='baseline':p.evaluate(self.inputs['source-size.js'])
        p.wait_for_timeout(250)

    def sensitivity(self,p):
        manifest=json.loads((PROTOTYPES/'sensitivity-manifest.json').read_text());name='d-baseline-workspace-name.css';text=(PROTOTYPES/name).read_text();self.sensitivityHash=hashlib.sha256(text.encode()).hexdigest();assert self.sensitivityHash==manifest['extraFiles'][name]
        (self.output/'inputs'/name).write_text(text);(self.output/'inputs'/'sensitivity-manifest.json').write_text(json.dumps(manifest,indent=2)+'\n');self.extraStyle=p.add_style_tag(content=text);p.wait_for_timeout(250)

    def attempt(self,p,case,name,action):
        print('TASK '+case['name']+' '+name,flush=True)
        try:
            detail=action();case['tasks'].append(dict(task=name,passed=True,details=detail));return True
        except Exception as error:
            case['tasks'].append(dict(task=name,passed=False,error=str(error).split('Call log:')[0].strip()[:700]));return False

    def capture(self,p,name):
        p.evaluate('''async()=>{await document.fonts.ready;await Promise.all(document.getAnimations().filter(a=>a.playState==='running'&&Number.isFinite(a.effect.getComputedTiming().endTime)).map(a=>a.finished.catch(()=>{})));await new Promise(requestAnimationFrame);await new Promise(requestAnimationFrame)}''');p.wait_for_timeout(500)
        result=p.evaluate('''()=>{
          const rect=e=>{if(!e||!e.getClientRects().length)return null;const r=e.getBoundingClientRect();return {x:r.x,y:r.y,width:r.width,height:r.height,right:r.right,bottom:r.bottom}};
          const clip=e=>{const r=rect(e);if(!r)return null;let left=Math.max(0,r.x),right=Math.min(innerWidth,r.right),top=Math.max(0,r.y),bottom=Math.min(innerHeight,r.bottom);for(let a=getComputedStyle(e).position==='fixed'?null:e.parentElement;a;a=a.parentElement){const s=getComputedStyle(a),b=a.getBoundingClientRect();if(/auto|hidden|scroll|clip/.test(s.overflowX)){left=Math.max(left,b.left);right=Math.min(right,b.right)}if(/auto|hidden|scroll|clip/.test(s.overflowY)){top=Math.max(top,b.top);bottom=Math.min(bottom,b.bottom)}if(s.position==='fixed')break}return {width:Math.max(0,right-left),height:Math.max(0,bottom-top),left,top,right,bottom}};
          const target=e=>{const r=rect(e),c=clip(e);if(!r)return null;const x=r.x+r.width/2,y=r.y+r.height/2,hit=x>=0&&x<innerWidth&&y>=0&&y<innerHeight?document.elementFromPoint(x,y):null;return {text:(e.getAttribute('aria-label')||e.textContent).trim().slice(0,160),bounds:r,clip:c,hit:!!hit&&(e===hit||e.contains(hit)),hitMethod:'elementFromPoint at raw control center',disabled:e.matches(':disabled')}};
          const source=document.querySelector('textarea#draft-text'),r=rect(source),c=source?clip(source):null;
          const rail=document.querySelector('.file-navigator'),files=[...document.querySelectorAll('.content-file-button')].map(e=>({path:e.getAttribute('data-file-path'),...target(e)}));
          const controls=document.querySelector('.file-navigator-controls'),controlsBox=rect(controls),railClip=rail?clip(rail):null,firstThreeHeight=files.slice(0,3).reduce((sum,file)=>sum+(file.bounds?.height??0),0);
          const scope=document.querySelector('.bundle-scope-header'),nav=document.querySelector('.workspace-header-navigation');
          const overlap=(a,b)=>a&&b?Math.max(0,Math.min(a.right,b.right)-Math.max(a.x,b.x))*Math.max(0,Math.min(a.bottom,b.bottom)-Math.max(a.y,b.y)):0;
          return {viewport:{width:innerWidth,height:innerHeight,dpr:devicePixelRatio,coarse:matchMedia('(pointer:coarse)').matches},scrollY,pageWidth:document.documentElement.scrollWidth,fixedClipAccounting:'Fixed rail escapes non-containing workbench ancestor clipping; descendant clip stops at viewport-fixed rail.',
            source:r?{...r,visibleHeight:c.height,visibleWidth:c.width,totalArea:r.width*r.height,visibleArea:c.width*c.height}:null,
            header:rect(document.querySelector('.workspace-desktop-header')),canvas:rect(document.querySelector('.workspace-column')),scope:rect(scope),workspaceName:document.querySelector('.workspace-switcher-name')?.textContent,bundleTitle:scope?.querySelector('h1')?.textContent,
            rail:rail?{bounds:rect(rail),clip:clip(rail),scrollTop:rail.scrollTop,clientHeight:rail.clientHeight,scrollHeight:rail.scrollHeight,overflowY:getComputedStyle(rail).overflowY}:null,
            fileBudget:rail?{visibleRailHeight:railClip.height,headingSearchTypeHeight:controlsBox?.height??0,firstThreeRowsHeight:firstThreeHeight,requiredHeight:(controlsBox?.height??0)+firstThreeHeight,controlsAndThreeRowsFit:railClip.height>=(controlsBox?.height??0)+firstThreeHeight-.5}:null,
            railScrollers:[...document.querySelectorAll('.file-navigator,.file-navigator *')].filter(e=>e.getClientRects().length&&/auto|scroll/.test(getComputedStyle(e).overflowY)&&e.scrollHeight>e.clientHeight+1).map(e=>({tag:e.tagName,classes:e.className,bounds:rect(e),scrollTop:e.scrollTop,scrollHeight:e.scrollHeight,clientHeight:e.clientHeight})),
            search:target(document.querySelector('#draft-search')||document.querySelector('#file-search')),files,fullyVisibleFiles:files.filter(f=>f.bounds&&f.clip&&f.clip.height>=f.bounds.height-.5&&f.clip.width>=f.bounds.width-.5&&f.hit).map(f=>f.path),
            controls:[...document.querySelectorAll('header button,header a[href],.file-navigator button,.file-navigator input,.file-navigator select,.draft-utility-footer button,.bundle-scope-header button,.bundle-scope-header a[href]')].map(target).filter(Boolean),
            scopeGlobalNavigationOverlapArea:overlap(rect(scope),rect(nav)),railGlobalNavigationOverlapArea:overlap(rect(rail),rect(nav)),
            dVariables:Object.fromEntries(['--d-scope-top','--d-files-top','--d-footer-height','--d-files-available'].map(k=>[k,getComputedStyle(document.documentElement).getPropertyValue(k).trim()])),
            sourceHeightVariable:getComputedStyle(document.documentElement).getPropertyValue('--experiment-source-height').trim(),
            inlineFiles:[...document.querySelectorAll('.file-navigator-toggle')].map(target),globalSheetFiles:[...document.querySelectorAll('[data-slot=sheet-content] .file-navigator')].length,
            evidence:rect(document.querySelector('.comparison-evidence')),evidenceTable:rect(document.querySelector('.comparison-evidence-table')),diff:rect(document.querySelector('.content-diff'))};
        }''')
        before=inspect_layout(p);cdp=p.context.new_cdp_session(p)
        try:bitmap=base64.b64decode(cdp.send('Page.captureScreenshot',dict(format='png',fromSurface=True))['data'])
        finally:cdp.detach()
        after=inspect_layout(p);keys=('viewport','viewportHeight','width','scrollY','visualViewportOffsetTop');stable={k:before[k] for k in keys}=={k:after[k] for k in keys}
        result['capture']=dict(method='CDP Page.captureScreenshot',pixels=list(struct.unpack('>II',bitmap[16:24])),stable=stable);(self.output/(name+'.png')).write_bytes(bitmap);(self.output/(name+'.json')).write_text(json.dumps(result,indent=2)+'\n')
        assert stable,'Screenshot changed route geometry';return result


def click(p,control):
    # Opening a real menu/dialog aria-hides its invoker; do not resolve that
    # role locator again until after Escape restores its visible context.
    control.click(timeout=2500);return dict(nativeClickCompleted=True)


def reset_top(p):
    p.mouse.move(p.viewport_size['width']-4,150);p.mouse.wheel(0,-10000);p.wait_for_timeout(150)


def draft_case(w,b,e,p,f,mode,width,height,coarse):
    name=f'{mode}-{width}x{height}'+('-coarse' if coarse else '');case=dict(name=name,mode=mode,viewport=[width,height],coarse=coarse,tasks=[]);e.results.append(case)
    visit(p,b,b.bundle_path('changes',channel=CHANNEL,draft=f['draft']['id'],path='AGENTS.md'));e.apply(p,mode);editor=p.get_by_label('Content',exact=True);expect(editor).to_have_value(f['candidate']['files'][0]['text']);case['initial']=e.capture(p,name+'-source-initial')
    def budget():
        value=case['initial']['fileBudget'];assert value['controlsAndThreeRowsFit'],value;return value
    e.attempt(p,case,'rail-heading-search-type-and-three-rows-budget',budget)
    for index in (2,19):
        file=f['candidate']['files'][index]
        def select(file=file):
            result=click(p,p.get_by_role('button',name='Open '+file['path'],exact=True));expect(editor).to_have_value(file['text']);return result
        e.attempt(p,case,'select-file-'+str(index+1),select)
    def search():
        field=p.get_by_label('Find an entry',exact=True);field.fill('fixture-20',timeout=2500);expect(p.locator('.content-file-button')).to_have_count(1,timeout=2500);p.get_by_role('button',name='Clear filters',exact=True).click(timeout=2500);expect(p.locator('.content-file-button')).to_have_count(24);return True
    e.attempt(p,case,'search-and-clear',search)
    def kind():
        p.get_by_label('Entry type',exact=True).select_option('memory',timeout=2500);expect(p.locator('.content-file-button')).to_have_count(21,timeout=2500);p.get_by_role('button',name='Clear filters',exact=True).click(timeout=2500);return True
    e.attempt(p,case,'kind-filter-and-clear',kind)
    def add():
        trigger=p.get_by_role('button',name='Add entry',exact=True);click(p,trigger);expect(p.get_by_role('menuitem',name='Add instruction',exact=True)).to_be_visible();p.keyboard.press('Escape');expect(p.get_by_role('menu')).to_have_count(0);expect(trigger).to_be_focused();return True
    e.attempt(p,case,'add-menu-open-and-escape',add)
    e.attempt(p,case,'post-file-tasks-capture',lambda:e.capture(p,name+'-source-after-file-tasks'))
    # Fresh real route clears any failed test's filters/menu while keeping this
    # mode's experiment stylesheet/listeners deliberately reapplied below.
    e.cleanup(p);visit(p,b,b.bundle_path('changes',channel=CHANNEL,draft=f['draft']['id'],path='AGENTS.md'));e.apply(p,mode)
    def members():
        click(p,p.get_by_role('navigation',name='Main navigation',exact=True).get_by_role('link',name='Members',exact=True));expect(p.get_by_role('heading',name='Members',exact=True)).to_be_visible();p.go_back(wait_until='networkidle');expect(p.get_by_label('Content',exact=True)).to_have_value(f['candidate']['files'][0]['text']);return True
    e.attempt(p,case,'global-members-and-browser-back',members)
    def back():
        click(p,p.get_by_role('link',name='Back to changes',exact=True));expect(p.get_by_role('heading',name='Make a change',exact=True)).to_be_visible();p.go_back(wait_until='networkidle');expect(p.get_by_label('Content',exact=True)).to_be_visible();return True
    e.attempt(p,case,'bundle-back-and-browser-back',back)
    e.attempt(p,case,'refresh',lambda:click(p,p.get_by_role('button',name='Refresh',exact=True)))
    def utilities():
        trigger=p.get_by_role('button',name='Import files into this draft',exact=True);click(p,trigger);expect(p.get_by_role('dialog',name='Import files into this draft',exact=True)).to_be_visible();p.keyboard.press('Escape');expect(trigger).to_be_focused()
        for label in ('Saved snapshot history','Draft details'):
            control=p.get_by_role('button',name=label,exact=True);click(p,control);expect(control).to_have_attribute('aria-expanded','true');control.click()
        return True
    e.attempt(p,case,'import-history-and-details-utilities',utilities);e.cleanup(p);return case


def review_case(w,b,e,p,f,mode,width,height,coarse):
    name=f'{mode}-{width}x{height}'+('-coarse' if coarse else '')+'-review';case=dict(name=name,mode=mode,viewport=[width,height],coarse=coarse,tasks=[]);e.results.append(case)
    visit(p,b,b.bundle_path('changes',channel=CHANNEL,draft=f['draft']['id'],candidate=f['draft']['snapshotVersion']['id'],generation=f['draft']['generation']));e.apply(p,mode)
    def loaded():
        p.get_by_role('link',name=re.compile(r'^Inspect evidence for ')).click(timeout=2500);p.get_by_role('tab',name='Details',exact=True).click();evidence=p.locator('.comparison-evidence');expect(evidence.get_by_role('row')).to_have_count(4)
        for value in ('Incomplete evidence; not a win','Reward 0 · cost $0','Reward missing · cost unknown','Missing outcome · grade missing · cost unknown',f['report']['parentVersionId'],f['report']['candidateVersionId'],f['request']['id']):expect(evidence).to_contain_text(value)
        expect(p.get_by_role('button',name='Review release with this evidence',exact=True)).to_be_disabled();evidence.scroll_into_view_if_needed();case['loadedEvidence']=e.capture(p,name+'-incomplete-evidence');return True
    e.attempt(p,case,'actual-inspect-fully-loaded-incomplete-evidence',loaded)
    def diff():
        p.get_by_role('tab',name='Files changed',exact=False).click();expect(p.locator('.content-diff').get_by_role('heading')).to_have_count(2);expect(p.locator('.content-diff')).to_contain_text('+ Desktop12 candidate change.');p.locator('.content-diff').scroll_into_view_if_needed();case['expandedDiff']=e.capture(p,name+'-expanded-full-diff');return True
    e.attempt(p,case,'expanded-two-file-real-diff',diff);e.cleanup(p);return case


def narrow_guards(w,b,e,f):
    results=[]
    for native in (False,True):
        temporary=tempfile.TemporaryDirectory(prefix='acclimate-desktop12-native-') if native else None
        context=b.playwright.chromium.launch_persistent_context(temporary.name,channel='chrome',headless=True,no_viewport=True,ignore_https_errors=True,args=['--window-size=1280,900']) if native else b.browser.new_context(ignore_https_errors=True,viewport=dict(width=390,height=844),has_touch=True,storage_state=b.context.storage_state())
        try:
            if native:
                b.sign_in(context);p=context.pages[0];visit(p,b,b.bundle_path('content',channel=CHANNEL));before=p.evaluate('({width:innerWidth,dpr:devicePixelRatio})');p.goto('chrome://settings/appearance',wait_until='domcontentloaded');p.evaluate('chrome.settingsPrivate.setDefaultZoom(2)');visit(p,b,b.bundle_path('content',channel=CHANNEL));p.wait_for_function('w=>Math.abs(innerWidth-w)<2',arg=before['width']/2);assert p.evaluate('devicePixelRatio')==before['dpr']*2
            else:p=context.new_page()
            p.set_default_timeout(3000)
            for mode in ('baseline','c','d'):
                name=('native200' if native else '390-coarse')+'-'+mode;case=dict(name=name,mode=mode,tasks=[]);e.results.append(case)
                def run():
                    visit(p,b,b.bundle_path('changes',channel=CHANNEL,draft=f['draft']['id'],path='AGENTS.md'));e.apply(p,mode);toggle=p.get_by_role('button',name='Files (24)',exact=True);expect(toggle).to_be_visible();expect(toggle).to_have_attribute('aria-expanded','false');assert toggle.locator('xpath=ancestor::*[@data-slot="sheet-content"]').count()==0
                    toggle.click();expect(toggle).to_have_attribute('aria-expanded','true');file=f['candidate']['files'][2];p.get_by_role('button',name='Open '+file['path'],exact=True).click();expect(toggle).to_have_attribute('aria-expanded','false');expect(toggle).to_be_focused();expect(p.get_by_label('Content',exact=True)).to_have_value(file['text'])
                    menu=p.get_by_role('button',name='Open navigation',exact=True);menu.click();sheet=p.get_by_role('dialog',name='Acclimate',exact=True);expect(sheet).to_be_visible();expect(sheet.locator('.file-navigator')).to_have_count(0);p.keyboard.press('Escape');expect(sheet).to_have_count(0);expect(menu).to_be_focused();capture=e.capture(p,name+'-inline-files-outside-global-sheet');assert capture['globalSheetFiles']==0;assert not capture['dVariables']['--d-files-available'];e.cleanup(p);return dict(inlineFiles=True,selectionFocusReturn=True,noFilesInGlobalSheet=True,actualNativeZoom=native)
                e.attempt(p,case,'baseline-narrow-inline-files-contract',run);results.append(case)
        finally:
            context.close()
            if temporary:temporary.cleanup()
    return results


def tiny_reach_guards(w,b,e,f):
    p=b.page;p.set_viewport_size(dict(width=1440,height=900))
    for mode in ('baseline','c','d'):
        case=dict(name=mode+'-1440x900-corrected-menu-utility',mode=mode,tasks=[]);e.results.append(case);visit(p,b,b.bundle_path('changes',channel=CHANNEL,draft=f['draft']['id'],path='AGENTS.md'));e.apply(p,mode)
        def add():
            trigger=p.get_by_role('button',name='Add entry',exact=True);click(p,trigger);expect(p.get_by_role('menuitem',name='Add instruction',exact=True)).to_be_visible();e.capture(p,case['name']+'-add-menu');p.keyboard.press('Escape');expect(p.get_by_role('menu')).to_have_count(0);expect(trigger).to_be_focused();return True
        e.attempt(p,case,'native-add-menu-and-escape-restores-invoker',add)
        def utilities():
            trigger=p.get_by_role('button',name='Import files into this draft',exact=True);click(p,trigger);expect(p.get_by_role('dialog',name='Import files into this draft',exact=True)).to_be_visible();e.capture(p,case['name']+'-import-dialog');p.keyboard.press('Escape');expect(trigger).to_be_focused()
            for label in ('Saved snapshot history','Draft details'):
                control=p.get_by_role('button',name=label,exact=True);click(p,control);expect(control).to_have_attribute('aria-expanded','true');control.click()
            return True
        e.attempt(p,case,'native-import-history-details-and-return',utilities);e.cleanup(p)


def main():
    parser=argparse.ArgumentParser(description=__doc__);parser.add_argument('--pg-bin');parser.add_argument('--expected-build-hash',required=True);parser.add_argument('--visibility-supplement-only',action='store_true');parser.add_argument('--final-supplement-only',action='store_true');parser.add_argument('--narrow-only',action='store_true');parser.add_argument('--output',type=Path,default=ROOT/'artifacts/desktop12-experiment');args=parser.parse_args();output=args.output.resolve();output.mkdir(parents=True,exist_ok=False,mode=0o700)
    e=Experiment(output);w=World(pg_bin(args.pg_bin));before=build_fingerprint();errors=[];persisted=False;runtime_errors=[]
    try:
        assert before==args.expected_build_hash==e.manifest['sourceBuildSha256'],'Frozen build differs from GO/manifest';w.start();w.fresh_scenario(SimpleNamespace(effective_tags=[]));f=fixture(w);b=w.browser();p=b.page;p.set_default_timeout(3000);p.on('pageerror',lambda error:runtime_errors.append(str(error)))
        initial=dict(release=w.call('GET',w.channel),promotions=w.call('GET',w.channel+'/releases')['items'],draft=w.call('GET',f['draftPath']),payload=w.call('GET',w.bundle+'/versions/'+f['draft']['snapshotVersion']['id']+'/payload'),requests=w.call('GET',w.bundle+'/evaluation-requests')['items'])
        coarse=b.browser.new_context(ignore_https_errors=True,viewport=dict(width=1024,height=700),has_touch=True,storage_state=b.context.storage_state());phone=coarse.new_page();phone.set_default_timeout(3000);phone.on('pageerror',lambda error:runtime_errors.append(str(error)))
        try:
            for width,height,touch,page in (() if args.narrow_only else (((1440,900,False,p),(1440,700,False,p)) if args.final_supplement_only else ((1440,900,False,p),(1440,700,False,p),(1024,700,True,phone)))):
                if not touch:page.set_viewport_size(dict(width=width,height=height))
                for mode in (('d',) if args.visibility_supplement_only or args.final_supplement_only else ('baseline','c','d')):
                    start=len(runtime_errors)
                    try:
                        if args.visibility_supplement_only or args.final_supplement_only:
                            name=f'd-{width}x{height}'+('-coarse' if touch else '')+('-workspace-name-sensitivity' if args.final_supplement_only else '-fixed-visibility');case=dict(name=name,mode=mode,viewport=[width,height],coarse=touch,tasks=[]);e.results.append(case)
                            visit(page,b,b.bundle_path('changes',channel=CHANNEL,draft=f['draft']['id'],path='AGENTS.md'));e.apply(page,mode)
                            if args.final_supplement_only:e.sensitivity(page)
                            case['initial']=e.capture(page,name+'-initial')
                            if args.final_supplement_only:
                                def budget():
                                    value=case['initial']['fileBudget'];assert value['controlsAndThreeRowsFit'],value;return value
                                e.attempt(page,case,'rail-heading-search-type-and-three-rows-budget',budget)
                                def identity():
                                    title=page.locator('.workspace-desktop-header .workspace-switcher-name');expect(title).to_have_text(WORKSPACE_NAME);title.hover();expect(page.get_by_role('tooltip')).to_have_text(WORKSPACE_NAME);page.keyboard.press('Escape');return True
                                e.attempt(page,case,'existing-full-identity-tooltip-preserved',identity)
                            e.attempt(page,case,'native-search-click',lambda:click(page,page.get_by_label('Find an entry',exact=True)))
                            def native_kind():
                                result=click(page,page.get_by_label('Entry type',exact=True));page.keyboard.press('Escape');return result
                            e.attempt(page,case,'native-kind-click-and-escape',native_kind)
                            e.capture(page,name+'-after-native-control-clicks')
                        else:draft_case(w,b,e,page,f,mode,width,height,touch);review_case(w,b,e,page,f,mode,width,height,touch)
                    except Exception as error:errors.append(dict(mode=mode,viewport=[width,height],error=str(error).split('Call log:')[0][:700]))
                    if len(runtime_errors)>start:errors.append(dict(mode=mode,viewport=[width,height],runtimeErrors=runtime_errors[start:]))
                    try:e.cleanup(page)
                    except Exception as error:errors.append(dict(mode=mode,check='experiment-cleanup',error=str(error)[:300]))
        finally:coarse.close()
        if args.final_supplement_only:tiny_reach_guards(w,b,e,f)
        if not args.visibility_supplement_only:narrow_guards(w,b,e,f)
        final=dict(release=w.call('GET',w.channel),promotions=w.call('GET',w.channel+'/releases')['items'],draft=w.call('GET',f['draftPath']),payload=w.call('GET',w.bundle+'/versions/'+f['draft']['snapshotVersion']['id']+'/payload'),requests=w.call('GET',w.bundle+'/evaluation-requests')['items']);assert initial==final,'Browser experiment mutated persisted fixture state';persisted=True
    except Exception as error:errors.append(dict(check='fixture-or-invariants',error=str(error).split('Call log:')[0][:900]))
    finally:
        after=build_fingerprint();w.close()
        if after!=before:errors.append(dict(check='frozen-build',error='Production .output changed'))
        tasks=[dict(case=case['name'],**task) for case in e.results for task in case['tasks']];measurements=[dict(case=case['name'],mode=case['mode'],viewport=case.get('viewport'),source=case.get('initial',{}).get('source'),visibleFiles=len(case.get('initial',{}).get('fullyVisibleFiles',[])),search=case.get('initial',{}).get('search'),dAvailable=case.get('initial',{}).get('dVariables',{}).get('--d-files-available'),scopeGlobalNavigationOverlapArea=case.get('initial',{}).get('scopeGlobalNavigationOverlapArea'),railScrollers=case.get('initial',{}).get('railScrollers')) for case in e.results if 'initial' in case]
        summary=dict(experimentOnly=True,shippingQualification=False,domStyleMutation=True,domNodeMoves=False,contentInjection=False,focusInjection=False,storageInjection=False,responseInterception=False,paidModelCalls=0,providerCalls=0,persistedStateUnchanged=persisted,sourceBuildBeforeSha256=before,sourceBuildAfterSha256=after,sourceBuildFingerprint='SHA256 of all sorted .output relative paths and bytes',prototypeInputSha256=e.hashes,workspaceNameSensitivitySha256=e.sensitivityHash,capturedStates=len(list(output.glob('*.png'))),fixtureErrors=errors,taskPasses=sum(task['passed'] for task in tasks),taskFailures=[task for task in tasks if not task['passed']],measurements=measurements,cases=e.results,limits=['CSS and the reviewed D style-variable/listener helper are intentionally injected into real frozen-build pages; this is not final UI qualification.','Full navigation removes prior document state; cleanup explicitly removes experiment-owned stylesheet and D variables/listeners.','24 real files; long workspace/bundle/channel; private service/OIDC/TLS; incomplete comparison uses synthetic bound outcomes, with no provider/model execution.','Tasks record inability to reach real controls as failure; scope/content are never hidden or moved to manufacture success.','C/D source heights reflect this experiment sizing policy, including utility-footer reservation; they are not architectural ceilings. 1024px sidebar cases are stress tests, not a mandatory shipping breakpoint.'])
        (output/'summary.json').write_text(json.dumps(summary,indent=2)+'\n');print(json.dumps({key:summary[key] for key in ('experimentOnly','capturedStates','taskPasses','taskFailures','fixtureErrors','persistedStateUnchanged','sourceBuildBeforeSha256','sourceBuildAfterSha256','measurements')},indent=2),flush=True)
    return 0 if persisted and before==after and not errors else 1


if __name__=='__main__':raise SystemExit(main())
