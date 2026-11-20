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


def library_fixtures(w):
    setups=[]
    for name in ('Review library alpha','Review library beta'):
        setups.append(w.call('POST',w.root+'/bundle-setups',dict(name=name,origin='created',channel='stable',payload=dict(schemaVersion=1,files=FILES),reason='Disposable library inventory fixture.')))
    w.call('POST',w.bundle+'/channels/preview/releases',dict(versionId=w.original['version']['id'],expectedRevision='0',unevaluatedReason='Disposable second channel fixture.'))
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


def main():
    parser=argparse.ArgumentParser(description=__doc__);parser.add_argument('--pg-bin');parser.add_argument('--output',type=Path,default=ROOT/'artifacts/desktop8-workflows')
    args=parser.parse_args();output=args.output.resolve();output.mkdir(parents=True,exist_ok=False,mode=0o700)
    e=Evidence(output,False);w=World(pg_bin(args.pg_bin));b=None;before=build_fingerprint();unchanged=False
    try:
        w.start();w.fresh_scenario(SimpleNamespace(effective_tags=[]));w.publish_initial('',files=FILES)
        inventory = library_fixtures(w)
        release_before = w.call('GET', w.channel)
        b = w.browser()
        e.run('library-bound-inventory-and-search', b.page, lambda: library(w, b, e, inventory))
        assert w.call('GET', w.channel) == release_before
        assert not b.errors,b.errors;unchanged=True
    except Exception as error:e.failures.append(dict(check='fixture-or-invariants',error=str(error),traceback=traceback.format_exc()))
    finally:
        after=build_fingerprint();w.close()
        if after!=before:e.failures.append(dict(check='frozen-build',error='Production .output changed'))
        summary=dict(passed=not e.failures and not e.geometry,testScope="library",checks=e.checks,failures=e.failures,geometryViolations=e.geometry,capturedStates=len(list(output.glob('*.png'))),sourceBuildBeforeSha256=before,sourceBuildAfterSha256=after,sourceBuildFingerprint='SHA256 of sorted .output relative paths and file bytes',releaseUnchanged=unchanged,paidModelCalls=0,externalWrites=0,domMutation=False,focusInjection=False,fixture='Private PostgreSQL + real service + frozen console build + OIDC/TLS',limits=["Disposable fixture service"])
        (output/'summary.json').write_text(json.dumps(summary,indent=2)+'\n');print(json.dumps(summary,indent=2),flush=True)
    return 0 if summary['passed'] else 1


if __name__=='__main__':raise SystemExit(main())
