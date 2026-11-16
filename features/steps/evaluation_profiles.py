"""Browser-only profile handoff; these scenarios never launch a provider."""
import json
import shlex
from behave import when, then
from playwright.sync_api import expect
from features.steps.console import ensure_editor, save_browser
from scripts.bdd.interactions import open_details


def candidate(context):
    w = context.world
    p = w.browser_fixture.page
    ensure_editor(context)
    p.get_by_role('textbox', name='Content', exact=True).fill('Review retries with an explicitly selected app evaluator.')
    save_browser(context)
    p.get_by_role('link', name='Continue to evaluation', exact=True).click()
    open_details(p, 'Set up evaluation request')
    expect(p.get_by_label('Evaluation configuration', exact=True)).to_be_visible()
    return w, p


@when('I save a browser candidate and select the native Luna evaluation configuration')
def native_profile(context):
    w, p = candidate(context)
    p.get_by_label('Evaluation configuration', exact=True).select_option('codex-luna-review')
    expect(p.get_by_text('Creating a request makes no model call.', exact=False)).to_be_visible()
    p.get_by_role('button', name='Create evaluation request', exact=True).click()
    expect(p.get_by_role('status').filter(has_text='Evaluation request created. Run it in your app, then return here for the results.')).to_be_visible()
    w.profile_request = w.call('GET', w.bundle+'/evaluation-requests')['items'][0]


@then('its strict frozen request and copied command select the native installed adapter without executing it')
def native_handoff(context):
    w = context.world
    p = w.browser_fixture.page
    request = w.profile_request
    assert request['status'] == 'requested' and request['requireBoundEvidence'] is True
    assert request['runtime'] == dict(configId='codex-luna-review', configRevision='1', app='service-proposer-review-v1',
        model='gpt-6-luna', sampling='reasoning-low', writes='disabled', network='disabled', maxTurns='4', turnTimeoutMs='110000', concurrency='1')
    assert request['datasetRevision'] == 'retry-review-snapshots-v1'
    assert request['graderRevision'] == 'retry-review-exact-finding-v1'
    assert request['expectedCases'] == [dict(caseId=case, repetition=0) for case in ['checkout-retry','checkout-keyed']]
    p.get_by_text('Included checkout setup (required)',exact=True).click()
    p.get_by_role('button', name='Copy setup-required command', exact=True).click()
    expect(p.get_by_role('status').filter(has_text='Copied.')).to_be_visible()
    command = shlex.split(p.evaluate('navigator.clipboard.readText()'))
    assert command == ['npm','run','evaluate:app','--','--config','/absolute/private/evaluator.json','--bundleID',w.setup['bundle']['id'],
                       '--requestID',request['id'],'--adapter','codex-luna-review','--live']
    # Checking a copied paid command is deliberately separate from executing it.
    assert w.call('GET', w.bundle+'/evaluation-requests/'+request['id'])['status'] == 'requested'
    assert w.call('GET', w.bundle+'/comparisons')['items'] == []


@when('I select my app evaluator and enter malformed then valid public configuration')
def custom_profile(context):
    w, p = candidate(context)
    p.get_by_label('Evaluation configuration', exact=True).select_option('custom')
    field = p.get_by_label('Public evaluator configuration (JSON)', exact=True).filter(visible=True)
    valid = dict(datasetRevision='bdd-custom-dataset-v7', graderRevision='bdd-custom-grader-v3',
        runtime=dict(configId='bdd-installed-app', configRevision='opaque-revision-42', app='bdd-app', model='none',
                     writes='disabled', maxCases='2', maxDurationMs='1000'),
        expectedCases=[dict(caseId=case, repetition=0) for case in ['case-one','case-two']])
    duplicate = dict(valid, expectedCases=[dict(caseId='case-one', repetition=0)]*2)
    for invalid in ['{', json.dumps(duplicate)]:
        field.fill(invalid)
        expect(p.get_by_role('button', name='Create evaluation request', exact=True)).to_be_disabled()
        expect(p.get_by_role('alert').last).to_be_visible()
        assert w.call('GET', w.bundle+'/evaluation-requests')['items'] == []
    field.fill(json.dumps(valid))
    p.get_by_role('button', name='Create evaluation request', exact=True).click()
    expect(p.get_by_role('status').filter(has_text='Evaluation request created. Run it in your app, then return here for the results.')).to_be_visible()
    w.custom_configuration = valid
    w.profile_request = w.call('GET', w.bundle+'/evaluation-requests')['items'][0]


@then('only the valid strict configuration is persisted and later form edits cannot change it')
def custom_frozen(context):
    w = context.world
    p = w.browser_fixture.page
    request = w.profile_request
    assert request['requireBoundEvidence'] is True and request['status'] == 'requested'
    for key, value in w.custom_configuration.items():
        assert request[key] == value
    article = p.get_by_label('Evaluation request '+request['id'], exact=True)
    expect(article.get_by_text('Run in your app with the request ID and frozen public configuration.', exact=True)).to_be_visible()
    article.get_by_role('button', name='Copy request ID', exact=True).click()
    assert p.evaluate('navigator.clipboard.readText()') == request['id']
    expect(article.locator('code').filter(has_text='npm run evaluate:app')).to_have_count(0)
    changed = dict(w.custom_configuration, runtime=dict(w.custom_configuration['runtime'], configRevision='later-unsubmitted-revision'))
    open_details(p, 'Create another evaluation request')
    p.get_by_label('Public evaluator configuration (JSON)', exact=True).filter(visible=True).fill(json.dumps(changed))
    article.locator('[data-slot=disclosure-trigger]').filter(has_text='Request details').click()
    frozen = json.loads(article.locator('pre').last.inner_text())
    assert frozen['runtime']['configRevision'] == 'opaque-revision-42'
    assert w.call('GET', w.bundle+'/evaluation-requests/'+request['id']) == request
    assert len(w.call('GET', w.bundle+'/evaluation-requests')['items']) == 1
