"""One native-target browser/helper/installed-app/receipt/rollback walkthrough."""
import json
import shutil
import subprocess
from behave import given, when, then
from playwright.sync_api import expect
from scripts.productization.qualify import ROOT
from features.steps.console import restore
from scripts.bdd.interactions import open_details


SKILL = '---\nname: retry-review\ndescription: Review payment retries for duplicate charges.\n---\nReview the payment retry path before recommending another attempt.\n'
REPAIRED_SKILL = SKILL + 'After an ambiguous timeout, reuse the original request idempotency key.\n'


def installed_prepare(w, version, payload, pinned=(), deny_receipt=False):
    directory = w.native_consumer
    config = directory / 'config.json'
    config.write_text(json.dumps(dict(baseUrl=w.h.base, workspaceId=w.h.project, bundleId=w.setup['bundle']['id'],
        connectionId=w.integration['id'], readToken=w.read_credential['secret'], receiptToken=w.write_credential['secret'],
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
        subprocess.run(['npm','pack','--offline','--pack-destination',str(directory),'--workspace','@anveld/acclimate-'+name],
                       cwd=ROOT, check=True, capture_output=True, text=True, timeout=30)
    tarballs = [str(path) for path in sorted(directory.glob('*.tgz'))]
    assert len(tarballs) == 2
    subprocess.run(['npm','install','--offline','--ignore-scripts','--no-audit','--no-fund',*tarballs],
                   cwd=directory, check=True, capture_output=True, text=True, timeout=30)
    shutil.copyfile(ROOT/'scripts/bdd/native_walk_consumer.mjs', directory/'consumer.mjs')
    w.native_consumer = directory
    w.native_old_prepared = installed_prepare(w, w.original['version'], w.native_initial_payload)
    assert w.native_old_prepared['appStarted'] and w.native_old_prepared['pending'] == 0


@when('I upload an incomplete native version, repair it and release the compatible version')
def upload_repair_and_release(context):
    w = context.world
    incomplete = json.loads(json.dumps(w.native_initial_payload))
    incomplete['files'][1]['text'] = '# Missing native metadata'
    versions = w.bundle + '/versions'
    uploaded = w.call('POST', versions, dict(
        parentVersionId=w.original['version']['id'], payload=incomplete))
    assert w.call('GET', f"{versions}/{uploaded['id']}/payload") == incomplete
    w.call('POST', w.channel + '/releases', dict(
        versionId=uploaded['id'], expectedRevision='1', unevaluatedReason='Fixture'), expected=400)
    w.native_candidate_payload = json.loads(json.dumps(w.native_initial_payload))
    w.native_candidate_payload['files'][1]['text'] = REPAIRED_SKILL
    repaired = w.call('POST', versions, dict(
        parentVersionId=uploaded['id'], payload=w.native_candidate_payload))
    release = w.manual_release(repaired, reason='Repaired native metadata')
    assert release['revision'] == '2'
    w.native_released = w.call('GET', w.channel)
    assert w.native_released['version'] == repaired


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
