"""UX regressions against disposable World service, database, files and browser."""

from behave import given, when, then
from playwright.sync_api import expect

from features.steps.console import page
from features.steps.remediation_recovery import records
from scripts.bdd.interactions import open_details


INVALID_TEXT = 'Keep this browser text while correcting the invalid path.'
EXTERNAL_TEXT = 'Generation two saved independently by another operator.'
BROWSER_TEXT = '  My later browser edits.\n\nPreserve whitespace and this final line.\n'
UNUSED_INSTRUCTIONS = 'Unused typed instructions must never become imported content.'


@when('I open a bookmarked content path missing from that channel')
def missing_path(context):
    w = context.world
    w.browser().visit(w.browser_fixture.bundle_path('content', path='memory/removed.md'))


@then('the missing selection is explained without displaying unrelated content')
def missing_path_feedback(context):
    p = page(context)
    expect(p.get_by_text('“memory/removed.md” isn’t available in this channel. Choose an entry from the list.', exact=True)).to_be_visible()
    expect(p.get_by_test_id('entry-content')).to_have_count(0)
    expect(p.get_by_role('link', name='Edit entry', exact=True)).to_have_count(0)
    expect(p.get_by_role('button', name='Content actions', exact=True)).to_have_count(0)
    expect(p.get_by_role('dialog', name='Published entry actions', exact=True)).to_have_count(0)
    expect(p.get_by_role('button', name='Copy content', exact=True)).to_have_count(0)
    expect(p.get_by_role('button', name='Download published entry', exact=True)).to_have_count(0)
    expect(p.get_by_role('link', name='Clear selection', exact=True)).to_be_visible()
    expect(p.get_by_role('treeitem', name='Open memory/team.md', exact=True)).to_be_visible()


@when('I clear the missing selection and choose the memory entry')
def recover_missing_path(context):
    p = page(context)
    p.get_by_role('link', name='Clear selection', exact=True).click()
    expect(p.get_by_test_id('entry-content')).to_have_text('Review code.')
    p.get_by_role('treeitem', name='Open memory/team.md', exact=True).click()


@given('I started a new bundle with unused typed instructions')
def new_import_bundle(context):
    w = context.world
    w.browser().visit('/setup')
    p = page(context)
    p.get_by_role('button', name='Create your first bundle', exact=True).click()
    p.get_by_label('Bundle name', exact=True).fill('Real files imported through the browser')
    p.get_by_label('Instructions', exact=True).fill(UNUSED_INSTRUCTIONS)
    assert w.call('GET', w.root + '/bundles')['items'] == []


@when('I choose Import files and select a real bundle folder')
def choose_real_files(context):
    w = context.world
    p = page(context)
    p.get_by_role('radio', name='Import files', exact=True).check()
    expect(p.get_by_label('Instructions', exact=True)).to_have_count(0)
    expect(p.get_by_role('button', name='Import and publish', exact=True)).to_be_disabled()
    w.ux_import_files = [
        dict(path='AGENTS.md', kind='instruction', text='Imported instructions: inspect every retry.'),
        dict(path='skills/ux-review/SKILL.md', kind='skill', text='---\nname: ux-review\ndescription: Review imported changes.\n---\nRead references/checks.md before reviewing.'),
        dict(path='skills/ux-review/references/checks.md', kind='skill', text='Imported support: check duplicate delivery.'),
    ]
    folder = w.h.dir / 'ux-import-bundle'
    for entry in w.ux_import_files:
        target = folder / entry['path']
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_text(entry['text'], encoding='utf-8')
    p.get_by_label('Bundle folder', exact=True).set_input_files(str(folder))


@then('I can review the actual instruction and skill contents before publication')
def review_real_import(context):
    w = context.world
    p = page(context)
    expect(p.get_by_role('heading', name='Import preview · generic', exact=True)).to_be_visible()
    for entry in w.ux_import_files:
        open_details(p, entry['path'] + ' · ' + entry['kind'])
        expect(p.locator('pre').filter(has_text=entry['text'])).to_have_text(entry['text'])
    expect(p.get_by_label('Initial publication summary', exact=True)).to_contain_text('Publishes 3 entries to stable.')
    expect(p.get_by_role('button', name='Import and publish', exact=True)).to_be_disabled()
    expect(p.get_by_text(UNUSED_INSTRUCTIONS, exact=True)).to_have_count(0)
    assert w.call('GET', w.root + '/bundles')['items'] == []


@when('I confirm the imported entries and publish the bundle')
def publish_real_import(context):
    p = page(context)
    p.get_by_role('checkbox', name='Confirm these entries for import', exact=True).check()
    p.get_by_role('button', name='Import and publish', exact=True).click()
    expect(p.get_by_role('navigation', name='Bundle navigation', exact=True)).to_be_visible()


@then('the published bundle contains exactly those imported files')
def exact_imported_publication(context):
    w = context.world
    p = page(context)
    bundles = w.call('GET', w.root + '/bundles')['items']
    assert len(bundles) == 1
    bundle = bundles[0]
    assert bundle['origin'] == 'imported'
    assert bundle['name'] == 'Real files imported through the browser'
    bundle_path = w.root + '/bundles/' + bundle['id']
    resolution = w.call('GET', bundle_path + '/channels/stable')
    actual = w.call('GET', bundle_path + '/versions/' + resolution['version']['id'] + '/payload')
    assert actual['schemaVersion'] == 1
    assert sorted(actual['files'], key=lambda entry: entry['path']) == sorted(w.ux_import_files, key=lambda entry: entry['path'])
    assert resolution['revision'] == '1'
    assert records(p) == []
    for entry in w.ux_import_files:
        p.get_by_role('treeitem', name='Open ' + entry['path'], exact=True).click()
        expect(p.get_by_label('Content of ' + entry['path'], exact=True)).to_have_text(entry['text'])


@then('I read that published memory in the same bundle without changing the release')
def recovered_memory(context):
    w = context.world
    p = page(context)
    expect(p).to_have_url(w.browser_fixture.base + w.browser_fixture.bundle_path('content', path='memory/team.md'))
    expect(p.get_by_label('Content of memory/team.md', exact=True)).to_have_text('Reusable project notes.')
    expect(p.get_by_role('link', name='Clear selection', exact=True)).to_have_count(0)
    assert w.call('GET', w.channel)['version'] == w.original['version']
