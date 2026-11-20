"""Acceptance of the human publication path; all state belongs to World/Harness."""
import json
from urllib.parse import parse_qs, urlparse
from behave import given, when, then
from playwright.sync_api import expect
from features.steps.console import page
from scripts.bdd.interactions import open_details
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
    assert w.call('GET',w.channel)['revision']=='1'


@when('I search and select an entry using only the keyboard')
def keyboard_select(context):
    p = page(context)
    search = p.get_by_label('Published content', exact=True)
    tab_to(p, search)
    p.keyboard.type('memory')
    tab_to(p, p.get_by_role('button', name='Search published paths or content', exact=True))
    p.keyboard.press('Enter')
    entry = p.get_by_role('treeitem', name='Open memory/team.md', exact=True)
    tab_to(p, entry)
    p.keyboard.press('Enter')


@then('the published entry is readable and tabs remain keyboard reachable')
def keyboard_result(context):
    p = page(context)
    expect(p.get_by_test_id('entry-content')).to_contain_text('Reusable project notes.')
    release = p.get_by_role('navigation', name='Bundle navigation').get_by_role('link', name='Releases')
    tab_to(p, release)
    assert_focus_visible(release)
