import json
import re
from pathlib import Path
from behave import given, when, then
from playwright.sync_api import expect
from scripts.productization.qualify import payload
from scripts.bdd.interactions import open_content_actions, open_details, submit_and_wait


def page(context):
    return context.world.browser().page


@given('I opened an empty console workspace')
def empty(context):
    w=context.world
    w.browser().visit('/setup')
    expect(page(context).get_by_role('heading',name='Give your agents a place to start',exact=True)).to_be_visible()
    page(context).get_by_role('button',name='Create your first bundle',exact=True).click()


@when('I create content from {source} in Bundles')
def create(context,source):
    p=page(context)
    p.get_by_label('Bundle name',exact=True).fill('Explicit BDD content')
    p.get_by_role('radio',name=source,exact=True).check()
    if source=='Write instructions':
        p.get_by_label('Instructions',exact=True).fill('Review code.')
    elif source=='Import JSON':
        p.get_by_label('Bundle JSON',exact=True).fill(json.dumps(payload('Review code.')))
    elif source=='Import files':
        p.get_by_label('Individual files',exact=True).set_input_files(
            dict(name='AGENTS.md',mimeType='text/markdown',buffer=b'Review code.'))
    else: raise AssertionError(source)
    if source!='Write instructions':
        p.get_by_label('Confirm these entries for import',exact=True).check()
    summary=p.get_by_label('Initial publication summary',exact=True)
    expect(summary).to_contain_text('Publishes ')
    expect(summary).to_contain_text('to stable.')
    expect(summary).to_contain_text('No evaluation is run.')
    expect(summary).to_contain_text('Native compatibility is unchecked.')
    open_details(p,'Publishing settings')
    expect(p.get_by_label('Compatibility target',exact=True)).to_have_value('generic')
    expect(p.get_by_text('Fixed after creation. Choose your agent for native compatibility checks.',exact=True)).to_be_visible()
    assert context.world.call('GET',context.world.root+'/bundles')['items']==[]
    p.get_by_role('button',name='Create and publish' if source=='Write instructions' else 'Import and publish',exact=True).click()
    expect(p.get_by_role('navigation',name='Bundle navigation',exact=True)).to_be_visible(timeout=30000)


@then('the bundle is selected and its stored origin is {origin}')
def selected_origin(context,origin):
    w=context.world
    entries=w.call('GET',w.root+'/bundles')['items']
    assert len(entries)==1 and entries[0]['origin']==origin
    assert '/w/'+w.h.project+'/bundles/'+entries[0]['id']+'/' in page(context).url
    bundle=w.root+'/bundles/'+entries[0]['id']
    releases=w.call('GET',bundle+'/channels/stable/releases')['items']
    assert len(releases)==1 and releases[0]['unevaluatedReason']
    expect(page(context).get_by_test_id('entry-content')).to_be_visible()


@when('I submit invalid setup and then correct it')
def corrected(context):
    p=page(context)
    p.get_by_label('Bundle name',exact=True).fill('Corrected content')
    open_details(p,'Publishing settings')
    p.get_by_label('Initial channel',exact=True).fill('invalid channel')
    p.get_by_label('Instructions',exact=True).fill('Review code.')
    p.get_by_role('button',name='Create and publish',exact=True).click()
    expect(p.get_by_text('Use a channel name with letters, numbers, hyphens or underscores.',exact=True)).to_be_visible()
    open_details(p,'Publishing settings')
    p.get_by_label('Initial channel',exact=True).fill('stable')
    p.get_by_role('button',name='Create and publish',exact=True).click()
    expect(p.get_by_role('navigation',name='Bundle navigation',exact=True)).to_be_visible(timeout=30000)


@then('the corrected bundle is created once')
def once(context):
    w=context.world
    entries=w.call('GET',w.root+'/bundles')['items']
    assert [entry['name'] for entry in entries]==['Corrected content']


@given('a published bundle with instructions, a skill and reusable memory')
def mixed(context):
    context.world.publish_initial('',files=[dict(path='AGENTS.md',kind='instruction',text='Review code.'),dict(path='skills/review/SKILL.md',kind='skill',text='---\nname: review\ndescription: Review changes.\n---\nCheck retries.'),dict(path='memory/team.md',kind='memory',text='Reusable project notes.')])


@given('I opened its Content page')
def open_content(context):
    context.world.browser().select_bundle()
    expect(page(context).get_by_test_id('entry-content')).to_contain_text('Review code.')


@when('I filter published entries and download the memory file')
def filter_download(context):
    p=page(context)
    p.get_by_label('Published content',exact=True).fill('definitely-no-such-entry')
    p.get_by_role('button',name='Search published paths or content',exact=True).click()
    p.wait_for_load_state('networkidle')
    expect(p.get_by_text('No matching entries. Clear filters to see all content.',exact=True)).to_be_visible()
    p.get_by_role('button',name='Clear filters',exact=True).click()
    p.wait_for_load_state('networkidle')
    expect(p.get_by_label('Published content',exact=True)).to_have_value('')
    expect(p.get_by_role('treeitem',name='Open AGENTS.md',exact=True)).to_be_visible()
    p.get_by_label('Published content',exact=True).fill('memory')
    p.get_by_role('button',name='Search published paths or content',exact=True).click()
    p.wait_for_load_state('networkidle')
    expect(p.get_by_role('treeitem',name='Open memory/team.md',exact=True)).to_be_visible()
    expect(p.get_by_role('treeitem',name='Open AGENTS.md',exact=True)).to_have_count(0)
    p.get_by_role('treeitem',name='Open memory/team.md',exact=True).click()
    actions=open_content_actions(p)
    with p.expect_download() as event:
        actions.get_by_role('button',name='Download published entry',exact=True).click()
    target=context.world.h.dir/'downloaded-memory.md'
    event.value.save_as(str(target))
    context.world.downloaded=target.read_text()


@then('the downloaded file contains the published memory')
def downloaded(context):
    assert context.world.downloaded=='Reusable project notes.'


@when('another operator publishes "{text}"')
def other_release(context,text):
    w=context.world
    current = w.call('GET', w.channel)
    version=w.call('POST',w.bundle+'/versions',dict(parentVersionId=current['version']['id'],payload=payload(text)))
    w.external_promotion = w.manual_release(version)


@when('I refresh the console')
def refresh(context):
    page(context).once('dialog',lambda dialog:dialog.accept())
    page(context).reload(wait_until='networkidle')


@when('I inspect the old release and restore it through the console')
def restore(context):
    w=context.world
    w.browser().select_bundle()
    w.browser_fixture.visit('/releases')
    p=page(context)
    p.get_by_role('article', name='Revision 1', exact=True).get_by_role('button').click()
    detail=p.get_by_role('region',name='Selected release',exact=True)
    detail.get_by_role('button',name='Inspect content for revision 1',exact=True).click()
    expect(p.get_by_role('heading',name='Version content',exact=True)).to_be_visible()
    expect(p.get_by_label('Content of AGENTS.md',exact=True)).to_contain_text('Review code.')
    with p.expect_download() as event:
        p.get_by_role('dialog').get_by_role('button',name='Download',exact=True).click()
    target=w.h.dir/'old-release.md'
    event.value.save_as(str(target))
    assert target.read_text()=='Review code.'
    p.get_by_role('dialog').get_by_role('button',name='Close',exact=True).click()
    detail.get_by_role('button',name='Restore revision 1',exact=True).click()
    p.get_by_label('Reason for restoring',exact=True).fill('BDD operator rollback.')
    p.get_by_role('button',name='Restore version',exact=True).click()
    expect(p.get_by_role('article',name='Revision 3 · Current',exact=True)).to_be_visible()


@then('the original content is current at revision 3 with the restore reason')
def restored(context):
    w=context.world
    current=w.call('GET',w.channel)
    assert current['revision']=='3' and current['version']==w.original['version']
    latest=w.call('GET',w.channel+'/releases')['items'][0]
    assert latest['unevaluatedReason'].endswith('BDD operator rollback.')


def open_restore_review(p, current_revision):
    p.get_by_role('article', name='Revision 1', exact=True).get_by_role('button').click()
    p.get_by_role('button', name='Restore revision 1', exact=True).click()
    dialog = p.get_by_role('dialog', name='Restore revision 1?', exact=True)
    expect(dialog).to_contain_text(f'current stable release (revision {current_revision})')
    expect(dialog.get_by_label('Reason for restoring')).to_have_value('')
    return dialog


@when('I open a restore of revision 1 against revision 2')
def review_original_restore(context):
    w = context.world
    w.browser().visit('/releases')
    dialog = open_restore_review(page(context), '2')
    dialog.get_by_label('Reason for restoring').fill('Reviewed the second release.')


@when('I confirm the restore I reviewed')
def submit_original_restore(context):
    page(context).get_by_role('dialog').get_by_role('button', name='Restore version', exact=True).click()


@then("the console explains the conflict and the other operator's revision 3 still serves")
def stale_restore_rejected(context):
    w = context.world
    dialog = page(context).get_by_role('dialog', name='Restore revision 1?')
    expect(dialog.get_by_role('alert')).to_contain_text(re.compile('release changed', re.I))
    expect(dialog.get_by_role('button', name='Review current release', exact=True)).to_be_enabled()
    current = w.call('GET', w.channel)
    assert current['revision'] == '3' and current['version'] == w.external_promotion['version']
    w.history_before_retry = w.call('GET', w.channel + '/releases')['items']
    assert w.history_before_retry[0]['id'] == w.external_promotion['id']


@when('I review the current release and confirm a new restore against revision 3')
def review_new_restore(context):
    p = page(context)
    p.get_by_role('button', name='Review current release', exact=True).click()
    expect(p.get_by_role('article', name='Revision 3 · Current', exact=True)).to_be_visible()
    current = p.get_by_role('region', name='Selected release', exact=True)
    expect(current).to_be_visible()
    current.get_by_role('button', name='Inspect content for revision 3', exact=True).click()
    expect(p.get_by_label('Content of AGENTS.md', exact=True)).to_contain_text('Review retry limits.')
    p.get_by_role('dialog').get_by_role('button', name='Close', exact=True).click()
    dialog = open_restore_review(p, '3')
    dialog.get_by_label('Reason for restoring').fill('Reviewed revision 3 before restoring.')
    dialog.get_by_role('button', name='Restore version', exact=True).click()


@then("exactly one restore follows the other operator's release in history")
def restore_after_new_review(context):
    w = context.world
    expect(page(context).get_by_role('article', name='Revision 4 · Current', exact=True)).to_be_visible()
    current = w.call('GET', w.channel)
    assert current['revision'] == '4' and current['version'] == w.original['version']
    restored, *previous = w.call('GET', w.channel + '/releases')['items']
    assert previous == w.history_before_retry
    assert restored['revision'] == '4' and restored['version'] == w.original['version']
    assert restored['previousVersionId'] == w.external_promotion['version']['id']
    assert restored['unevaluatedReason'].endswith('Reviewed revision 3 before restoring.')


@when('I create an integration and issue a read credential in the console')
def ui_issue(context):
    w=context.world
    w.browser().select_bundle()
    w.browser_fixture.visit('/integrations')
    p=page(context)
    p.get_by_role('button',name='New connection',exact=True).click()
    p.get_by_label('Display name',exact=True).fill('BDD browser app')
    p.get_by_label('Bundle',exact=True).select_option(w.setup['bundle']['id'])
    p.get_by_label('Channel',exact=True).select_option('stable')
    p.get_by_role('button',name='Create connection',exact=True).click()
    p.get_by_role('button',name='Create read credential',exact=True).click()
    expect(p.get_by_role('heading',name='Save this credential now',exact=True)).to_be_visible()
    w.ui_secret=p.get_by_role('dialog').get_by_label('One-time credential secret',exact=True).input_value()
    w.ui_credential_id=p.get_by_role('dialog').locator('code').inner_text()
    w.h.tokens['issued-browser']=w.ui_secret


@then('its secret is shown once and missing delivery is labelled unknown')
def secret_once(context):
    w=context.world
    assert w.ui_secret.startswith('aci_')
    p=page(context)
    expect(p.get_by_role('dialog')).to_contain_text('secret appears only once')
    # The status underneath remains factual; closing the dialog makes it visible.


@when('I close the secret dialog and revoke that credential')
def ui_revoke(context):
    p=page(context)
    p.get_by_role('button',name='I saved it · close',exact=True).click()
    p.get_by_role('tab',name='Delivery reports',exact=True).click()
    expect(p.get_by_text('No delivery report received; status unknown.',exact=False)).to_be_visible()
    p.get_by_role('tab',name='Credentials',exact=True).click()
    p.get_by_role('button',name=re.compile(r'^Revoke (read|reporting) credential ')).click()
    submit_and_wait(p,p.get_by_role('dialog').get_by_role('button',name='Revoke',exact=True))
    row=p.locator('code').filter(has_text=re.compile('^'+re.escape(context.world.ui_credential_id)+'$')).locator('../..')
    expect(row.get_by_text('Read credential · Revoked',exact=True)).to_be_visible()
    expect(row.get_by_role('button',name=re.compile(r'^Revoke (read|reporting) credential '))).to_have_count(0)


@then('the closed secret is not displayed and its next fetch is denied')
def revoked_secret(context):
    w=context.world
    expect(page(context).get_by_label('One-time credential secret',exact=True)).to_have_count(0)
    expect(page(context).get_by_text(w.ui_secret,exact=True)).to_have_count(0)
    w.call('GET',w.channel,actor='issued-browser',expected=403)


@then('the page shows the last read and unknown current state without editable content')
def failed_read(context):
    p=page(context)
    expect(p.get_by_text('Could not connect',exact=True)).to_be_visible()
    expect(p.get_by_text(re.compile(r'Last read at .*Content is hidden until a verified refresh succeeds\.'))).to_be_visible()
    expect(p.get_by_test_id('entry-content')).to_have_count(0)
    expect(p.get_by_role('textbox', name='Content', exact=True)).to_have_count(0)


@when('I visit every main route at desktop and mobile sizes')
def routes(context):
    w=context.world
    p=page(context)
    from scripts.bdd.layout import capture_layout
    artifact_dir=Path(context.config.userdata['artifact_dir'])/'ui-layout'
    # Wait for a data-backed result or route action before measuring each layout.
    routes = {
        '/content': lambda page: page.get_by_test_id('entry-content'),
        '/releases': lambda page: page.get_by_test_id('release-decision').first,
        '/setup': lambda page: page.get_by_role('link', name='BDD bundle', exact=True),
        '/integrations': lambda page: page.get_by_role('button', name='New connection', exact=True),
        '/connect': lambda page: page.get_by_role('button', name='Copy install command', exact=True),
    }

    def visit_route(page, route):
        w.browser_fixture.visit(route, page=page)
        expect(routes[route](page)).to_be_visible()
        page.evaluate('document.fonts.ready.then(() => true)')

    for width in (1440,1024,768,390,320):
        p.set_viewport_size(dict(width=width,height=1000))
        for route in routes:
            visit_route(p, route)
            capture_layout(p,artifact_dir,f'{width}-{route[1:]}')
        if width==390:
            trigger=p.get_by_role('button',name='Open navigation',exact=True)
            trigger.click()
            capture_layout(p,artifact_dir,'390-navigation-open')
            p.get_by_role('dialog').get_by_role('link',name='Bundles',exact=True).click()
            expect(p).to_have_url(w.browser_fixture.base+w.browser_fixture.workspace_path())
    p.set_viewport_size(dict(width=1440,height=1000))
    for route in routes:
        visit_route(p, route)
        # Chromium's CSS zoom exercises 200% text/control scaling and reflow in
        # headless acceptance; native browser zoom is also checked interactively.
        p.evaluate("document.documentElement.style.zoom='2'")
        capture_layout(p,artifact_dir,'zoom200-'+route[1:])
    p.evaluate("document.documentElement.style.zoom=''")
    # A fresh touch context makes CSS pointer:coarse rules real, rather than
    # overriding matchMedia or testing the desktop targets at a narrow width.
    b=w.browser_fixture
    touch=b.browser.new_context(ignore_https_errors=True,viewport=dict(width=390,height=1000),has_touch=True,
                                storage_state=b.context.storage_state())
    try:
        touch_page=touch.new_page()
        touch_page.on('pageerror',lambda error:b.errors.append(str(error)))
        for route in routes:
            visit_route(touch_page, route)
            capture_layout(touch_page,artifact_dir,'coarse390-'+route[1:],coarse=True)
    finally:
        touch.close()


@then('the routes have no browser errors or horizontal overflow')
def readable(context):
    w=context.world
    assert w.browser_fixture.errors==[],w.browser_fixture.errors


@then('the published entry becomes "{text}" without a refresh control')
def automatically_updated_content(context,text):
    p=page(context)
    expect(p.get_by_test_id('entry-content')).to_contain_text(text,timeout=22000)
    expect(p.get_by_role('button',name=re.compile(r'^Refresh'))).to_have_count(0)
    expect(p.get_by_role('alertdialog')).to_have_count(0)
