#!/usr/bin/env python3
"""Source workspace reflow and interaction evidence on disposable PostgreSQL/OIDC."""
import argparse,json,sys
from pathlib import Path
from types import SimpleNamespace
ROOT=Path(__file__).resolve().parents[2];sys.path.insert(0,str(ROOT))
from playwright.sync_api import expect
from scripts.bdd.world import World
from scripts.bdd.run import pg_bin
from scripts.bdd.layout import capture_layout
from scripts.testing.compact_console import FILES,visit
from scripts.testing.desktop_layouts import build_fingerprint


def run(args):
    out=args.output.resolve();out.mkdir(parents=True,exist_ok=False,mode=0o700)
    w=World(pg_bin(args.pg_bin));before=build_fingerprint();checks=[]
    try:
        w.start();w.fresh_scenario(SimpleNamespace(effective_tags=[]))
        deep='skills/review/references/one/two/three/four/five/six/seven/ambiguous-outcome-operation-identity-checks.md'
        files=FILES+[dict(path=deep,kind='skill',text='# Deep reference\n\nKeep the original operation identity.\n')]
        w.publish_initial('',files=files)
        b=w.browser();p=b.page;p.set_viewport_size(dict(width=1440,height=1000))
        routes=dict(content=b.bundle_path('content',path=deep))
        for name,path in routes.items():
            visit(p,b,path)
            frame=p.get_by_test_id('file-browser')
            outer=frame.locator('..')
            outer.evaluate('e=>e.style.width="430px"')
            capture_layout(p,out,name+'-constrained-before')
            state=frame.evaluate('e=>({width:e.clientWidth,columns:getComputedStyle(e).gridTemplateColumns,toggleVisible:!!e.querySelector(".file-navigator-toggle").getClientRects().length,bodyHidden:e.querySelector(".file-navigator-body").hidden})')
            (out/(name+'-state.json')).write_text(json.dumps(state,indent=2)+'\n')
        if args.verify:
            from scripts.testing.source_workspace_checks import verify
            verify(w,b,p,routes,out,checks)
        assert not b.errors,b.errors
        assert before==build_fingerprint()
        result=dict(passed=True,checks=checks,sourceBuildSha256=before,browserErrors=b.errors,modelCalls=0,limits=['Fixture PostgreSQL/OIDC, no model calls.','Viewport/container reflow does not establish native zoom or screen-reader behavior.'])
        (out/'summary.json').write_text(json.dumps(result,indent=2)+'\n');print(json.dumps(result,indent=2),flush=True)
    except BaseException as error:
        if getattr(w,'browser_fixture',None):
            w.browser_fixture.page.screenshot(path=str(out/'failure.png'),full_page=True)
            (out/'failure-accessibility.txt').write_text(w.browser_fixture.page.locator('body').aria_snapshot())
        (out/'failure.json').write_text(json.dumps(dict(error=str(error),checks=checks),indent=2)+'\n');raise
    finally:w.close()

if __name__=='__main__':
    parser=argparse.ArgumentParser(description=__doc__);parser.add_argument('--pg-bin');parser.add_argument('--output',required=True,type=Path);parser.add_argument('--verify',action='store_true');run(parser.parse_args())
