#!/usr/bin/env python3
"""Verify grouped bundle scope using real private fixtures and the frozen build.

No builds, external writes, providers, models, DOM mutation, or focus injection.
Acceptance is declared before measurement: long 1024px title <=3 lines and
source top <=386px; ordinary 1440px source top <=200px, width >=1180px,
height >=640px. All routes retain full identity, navigation, and legibility.
"""
import argparse
import json
from pathlib import Path
import sys
import traceback
from types import SimpleNamespace
from urllib.parse import urlsplit

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT))
from playwright.sync_api import expect
from scripts.bdd.run import pg_bin
from scripts.bdd.world import World
from scripts.bdd.layout import tab_to
from scripts.testing.compact_console import FILES, visit
from scripts.testing.compact_edges import activate
from scripts.testing.desktop_layouts import Evidence, build_fingerprint, navigation

# Exact real fixture identity from compact_edges.long_identity.
LONG_PATH = 'memory/release-guidelines/production-retry-contracts/provider-specific-evidence/retained-context.md'
LONG_NAME = 'Production review instructions and reusable memory for background agent integrations'
LONG_CHANNEL = 'production-review-integrations-preserved-retry-contracts'
LONG_TEXT = '# Long path fixture\nKeep full paths readable without hover.\n'


def scope_metrics(page):
    return page.evaluate('''() => {
      const rect = el => {if (!el) return null; const r=el.getBoundingClientRect(); return {top:r.top,left:r.left,width:r.width,height:r.height,right:r.right,bottom:r.bottom};};
      const heading=document.querySelector('.bundle-scope-identity h1');
      const select=document.querySelector('.bundle-channel-picker select');
      const header=document.querySelector('.bundle-scope-header');
      const lineHeight=parseFloat(getComputedStyle(heading).lineHeight);
      const textRange=document.createRange(); textRange.selectNodeContents(heading);
      const directory=document.querySelector('.file-row-directory');
      const directoryRange=document.createRange(); if(directory)directoryRange.selectNodeContents(directory);
      const selected=document.querySelector('.selected-file-path');
      return {header:rect(header),primary:rect(document.querySelector('.bundle-scope-primary')),
        secondary:rect(document.querySelector('.bundle-scope-secondary')),
        title:{text:heading.textContent,bounds:rect(heading),lineHeight,lines:Math.round(heading.getBoundingClientRect().height/lineHeight),textBounds:rect(textRange),overflow:getComputedStyle(heading).overflow,textOverflow:getComputedStyle(heading).textOverflow},
        channel:{tag:select.tagName,value:select.value,selectedText:select.selectedOptions[0].textContent,bounds:rect(select)},
        directory:directory?{text:directory.textContent,wbr:directory.querySelectorAll('wbr').length,bounds:rect(directory),lineCount:new Set([...directoryRange.getClientRects()].filter(r=>r.width>0).map(r=>r.top)).size,scrollWidth:directory.scrollWidth,clientWidth:directory.clientWidth}:null,
        selectedPath:selected?{text:selected.textContent,wbr:selected.querySelectorAll('wbr').length}:null,
        railDirectories:[...document.querySelectorAll('.file-row-directory')].map(el=>{
          const range=document.createRange();range.selectNodeContents(el);
          return {path:el.closest('[data-file-path]')?.getAttribute('data-file-path'),text:el.textContent,
            wbr:el.querySelectorAll('wbr').length,slashBreaks:[...el.querySelectorAll('wbr')].every(br=>br.previousSibling?.textContent.endsWith('/')),
            lineCount:new Set([...range.getClientRects()].filter(r=>r.width>0).map(r=>r.top)).size,
            scrollWidth:el.scrollWidth,clientWidth:el.clientWidth};
        })};
    }''')


def capture_scope(w, b, evidence, page, route, name, width, height, *, coarse=False, ordinary=False):
    page.set_viewport_size(dict(width=width, height=height))
    visit(page, b, route)
    identity='BDD bundle' if ordinary else LONG_NAME
    channel='stable' if ordinary else LONG_CHANNEL
    expect(page.get_by_role('heading', name=identity, exact=True)).to_be_visible()
    expect(page.get_by_label('Channel', exact=True)).to_have_value(channel)
    checked=navigation(page)
    # Native input and the full four-view navigation remain keyboard reachable.
    picker=page.get_by_label('Channel', exact=True)
    tab_to(page, picker)
    expect(picker).to_be_focused()
    page.mouse.move(1,1);page.mouse.wheel(0,-10000)
    page.wait_for_function('scrollY <= 1')
    metrics=evidence.capture(page,name,coarse=coarse)
    scope=scope_metrics(page)
    metrics['scopeProof']=scope
    (evidence.output/(name+'.json')).write_text(json.dumps(metrics,indent=2)+'\n')
    assert not metrics['violations'],metrics['violations']
    assert scope['title']['text']==identity,scope['title']
    assert scope['channel']['tag']=='SELECT' and scope['channel']['value']==channel,scope['channel']
    assert scope['channel']['selectedText']==channel,scope['channel']
    assert [row['name'] for row in checked if row['navigation']=='Bundle navigation']==['Content','Changes','Releases','Evaluations'],checked
    text=scope['title']['textBounds'];heading=scope['title']['bounds']
    assert text['left']>=heading['left']-1 and text['right']<=heading['right']+1 and text['bottom']<=heading['bottom']+1,scope['title']
    assert scope['primary']['bottom']<=scope['secondary']['top']+1 or abs(scope['primary']['top']-scope['secondary']['top'])<=1,scope
    source=metrics['editor'] or metrics['publishedContent']
    if not ordinary:
        if width==1024:
            assert scope['title']['lines']<=3,scope['title']
            if source:
                assert source['top']<=386,dict(source=source,scope=scope)
        if metrics['selectedPath']:
            assert metrics['selectedPath']['text']==LONG_PATH,metrics['selectedPath']
            assert metrics['selectedPath']['scrollWidth']<=metrics['selectedPath']['clientWidth']+1,metrics['selectedPath']
            assert scope['selectedPath']['text']==LONG_PATH and scope['selectedPath']['wbr']==LONG_PATH.count('/'),scope['selectedPath']
        if scope['directory']:
            directory=LONG_PATH.rsplit('/',1)[0]+'/'
            assert scope['directory']['text']==directory,scope['directory']
            assert scope['directory']['wbr']==directory.count('/'),scope['directory']
            assert scope['directory']['lineCount']>1,scope['directory']
            assert scope['directory']['scrollWidth']<=scope['directory']['clientWidth']+1,scope['directory']
    elif metrics['editor']:
        assert source['top']<=200 and source['width']>=1180 and source['height']>=640,source
        rail=scope['railDirectories']
        assert len(rail)==len(FILES),rail
        for row in rail:
            expected=row['path'].rsplit('/',1)[0]+'/' if '/' in row['path'] else '/'
            assert row['text']==expected and row['wbr']==expected.count('/') and row['slashBreaks'],row
            assert row['scrollWidth']<=row['clientWidth']+1,row
        nested=next(row for row in rail if row['path']=='skills/review/references/checks.md')
        assert nested['lineCount']>1,nested
    details=dict(viewport=[width,height],coarse=coarse,titleLines=scope['title']['lines'],header=scope['header'],source=source,navigation=checked,channel=channel)
    print('METRICS '+name+' '+json.dumps(details),flush=True)
    return details


def main():
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--pg-bin')
    parser.add_argument('--ordinary-only',action='store_true',help='Supplementary exact text and slash-boundary proof for ordinary file rails')
    parser.add_argument('--output',type=Path,required=True)
    args=parser.parse_args()
    output=args.output.resolve();output.mkdir(parents=True,exist_ok=False,mode=0o700)
    evidence=Evidence(output,False);w=World(pg_bin(args.pg_bin));b=None
    before=build_fingerprint();after=None;release_unchanged=False
    try:
        w.start();w.fresh_scenario(SimpleNamespace(effective_tags=[]));w.publish_initial('',files=FILES)
        setup=w.call('POST',w.root+'/bundle-setups',dict(name=LONG_NAME,origin='created',channel=LONG_CHANNEL,
          payload=dict(schemaVersion=1,files=[dict(path=LONG_PATH,kind='memory',text=LONG_TEXT)]),reason='Disposable grouped scope layout fixture.'))
        long_bundle=w.root+'/bundles/'+setup['bundle']['id']
        long_channel=long_bundle+'/channels/'+LONG_CHANNEL
        initial=w.call('GET',long_channel)
        requests_before=w.call('GET',long_bundle+'/evaluation-requests')['items']
        b=w.browser();page=b.page
        routes={view:b.bundle_path(view,bundle_id=setup['bundle']['id'],channel=LONG_CHANNEL,**(dict(path=LONG_PATH) if view=='content' else {})) for view in ('content','changes','releases','connect')}
        visit(page,b,routes['content'])
        activate(page,page.get_by_role('link',name='Edit entry',exact=True))
        expect(page.get_by_label('Content',exact=True)).to_have_value(LONG_TEXT)
        parsed=urlsplit(page.url);routes['draft']=parsed.path+('?' + parsed.query if parsed.query else '')
        # Report the decisive 1024px result before the wider route matrix.
        for view in (() if args.ordinary_only else ('draft','content','changes','releases','connect')):
            name='long-1024-'+view
            evidence.run(name,page,lambda view=view,name=name:capture_scope(w,b,evidence,page,routes[view],name,1024,900))
        for width,height in (() if args.ordinary_only else ((1440,900),(1920,1080))):
            for view,route in routes.items():
                name=f'long-{width}-{view}'
                evidence.run(name,page,lambda route=route,name=name,width=width,height=height:capture_scope(w,b,evidence,page,route,name,width,height))
        context=b.browser.new_context(ignore_https_errors=True,viewport=dict(width=1024,height=900),has_touch=True,storage_state=b.context.storage_state())
        try:
            coarse_page=context.new_page();coarse_page.set_default_timeout(10000)
            coarse_page.on('pageerror',lambda error:b.errors.append(str(error)))
            for view,route in ({} if args.ordinary_only else routes).items():
                name='long-1024-coarse-'+view
                evidence.run(name,coarse_page,lambda route=route,name=name:capture_scope(w,b,evidence,coarse_page,route,name,1024,900,coarse=True))
        finally:
            context.close()
        # Ordinary scope retains the already-approved editor allocation.
        visit(page,b,b.bundle_path('content',path='AGENTS.md'))
        activate(page,page.get_by_role('link',name='Edit entry',exact=True))
        parsed=urlsplit(page.url);ordinary=parsed.path+('?' + parsed.query if parsed.query else '')
        evidence.run('ordinary-1440-draft',page,lambda:capture_scope(w,b,evidence,page,ordinary,'ordinary-1440-draft',1440,900,ordinary=True))
        assert w.call('GET',long_channel)==initial,'Long release changed during layout review'
        assert w.call('GET',w.channel)['version']==w.original['version'],'Stable World release changed'
        assert w.call('GET',long_bundle+'/evaluation-requests')['items']==requests_before,'Layout review created model work'
        assert not b.errors,b.errors
        release_unchanged=True
    except Exception as error:
        evidence.failures.append(dict(check='fixture-or-invariants',error=str(error),traceback=traceback.format_exc()))
    finally:
        after=build_fingerprint()
        if after!=before:evidence.failures.append(dict(check='frozen-build',error='Production .output changed'))
        w.close()
        baseline={}
        for view,key in (('draft','editor'),('content','publishedContent')):
            value=json.loads((ROOT/'artifacts/layout6-edges-final-3'/f'long-1024-{view}.json').read_text())
            baseline[view]=dict(sourceTop=value[key]['top'],artifact=f'artifacts/layout6-edges-final-3/long-1024-{view}.json')
        summary=dict(passed=not evidence.failures and not evidence.geometry,checks=evidence.checks,failures=evidence.failures,geometryViolations=evidence.geometry,
          capturedStates=len(list(output.glob('*.png'))),baseline=baseline,sourceBuildBeforeSha256=before,sourceBuildAfterSha256=after,
          sourceBuildFingerprint='SHA256 of sorted .output relative paths and file bytes',releaseUnchanged=release_unchanged,
          paidModelCalls=0,externalWrites=0,domMutation=False,focusInjection=False,
          fixture='Private PostgreSQL + real service + existing console build + OIDC/TLS',
          acceptance=dict(long1024TitleMaxLines=3,long1024SourceMaxTop=386,ordinary1440SourceMaxTop=200,ordinary1440SourceMinWidth=1180,ordinary1440SourceMinHeight=640),
          limits=['Source fixtures only; no provider/model execution.','Fine pointer desktop 1024/1440/1920 and actual touch/coarse 1024 context.','Path DOM text and slash-boundary WBR verified; copy/rename behavior covered by separate core suite.'])
        (output/'summary.json').write_text(json.dumps(summary,indent=2)+'\n')
        print(json.dumps(summary,indent=2),flush=True)
    return 0 if summary['passed'] else 1


if __name__=='__main__':
    raise SystemExit(main())
