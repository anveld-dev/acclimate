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
from scripts.testing.compact_console import FILES, select_release, visit
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


def release_facts(page, history):
    expect(page.get_by_test_id('release-decision')).to_have_count(len(history))
    for item in history:
        row = select_release(page, item['revision'])
        expect(row.locator('time')).to_be_visible()
        selected = page.get_by_role('region', name='Selected release', exact=True)
        expect(selected).to_contain_text(item['unevaluatedReason'])
        details = selected.get_by_role('button', name=f"Release details for revision {item['revision']}", exact=True)
        details.click()
        dialog = page.get_by_role('dialog', name='Release details', exact=True)
        for value in (item['id'], item['version']['id'], item['version']['digest'], item['reviewer']):
            expect(dialog).to_contain_text(value)
        page.keyboard.press('Escape')
        expect(details).to_be_focused()


def release_dialogs(w,b,e,p,f,prefix,*,cdp=None):
    old=f['history'][-1];select_release(p,old['revision']);inspect=p.get_by_role('button',name=re.compile(r'^Inspect content for revision '));activate(p,inspect)
    dialog=p.get_by_role('dialog',name='Version content',exact=True);expect(dialog.get_by_text('Loading version…',exact=True)).to_have_count(0)
    expect(dialog.get_by_label('Content of AGENTS.md',exact=True)).to_have_text(FILES[0]['text']);open_details(p,'Version details')
    for value in (old['version']['id'],old['version']['digest']):expect(dialog).to_contain_text(value)
    capture(e,p,prefix+'-historical-version-inspector',cdp=cdp);p.keyboard.press('Escape');expect(dialog).to_have_count(0);expect(inspect).to_be_focused()
    restore=p.get_by_role('button',name=re.compile(r'^Restore revision '));activate(p,restore);dialog=p.get_by_role('dialog',name='Restore revision '+old['revision']+'?',exact=True);expect(dialog).to_be_visible()
    expect(dialog.get_by_role('button',name='Restore version',exact=True)).to_be_disabled()
    reason=dialog.get_by_label('Reason for restoring',exact=True);reason.fill('Reviewing a historical version without changing the release.')
    expect(dialog.get_by_role('button',name='Restore version',exact=True)).to_be_enabled()
    for value in ('BDD bundle','stable',f['history'][0]['revision'],old['version']['id']):expect(dialog).to_contain_text(value)
    capture(e,p,prefix+'-restore-review-dialog',cdp=cdp);p.keyboard.press('Escape');expect(dialog).to_have_count(0);expect(restore).to_be_focused()
    return dict(inspectedVersion=old['version']['id'],fullVersionAndDigest=True,restoreReasonRequired=True,escapedWithoutRestore=True,keyboardReturn=True)


def releases(w,b,e,f):
    p=b.page;results=[]
    for width in (1440,1920,1024):
        p.set_viewport_size(dict(width=width,height=1000));visit(p,b,b.bundle_path('releases'));capture(e,p,str(width)+'-release-history-overview')
        release_facts(p, f['history'])
        capture(e, p, f'{width}-release-selections')
        results.append(dict(width=width, releaseIds=[item['id'] for item in f['history']]))
    results.append(release_dialogs(w,b,e,p,f,'1024'))
    return results


def main():
    parser=argparse.ArgumentParser(description=__doc__);parser.add_argument('--pg-bin');parser.add_argument('--expected-build-hash');parser.add_argument('--output',type=Path,default=ROOT/'artifacts/desktop10-workflows');args=parser.parse_args()
    output=args.output.resolve();output.mkdir(parents=True,exist_ok=False,mode=0o700);e=Evidence(output,False);before=build_fingerprint();w=World(pg_bin(args.pg_bin));unchanged=False
    try:
        if args.expected_build_hash:assert before==args.expected_build_hash,'Frozen build hash differs from GO'
        w.start()
        w.fresh_scenario(SimpleNamespace(effective_tags=[]))
        w.publish_initial('', files=FILES)
        for index in range(2):
            version = w.call('POST', w.bundle + '/versions', dict(
                parentVersionId=w.call('GET', w.channel)['version']['id'],
                payload=dict(schemaVersion=1, files=[dict(f, text=f['text'] + f'\nVersion {index + 2}\n') for f in FILES])))
            w.manual_release(version, reason=f'Disposable release {index + 2}')
        history = w.call('GET', w.channel + '/releases')['items']
        b = w.browser()
        e.run('published-search-url-filter-and-narrow-rail', b.page, lambda: search_matrix(w, b, e))
        e.run('multi-release-facts-and-dialog-keyboard-return', b.page, lambda: releases(w, b, e, dict(history=history)))
        assert w.call('GET', w.channel + '/releases')['items'] == history
        assert not b.errors,b.errors;unchanged=True
    except Exception as error:e.failures.append(dict(check='fixture-or-invariants',error=str(error),traceback=traceback.format_exc()))
    finally:
        after=build_fingerprint();w.close()
        if before!=after:e.failures.append(dict(check='frozen-build',error='Production .output changed'))
        summary=dict(passed=not e.failures and not e.geometry,checks=e.checks,failures=e.failures,geometryViolations=e.geometry,capturedStates=len(list(output.glob('*.png'))),sourceBuildBeforeSha256=before,sourceBuildAfterSha256=after,sourceBuildFingerprint='SHA256 of all sorted .output relative paths and bytes',savedContentAndReleaseHistoryUnchanged=unchanged,allowedWrites="Fixture setup only",paidModelCalls=0,externalWrites=0,domMutation=False,focusInjection=False,storageInjection=False,fixture='Private PostgreSQL + real service + frozen production console + real OIDC/TLS',limits=["Disposable fixture service"])
        (output/'summary.json').write_text(json.dumps(summary,indent=2)+'\n');print(json.dumps(summary,indent=2),flush=True)
    return 0 if summary['passed'] else 1


if __name__=='__main__':raise SystemExit(main())
