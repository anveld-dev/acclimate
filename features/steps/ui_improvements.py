"""Acceptance of the human publication path; all state belongs to World/Harness."""
import json
from urllib.parse import parse_qs, urlparse
from behave import given, when, then
from playwright.sync_api import expect
from scripts.bdd.editor import expect_editor_value
from features.steps.console import page, ensure_editor, save_browser, saved_draft
from scripts.bdd.interactions import open_entry_actions, close_entry_actions, open_details, submit_and_wait
from scripts.bdd.layout import tab_to, assert_focus_visible


@when('I compare all three creation sources without publishing')
def compare_sources(context):
    p=page(context)
    p.get_by_label('Bundle name',exact=True).fill('Explicit source selection')
    p.get_by_label('Instructions',exact=True).fill('Keep these exact instructions.')
    p.get_by_role('radio',name='Import JSON',exact=True).check()
    expect(p.get_by_label('Instructions',exact=True)).to_have_count(0)
    p.get_by_label('Bundle JSON',exact=True).fill(json.dumps(dict(schemaVersion=1,files=[dict(path='AGENTS.md',kind='instruction',text='Imported preview only.')])))
    expect(p.get_by_role('heading',name='Import preview · generic',exact=True)).to_be_visible()
    expect(p.get_by_role('radiogroup',name='Bundle source').get_by_role('radio')).to_have_count(3)
    p.get_by_role('radio',name='Import files',exact=True).check()
    expect(p.get_by_label('Bundle JSON',exact=True)).to_have_count(0)
    p.get_by_label('Individual files',exact=True).set_input_files(
        dict(name='AGENTS.md',mimeType='text/markdown',buffer=b'Uploaded preview only.'))
    p.get_by_role('button',name='AGENTS.md · instruction',exact=True).click()
    expect(p.locator('[data-slot=disclosure][data-state=open] pre').first).to_have_text('Uploaded preview only.')
    p.get_by_role('radio',name='Write instructions',exact=True).check()


@then('only the selected source is rendered and no content has been created')
def one_source(context):
    w=context.world
    p=page(context)
    expect(p.get_by_label('Instructions',exact=True)).to_have_value('Keep these exact instructions.')
    expect(p.get_by_label('Bundle JSON',exact=True)).to_have_count(0)
    expect(p.get_by_role('heading',name='Import preview · generic',exact=True)).to_have_count(0)
    summary=p.get_by_label('Initial publication summary',exact=True)
    expect(summary).to_contain_text('Publishes 1 entry to stable.')
    expect(summary).to_contain_text('No evaluation is run.')
    expect(summary).to_contain_text('Native compatibility is unchecked.')
    open_details(p,'Publishing settings')
    expect(p.get_by_label('Compatibility target',exact=True)).to_have_value('generic')
    expect(p.get_by_text('Fixed after creation. Choose your agent for native compatibility checks.',exact=True)).to_be_visible()
    assert w.call('GET',w.root+'/bundles')['items']==[]


@when('the browser loses the successful initial publication response')
def lose_initial(context):
    p=page(context)
    dropped=[]
    def drop(route):
        if route.request.method=='POST' and not dropped:
            response=route.fetch()
            assert response.ok
            dropped.append(True)
            route.abort('failed')
        else:
            route.continue_()
    p.route('**/*',drop)
    try:
        p.get_by_role('button',name='Create and publish',exact=True).click()
        expect(p.get_by_role('button',name='Check result',exact=True)).to_be_enabled()
    finally:
        p.unroute('**/*',drop)
    assert dropped


@then('source changes cannot replace the frozen publication and checking its result opens it once')
def reconcile_initial(context):
    w=context.world
    p=page(context)
    expect(p.get_by_role('radiogroup',name='Bundle source',exact=True)).to_have_count(0)
    expect(p.get_by_role('button',name='Pending creation',exact=True)).to_be_disabled()
    open_details(p,'Creation recovery details')
    frozen=json.loads(p.get_by_label('Exact submitted creation',exact=True).inner_text())
    assert frozen['origin']=='created'
    assert frozen['payload']['files'][0]['text']=='Keep these exact instructions.'
    bundle, = w.call('GET',w.root+'/bundles')['items']
    browser = w.browser_fixture
    def leave_creation(dialog):
        assert dialog.type == 'beforeunload'
        dialog.accept()
    p.on('dialog',leave_creation)
    try:
        browser.visit(browser.bundle_path('changes',bundle_id=bundle['id']))
    finally:
        p.remove_listener('dialog',leave_creation)
    expect(p.get_by_role('status').filter(has_text='A bundle publication is still unresolved.')).to_be_visible()
    p.get_by_role('link',name='Open creation recovery',exact=True).click()
    expect(p.get_by_role('button',name='Pending creation',exact=True)).to_be_disabled()
    p.get_by_role('button',name='Check result',exact=True).click()
    expect(p.get_by_test_id('entry-content')).to_contain_text('Keep these exact instructions.')
    assert len(w.call('GET',w.root+'/bundles')['items'])==1
    expect(p.get_by_role('button',name='Check result',exact=True)).to_have_count(0)


@when('I save a draft and leave later unsaved text to review its manual release')
def manual_review(context):
    w=context.world
    p=page(context)
    ensure_editor(context)
    p.get_by_role('textbox', name='Content', exact=True).fill('Saved manual release snapshot.')
    save_browser(context)
    w.manual_saved=saved_draft(w)
    p.get_by_role('textbox', name='Content', exact=True).fill('Later unsaved text must never publish.')
    p.get_by_role('link',name='Evaluate saved generation 1',exact=True).click()
    expect(p.get_by_role('heading',name='Leave current edits?',exact=True)).to_be_visible()
    p.get_by_role('button',name='Leave editor',exact=True).click()
    expect(p.get_by_label('Saved change review',exact=True)).to_contain_text('Generation 1 saved')
    expect(p.locator('.bundle-scope-header').get_by_role('combobox',name='Channel',exact=True)).to_contain_text('stable')
    p.get_by_role('tab',name='Details',exact=True).click()
    details=p.get_by_role('region',name='Saved change details',exact=True)
    open_details(details,'Saved snapshot details')
    expect(details).to_contain_text('Channel stable · current revision 1')
    open_details(p.get_by_role('complementary',name='Release decision',exact=True),'Publish without evaluation')


@then('manual publication requires its own reason and confirms the saved generation')
def manual_confirmation(context):
    w=context.world
    p=page(context)
    expect(p.get_by_role('button',name='Review manual release',exact=True)).to_be_disabled()
    p.get_by_label('Manual release reason',exact=True).fill('Operator reviewed the saved diff without evaluation.')
    p.get_by_role('button',name='Review manual release',exact=True).click()
    dialog=p.get_by_role('dialog',name='Publish to stable?',exact=True)
    expect(dialog).to_contain_text('generation 1')
    expect(dialog).to_contain_text(w.manual_saved['snapshotVersion']['id'])
    expect(dialog).to_contain_text('Operator reviewed the saved diff without evaluation.')
    assert w.call('GET',w.channel+'/releases')['items'][0]['revision']=='1'
    assert w.call('GET',w.bundle+'/evaluation-requests')['items']==[]


@when('I confirm the manual release')
def manual_publish(context):
    p=page(context)
    submit_and_wait(p,p.get_by_role('dialog').get_by_role('button',name='Publish without evaluation',exact=True))
    expect(page(context).get_by_role('status').filter(has_text='Release recorded.')).to_be_visible()


@then('only the saved snapshot is released with its manual reason and no evaluation')
def manual_truth(context):
    w=context.world
    current=w.call('GET',w.channel)
    assert current['revision']=='2' and current['version']==w.manual_saved['snapshotVersion']
    release=w.call('GET',w.channel+'/releases')['items'][0]
    assert release['unevaluatedReason']=='Operator reviewed the saved diff without evaluation.'
    assert release.get('comparisonId') is None
    assert w.call('GET',w.bundle+'/evaluation-requests')['items']==[]
    assert w.draft_text(w.manual_saved)=='Saved manual release snapshot.'


@when('I record an interruption while keeping a separate manual release reason')
def interrupt_separately(context):
    w=context.world
    p=page(context)
    open_details(p,'Publish without evaluation')
    p.get_by_label('Manual release reason',exact=True).fill('Independent manual review rationale.')
    open_details(p,'Record an interruption')
    action=p.get_by_role('button',name='Mark interrupted',exact=True)
    expect(action).to_be_disabled()
    p.get_by_label('Interruption reason for '+w.browser_request['id'],exact=True).fill('External fixture runner was abandoned.')
    action.click()
    expect(p.get_by_role('status').filter(has_text='Interruption recorded. Your app may still be running.')).to_be_visible()


@then('the request records only its interruption reason and the manual reason remains independent')
def independent_reasons(context):
    w=context.world
    p=page(context)
    request=w.call('GET',w.bundle+'/evaluation-requests/'+w.browser_request['id'])
    assert request['status']=='interrupted'
    assert request['error']=='External fixture runner was abandoned.'
    expect(p.get_by_label('Manual release reason',exact=True)).to_have_value('Independent manual review rationale.')
    p.get_by_label('Manual release reason',exact=True).fill('')
    expect(p.get_by_role('button',name='Review manual release',exact=True)).to_be_disabled()
    assert w.call('GET',w.channel+'/releases')['items'][0]['revision']=='1'
    assert w.call('GET',w.bundle+'/comparisons')['items']==[]


@given('a connection for its bundle and channel')
def setup_connection(context):
    context.world.create_integration()


@when('I follow App setup to Connections and back from the selected connection')
def setup_roundtrip(context):
    w=context.world
    b=w.browser()
    b.select_bundle()
    p=b.page
    p.get_by_role('button',name='Use in an app',exact=True).click()
    p.get_by_role('link',name='Full setup guide',exact=True).click()
    expect(p.get_by_role('heading',name='1. Install the SDK',exact=True)).to_be_visible()
    expect(p.get_by_role('heading',name='2. Configure access',exact=True)).to_be_visible()
    expect(p.get_by_role('heading',name='3. Run the delivery check',exact=True)).to_be_visible()
    p.get_by_role('radio',name='Python',exact=True).click()
    recipe=p.get_by_label('Python delivery recipe',exact=True)
    expect(recipe).to_contain_text('from acclimate')
    p.get_by_role('button',name='Copy recipe',exact=True).click()
    assert p.evaluate('navigator.clipboard.readText()')==recipe.text_content()
    p.evaluate("Object.defineProperty(navigator.clipboard,'writeText',{configurable:true,value:async()=>{throw new DOMException('Denied by acceptance fixture','NotAllowedError')}})")
    p.get_by_role('button',name='Copy recipe',exact=True).click()
    expect(p.get_by_role('status').filter(has_text='Clipboard unavailable. Select and copy the text instead.')).to_be_visible()
    assert recipe.evaluate("el=>getComputedStyle(el).userSelect")=='text'
    p.get_by_role('link',name='Manage app credentials',exact=True).click()
    query=parse_qs(urlparse(p.url).query)
    assert query['bundleId']==[w.setup['bundle']['id']] and query['channel']==['stable']
    p.get_by_role('link').filter(has=p.get_by_text(w.integration['displayName'],exact=True)).click()
    p.get_by_role('tab',name='Setup',exact=True).click()
    p.get_by_role('button',name='1. Bundle & channel',exact=False).click()
    p.get_by_role('link',name='Full setup guide',exact=True).click()


@then('App setup remains active for the same bundle and channel')
def setup_scope(context):
    w=context.world
    p=page(context)
    expect(p).to_have_url(w.browser_fixture.base+w.browser_fixture.bundle_path('connect'))
    expect(p.get_by_role('navigation',name='Bundle navigation',exact=True).locator('[aria-current=page]')).to_have_count(0)
    expect(p.get_by_role('link',name='Back to content',exact=True)).to_be_visible()
    assert w.call('GET',w.bundle+'/evaluation-requests')['items']==[]
    assert w.call('GET',w.channel+'/releases')['items'][0]['revision']=='1'


@when('I search and rename an entry using only the keyboard')
def keyboard_edit(context):
    p=page(context)
    search=p.get_by_label('Published content',exact=True)
    tab_to(p,search)
    p.keyboard.insert_text('memory')
    p.keyboard.press('Enter')
    expect(p.get_by_role('treeitem',name='Open AGENTS.md',exact=True)).to_have_count(0,timeout=30000)
    entry=p.get_by_role('treeitem',name='Open memory/team.md',exact=True)
    tab_to(p,entry)
    p.keyboard.press('Enter')
    # Edit the entry actually rendered after the keyboard navigation settles.
    expect(p.get_by_test_id('entry-content')).to_have_text('Reusable project notes.',timeout=30000)
    edit=p.get_by_role('link',name='Edit entry',exact=True)
    tab_to(p,edit)
    p.keyboard.press('Enter')
    expect_editor_value(p.get_by_role('textbox', name='Content', exact=True), 'Reusable project notes.', timeout=30000)
    settings=p.get_by_role('button',name='Entry actions',exact=True)
    tab_to(p,settings)
    p.keyboard.press('Enter')
    path=p.get_by_label('Entry path (rename)',exact=True)
    tab_to(p,path)
    p.keyboard.press('ControlOrMeta+A')
    p.keyboard.insert_text('memory/keyboard.md')
    p.keyboard.press('Tab')
    expect(path).to_have_value('memory/keyboard.md')
    p.keyboard.press('Escape')
    expect(p.get_by_role('dialog',name='Entry actions',exact=True)).to_have_count(0)
    expect(settings).to_be_focused()


@when('I dismiss the unsaved-work dialog and return to the invoking link')
def keyboard_dialog(context):
    p=page(context)
    release=p.get_by_role('navigation',name='Bundle navigation',exact=True).get_by_role('link',name='Releases',exact=True)
    tab_to(p,release)
    p.keyboard.press('Enter')
    expect(p.get_by_role('heading',name='Leave current edits?',exact=True)).to_be_visible()
    dialog=p.get_by_role('alertdialog',name='Leave current edits?',exact=True)
    cancel=dialog.get_by_role('button',name='Keep editing',exact=True)
    expect(cancel).to_be_focused()
    assert_focus_visible(cancel)
    p.keyboard.press('Escape')
    expect(p.get_by_role('heading',name='Leave current edits?',exact=True)).to_have_count(0)
    expect(release).to_be_focused()
    assert_focus_visible(release)


@then('the renamed browser text is preserved and tabs remain keyboard reachable')
def keyboard_preserved(context):
    w=context.world
    p=page(context)
    open_entry_actions(p)
    expect(p.get_by_label('Entry path (rename)',exact=True)).to_have_value('memory/keyboard.md')
    close_entry_actions(p)
    expect_editor_value(p.get_by_role('textbox', name='Content', exact=True), 'Reusable project notes.')
    tab_to(p,p.get_by_role('button',name='Use in an app',exact=True))
    assert w.call('GET',w.channel+'/drafts')['items']==[]
    assert w.call('GET',w.channel+'/releases')['items'][0]['revision']=='1'
