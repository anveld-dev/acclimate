#!/usr/bin/env python3
"""Workspace layout evidence on disposable PostgreSQL/OIDC; no model calls."""
import argparse
import json
import sys
from pathlib import Path
from types import SimpleNamespace
ROOT=Path(__file__).resolve().parents[2]
sys.path.insert(0,str(ROOT))
from playwright.sync_api import expect
from scripts.bdd.world import World
from scripts.bdd.run import pg_bin
from scripts.bdd.layout import capture_layout
from scripts.testing.compact_console import visit
from scripts.testing.desktop_layouts import build_fingerprint


def seed(w):
    w.start();w.fresh_scenario(SimpleNamespace(effective_tags=[]));w.enable_email()
    w.sign_in('admin','operator');w.browser_actor='admin';w.create_workspace()
    w.publish_initial('Read the relevant skill before changing instructions.')
    for name in ['Support triage','Payment operations','Code review','Research assistant']:
        w.call('POST',w.root+'/bundle-setups',dict(name=name,channel='stable',origin='created',reason='Explicit workspace layout fixture; no evaluation.',payload=dict(schemaVersion=1,files=[dict(path='AGENTS.md',kind='instruction',text='Check the source evidence before answering.')]),compatibilityTarget='generic'))
    w.create_integration();w.issue('content-read');w.issue('receipt-write')
    for stage in ['verified','prepared','started']:
        w.call('POST',w.integration_path+'/receipts',dict(w.delivery_event(),stage=stage),actor='receipt-writer')
    for name in ['Review worker','Support production','Nightly research']:
        w.empty_connection=w.call('POST',w.root+'/connections',dict(displayName=name,bundleId=w.setup['bundle']['id'],channel='stable'))
    for actor,name,role in [('member','Alex Rivera','viewer'),('other','Alex Rivera','editor'),('guest','Taylor Chen','viewer')]:
        w.sign_in(actor,'opaque-'+actor)
        user=w.call('POST','/v1/auth/sessions',dict(issuer=w.issuer,subject='opaque-'+actor,displayName=name,email=actor+'@example.test',emailVerified=True),actor='login-authority')
        w.call('PUT',w.root+'/memberships/'+user['userId'],dict(role=role),actor='admin')
    w.call('POST',w.root+'/invitations',dict(email='jordan@example.test',role='editor'),actor='admin')
    w.h.identity().next_token_claims={'name':'Morgan Lee'}


def run(args):
    out=args.output.resolve();out.mkdir(parents=True,exist_ok=False,mode=0o700)
    w=World(pg_bin(args.pg_bin));before=build_fingerprint();checks=[]
    try:
        seed(w);b=w.browser();p=b.page
        routes=dict(bundles=b.workspace_path(),connections=b.workspace_path('connections'),members=b.workspace_path('members'))
        routes['connection-detail']=routes['connections']+'?integration='+w.integration['id']
        if args.record:
            from scripts.testing.workspace_video import record
            record(w,b,routes,out)
            checks.append('Real agent-browser walkthrough recorded on disposable data without secret issuance')
        for width in ([] if args.record else [1440,1024,390,320]):
            p.set_viewport_size(dict(width=width,height=1000))
            for name,path in routes.items():
                visit(p,b,path)
                expect(p.locator('.page-header')).to_be_visible()
                assert p.evaluate('document.documentElement.scrollWidth <= innerWidth + 1'),(width,name)
                capture_layout(p,out,f'{name}-{width}')
            checks.append(f'Four workspace views fit {width}px')
        p.set_viewport_size(dict(width=1440,height=1000))
        visit(p,b,routes['members'])
        p.get_by_role('button',name='Invite member',exact=True).click()
        capture_layout(p,out,'member-invite-dialog')
        p.keyboard.press('Escape')
        visit(p,b,routes['bundles'])
        p.get_by_role('button',name='New bundle',exact=True).click()
        capture_layout(p,out,'bundle-create')
        if args.verify:
            from scripts.testing.workspace_layout_checks import verify
            verify(w,b,p,routes,out,checks)
        assert not b.errors,b.errors
        assert before==build_fingerprint(),'Build changed during capture'
        summary=dict(passed=True,checks=checks,browserErrors=b.errors,paidModelCalls=0,sourceBuildSha256=before,limits=['Disposable PostgreSQL/OIDC and simulated app reports.','Only listed states exercised; viewport reflow does not establish native zoom or screen-reader behavior.'])
        (out/'summary.json').write_text(json.dumps(summary,indent=2)+'\n')
        print(json.dumps(summary,indent=2),flush=True)
    except BaseException as error:
        if getattr(w,'browser_fixture',None):
            p=w.browser_fixture.page
            if not p.is_closed():
                p.screenshot(path=str(out/'failure.png'),full_page=True)
                (out/'failure-accessibility.txt').write_text(p.locator('body').aria_snapshot())
        (out/'failure.json').write_text(json.dumps(dict(checks=checks,error=str(error)),indent=2)+'\n')
        raise
    finally:w.close()

if __name__=='__main__':
    parser=argparse.ArgumentParser(description=__doc__);parser.add_argument('--pg-bin');parser.add_argument('--verify',action='store_true');parser.add_argument('--record',action='store_true');parser.add_argument('--output',required=True,type=Path)
    run(parser.parse_args())
