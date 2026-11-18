import re
import json
import uuid
from behave import given, when, then
from playwright.sync_api import expect
from scripts.bdd.editor import expect_editor_value
from scripts.bdd.interactions import close_draft_details
from scripts.productization.qualify import payload
from scripts.bdd.layout import tab_to, inspect_layout, assert_navigation_metrics
from scripts.bdd.interactions import open_entry_actions, close_entry_actions, open_details, submit_and_wait, choose_workspace, assert_workspace_selected, workspace_menu


def browser(context):
    return context.world.browser()


def tabs(context):
    return browser(context).page.get_by_role('navigation',name='Bundle navigation',exact=True)


@when('I open its scoped Content URL')
def scoped(context):
    browser(context).select_bundle()


@then('the workspace navigation contains Bundles, Delivery and Connections')
def workspace_links(context):
    nav=browser(context).page.get_by_role('navigation',name='Main navigation',exact=True).filter(visible=True)
    assert nav.get_by_role('link').count()==4
    for name in ('Bundles','Delivery','Connections','Members'):
        expect(nav.get_by_role('link',name=name,exact=True)).to_have_count(1)


@then('the bundle tabs contain Content, Changes, Releases and App setup')
def bundle_tabs(context):
    assert tabs(context).get_by_role('link').all_text_contents()==['Content','Changes','Releases','App setup']
    expect(tabs(context).get_by_role('link',name='Content',exact=True)).to_have_attribute('aria-current','page')


@then('the old seven-peer navigation and inert footer are absent')
def no_old_navigation(context):
    p=browser(context).page
    workspace_navigation=p.get_by_role('navigation',name='Main navigation',exact=True).filter(visible=True)
    for name in ['Overview','Improvement','Setup','Access','Content','Releases']:
        expect(workspace_navigation.get_by_role('link',name=name,exact=True)).to_have_count(0)
    expect(p.get_by_text('Stored workspaces',exact=True)).to_have_count(0)
    expect(p.get_by_role('heading',name='BDD bundle',exact=True)).to_be_visible()
    assert '/w/'+context.world.h.project+'/bundles/'+context.world.setup['bundle']['id'] in p.url


def tooltip_visible(page,name):
    tooltip=page.get_by_role('tooltip',name=name,exact=True).and_(page.locator('[data-state$="-open"]'))
    try:
        expect(tooltip).to_be_visible()
    except AssertionError as error:
        state=page.evaluate("""()=>({active:document.activeElement?.getAttribute('aria-label'),bodyPointerEvents:getComputedStyle(document.body).pointerEvents,tooltips:[...document.querySelectorAll('[data-slot=tooltip-content],[role=tooltip]')].map(el=>({text:el.textContent,state:el.getAttribute('data-state'),role:el.getAttribute('role'),hidden:el.hidden,display:getComputedStyle(el).display,visibility:getComputedStyle(el).visibility}))})""")
        raise AssertionError(str(error)+'\nTooltip state: '+json.dumps(state)) from error
    return tooltip


def leave_tooltips(page):
    # Switch input modes after the previous tooltip has actually left the DOM.
    # Its closing animation can otherwise race the next native focus event.
    page.mouse.move(500,150,steps=8)
    expect(page.locator('[data-slot=tooltip-content]')).to_have_count(0)


@then('desktop navigation uses labelled icons with hover and keyboard tooltips')
def desktop_icon_navigation(context):
    p=browser(context).page
    rail=p.locator('.workspace-desktop-rail')
    expect(rail).to_be_visible()
    collapse=rail.get_by_role('button',name='Collapse navigation',exact=True)
    if collapse.count():
        assert rail.bounding_box()['width'] > 100
        collapse.click()
    expect(rail.get_by_role('button',name='Expand navigation',exact=True)).to_have_attribute('aria-expanded','false')
    bounds=rail.bounding_box()
    assert abs(bounds['x'])<=1 and abs(bounds['width']-64)<=1,bounds
    navigation=rail.get_by_role('navigation',name='Main navigation',exact=True)
    for name in ('Bundles','Delivery','Connections','Members'):
        control=navigation.get_by_role('link',name=name,exact=True)
        label=control.locator('span.sr-only')
        expect(label).to_have_text(name)
        hidden_label=label.bounding_box()
        assert hidden_label and hidden_label['width']<=1 and hidden_label['height']<=1, 'Desktop rail labels must remain accessible without occupying visible row space'
        expect(control.locator('svg[aria-hidden=true]')).to_be_visible()
        control.hover()
        tooltip=p.get_by_role('tooltip',name=name,exact=True).and_(p.locator('[data-state$="-open"]'))
        tooltip_visible(p,name)
        p.keyboard.press('Escape')
        expect(tooltip).to_have_count(0)
        leave_tooltips(p)
        tab_to(p,control)
        tooltip_visible(p,name)
        p.keyboard.press('Escape')
        expect(tooltip).to_have_count(0)
        expect(control).to_be_focused()


@then('workspace switching precedes navigation and the account remains at the bottom of the rail')
def workspace_scope_and_account(context):
    p=browser(context).page
    rail=p.locator('.workspace-desktop-rail')
    workspace=rail.get_by_role('button',name='Workspaces')
    account=rail.get_by_role('button',name='Account',exact=True)
    wr,ar,rr=workspace.bounding_box(),account.bounding_box(),rail.bounding_box()
    nav=rail.get_by_role('navigation',name='Main navigation').bounding_box()
    assert wr['y']+wr['height']<=nav['y'],dict(workspace=wr,navigation=nav)
    assert wr['y']+wr['height']<=ar['y'] and ar['y']+ar['height']<=rr['y']+rr['height'],dict(workspace=wr,account=ar,rail=rr)
    assert ar['y']+ar['height']>=rr['y']+rr['height']-24,dict(account=ar,rail=rr)
    menu=workspace_menu(p)
    expect(menu.locator('[role=menuitemradio][data-workspace-id="'+context.world.h.project+'"]')).to_have_attribute('aria-checked','true')
    p.keyboard.press('Escape')
    expect(menu).to_have_count(0)
    expect(workspace).to_be_focused()
    leave_tooltips(p)
    p.mouse.move(ar['x']+ar['width']/2,ar['y']+ar['height']/2,steps=8)
    tooltip=p.get_by_role('tooltip',name='Account',exact=True).and_(p.locator('[data-state$="-open"]'))
    tooltip_visible(p,'Account')
    p.keyboard.press('Escape')
    leave_tooltips(p)
    tab_to(p,account)
    tooltip_visible(p,'Account')
    p.keyboard.press('Escape')
    expect(p.locator('[data-slot=tooltip-content]')).to_have_count(0)
    p.keyboard.press('Enter')
    expect(p.get_by_role('dialog',name='Your account',exact=True)).to_be_visible()
    p.wait_for_function("document.querySelector('[role=dialog]')?.contains(document.activeElement)")
    p.keyboard.press('Escape')
    expect(p.get_by_role('dialog',name='Your account',exact=True)).to_have_count(0)
    expect(account).to_be_focused()


@then('bundle identity and tabs occupy separate header rows')
def separate_header_rows(context):
    p=browser(context).page
    metrics=inspect_layout(p)
    assert_navigation_metrics(metrics)
    header=p.locator('.bundle-scope-header')
    channel=header.get_by_role('combobox',name='Channel',exact=True)
    expect(channel).to_contain_text('stable')
    first=header.locator('.bundle-scope-primary').bounding_box()
    second=header.locator('.bundle-scope-secondary').bounding_box()
    assert second['y']>=first['y']+first['height']-1,dict(first=first,second=second)
    before=p.url
    tab_to(p,channel)
    p.keyboard.press('Enter')
    option=p.get_by_role('option',name='stable',exact=True)
    expect(option).to_be_visible()
    expect(option).to_have_attribute('aria-selected','true')
    p.keyboard.press('Escape')
    expect(p.get_by_role('listbox')).to_have_count(0)
    expect(channel).to_be_focused()
    assert p.url==before,'Opening or cancelling Channel must not navigate'


@when('I open the published memory and choose Edit entry')
def memory_edit(context):
    b=browser(context)
    b.select_bundle()
    b.page.get_by_role('treeitem',name='Open memory/team.md',exact=True).click()
    expect(b.page.get_by_test_id('entry-content')).to_have_text('Reusable project notes.',timeout=30000)
    b.page.get_by_role('link',name='Edit entry',exact=True).click()


@then('the new draft selects that memory path and text in one editor')
def same_entry(context):
    p=browser(context).page
    expect(p).to_have_url(re.compile(r'/changes\?.*draft=new.*path=memory%2Fteam.md'))
    open_entry_actions(p)
    expect(p.get_by_label('Entry path (rename)',exact=True)).to_have_value('memory/team.md')
    close_entry_actions(p)
    field=p.get_by_role('textbox', name='Content', exact=True)
    expect(field).to_have_count(1)
    expect_editor_value(field, 'Reusable project notes.')
    expect(p.get_by_test_id('file-browser')).to_have_count(0)


@given('another bundle is published on the same channel and revision')
def second_bundle(context):
    w=context.world
    w.other_bundle=w.call('POST',w.root+'/bundle-setups',dict(name='Other BDD bundle',origin='created',channel='stable',payload=payload('Other bundle instructions.'),reason='Independent second bundle.'))
    assert w.other_bundle['resolution']['revision']==w.original['revision']=='1'


def select_other_tab(w):
    b=w.browser()
    other=b.context.new_page()
    other.on('pageerror',lambda error:b.errors.append(str(error)))
    other.goto(b.base+b.bundle_path('content',bundle_id=w.other_bundle['bundle']['id']))
    expect(other.get_by_test_id('entry-content')).to_contain_text('Other bundle instructions.')
    other.wait_for_load_state('networkidle')
    return other


@when('another tab opens the other bundle and I open the saved draft bookmark')
def bookmark(context):
    w=context.world
    b=browser(context)
    b.select_bundle()
    select_other_tab(w)
    w.draft_bookmark=b.base+b.bundle_path('changes',draft=w.draft['id'])
    b.page.goto(w.draft_bookmark)


@then('the bookmark still names the original bundle and saved text')
def bookmark_stable(context):
    w=context.world
    p=browser(context).page
    expect(p).to_have_url(w.draft_bookmark)
    expect_editor_value(p.get_by_role('textbox', name='Content', exact=True), 'Review retries.')
    open_details(p,'Draft details')
    details=p.get_by_role('dialog',name='Draft details',exact=True)
    expect(details).to_contain_text(w.draft['id'])
    expect(details).to_contain_text(w.draft['snapshotVersion']['id'])
    close_draft_details(p)
    expect(p.get_by_role('heading',name='BDD bundle',exact=True)).to_be_visible()


@when('I inspect release history after another tab selects the other bundle')
def history_views(context):
    w=context.world
    b=browser(context)
    b.visit('/releases')
    select_other_tab(w)
    b.page.reload(wait_until='networkidle')
    expect(b.page).to_have_url(b.base+b.bundle_path('releases'))


@then("each history view contains only its own bundle's verified content")
def histories_isolated(context):
    w=context.world
    b=browser(context)
    for bundle_id,text in [(w.setup['bundle']['id'],'Review code.'),(w.other_bundle['bundle']['id'],'Other bundle instructions.')]:
        if bundle_id!=w.setup['bundle']['id']:
            b.page.get_by_role('link',name='Bundles',exact=True).first.click()
            row=b.page.get_by_role('listitem').filter(has=b.page.get_by_role('link',name='Other BDD bundle',exact=True))
            row.get_by_role('link',name='stable',exact=True).click()
            tabs(context).get_by_role('link',name='Releases',exact=True).click()
        expect(b.page).to_have_url(b.base+b.bundle_path('releases',bundle_id=bundle_id))
        row=b.page.get_by_role('article',name=re.compile(r'^Revision 1( · Current)?$'))
        expect(b.page.get_by_role('article')).to_have_count(1)
        row.get_by_role('button',name=re.compile(r'^Compare Revision 1\b',re.I)).click()
        b.page.get_by_role('region',name='Comparison for revision 1',exact=True).get_by_role('button',name='Inspect content for revision 1',exact=True).click()
        expect(b.page.get_by_label('Content of AGENTS.md',exact=True)).to_contain_text(text)
        b.page.get_by_role('dialog').get_by_role('button',name='Close',exact=True).click()


@when('I prepare a connection for the first bundle')
def prepare_connection(context):
    w=context.world
    b=browser(context)
    b.select_bundle()
    b.visit('/integrations')
    p=b.page
    p.get_by_role('button',name='New connection',exact=True).click()
    p.get_by_label('Display name',exact=True).fill('Cross-tab connection')
    p.get_by_label('Bundle',exact=True).select_option(w.setup['bundle']['id'])
    p.get_by_label('Channel',exact=True).select_option('stable')


@when('another tab selects the second bundle before I submit that form')
def cross_tab(context):
    select_other_tab(context.world)
    browser(context).page.get_by_role('button',name='Create connection',exact=True).click()
    expect(browser(context).page).to_have_url(re.compile(r'/connections\?integration='))


@then('the created connection remains bound to the first bundle and channel')
def bound_connection(context):
    w=context.world
    rows=w.call('GET',w.root+'/connections')['items']
    assert len(rows)==1
    assert rows[0]['bundleId']==w.setup['bundle']['id'] and rows[0]['channel']=='stable'
    expect(browser(context).page.get_by_role('heading',name='Cross-tab connection',exact=True)).to_be_visible()


@when('I open its bundle ID under an unauthorized workspace URL')
def denied_url(context):
    w=context.world
    b=browser(context)
    w.denied_url=b.base+'/w/not-authorized-'+uuid.uuid4().hex+'/bundles/'+w.setup['bundle']['id']+'/channels/stable/content'
    b.page.goto(w.denied_url)


@then('that URL stays unavailable without displaying another bundle')
def no_substitution(context):
    w=context.world
    p=browser(context).page
    expect(p).to_have_url(w.denied_url)
    expect(p.get_by_test_id('entry-content')).to_have_count(0)
    expect(p.get_by_role('button',name='Save draft',exact=True)).to_have_count(0)
    expect(p.get_by_text('Access denied.',exact=False).first).to_be_visible()


@when('the reader opens App setup')
def connect_recipe(context):
    browser(context).page.get_by_role('link',name='App setup',exact=True).first.click()


@then('the SDK recipe is readable without editing or connection administration')
def recipe_visible(context):
    p=browser(context).page
    expect(p.get_by_role('heading',name='App setup',exact=True)).to_be_visible()
    expect(p.get_by_role('region',name='SDK delivery recipe',exact=True)).to_be_visible()
    expect(p.get_by_label('TypeScript delivery recipe',exact=True)).to_be_visible()
    expect(p.get_by_role('navigation',name='Main navigation',exact=True).filter(visible=True).get_by_role('link',name='Connections',exact=True)).to_have_count(0)
    expect(p.get_by_role('button',name='Create read credential',exact=True)).to_have_count(0)


@when('I compare their verified workspace-creation capabilities')
def read_capabilities(context):
    w=context.world
    w.operator_capability=w.call('GET','/v1/auth/session',actor='admin')['canCreateWorkspace']
    w.member_capability=w.call('GET','/v1/auth/session',actor='member')['canCreateWorkspace']


@then('only the configured deployment operator can create a workspace')
def operator_only(context):
    assert context.world.operator_capability is True
    assert context.world.member_capability is False


@then("the member's console keeps Members but hides New workspace")
def admin_menu(context):
    w=context.world
    w.browser_actor='member'
    b=browser(context)
    b.select_bundle()
    expect(b.page.get_by_role('navigation',name='Main navigation',exact=True).filter(visible=True).get_by_role('link',name='Members',exact=True)).to_be_visible()
    expect(b.page.get_by_role('button',name='New workspace',exact=True)).to_have_count(0)
    workspace_menu(b.page)
    expect(b.page.get_by_role('menuitem',name='New workspace',exact=True)).to_have_count(0)
    b.page.keyboard.press('Escape')


@given("a previous browser left a committed creation with an unconfirmed result")
def previous_creation(context):
    w=context.world
    b=browser(context)
    b.visit('/setup')
    page=b.page
    page.get_by_role('button',name='Create your first bundle',exact=True).click()
    page.get_by_label('Bundle name',exact=True).fill('Recovered browser bundle')
    page.get_by_label('Instructions',exact=True).fill('Recovered instructions.')
    # The real service commits, then the browser loses the response before it can clear recovery.
    def drop(route):
        if route.request.method=='POST':
            assert route.fetch().ok
            route.abort('failed')
        else:
            route.continue_()
    page.route('**/*',drop)
    try:
        page.get_by_role('button',name='Create and publish',exact=True).click()
        expect(page.get_by_role('button',name='Check result',exact=True)).to_be_enabled()
    finally:
        page.unroute('**/*',drop)
    bundles=w.call('GET',w.root+'/bundles')['items']
    assert len(bundles)==1
    w.previous_bundle_id=bundles[0]['id']
    w.pending_slot=page.evaluate("Object.keys(sessionStorage).find(key=>key.startsWith('acclimate:operation:v1:'))")
    assert w.pending_slot


@when('I reopen the bundle library with its previous operation record')
def previous_operation(context):
    b=browser(context)
    b.page.reload(wait_until='networkidle')
    expect(b.page.get_by_role('button',name='Check result',exact=True)).to_be_visible()


@when('I look up the pending creation result')
def recover_previous(context):
    browser(context).page.get_by_role('button',name='Check result',exact=True).click()


@then('the original bundle opens once and the previous storage key is gone')
def previous_once(context):
    w=context.world
    b=browser(context)
    expected=b.base+b.bundle_path('content',bundle_id=w.previous_bundle_id)
    expect(b.page).to_have_url(expected)
    expect(b.page.get_by_test_id('entry-content')).to_contain_text('Recovered instructions.')
    rows=w.call('GET',w.root+'/bundles')['items']
    assert [row['id'] for row in rows]==[w.previous_bundle_id]
    assert b.page.evaluate('(key)=>sessionStorage.getItem(key)',w.pending_slot) is None


@when('I search for memory, edit that entry and go Back')
def search_back(context):
    w=context.world
    b=browser(context)
    b.select_bundle()
    p=b.page
    p.get_by_label('Published content',exact=True).fill('memory')
    p.get_by_role('button',name='Search published paths or content',exact=True).click()
    p.wait_for_load_state('networkidle')
    expect(p.get_by_role('treeitem',name='Open AGENTS.md',exact=True)).to_have_count(0,timeout=30000)
    p.get_by_role('treeitem',name='Open memory/team.md',exact=True).click()
    expect(p.get_by_test_id('entry-content')).to_have_text('Reusable project notes.',timeout=30000)
    w.memory_bookmark=p.url
    p.get_by_role('link',name='Edit entry',exact=True).click()
    expect_editor_value(p.get_by_role('textbox', name='Content', exact=True), 'Reusable project notes.')
    p.go_back()


@then('the published memory and its URL search are restored')
def restored_search(context):
    w=context.world
    p=browser(context).page
    expect(p).to_have_url(w.memory_bookmark)
    expect(p.get_by_label('Published content',exact=True)).to_have_value('memory')
    expect(p.get_by_test_id('entry-content')).to_contain_text('Reusable project notes.')
    expect(p.get_by_role('treeitem',name='Open AGENTS.md',exact=True)).to_have_count(0)
    expect(p.get_by_role('textbox', name='Content', exact=True)).to_have_count(0)


@given('the operator can also access another workspace')
def another_workspace(context):
    w=context.world
    w.extra_workspace=w.call('POST','/v1/workspaces',dict(id='second-'+uuid.uuid4().hex,name='Second workspace'),actor='admin')


@when('I edit content and try to switch workspace')
def edit_then_switch(context):
    w=context.world
    b=browser(context)
    b.select_bundle()
    b.page.get_by_role('link',name='Edit entry',exact=True).click()
    b.page.get_by_role('textbox', name='Content', exact=True).fill('Unsaved workspace notes.')
    choose_workspace(b.page,w.extra_workspace['id'])
    expect(b.page.get_by_role('heading',name='Leave current edits?',exact=True)).to_be_visible()


@when('I cancel that workspace switch')
def cancel_workspace(context):
    browser(context).page.get_by_role('button',name='Keep editing',exact=True).click()


@then('the original workspace and unsaved text remain selected')
def workspace_kept(context):
    w=context.world
    p=browser(context).page
    expect(p).to_have_url(re.compile('/w/'+re.escape(w.h.project)+'/bundles/'))
    assert_workspace_selected(p,w.h.project)
    expect_editor_value(p.get_by_role('textbox', name='Content', exact=True), 'Unsaved workspace notes.')


@when('I confirm leaving edits to switch workspace')
def leave_workspace(context):
    w=context.world
    p=browser(context).page
    choose_workspace(p,w.extra_workspace['id'])
    p.get_by_role('button',name='Leave editor',exact=True).click()


@then('the other workspace opens without saving the abandoned text')
def switched_without_save(context):
    w=context.world
    b=browser(context)
    expect(b.page).to_have_url(b.base+b.workspace_path(project_id=w.extra_workspace['id']))
    expect(b.page.get_by_role('navigation',name='Main navigation',exact=True).filter(visible=True).get_by_role('link',name='Bundles',exact=True)).to_have_attribute('href',b.workspace_path(project_id=w.extra_workspace['id']))
    expect(b.page.get_by_role('textbox', name='Content', exact=True)).to_have_count(0)
    assert w.call('GET',w.channel+'/drafts')['items']==[]
    assert w.call('GET',w.channel)['version']==w.original['version']


@when('the member opens Members and starts an email invitation')
def member_lookup(context):
    w=context.world
    w.enable_email()
    w.browser_actor='member'
    b=browser(context)
    b.visit('/access')
    b.page.get_by_role('button',name='Invite member',exact=True).click()
    b.page.get_by_label('Email',exact=True).fill('next@example.test')


@when('the operator downgrades that member to viewer')
def downgrade_member(context):
    w=context.world
    w.call('PUT',w.root+'/memberships/'+w.sessions['member']['userId'],dict(role='viewer'),actor='admin')


@when('the member refreshes the membership page')
def refresh_members(context):
    p=browser(context).page
    p.reload(wait_until='networkidle')


@then('membership controls and the pending invite form are removed')
def old_controls_gone(context):
    p=browser(context).page
    expect(p.get_by_role('button',name='Invite member',exact=True)).to_have_count(0)
    expect(p.locator('.member-role-trigger')).to_have_count(0)
    expect(p.locator('.member-actions-trigger')).to_have_count(0)
    expect(p.get_by_role('button',name='Remove access',exact=True)).to_have_count(0)
    expect(p.get_by_role('dialog').get_by_text('operator',exact=True)).to_have_count(0)
    expect(p.get_by_label('Email',exact=True)).to_have_count(0)
    expect(p.get_by_role('navigation',name='Main navigation',exact=True).filter(visible=True).get_by_role('link',name='Members',exact=True)).to_have_count(0)


@when('I type initial instructions and try to open Connections')
def start_creation(context):
    p=browser(context).page
    p.get_by_label('Bundle name',exact=True).fill('Unsaved bundle')
    p.get_by_label('Instructions',exact=True).fill('Unsaved initial instructions.')
    p.get_by_role('navigation',name='Main navigation',exact=True).filter(visible=True).get_by_role('link',name='Connections',exact=True).click()
    expect(p.get_by_role('heading',name='Leave current edits?',exact=True)).to_be_visible()


@when('I keep editing the new bundle')
def keep_creation(context):
    browser(context).page.get_by_role('button',name='Keep editing',exact=True).click()


@then('the initial instructions remain in the creation form')
def initial_text_kept(context):
    expect(browser(context).page.get_by_label('Instructions',exact=True)).to_have_value('Unsaved initial instructions.')


@when('I leave that creation form for Connections')
def leave_creation(context):
    p=browser(context).page
    p.get_by_role('navigation',name='Main navigation',exact=True).filter(visible=True).get_by_role('link',name='Connections',exact=True).click()
    p.get_by_role('button',name='Leave editor',exact=True).click()


@then('its browser text is discarded and no bundle was created')
def creation_discarded(context):
    w=context.world
    b=browser(context)
    expect(b.page).to_have_url(b.base+b.workspace_path('connections'))
    b.page.get_by_role('navigation',name='Main navigation',exact=True).filter(visible=True).get_by_role('link',name='Bundles',exact=True).click()
    b.page.get_by_role('button',name='Create your first bundle',exact=True).click()
    expect(b.page.get_by_label('Instructions',exact=True)).to_have_value('')
    assert w.call('GET',w.root+'/bundles')['items']==[]
