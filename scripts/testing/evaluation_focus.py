#!/usr/bin/env python3
"""Mount the actual components in Vite to test React replacement without a reload."""
import argparse,json,sys
from pathlib import Path
ROOT=Path(__file__).resolve().parents[2];sys.path.insert(0,str(ROOT))
from playwright.sync_api import expect
from scripts.bdd.world import World
from scripts.bdd.run import pg_bin
from scripts.testing.evaluation_layouts import seed
from scripts.testing.compact_console import visit
from scripts.bdd.layout import capture_layout


def run(args):
    out=args.output.resolve();out.mkdir(parents=True,exist_ok=False,mode=0o700)
    w=World(pg_bin(args.pg_bin));w.dev_console=True;checks=[]
    try:
        seed(w);b=w.browser();p=b.page;visit(p,b,b.bundle_path('content'))
        p.evaluate('''async report=>{
          const node=document.createElement('div');node.id='evaluation-focus-fixture';
          Object.assign(node.style,{position:'fixed',inset:'0 0 0 64px',zIndex:'9999',overflow:'auto',background:'var(--background)',padding:'20px'});
          document.body.append(node);
          const fixture=await import('/tests/fixtures/evaluation-focus.tsx');
          window.evaluationFixture=fixture.mountFixture(node,report);
        }''',w.report)
        area=p.locator('#evaluation-focus-fixture');trigger=area.get_by_role('button',name='Inspect case retry-00 / 2',exact=True)
        trigger.focus();p.keyboard.press('Enter');expect(trigger).to_be_focused()
        p.evaluate("report=>window.evaluationFixture.render({...report,id:'replacement-report'})",w.report)
        heading=area.get_by_role('heading',name='Evaluation case results',exact=True)
        expect(heading).to_be_focused();expect(heading).to_be_visible()
        expect(area.locator('.evaluation-pair-detail').first).to_be_hidden()
        capture_layout(p,out,'comparison-focus-recovered')
        outside=area.locator('#outside-evidence');outside.focus()
        p.evaluate("report=>window.evaluationFixture.render({...report,id:'another-report'})",w.report)
        expect(outside).to_be_focused()
        checks.append('Actual React comparison replacement restores removed control focus to a visible results heading and preserves outside focus')
        expect(area.locator('.recharts-bar-rectangle')).to_have_count(2)
        expect(area.locator('.recharts-wrapper')).to_be_visible()
        expect(area.locator('[data-chart]')).to_be_visible()
        capture_layout(p,out,'shared-chart-smoke')
        checks.append('Shared shadcn ChartContainer renders Recharts bars with signed fixture rewards and theme configuration')
        assert not b.errors,b.errors
        (out/'summary.json').write_text(json.dumps(dict(passed=True,checks=checks,browserErrors=b.errors,modelCalls=0,limits=['Mounted actual components in development Vite; no page reload or backend report mutation.','No native screen-reader or live model qualification.']),indent=2)+'\n')
        print(json.dumps(dict(passed=True,checks=checks)),flush=True)
    except BaseException as error:
        if getattr(w,'browser_fixture',None):w.browser_fixture.page.screenshot(path=str(out/'failure.png'),full_page=True)
        (out/'failure.json').write_text(json.dumps(dict(error=str(error),checks=checks,browserErrors=getattr(getattr(w,'browser_fixture',None),'errors',[])),indent=2)+'\n');raise
    finally:w.close()

if __name__=='__main__':
    parser=argparse.ArgumentParser(description=__doc__);parser.add_argument('--pg-bin');parser.add_argument('--output',required=True,type=Path);run(parser.parse_args())
