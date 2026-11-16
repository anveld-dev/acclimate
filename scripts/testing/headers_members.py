#!/usr/bin/env python3
"""Real header/member checks on disposable PostgreSQL and OIDC fixtures."""
import argparse
import json
import sys
from pathlib import Path
from types import SimpleNamespace
ROOT=Path(__file__).resolve().parents[2]
sys.path.insert(0,str(ROOT))
from playwright.sync_api import expect
from scripts.bdd.run import pg_bin
from scripts.bdd.world import World
from scripts.bdd.layout import capture_layout
from scripts.testing.compact_console import visit
from scripts.testing.desktop_layouts import build_fingerprint


def run(args):
    output=args.output.resolve();output.mkdir(parents=True,exist_ok=False,mode=0o700)
    w=World(pg_bin(args.pg_bin));before=build_fingerprint();checks=[]
    def record(name): checks.append(name)
    try:
        w.start();w.fresh_scenario(SimpleNamespace(effective_tags=[]))
        w.enable_email()
        w.sign_in('admin','operator');w.browser_actor='admin';w.create_workspace();w.publish_initial('Read the relevant skill before changing instructions.')
        people={}
        for actor,name in [('member','Alex Rivera'),('other','Alex Rivera'),('guest','Taylor Chen')]:
            w.sign_in(actor,'opaque-'+actor)
            w.call('POST','/v1/auth/sessions',dict(issuer=w.issuer,subject='opaque-'+actor,displayName=name,email=actor+'@example.test',emailVerified=True),actor='login-authority')
            people[actor]=w.sessions[actor]['userId']
        assert people['member']!=people['other']
        assert w.call('GET',w.root+'/users/'+people['member'],actor='admin')['role'] is None
        w.call('PUT',w.root+'/memberships/'+people['member'],dict(role='viewer'),actor='admin')
        w.call('PUT',w.root+'/memberships/'+people['other'],dict(role='editor'),actor='admin')
        w.h.identity().next_token_claims={'name':'Morgan Lee'}
        b=w.browser();p=b.page
        headers=[]
        for name,path in [('bundles',b.workspace_path()),('connections',b.workspace_path('connections')),('members',b.workspace_path('members')),('content',b.bundle_path('content'))]:
            visit(p,b,path)
            header=p.locator('.page-header');expect(header).to_be_visible()
            headers.append(header.locator('h1').evaluate('(el)=>({left:el.getBoundingClientRect().left,font:getComputedStyle(el).fontSize,weight:getComputedStyle(el).fontWeight})'))
            capture_layout(p,output,'1440-'+name)
        assert len({round(h['left']) for h in headers})==1,headers
        assert len({(h['font'],h['weight']) for h in headers})==1,headers
        record('workspace and bundle headers share typography and left alignment')
        visit(p,b,b.workspace_path('members'))
        expect(p.get_by_role('cell').filter(has=p.get_by_text('Morgan Lee',exact=True))).to_be_visible()
        expect(p.get_by_text('Alex Rivera',exact=True)).to_have_count(2)
        record('signed display name renders; duplicate names remain separate accounts')
        for width in [1024,390,320]:
            p.set_viewport_size(dict(width=width,height=900))
            capture_layout(p,output,str(width)+'-members')
            geometry=p.evaluate('''()=>({width:innerWidth,page:document.documentElement.scrollWidth,table:document.querySelector('table').getBoundingClientRect().width,container:document.querySelector('[data-slot="table-container"]').clientWidth})''')
            assert geometry['page']<=width+1 and geometry['table']<=geometry['container']+1,geometry
        record('member table fits desktop and 320px without hidden horizontal scrolling')
        p.set_viewport_size(dict(width=1440,height=1000))
        row=p.get_by_role('row').filter(has=p.get_by_text('Viewer',exact=True))
        member_index=row.evaluate('(el)=>[...el.parentElement.children].indexOf(el)')
        row=p.locator('.workspace-member-row').nth(member_index)
        row.locator('.member-role-trigger').click()
        p.get_by_role('menuitemradio').filter(has_text='Editor').click()
        expect(p.get_by_role('dialog')).to_have_count(0)
        expect(row.locator('.member-role-trigger')).to_have_text('Editor')
        expect(row.locator('.member-role-trigger')).to_be_focused()
        assert w.call('GET',w.root+'/users/'+people['member'],actor='admin')['role']=='editor'
        record('existing member role updates in its row without opening a dialog')
        p.get_by_role('button',name='Invite member',exact=True).click()
        capture_layout(p,output,'invite-member-empty')
        p.get_by_label('Email',exact=True).fill('guest@example.test')
        add=p.get_by_role('dialog',name='Invite member',exact=True)
        assert w.call('GET',w.root+'/users/'+people['guest'],actor='admin')['role'] is None
        capture_layout(p,output,'invite-member-ready')
        add.get_by_role('button',name='Send invite',exact=True).click()
        expect(add).to_have_count(0)
        invitation=next(value for value in w.call('GET',w.root+'/invitations',actor='admin')['items'] if value['email']=='guest@example.test')
        assert w.call('GET',w.root+'/users/'+people['guest'],actor='admin')['role'] is None
        w.call('POST','/v1/invitations/'+invitation['id']+'/accept',actor='guest')
        p.reload(wait_until='networkidle')
        record('email invitation preserves access until the verified recipient explicitly accepts')
        guest=p.get_by_role('row').filter(has=p.get_by_text('Taylor Chen',exact=True))
        guest.locator('.member-actions-trigger').click()
        p.get_by_role('menuitem',name='Remove access',exact=True).click()
        remove=p.get_by_role('alertdialog',name='Remove workspace access?',exact=True)
        expect(remove).to_contain_text('Taylor Chen');capture_layout(p,output,'remove-confirmation')
        remove.get_by_role('button',name='Keep member',exact=True).click()
        expect(guest.locator('.member-actions-trigger')).to_be_focused()
        assert w.call('GET',w.root+'/users/'+people['guest'],actor='admin')['role']=='viewer'
        guest.locator('.member-actions-trigger').click()
        p.get_by_role('menuitem',name='Remove access',exact=True).click()
        remove.get_by_role('button',name='Remove member',exact=True).click()
        expect(remove).to_have_count(0)
        assert w.call('GET',w.root+'/users/'+people['guest'],actor='admin')['role'] is None
        record('remove confirmation identifies the account; cancel preserves and confirm revokes access')
        p.get_by_role('row').filter(has=p.get_by_text('Morgan Lee',exact=True)).locator('.member-role-trigger').click()
        p.get_by_role('menuitemradio').filter(has_text='Viewer').click()
        expect(p.get_by_role('status')).to_contain_text('Add another administrator')
        assert w.call('GET',w.root+'/users/'+w.sessions['admin']['userId'],actor='admin')['role']=='admin'
        record('last administrator cannot be demoted')
        p.get_by_role('button',name='Invite member',exact=True).click()
        p.get_by_label('Email',exact=True).fill('owner@example.test')
        p.get_by_label('Workspace role',exact=True).select_option('admin')
        p.get_by_role('dialog').get_by_role('button',name='Cancel',exact=True).click()
        p.get_by_role('button',name='Invite member',exact=True).click()
        expect(p.get_by_label('Email',exact=True)).to_have_value('')
        expect(p.get_by_label('Workspace role',exact=True)).to_have_value('viewer')
        p.get_by_role('dialog').get_by_role('button',name='Cancel',exact=True).click()
        record('reopening an invitation clears the email and resets the role to Viewer')
        anonymous=b.browser.new_context(ignore_https_errors=True)
        public=anonymous.new_page()
        destination=b.bundle_path('content')+'?path=AGENTS.md'
        public.goto(b.base+destination,wait_until='networkidle')
        expect(public.get_by_label('Fixture subject')).to_be_visible()
        assert 'Welcome to Acclimate' not in public.locator('body').inner_text()
        public.get_by_label('Fixture subject').fill('operator')
        public.get_by_role('button',name='Sign in to fixture').click()
        expect(public).to_have_url(b.base+destination)
        anonymous.close()
        record('signed-out visits go directly to the identity provider and preserve the requested page')
        assert not b.errors,b.errors
        result=dict(passed=True,checks=checks,browserErrors=0,paidModelCalls=0,sourceBuildBeforeSha256=before,sourceBuildAfterSha256=build_fingerprint())
        assert result['sourceBuildAfterSha256']==before
        (output/'summary.json').write_text(json.dumps(result,indent=2)+'\n')
        print(json.dumps(result,indent=2))
    finally:w.close()

if __name__=='__main__':
    parser=argparse.ArgumentParser(description=__doc__);parser.add_argument('--pg-bin');parser.add_argument('--output',required=True,type=Path)
    run(parser.parse_args())
