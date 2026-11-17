"""UX regressions against disposable World service, database, files and browser."""
import json

from behave import given, when, then
from playwright.sync_api import expect
from scripts.bdd.editor import expect_editor_value
from scripts.bdd.interactions import close_draft_details

from features.steps.console import page, ensure_editor, save_browser, saved_draft
from features.steps.remediation_recovery import records
from scripts.bdd.interactions import open_entry_actions, close_entry_actions, open_details
from scripts.productization.qualify import payload


INVALID_TEXT = 'Keep this browser text while correcting the invalid path.'
EXTERNAL_TEXT = 'Generation two saved independently by another operator.'
BROWSER_TEXT = '  My later browser edits.\n\nPreserve whitespace and this final line.\n'
UNUSED_INSTRUCTIONS = 'Unused typed instructions must never become imported content.'


@when('I try to save a fresh browser draft with an invalid entry path')
def invalid_fresh_draft(context):
    ensure_editor(context)
    p = page(context)
    p.get_by_role('textbox', name='Content', exact=True).fill(INVALID_TEXT)
    open_entry_actions(p)
    p.get_by_label('Entry path (rename)', exact=True).fill('../escape.md')
    close_entry_actions(p)
    p.get_by_role('button', name='Save draft', exact=True).click()


@then('the draft explains the invalid content without locking another save')
def invalid_feedback(context):
    w = context.world
    p = page(context)
    # Feedback belongs to this editor, remains in the page after submission, and
    # does not require finding a transient toast or opening recovery details.
    editor = p.locator('section').filter(has=p.get_by_role('textbox', name='Content', exact=True)).last
    feedback = editor.get_by_role('status').filter(has_text='Bundle contains an invalid file')
    expect(feedback).to_be_visible()
    expect(feedback).to_be_in_viewport()
    expect_editor_value(p.get_by_role('textbox', name='Content', exact=True), INVALID_TEXT)
    open_entry_actions(p)
    expect(p.get_by_label('Entry path (rename)', exact=True)).to_have_value('../escape.md')
    close_entry_actions(p)
    expect(p.get_by_role('button', name='Save draft', exact=True)).to_be_enabled()
    expect(p.get_by_role('button', name='Check result', exact=True)).to_have_count(0)
    assert records(p) == [], 'Locally rejected content must not freeze a pending submission'
    assert w.call('GET', w.channel + '/drafts')['items'] == []
    assert w.call('GET', w.channel)['version'] == w.original['version']


@when('I correct the invalid path and save the draft')
def correct_invalid_draft(context):
    p = page(context)
    open_entry_actions(p)
    p.get_by_label('Entry path (rename)', exact=True).fill('AGENTS.md')
    close_entry_actions(p)
    save_browser(context)


@then('only the corrected draft snapshot is saved and the release stays unchanged')
def corrected_snapshot(context):
    w = context.world
    drafts = w.call('GET', w.channel + '/drafts')['items']
    assert len(drafts) == 1 and drafts[0]['generation'] == 1
    actual = w.call('GET', w.bundle + '/versions/' + drafts[0]['snapshotVersion']['id'] + '/payload')
    assert actual == payload(INVALID_TEXT)
    expect_editor_value(page(context).get_by_role('textbox', name='Content', exact=True), INVALID_TEXT)
    assert records(page(context)) == []
    assert w.call('GET', w.channel)['version'] == w.original['version']


@given('I saved a browser draft before an external newer generation')
def external_generation(context):
    w = context.world
    p = page(context)
    ensure_editor(context)
    p.get_by_role('textbox', name='Content', exact=True).fill('Generation one opened in this browser.')
    save_browser(context)
    w.ux_first_draft = saved_draft(w)
    w.ux_draft_path = w.channel + '/drafts/' + w.ux_first_draft['id']
    w.ux_external_draft = w.call('POST', w.ux_draft_path + '/save', dict(
        expectedGeneration=w.ux_first_draft['generation'], payload=payload(EXTERNAL_TEXT)))
    assert w.ux_external_draft['generation'] == 2
    p.get_by_role('textbox', name='Content', exact=True).fill(BROWSER_TEXT)
    w.ux_editor_url = p.url


@when('I cancel reloading that saved draft with unsaved browser edits')
def cancel_reload(context):
    p = page(context)
    p.get_by_role('button', name='Reload saved draft', exact=True).click()
    expect(p.get_by_role('heading', name='Leave current edits?', exact=True)).to_be_visible()
    p.get_by_role('button', name='Keep editing', exact=True).click()


@then('the exact browser edits remain while the newer generation stays saved')
def reload_cancel_retains(context):
    w = context.world
    p = page(context)
    expect(p).to_have_url(w.ux_editor_url)
    expect_editor_value(p.get_by_role('textbox', name='Content', exact=True), BROWSER_TEXT)
    expect(p.get_by_role('heading', name='Leave current edits?', exact=True)).to_have_count(0)
    expect(p.get_by_role('button', name='Save draft', exact=True)).to_be_enabled()
    assert w.call('GET', w.ux_draft_path) == w.ux_external_draft
    assert w.draft_text(w.ux_external_draft) == EXTERNAL_TEXT


@when('I explicitly discard those browser edits and reload the saved draft')
def accept_reload(context):
    p = page(context)
    p.get_by_role('button', name='Reload saved draft', exact=True).click()
    expect(p.get_by_role('heading', name='Leave current edits?', exact=True)).to_be_visible()
    p.get_by_role('button', name='Leave editor', exact=True).click()


@then('the editor reads the externally saved generation without creating another save')
def latest_reload(context):
    w = context.world
    p = page(context)
    expect_editor_value(p.get_by_role('textbox', name='Content', exact=True), EXTERNAL_TEXT)
    expect(p.get_by_role('button', name='Save draft', exact=True)).to_be_disabled()
    open_details(p, 'Draft details')
    details = p.get_by_role('dialog', name='Draft details', exact=True)
    expect(details).to_contain_text('generation 2')
    expect(details).to_contain_text(w.ux_external_draft['snapshotVersion']['id'])
    close_draft_details(p)
    assert w.call('GET', w.ux_draft_path) == w.ux_external_draft
    assert len(w.call('GET', w.ux_draft_path + '/history')['items']) == 2
    assert records(p) == []
    assert w.call('GET', w.channel)['version'] == w.original['version']


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


@then('I read that published memory in the same bundle without creating a draft')
def recovered_memory(context):
    w = context.world
    p = page(context)
    expect(p).to_have_url(w.browser_fixture.base + w.browser_fixture.bundle_path('content', path='memory/team.md'))
    expect(p.get_by_label('Content of memory/team.md', exact=True)).to_have_text('Reusable project notes.')
    expect(p.get_by_role('link', name='Clear selection', exact=True)).to_have_count(0)
    assert w.call('GET', w.channel + '/drafts')['items'] == []
    assert w.call('GET', w.channel)['version'] == w.original['version']


@when('I enter custom evaluator JSON and try to leave its review page')
def custom_evaluator_navigation(context):
    w = context.world
    p = page(context)
    ensure_editor(context)
    p.get_by_role('textbox', name='Content', exact=True).fill('Saved candidate for custom evaluator navigation.')
    save_browser(context)
    w.ux_evaluation_draft = saved_draft(w)
    p.get_by_role('link', name='Continue to evaluation', exact=True).click()
    open_details(p, 'Set up evaluation request')
    expect(p.get_by_label('Evaluation configuration', exact=True)).to_have_value('')
    expect(p.get_by_role('button', name='Create evaluation request', exact=True)).to_be_disabled()
    p.get_by_label('Evaluation configuration', exact=True).select_option('custom')
    configuration = dict(datasetRevision='ux-fixture-data-v1', graderRevision='ux-fixture-grader-v1',
        runtime=dict(configId='ux-installed-fixture', configRevision='1', app='ux-app', model='none'),
        expectedCases=[dict(caseId='ux-case', repetition=0)])
    w.ux_configuration_text = ' \n' + json.dumps(configuration, indent=3) + '\n\n'
    p.get_by_label('Public evaluator configuration (JSON)', exact=True).fill(w.ux_configuration_text)
    expect(p.get_by_role('button', name='Create evaluation request', exact=True)).to_be_enabled()
    w.ux_evaluation_url = p.url
    p.get_by_role('navigation', name='Bundle navigation', exact=True).get_by_role('link', name='Releases', exact=True).click()


@then('navigation warns before losing the custom evaluator configuration')
def evaluator_warning(context):
    p = page(context)
    expect(p.get_by_role('heading', name='Leave current edits?', exact=True)).to_be_visible()
    expect(p.get_by_text('Unsaved text will be lost.', exact=False)).to_be_visible()
    assert context.world.call('GET', context.world.bundle + '/evaluation-requests')['items'] == []


@when('I keep editing the custom evaluator configuration')
def retain_custom_evaluator(context):
    page(context).get_by_role('button', name='Keep editing', exact=True).click()


@then('its exact JSON remains without requesting or running an evaluation')
def exact_custom_evaluator(context):
    w = context.world
    p = page(context)
    expect(p).to_have_url(w.ux_evaluation_url)
    expect(p.get_by_role('heading', name='Leave current edits?', exact=True)).to_have_count(0)
    expect(p.get_by_label('Evaluation configuration', exact=True)).to_have_value('custom')
    expect(p.get_by_label('Public evaluator configuration (JSON)', exact=True)).to_have_value(w.ux_configuration_text)
    expect(p.get_by_role('button', name='Create evaluation request', exact=True)).to_be_enabled()
    assert w.call('GET', w.bundle + '/evaluation-requests')['items'] == []
    assert w.call('GET', w.bundle + '/comparisons')['items'] == []
    assert saved_draft(w) == w.ux_evaluation_draft
    assert w.call('GET', w.channel)['version'] == w.original['version']


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
    assert w.call('GET', bundle_path + '/channels/stable/drafts')['items'] == []
    assert w.call('GET', bundle_path + '/evaluation-requests')['items'] == []
    assert records(p) == []
    for entry in w.ux_import_files:
        p.get_by_role('treeitem', name='Open ' + entry['path'], exact=True).click()
        expect(p.get_by_label('Content of ' + entry['path'], exact=True)).to_have_text(entry['text'])
