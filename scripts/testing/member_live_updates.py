#!/usr/bin/env python3
"""Members polling on real PostgreSQL, including pagination, focus and outages."""
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


def run(args):
    w=World(pg_bin(args.pg_bin))
    checks=[]
    try:
        w.start(); w.fresh_scenario(SimpleNamespace(effective_tags=[])); w.enable_email()
        w.sign_in('admin','operator'); w.browser_actor='admin'; w.create_workspace()
        names={}
        for index in range(36):
            subject=f'member-{index:02}'
            user=w.call('POST','/v1/auth/sessions',dict(issuer=w.issuer,subject=subject,displayName=f'Member {index:02}'),actor='login-authority')
            names[user['userId']]=subject
            w.call('PUT',w.root+'/memberships/'+user['userId'],dict(role='viewer'),actor='admin')
        b=w.browser(); p=b.page; b.visit('/access')
        expect(p.locator('.workspace-member-row')).to_have_count(25)
        p.get_by_role('button',name='Load more members',exact=True).click()
        expect(p.locator('.workspace-member-row')).to_have_count(37)
        members=w.call('GET',w.root+'/memberships?limit=100',actor='admin')['items']
        target=next(item for item in reversed(members) if item['id'] in names)
        row_index=next(index for index,item in enumerate(members) if item['id']==target['id'])
        row=p.locator('.workspace-member-row').nth(row_index)
        row.locator('.member-role-trigger').click()
        p.keyboard.press('Escape')
        expect(row.locator('.member-role-trigger')).to_be_focused()
        assert p.evaluate('scrollY')>0
        navigations=[]
        p.on('framenavigated',lambda frame:navigations.append(True) if frame==p.main_frame else None)
        def rename(value):
            w.call('POST','/v1/auth/sessions',dict(issuer=w.issuer,subject=names[target['id']],displayName=value),actor='login-authority')
        rename('Updated outside page one')
        expect(row.get_by_text('Updated outside page one',exact=True)).to_be_visible(timeout=12000)
        expect(p.locator('.workspace-member-row')).to_have_count(37)
        expect(row.locator('.member-role-trigger')).to_be_focused()
        assert not navigations
        checks.append('Polling updates a second-page member while scrolled and button-focused, preserving all loaded rows and keyboard focus')
        w.h.stop_service()
        # Wait for a real scheduled read to encounter the temporary outage.
        p.wait_for_timeout(6500)
        expect(p.locator('.workspace-member-row')).to_have_count(37)
        expect(row.get_by_text('Updated outside page one',exact=True)).to_be_visible()
        w.h.restart()
        rename('Updated after reconnecting')
        expect(row.get_by_text('Updated after reconnecting',exact=True)).to_be_visible(timeout=12000)
        expect(p.locator('.workspace-member-row')).to_have_count(37)
        assert not navigations
        checks.append('Transient service failure retains rows; polling recovers without navigation or reload')
        # A revoked administrator must lose controls on the next read.
        w.call('PUT',w.root+'/memberships/'+target['id'],dict(role='admin'),actor='admin')
        w.call('PUT',w.root+'/memberships/'+w.sessions['admin']['userId'],dict(role='viewer'),actor='admin')
        expect(p.get_by_role('button',name='Invite member',exact=True)).to_have_count(0,timeout=12000)
        expect(p.locator('.member-role-trigger')).to_have_count(0)
        checks.append('A background role downgrade removes membership controls automatically')
        assert not b.errors,b.errors
        return dict(passed=True,checks=checks,modelCalls=0)
    finally:w.close()


if __name__=='__main__':
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--pg-bin')
    parser.add_argument('--report',type=Path,required=True)
    args=parser.parse_args()
    if args.report.exists():raise SystemExit('Use a fresh report path')
    result=run(args)
    args.report.parent.mkdir(parents=True,exist_ok=True)
    args.report.write_text(json.dumps(result,indent=2)+'\n')
    print(f'{len(result["checks"])} Members live-update checks passed.')
