#!/usr/bin/env python3
"""Suggestion UI captures and checks with disposable PostgreSQL/OIDC and a local fixture provider."""
import argparse,json,sys,time
from pathlib import Path
from types import SimpleNamespace
ROOT=Path(__file__).resolve().parents[2];sys.path.insert(0,str(ROOT))
from playwright.sync_api import expect
from scripts.bdd.world import World
from scripts.bdd.run import pg_bin
from scripts.bdd.layout import capture_layout
from scripts.testing.compact_console import FILES,visit
from scripts.testing.desktop_layouts import build_fingerprint
from scripts.testing.desktop11_workflows import terminal

LONG_PATH='memory/retry-contracts/provider-evidence/long-retained-context-for-background-agents.md'

def seed(w):
    w.start();w.fresh_scenario(SimpleNamespace(effective_tags=['provider_fixture']))
    files=FILES+[dict(path=LONG_PATH,kind='memory',text='Retain original operation identities.')]
    w.publish_initial('',files=files)
    w.files=files
    w.large=w.call('POST',w.root+'/bundle-setups',dict(name='Large scoped suggestion fixture',origin='created',channel='stable',payload=dict(schemaVersion=1,files=files+[dict(path=f'memory/context-{i:02}.md',kind='memory',text='Approved reusable fixture context.') for i in range(24)]),reason='Disposable large-scope UI fixture.'))
    w.draft=w.call('POST',w.channel+'/drafts',dict(baseVersionId=w.original['version']['id'],baseRevision=w.original['revision'],payload=dict(schemaVersion=1,files=files)))
    w.proposals=[]
    for mode in ['valid','outside-paths']:
        w.provider.mode=mode
        value=w.call('POST',w.bundle+'/proposals',dict(parentVersionId=w.original['version']['id'],allowedPaths=['AGENTS.md'],hypothesis='Keep retry decisions grounded in the original payment receipt.',evidence=['A timed-out request can still complete.']))
        w.proposals.append(terminal(w,value))
    w.provider.mode='valid'

def run(args):
    out=args.output.resolve();out.mkdir(parents=True,exist_ok=False,mode=0o700);w=World(pg_bin(args.pg_bin));before=build_fingerprint();checks=[]
    try:
        seed(w);b=w.browser();p=b.page
        for width in [1440,1024,390,320]:
            p.set_viewport_size(dict(width=width,height=1000));visit(p,b,b.bundle_path('changes',proposal='new'))
            expect(p.locator('.proposal-workspace')).to_be_visible()
            assert p.evaluate('document.documentElement.scrollWidth<=innerWidth+1')
            capture_layout(p,out,f'composer-{width}')
            p.get_by_label('Hypothesis',exact=True).fill('Preserve the original receipt and idempotency key after an ambiguous timeout.')
            p.get_by_role('checkbox',name='AGENTS.md',exact=True).check()
            p.get_by_label('Authorized evidence (one item per line)',exact=True).fill('A timed-out operation later returned a confirmed receipt.\nA second attempt caused a duplicate effect.')
            p.get_by_role('checkbox',name='Authorize bundle disclosure',exact=True).check()
            capture_layout(p,out,f'filled-composer-{width}')
            checks.append(f'Composer and filled consent state fit {width}px')
        p.set_viewport_size(dict(width=1440,height=1000))
        # Reloading an edited form deliberately discards fixture-only browser inputs.
        visit(p,b,b.bundle_path('changes'))
        expect(p.get_by_role('region',name='Suggestions',exact=True)).to_contain_text('Ready to review')
        capture_layout(p,out,'changes-overview-1440')
        for value in w.proposals:
            visit(p,b,b.bundle_path('changes',proposal=value['id']))
            expect(p.get_by_role('region',name='Saved change review',exact=True)).to_be_visible()
            capture_layout(p,out,'suggestion-'+value['status'])
        if args.verify:
            from scripts.testing.suggestion_layout_checks import verify
            verify(w,b,p,out,checks)
        assert not b.errors,b.errors;assert before==build_fingerprint()
        result=dict(passed=True,checks=checks,browserErrors=b.errors,sourceBuildSha256=before,paidModelCalls=0,provider='localhost deterministic fixture',limits=['Real disposable PostgreSQL/OIDC; no live provider/model quality claim.','Only listed states are qualified; native zoom and screen readers are untested.'])
        (out/'summary.json').write_text(json.dumps(result,indent=2)+'\n');print(json.dumps(result,indent=2),flush=True)
    except BaseException as error:
        if getattr(w,'browser_fixture',None):
            w.browser_fixture.page.screenshot(path=str(out/'failure.png'),full_page=True)
            (out/'failure-accessibility.txt').write_text(w.browser_fixture.page.locator('body').aria_snapshot())
        (out/'failure.json').write_text(json.dumps(dict(error=str(error),checks=checks),indent=2)+'\n');raise
    finally:w.close()

if __name__=='__main__':
    parser=argparse.ArgumentParser(description=__doc__);parser.add_argument('--pg-bin');parser.add_argument('--output',required=True,type=Path);parser.add_argument('--verify',action='store_true');run(parser.parse_args())
