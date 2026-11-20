"""Deliver an imported native bundle through an enrolled, installed application."""
import json
import shutil
import subprocess
from behave import given, when, then
from playwright.sync_api import expect
from scripts.productization.qualify import ROOT
from scripts.bdd.interactions import open_details


SKILL = '---\nname: retry-review\ndescription: Review payment retries for duplicate charges.\n---\nReview the payment retry path before recommending another attempt.\n'


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
    seed, = w.call('GET', w.channel + '/releases')['items']
    w.original = dict(channel='stable', revision=seed['revision'], version=seed['version'])
    w.setup = dict(bundle=bundle, resolution=w.original)


@when('an isolated app installs the packed SDK and native plugin and retains its original prepared workspace')
def installed_initial(context):
    w = context.world
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


@then('the connected native job starts on the verified seed and reports its delivery')
def native_initial_delivered(context):
    w = context.world
    job = w.native_old_prepared
    assert job['version'] == w.original['version']
    receipts = w.call('GET', w.integration_path + '/receipts')['items']
    assert {item['stage'] for item in receipts} == {'resolved','downloaded','verified','prepared','started'}
    assert all(item['versionId'] == job['version']['id'] for item in receipts)
