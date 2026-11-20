import uuid
from behave import given, when, then
from playwright.sync_api import expect
from scripts.bdd.interactions import open_details, submit_and_wait, create_workspace_action, assert_workspace_selected

@when('the member opens that content in the console')
def open_member(context):
    w=context.world
    w.browser_actor='member'
    w.browser().select_bundle()

@then('the member can inspect content and delivery')
def rights(context):
    w=context.world
    p=w.browser_fixture.page
    expect(p.get_by_test_id('entry-content')).to_have_text('Review code.')
    expect(p.get_by_role('link', name='Edit entry', exact=True)).to_have_count(0)
    # Observe delivery as an ordinary workspace member without granting credential administration.
    connection=w.call('POST',w.root+'/connections',dict(bundleId=w.setup['bundle']['id'],
        channel='stable',displayName='Reader delivery fixture'),actor='admin')
    p.get_by_role('link',name='Delivery',exact=True).click()
    expect(p).to_have_url(w.browser_fixture.base+w.browser_fixture.workspace_path('delivery'))
    expect(p.get_by_role('heading',name='Delivery',exact=True)).to_be_visible()
    row=p.get_by_role('region',name='Delivery for Reader delivery fixture',exact=True)
    expect(row).to_be_visible()
    evaluations=row.get_by_role('link',name='View bundle evaluations for Reader delivery fixture')
    assert w.setup['bundle']['id'] in evaluations.get_attribute('href')
    expect(row).to_contain_text('Nothing reported within retention · delivery unknown.')
    assert w.call('GET',w.root+'/connection-observations',actor='member')['items'][0]['id']==connection['id']
    expect(p.get_by_role('link',name='Connections',exact=True)).to_have_count(0)
    for name in ['Create read credential','Create reporting credential','Create replacement credential',
                 'Create connection','Revoke connection','Revoke credential']:
        expect(p.get_by_role('button',name=name,exact=True)).to_have_count(0)

@when('the administrator invites that person by email in the console')
def lookup(context):
    w=context.world
    w.enable_email()
    w.call('POST','/v1/auth/sessions',dict(issuer=w.issuer,subject='ordinary-person',email='ordinary@example.test',emailVerified=True),actor='login-authority')
    w.browser().visit('/access')
    p=w.browser_fixture.page
    p.get_by_role('button',name='Invite member',exact=True).click()
    p.get_by_label('Email',exact=True).fill('ordinary@example.test')

@then('an invitation does not grant membership before acceptance')
def confirmation(context):
    w=context.world
    p=w.browser_fixture.page
    expect(p.get_by_role('dialog').get_by_role('button',name='Send invite',exact=True)).to_be_enabled()
    assert w.call('GET',w.root+'/users/'+w.sessions['member']['userId'])['role'] is None

@when('the invitation is sent and the recipient accepts viewer access')
def grant(context):
    w=context.world
    p=w.browser_fixture.page
    submit_and_wait(p,p.get_by_role('dialog').get_by_role('button',name='Send invite',exact=True))
    invitations=w.call('GET',w.root+'/invitations')['items']
    invitation=next(value for value in invitations if value['email']=='ordinary@example.test')
    assert w.call('GET',w.root+'/users/'+w.sessions['member']['userId'])['role'] is None
    w.call('POST','/v1/invitations/'+invitation['id']+'/accept',actor='member')
    p.reload(wait_until='networkidle')

@when('the administrator confirms and removes access in the console')
def remove(context):
    w=context.world
    w.browser().visit('/access')
    p=w.browser_fixture.page
    member=p.get_by_role('row').filter(has=p.get_by_text('ordinary-person',exact=True))
    member.get_by_role('button',name=f'Actions for ordinary-person, user ID {w.sessions["member"]["userId"]}',exact=True).click()
    p.get_by_role('menuitem',name='Remove access',exact=True).click()
    confirmation=p.get_by_role('alertdialog',name='Remove workspace access?',exact=True)
    expect(confirmation).to_contain_text('ordinary-person')
    assert w.call('GET',w.root+'/users/'+w.sessions['member']['userId'])['role']=='viewer'
    submit_and_wait(p,confirmation.get_by_role('button',name='Remove member',exact=True))
    expect(p.get_by_role('status').filter(has_text='Workspace access updated')).to_be_visible()

@then('the member is denied on the next content request')
def denied(context):
    w=context.world
    w.call('GET',w.channel,actor='member',expected=403)

@when('I create a workspace through the console')
def create(context):
    w=context.world
    w.browser().visit('/')
    p=w.browser_fixture.page
    if not p.get_by_label('Workspace ID',exact=True).count():
        create_workspace_action(p).click()
    w.browser_project='browser-'+uuid.uuid4().hex
    p.get_by_label('Workspace ID',exact=True).fill(w.browser_project)
    p.get_by_label('Workspace name',exact=True).fill('Browser workspace')
    p.get_by_role('button',name='Create workspace',exact=True).click()
    expect(p).to_have_url(w.browser_fixture.base+w.browser_fixture.workspace_path(workspace_id=w.browser_project))

@then('its creator can select it with administrator rights')
def created(context):
    w=context.world
    projects=w.personal_projects('admin')
    assert any(p['id']==w.browser_project and p['role']=='admin' for p in projects)
    assert_workspace_selected(w.browser_fixture.page,w.browser_project)


@when('the administrator opens the current member list')
def open_members(context):
    context.world.browser().visit('/access')

@then('the existing member can be selected with their current role')
def existing_member(context):
    w=context.world
    p=w.browser_fixture.page
    member=p.get_by_role('row').filter(has=p.get_by_text('ordinary-person',exact=True))
    expect(member.get_by_text('ordinary-person',exact=True)).to_be_visible()
    expect(member.get_by_text('Viewer',exact=True)).to_be_visible()
    trigger=member.get_by_role('button',name=f'Role for ordinary-person, user ID {w.sessions["member"]["userId"]}: Viewer',exact=True)
    trigger.click()
    expect(p.get_by_role('menuitemradio').filter(has_text='Viewer')).to_have_attribute('aria-checked','true')
    expect(p.get_by_role('dialog')).to_have_count(0)
    p.keyboard.press('Escape')
    expect(trigger).to_be_focused()

@given('the administrator has a scoped connection')
def admin_connection(context):
    w=context.world
    w.integration=w.call('POST',w.root+'/connections',dict(bundleId=w.setup['bundle']['id'],channel='stable',displayName='Recovery fixture'),actor='admin')
    w.integration_path=w.root+'/connections/'+w.integration['id']
    w.browser().visit(w.browser().workspace_path('connections')+'?connection='+w.integration['id'])

@when('the browser loses a successful credential issuance response')
def lost_credential(context):
    w=context.world
    p=w.browser_fixture.page
    p.get_by_role('tab',name='Credentials',exact=True).click()
    dropped=[]
    def drop(route):
        if route.request.method=='POST' and not dropped:
            response=route.fetch()
            assert response.ok
            dropped.append(True)
            route.abort('failed')
        else: route.continue_()
    p.route('**/*',drop)
    p.get_by_role('button',name='Create read credential',exact=True).click()
    expect(p.get_by_role('alert')).to_contain_text('Outcome unknown')
    p.unroute('**/*',drop)
    assert dropped

@when('the administrator reloads and reconciles the original issuance')
def reconcile_credential(context):
    p=context.world.browser_fixture.page
    p.reload()
    p.get_by_role('button',name='Check creation result',exact=True).click()
    expect(p.get_by_text('Revocation not confirmed',exact=False)).to_be_visible()

@then('replacement is unavailable until original revocation is confirmed')
def replacement_blocked(context):
    p=context.world.browser_fixture.page
    expect(p.get_by_role('button',name='Create replacement credential',exact=True)).to_have_count(0)
    expect(p.get_by_role('button',name='Create read credential',exact=True)).to_be_disabled()

@when('the browser loses original revocation and the administrator reconciles before replacement')
def replace_credential(context):
    p=context.world.browser_fixture.page
    p.get_by_role('button',name='Confirm revoke original credential',exact=True).click()
    dropped=[]
    def drop(route):
        if route.request.method=='POST' and not dropped:
            response=route.fetch()
            assert response.ok
            dropped.append(True)
            route.abort('failed')
        else: route.continue_()
    p.route('**/*',drop)
    p.get_by_role('dialog').get_by_role('button',name='Revoke',exact=True).click()
    expect(p.get_by_role('alert')).to_contain_text('Outcome unknown')
    p.unroute('**/*',drop)
    assert dropped
    expect(p.get_by_role('button',name='Create replacement credential',exact=True)).to_have_count(0)
    p.get_by_role('dialog').get_by_role('button',name='Cancel',exact=True).click()
    p.reload(wait_until='networkidle')
    p.get_by_role('button',name='Create replacement credential',exact=True).click()
    expect(p.get_by_role('dialog').get_by_text('Save this credential now',exact=True)).to_be_visible()
    context.world.replacement_secret=p.get_by_label('One-time credential secret',exact=True).input_value()

@then('exactly one active replacement remains and secrets were never stored')
def replacement_evidence(context):
    w=context.world
    listing=w.call('GET',w.root+'/connections',actor='admin')['items']
    entry=next(item for item in listing if item['id']==w.integration['id'])
    assert len(entry['credentials'])==2
    assert len([item for item in entry['credentials'] if not item['revokedAt']])==1
    stored=w.browser_fixture.page.evaluate('JSON.stringify([Object.entries(sessionStorage),Object.entries(localStorage)])')
    assert w.replacement_secret and w.replacement_secret not in stored
    assert 'aci_' not in stored
