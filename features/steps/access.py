from behave import given, when, then
from scripts.productization.qualify import payload
@when('the console transport requests workspaces without a session')
def no_person(context):
    context.world.call('GET', '/v1/workspaces', actor='console-transport', expected=401)


@when('a configured application lists its own workspace')
def machine(context):
    w = context.world
    w.projects = w.call('GET', '/v1/workspaces', actor='operator')['items']


@then('its configured project is returned')
def scoped(context):
    w = context.world
    assert any(p['id'] == w.h.project for p in w.projects)


@given('I signed in as the configured operator')
def admin(context):
    context.world.sign_in('admin', 'operator')


@given('I signed in as an ordinary person')
def member(context):
    context.world.sign_in('member', 'ordinary-person')


@when('I create a new workspace')
def bootstrap(context):
    context.world.create_workspace()


@then('I can select it with administrator rights')
def admin_project(context):
    w = context.world
    projects = w.personal_projects('admin')
    assert any(p['id'] == w.new_project['id'] and p['role'] == 'admin' for p in projects)


@when('I try to create a new workspace')
def cannot_bootstrap(context):
    context.world.call('POST', '/v1/workspaces', dict(id='not-operator',name='Denied'), actor='member', expected=403)


@given('an administrator created a workspace with published content')
def people_project(context):
    w = context.world
    w.sign_in('admin', 'operator')
    w.sign_in('member', 'ordinary-person')
    w.create_workspace()
    w.publish_initial('Review code.')


@given('the administrator grants the member the {role} role')
def grant(context, role):
    w = context.world
    w.call('PUT', w.root + '/memberships/' + w.sessions['member']['userId'], dict(role=role), actor='admin')
    w.member_role = role


@when('the member tries to save a draft')
def member_write(context):
    w = context.world
    allowed = w.member_role in ('editor', 'admin')
    w.call('POST', w.channel + '/drafts', dict(baseVersionId=w.original['version']['id'],baseRevision='1',payload=payload('Member edit.')), actor='member', expected=201 if allowed else 403)
    w.member_write_status = w.last_status


@then('the write is {decision}')
def decision(context, decision):
    assert context.world.member_write_status == (201 if decision == 'allowed' else 403)


@then('the member can read the current content')
def read(context):
    w = context.world
    assert w.call('GET', w.channel, actor='member')['version'] == w.original['version']


@when('the administrator changes the member to viewer')
def downgrade(context):
    grant(context, 'viewer')


@when('the administrator removes the member')
def remove(context):
    w = context.world
    w.call('DELETE', w.root + '/memberships/' + w.sessions['member']['userId'], actor='admin')


@when('the member requests the content again')
def removed_read(context):
    w = context.world
    w.call('GET', w.channel, actor='member', expected=403)


@when('the member tries to promote themselves to administrator')
def escalation(context):
    w = context.world
    w.call('PUT', w.root + '/memberships/' + w.sessions['member']['userId'], dict(role='admin'), actor='member', expected=403)


@when("the administrator looks up the member's opaque user ID")
def lookup(context):
    w = context.world
    w.verified_user = w.call('GET', w.root + '/users/' + w.sessions['member']['userId'], actor='admin')


@then('the verified issuer and subject are returned for confirmation')
def verified(context):
    w = context.world
    assert w.verified_user == dict(id=w.sessions['member']['userId'],issuer=w.issuer,subject='ordinary-person',role=None)


@when('I sign out')
def logout(context):
    w = context.world
    w.old_session = dict(w.sessions['member'])
    w.call('DELETE', '/v1/auth/session', actor='member')


@then('the old session cannot read my identity')
def signed_out(context):
    context.world.call('GET', '/v1/auth/session', actor='member', expected=401)


@when('I sign in again while carrying the old cookie')
def again(context):
    w = context.world
    from urllib.request import Request, urlopen
    import json
    # The login authority may rotate a revoked secret; it never treats it as identity.
    response = urlopen(Request(w.h.base + '/v1/auth/sessions',data=json.dumps(dict(issuer=w.issuer,subject='ordinary-person')).encode(),headers={'Authorization':'Bearer '+w.login_token,'Content-Type':'application/json','X-Acclimate-Session':w.old_session['secret']}))
    w.sessions['member'] = json.loads(response.read())


@then('I receive a different valid session for the same person')
def replacement(context):
    w = context.world
    assert w.sessions['member']['secret'] != w.old_session['secret']
    assert w.call('GET', '/v1/auth/session', actor='member')['userId'] == w.old_session['userId']


@when('the final administrator tries to remove their own membership')
def remove_final_admin(context):
    w=context.world
    w.call('DELETE',w.root+'/memberships/'+w.sessions['admin']['userId'],actor='admin',expected=409)

@then('the service preserves the final administrator')
def preserve_final_admin(context):
    w=context.world
    assert w.last['error']['code']=='last_admin'
    current=w.call('GET',w.root+'/users/'+w.sessions['admin']['userId'],actor='admin')
    assert current['role']=='admin'

@when('the administrator inspects current workspace members')
def inspect_members(context):
    w=context.world
    w.member_page=w.call('GET',w.root+'/memberships?limit=1',actor='admin')
    w.member_rows=list(w.member_page['items'])
    if w.member_page['nextCursor']:
        w.member_rows+=w.call('GET',w.root+'/memberships?limit=1&cursor='+w.member_page['nextCursor'],actor='admin')['items']

@then('the member is listed with the current viewer role')
def member_current_role(context):
    w=context.world
    assert next(row for row in w.member_rows if row['id']==w.sessions['member']['userId'])['role']=='viewer'
    assert w.call('GET',w.root+'/users/'+w.sessions['member']['userId'],actor='admin')['role']=='viewer'


@when('I inspect the configured machine workspace before adoption')
def inspect_unowned(context):
    w=context.world
    w.personal_projects=w.personal_projects('admin')
    w.membership_count=w.h.sql("SELECT count(*) FROM project_memberships WHERE project_id='"+w.h.project+"'")


@then('it has no memberships and is absent from my personal workspace list')
def machine_not_owner(context):
    w=context.world
    assert w.membership_count=='0'
    assert not any(row['id']==w.h.project for row in w.personal_projects)


@when('I explicitly adopt that memberless workspace with a reason')
def adopt(context):
    w=context.world
    w.adoption=w.call('POST','/v1/auth/workspace-adoptions',dict(projectId=w.h.project,reason='Reviewed fixture ownership cutover.'),actor='admin')


@then('my administrator membership and immutable adoption audit preserve the original release')
def adopted_exact(context):
    w=context.world
    row=w.adoption
    assert row['projectId']==w.h.project and row['userId']==w.sessions['admin']['userId']
    assert row['reason']=='Reviewed fixture ownership cutover.' and row['currentRole']=='admin'
    assert row['alreadyAdopted'] is False and row['createdAt']
    assert w.call('GET',w.channel,actor='admin')==w.original
    assert any(p['id']==w.h.project and p['role']=='admin' for p in w.personal_projects('admin'))


@given('I explicitly adopted a workspace then transferred its administration')
def transferred_adoption(context):
    w=context.world
    adopt(context)
    w.original_adoption=dict(w.adoption)
    w.sign_in('member','ordinary-person')
    w.call('PUT',w.root+'/memberships/'+w.sessions['member']['userId'],dict(role='admin'),actor='admin')
    w.call('DELETE',w.root+'/memberships/'+w.sessions['admin']['userId'],actor='member')


@when('I retry the original adoption with a different reason')
def retry_adoption(context):
    w=context.world
    w.adoption=w.call('POST','/v1/auth/workspace-adoptions',dict(projectId=w.h.project,reason='This must not replace the audit.'),actor='admin')


@then('the original audit is returned without restoring my removed membership')
def historical_only(context):
    w=context.world
    assert w.adoption==dict(w.original_adoption,alreadyAdopted=True,currentRole=None)
    assert not any(p['id']==w.h.project for p in w.personal_projects('admin'))
    w.call('GET',w.root+'/memberships',actor='admin',expected=403)


@when('I attempt to adopt that already owned workspace')
def owned_adoption(context):
    w=context.world
    w.call('POST','/v1/auth/workspace-adoptions',dict(projectId=w.h.project,reason='Cannot override membership ownership.'),actor='admin',expected=409)


@then('existing workspace ownership is preserved')
def owned_preserved(context):
    assert context.world.last['error']['code']=='workspace_owned'


@when('I request browser identity using a machine grant with {session}')
def machine_identity(context,session):
    from urllib.request import Request,urlopen
    from urllib.error import HTTPError
    w=context.world
    headers={'Authorization':'Bearer '+w.h.tokens['operator']}
    if session=='a live session': headers['X-Acclimate-Session']=w.sessions['admin']['secret']
    try: response=urlopen(Request(w.h.base+'/v1/auth/session',headers=headers),timeout=10)
    except HTTPError as error: response=error
    w.last_status=response.status
    assert response.status==401


@when('the trusted login authority submits a different issuer')
def unpinned_issuer(context):
    w=context.world
    w.call('POST','/v1/auth/sessions',dict(issuer='https://another-issuer.example.invalid',subject='operator'),actor='login-authority',expected=400)


@then('the unpinned identity is rejected before any session is issued')
def issuer_rejected(context):
    assert context.world.last_status==400
    assert 'secret' not in context.world.last
