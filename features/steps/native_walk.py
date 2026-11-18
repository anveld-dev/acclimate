"""One native-target browser/helper/installed-app/receipt/rollback walkthrough."""
import json
import shutil
import subprocess
from behave import given, when, then
from playwright.sync_api import expect
from scripts.bdd.editor import expect_editor_value
from scripts.productization.qualify import ROOT
from features.steps.console import save_browser, saved_draft, external_app, review_publish, restore, install_browser_evaluator
from features.steps.remediation_recovery import lose_response, records
from scripts.bdd.interactions import open_details


SKILL = '---\nname: retry-review\ndescription: Review payment retries for duplicate charges.\n---\nReview the payment retry path before recommending another attempt.\n'
REPAIRED_SKILL = SKILL + 'After an ambiguous timeout, reuse the original request idempotency key.\n'


def installed_prepare(w, version, payload, pinned=(), deny_receipt=False):
    directory = w.native_consumer
    config = directory / 'config.json'
    config.write_text(json.dumps(dict(baseUrl=w.h.base, projectId=w.h.project, bundleId=w.setup['bundle']['id'],
        integrationId=w.integration['id'], readToken=w.read_credential['secret'], receiptToken=w.write_credential['secret'],
        expectedVersion=version, expectedPayload=payload, pinned=list(pinned), denyReceipt=deny_receipt)))
    config.chmod(0o600)
    result = subprocess.run(['node', str(directory/'consumer.mjs'), str(config)], cwd=directory,
        env=dict(w.h.env, TMPDIR=str(directory/'native-tmp')), capture_output=True, text=True, timeout=30)
    assert result.returncode == 0, 'Installed native app failed: ' + result.stderr[-2000:]
    return json.loads(result.stdout.strip().splitlines()[-1])


@given('I import a Codex-target bundle with a native skill and declarative payment memory in the browser')
def native_import(context):
    w = context.world
    w.native_initial_payload = dict(schemaVersion=1, files=[
        dict(path='AGENTS.md', kind='instruction', text='Review code.'),
        dict(path='skills/retry-review/SKILL.md', kind='skill', text=SKILL),
        dict(path='payment-policy.json', kind='memory', text=json.dumps(dict(maxAttempts=2, idempotency='attempt'))),
    ])
    b = w.browser()
    b.visit('/setup')
    p = b.page
    p.get_by_role('button', name='Create your first bundle', exact=True).click()
    p.get_by_label('Bundle name', exact=True).fill('Native combined walkthrough')
    open_details(p, 'Publishing settings')
    p.get_by_label('Compatibility target', exact=True).select_option('codex')
    p.get_by_role('radio', name='Import JSON', exact=True).check()
    p.get_by_label('Bundle JSON', exact=True).fill(json.dumps(w.native_initial_payload))
    p.get_by_label('Confirm these entries for import', exact=True).check()
    p.get_by_role('button', name='Import and publish', exact=True).click()
    expect(p.get_by_role('navigation', name='Bundle navigation', exact=True)).to_be_visible()
    bundle = w.call('GET', w.root+'/bundles')['items'][0]
    assert bundle['compatibilityTarget'] == 'codex' and bundle['origin'] == 'imported'
    w.bundle = w.root+'/bundles/'+bundle['id']
    w.channel = w.bundle+'/channels/stable'
    w.original = w.call('GET', w.channel)
    w.setup = dict(bundle=bundle, resolution=w.original)


@given('an isolated app installs the packed SDK and native plugin and retains its original prepared workspace')
def installed_initial(context):
    w = context.world
    w.create_integration()
    w.issue('content-read')
    w.issue('receipt-write')
    directory = w.h.dir/'native-installed-app'
    directory.mkdir(mode=0o700)
    (directory/'native-tmp').mkdir(mode=0o700)
    (directory/'package.json').write_text('{"private":true,"type":"module"}')
    for name in ['sdk', 'codex-plugin']:
        subprocess.run(['npm','pack','--offline','--pack-destination',str(directory),'--workspace','@acclimate/'+name],
                       cwd=ROOT, check=True, capture_output=True, text=True, timeout=30)
    tarballs = [str(path) for path in sorted(directory.glob('*.tgz'))]
    assert len(tarballs) == 2
    subprocess.run(['npm','install','--offline','--ignore-scripts','--no-audit','--no-fund',*tarballs],
                   cwd=directory, check=True, capture_output=True, text=True, timeout=30)
    shutil.copyfile(ROOT/'scripts/bdd/native_walk_consumer.mjs', directory/'consumer.mjs')
    w.native_consumer = directory
    w.native_old_prepared = installed_prepare(w, w.original['version'], w.native_initial_payload)
    assert w.native_old_prepared['appStarted'] and w.native_old_prepared['pending'] == 0


@when('I save an incomplete native manifest, reload it, then repair it and recover a lost save response')
def incomplete_repair(context):
    w = context.world
    b = w.browser_fixture
    p = b.page
    b.visit(b.bundle_path('changes', draft='new', path='skills/retry-review/SKILL.md'))
    p.get_by_role('textbox', name='Content', exact=True).fill('# Incomplete manifest retained as a draft.\n')
    save_browser(context)
    incomplete = saved_draft(w)
    assert incomplete['generation'] == 1
    p.reload()
    expect_editor_value(p.get_by_role('textbox', name='Content', exact=True), '# Incomplete manifest retained as a draft.\n')
    expect(p.get_by_text('Native compatibility needs repair before publication.', exact=False)).to_be_visible()
    p.get_by_role('textbox', name='Content', exact=True).fill(REPAIRED_SKILL)
    p.get_by_role('treeitem', name='Open AGENTS.md', exact=True).click()
    p.get_by_role('textbox', name='Content', exact=True).fill('Review code. Reuse the same idempotency key after a lost response.')
    p.get_by_role('treeitem', name='Open payment-policy.json', exact=True).click()
    p.get_by_role('textbox', name='Content', exact=True).fill(json.dumps(dict(maxAttempts=2, idempotency='request')))
    lose_response(p, lambda: p.get_by_role('button', name='Save draft', exact=True).click())
    committed = saved_draft(w)
    assert committed['id'] == incomplete['id'] and committed['generation'] == 2
    p.get_by_role('button', name='Check result', exact=True).click()
    expect(p.get_by_role('button', name='Check result', exact=True)).to_have_count(0)
    assert records(p) == [] and saved_draft(w) == committed
    p.reload()
    expect(p.get_by_text('Native compatibility needs repair before publication.', exact=False)).to_have_count(0)
    expect_editor_value(p.get_by_role('textbox', name='Content', exact=True), json.dumps(dict(maxAttempts=2, idempotency='request')))
    w.browser_saved = committed
    w.native_candidate_payload = w.call('GET', w.bundle+'/versions/'+committed['snapshotVersion']['id']+'/payload')


@when('I request strict evaluation, run the copied private helper, inspect every bound case and deliberately release')
def strict_helper_release(context):
    w = context.world
    p = w.browser_fixture.page
    p.get_by_role('link', name='Continue to evaluation', exact=True).click()
    open_details(p, 'Set up evaluation request')
    expect(p.get_by_role('button', name='Create evaluation request', exact=True)).to_be_disabled()
    install_browser_evaluator(w, p)
    p.get_by_role('button', name='Create evaluation request', exact=True).click()
    expect(p.get_by_role('status').filter(has_text='Evaluation request created. Run it in your app, then return here for the results.')).to_be_visible()
    w.browser_request = w.call('GET', w.bundle+'/evaluation-requests')['items'][0]
    assert w.browser_request['requireBoundEvidence'] is True
    assert w.call('GET', w.channel)['revision'] == '1'
    external_app(context)
    request = w.call('GET', w.bundle+'/evaluation-requests/'+w.browser_request['id'])
    assert request['status'] == 'completed' and request['evaluatorPrincipal'] == 'evaluator'
    report = w.call('GET', w.bundle+'/comparisons/'+request['comparisonId'])
    assert report['complete'] and len(report['results']) == len(report['expectedCases']) == 2
    assert report['evaluation'] == dict(requestId=request['id'], attemptId=request['attemptId'])
    assert all(pair[side]['executionStatus'] == 'completed' and pair[side]['gradingStatus'] == 'scored'
               for pair in report['results'] for side in ['parent','candidate'])
    assert all(pair['candidate']['reward'] == 1 for pair in report['results'])
    assert any(pair['parent']['reward'] == 0 for pair in report['results'])
    assert w.call('GET', w.channel)['revision'] == '1', 'App evaluation must not promote automatically'
    review_publish(context, expected_verdict='pass')
    open_details(p,'Case map and all outcomes')
    open_details(p,'Evidence details')
    expect(p.locator('.comparison-evidence-binding').get_by_text(request['id'],exact=True)).to_be_visible()
    expect(p.locator('.comparison-evidence-provenance')).to_contain_text('Attempt '+request['attemptId'])
    open_details(p,'Comparison lookup and details')
    frozen=json.loads(p.locator('[data-slot=disclosure-trigger]').filter(has_text='Comparison lookup and details').locator('..').locator('pre').inner_text())
    assert frozen['evaluation']==dict(requestId=request['id'],attemptId=request['attemptId'])
    current = w.call('GET', w.channel)
    assert current['revision'] == '2' and current['version'] == w.browser_saved['snapshotVersion']
    w.native_released = current


@then('the installed app prepares the released native bytes, observes its actual start and records only optional delivery evidence')
def delivered_release(context):
    w = context.world
    w.native_new_prepared = installed_prepare(w, w.native_released['version'], w.native_candidate_payload, [w.native_old_prepared])
    assert w.native_new_prepared['appStarted'] and w.native_new_prepared['pending'] == 0
    receipts = w.call('GET', w.integration_path+'/receipts')['items']
    selected = [row for row in receipts if row['versionId'] == w.native_released['version']['id']]
    assert {'resolved','verified','prepared','started'} <= {row['stage'] for row in selected}
    assert all(row['digest'] == w.native_released['version']['digest'] for row in selected)
    assert all(not any(key in row for key in ['content','memory','prompt','modelConsumed','sessionId']) for row in selected)


@when('I roll back through the browser and the next installed job has an unavailable optional reporting credential')
def rollback_job(context):
    w = context.world
    restore(context)
    current = w.call('GET', w.channel)
    assert current['revision'] == '3' and current['version'] == w.original['version']
    w.native_rolled_back = installed_prepare(w, current['version'], w.native_initial_payload,
                                           [w.native_old_prepared, w.native_new_prepared], deny_receipt=True)


@then('rollback delivery succeeds while both earlier prepared workspaces keep their exact pinned bytes')
def pinned_rollback(context):
    w = context.world
    assert w.native_rolled_back['appStarted'] and w.native_rolled_back['pending'] > 0
    assert w.native_rolled_back['version'] == w.native_old_prepared['version']
    assert w.native_new_prepared['version'] != w.native_old_prepared['version']
    for prepared in [w.native_old_prepared, w.native_new_prepared]:
        for file in prepared['files']:
            from pathlib import Path
            assert Path(file['absolutePath']).read_text() == file['text']
