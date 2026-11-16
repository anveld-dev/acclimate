#!/usr/bin/env python3
"""Evaluation UI evidence on real disposable PostgreSQL/OIDC, with simulated results."""
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


def seed(w,count=60):
    w.start();w.fresh_scenario(SimpleNamespace(effective_tags=[]));w.publish_initial('',files=FILES)
    w.draft=w.call('POST',w.channel+'/drafts',dict(baseVersionId=w.original['version']['id'],baseRevision=w.original['revision'],payload=dict(schemaVersion=1,files=[dict(f,text=f['text']+'\nCheck the receipt before retrying.\n') for f in FILES])))
    w.settings=dict(parentVersionId=w.original['version']['id'],parentDigest=w.original['version']['digest'],candidateVersionId=w.draft['snapshotVersion']['id'],candidateDigest=w.draft['snapshotVersion']['digest'],datasetRevision='receipt-safety-fixture-v2',graderRevision='receipt-contract-v3',runtime=dict(executor='fixture',model='none'),expectedCases=[dict(caseId=f'retry-{i//5:02}',repetition=i%5) for i in range(count)])
    w.settings['expectedCases'][7]['caseId']='retry-long-'+('unbroken-'*20)
    w.evaluation=w.call('POST',w.bundle+'/evaluation-requests',dict(w.settings,requireBoundEvidence=True))
    request_path=w.bundle+'/evaluation-requests/'+w.evaluation['id'];attempt='layout-fixture-attempt'
    w.call('POST',request_path+'/start',dict(attemptId=attempt),actor='evaluator')
    def outcome(value):return dict(executionStatus='completed',gradingStatus='scored',reward=value,usage=dict(costUsd=0.002),outputRef='artifact://fixture/receipt.json')
    results=[]
    for i,case in enumerate(w.settings['expectedCases'][:-1]):
        parent=outcome(0 if i%3==0 else 1);candidate=outcome(1 if i%3!=1 else 0)
        if i==1:candidate=dict(executionStatus='infrastructure_failed',gradingStatus='missing',reward=None,usage=None,error='Fixture worker lost its connection before the outcome was confirmed.')
        if i==2:candidate=outcome(-0.5);candidate.update(executionStatus='task_failed',error='Fixture task failed: original operation identity was not retained. '+('long-error-'*60),outputRef='artifact://fixture/'+('reference-'*60)+'.json')
        if i==3:parent.pop('usage')
        results.append(dict(case,parent=parent,candidate=candidate))
    w.report=w.call('POST',w.bundle+'/comparisons',dict(w.settings,evaluation=dict(requestId=w.evaluation['id'],attemptId=attempt),results=results),actor='evaluator')
    w.call('POST',request_path+'/finish',dict(attemptId=attempt,comparisonId=w.report['id']),actor='evaluator')
    w.queued=w.call('POST',w.bundle+'/evaluation-requests',dict(w.settings,datasetRevision='queued-fixture',requireBoundEvidence=True))


def run(args):
    out=args.output.resolve();out.mkdir(parents=True,exist_ok=False,mode=0o700);w=World(pg_bin(args.pg_bin));before=build_fingerprint();checks=[]
    try:
        seed(w,args.cases);b=w.browser();p=b.page
        route=b.bundle_path('changes',candidate=w.draft['snapshotVersion']['id'],request=w.evaluation['id'],comparison=w.report['id'])
        for width in [1440,1024,390,320]:
            p.set_viewport_size(dict(width=width,height=1000));visit(p,b,route)
            expect(p.get_by_role('region',name='Observed paired rewards',exact=True)).to_be_visible()
            expect(p.get_by_role('table',name='Evaluation case outcomes',exact=True)).to_be_visible()
            assert p.evaluate('document.documentElement.scrollWidth<=innerWidth+1')
            capture_layout(p,out,f'review-{width}')
            p.locator('.comparison-evidence').scroll_into_view_if_needed();capture_layout(p,out,f'cases-{width}')
            checks.append(f'Full review and cases fit {width}px')
        if args.verify:
            from scripts.testing.evaluation_layout_checks import verify
            verify(w,b,p,route,out,checks)
        assert not b.errors,b.errors;assert before==build_fingerprint()
        summary=dict(passed=True,checks=checks,browserErrors=b.errors,sourceBuildSha256=before,modelCalls=0,expectedPairs=args.cases,limits=['Simulated outcomes on disposable PostgreSQL/OIDC.','Only listed interactions tested; no native zoom/screen-reader or live model qualification.'])
        (out/'summary.json').write_text(json.dumps(summary,indent=2)+'\n');print(json.dumps(summary,indent=2),flush=True)
    except BaseException as error:
        if getattr(w,'browser_fixture',None):
            w.browser_fixture.page.screenshot(path=str(out/'failure.png'),full_page=True)
            (out/'failure-accessibility.txt').write_text(w.browser_fixture.page.locator('body').aria_snapshot())
        (out/'failure.json').write_text(json.dumps(dict(error=str(error),checks=checks),indent=2)+'\n');raise
    finally:w.close()

if __name__=='__main__':
    parser=argparse.ArgumentParser(description=__doc__);parser.add_argument('--pg-bin');parser.add_argument('--output',required=True,type=Path);parser.add_argument('--verify',action='store_true');parser.add_argument('--cases',type=int,default=60);run(parser.parse_args())
