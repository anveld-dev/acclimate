"""Recovery survives a real document reload using only the disposable browser fixture."""
import re

from behave import when, then
from playwright.sync_api import expect
from scripts.bdd.editor import expect_editor_value
from scripts.bdd.interactions import close_draft_details

from features.steps.console import page, saved_draft
from features.steps.remediation_recovery import records, TEXT_A
from scripts.bdd.interactions import open_details


@when('I reload that uncertain fresh draft and check the result')
def reload_uncertain_fresh_draft(context):
    w = context.world
    p = page(context)
    expect(p).to_have_url(re.compile(r'[?&]draft=new(?:&|$)'))
    p.once('dialog', lambda dialog: dialog.accept())
    response = p.reload(wait_until='networkidle')
    assert response and response.status == 200
    expect(p).to_have_url(w.before_retry_url)
    # The document starts from the published baseline, while the exact pending
    # request survives in session storage. This difference is not a local edit.
    expect_editor_value(p.get_by_role('textbox', name='Content', exact=True), 'Review code.')
    expect(p.get_by_role('button', name='Check result', exact=True)).to_be_enabled()
    assert records(p) == w.recovery_records
    assert saved_draft(w) == w.recovered_draft
    p.get_by_role('button', name='Check result', exact=True).click()


@then('the committed snapshot reopens without duplicating or overwriting its saved text')
def reloaded_snapshot_is_committed(context):
    w = context.world
    p = page(context)
    expect(p).to_have_url(re.compile(r'[?&]draft=' + w.recovered_draft['id'] + r'(?:&|$)'))
    p.wait_for_load_state('networkidle')
    expect_editor_value(p.get_by_role('textbox', name='Content', exact=True), TEXT_A)
    expect(p.get_by_role('textbox', name='Content', exact=True)).to_be_enabled()
    expect(p.get_by_text(re.compile(r'\bUnsaved changes\b'))).to_have_count(0)
    expect(p.get_by_role('button', name='Save draft', exact=True)).to_be_disabled()
    expect(p.get_by_role('button', name='Check result', exact=True)).to_have_count(0)
    expect(p.get_by_role('link', name='Continue to evaluation', exact=True)).to_be_visible()
    open_details(p, 'Draft details')
    details = p.get_by_role('dialog', name='Draft details', exact=True)
    expect(details).to_contain_text('generation 1')
    expect(details).to_contain_text(w.recovered_draft['snapshotVersion']['id'])
    close_draft_details(p)
    assert records(p) == []
    drafts = w.call('GET', w.channel + '/drafts')['items']
    assert drafts == [w.recovered_draft]
    assert w.draft_text(drafts[0]) == TEXT_A
    history = w.call('GET', w.channel + '/drafts/' + drafts[0]['id'] + '/history')['items']
    assert len(history) == 1 and history[0]['generation'] == 1
    assert w.call('GET', w.channel)['version'] == w.original['version']
