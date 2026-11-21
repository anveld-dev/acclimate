import json
import uuid
from datetime import datetime, timedelta, timezone
from behave import given, when, then


@given('I created an integration for this bundle and channel')
def integration(context):
    context.world.create_integration()


@when("I inspect the integration's recent reports")
def reports(context):
    w = context.world
    w.receipts = w.call('GET', w.integration_path + '/receipts')['items']


@then('no delivery report is returned')
def no_claim(context):
    assert context.world.receipts == []


@given('I issued a {kind} credential')
def issued(context, kind):
    context.world.issue(kind)


@when('the integration resolves and fetches the published version')
def read_released(context):
    w = context.world
    w.observed_resolution = w.call('GET', w.channel, actor='content-reader')
    w.observed_payload = w.call('GET', w.bundle + '/versions/' + w.observed_resolution['version']['id'] + '/payload', actor='content-reader')


@then('it receives "{text}" with the released digest')
def content(context, text):
    w = context.world
    assert w.observed_payload['files'][0]['text'] == text
    assert w.observed_resolution['version']['digest'] == w.original['version']['digest']


@when("the integration requests the unreleased version's bytes")
def unpublished(context):
    w = context.world
    w.call('GET', w.bundle + '/versions/' + w.uploaded_version['id'] + '/payload', actor='content-reader', expected=403)


@when('that credential requests {resource}')
def limited(context, resource):
    w = context.world
    actor = 'content-reader' if w.credential['kind'] == 'content-read' else 'receipt-writer'
    if resource == 'receipt history':
        w.call('GET', w.integration_path + '/receipts', actor=actor, expected=(401,403))
    elif resource == 'content bytes':
        w.call('GET', w.bundle + '/versions/' + w.original['version']['id'] + '/payload', actor=actor, expected=(401,403))
    elif resource == 'publish':
        w.call('POST', w.channel + '/releases', dict(versionId=w.original['version']['id'], expectedRevision='1', unevaluatedReason='Denied credential use.'), actor=actor, expected=(401,403))
    else:
        raise AssertionError(resource)


@given('the app reports verified delivery')
@when('the app reports verified delivery')
def report(context):
    w = context.world
    w.event = w.delivery_event()
    w.receipt = w.call('POST', w.integration_path + '/receipts', w.event, actor='receipt-writer')


@then('the stored observation names the same version and digest')
def exact_observation(context):
    w = context.world
    items = w.call('GET', w.integration_path + '/receipts')['items']
    assert len(items) == 1
    assert items[0]['versionId'] == w.original['version']['id']
    assert items[0]['digest'] == w.original['version']['digest']
    assert items[0]['stage'] == 'verified'


@then('it contains no content, memory or model-use claim')
def private(context):
    w = context.world
    text = json.dumps(w.receipt)
    assert 'Review code.' not in text
    assert not any(key in w.receipt for key in ['content', 'memory', 'prompt', 'modelConsumed', 'sessionId'])


@when('it repeats the identical event')
def repeat(context):
    w = context.world
    w.repeated_receipt = w.call('POST', w.integration_path + '/receipts', w.event, actor='receipt-writer')


@then('the same event is returned and history contains one report')
def once(context):
    w = context.world
    assert w.repeated_receipt == w.receipt
    assert len(w.call('GET', w.integration_path + '/receipts')['items']) == 1


@when('it reuses the event ID for another stage')
def changed(context):
    w = context.world
    w.call('POST', w.integration_path + '/receipts', dict(w.event, stage='prepared'), actor='receipt-writer', expected=409)


@then('the changed observation is rejected')
def conflict(context):
    assert context.world.last_status == 409


@given('another integration exists in this project')
def other(context):
    w = context.world
    w.other_integration = w.call('POST', w.root + '/connections', dict(displayName='Other application', bundleId=w.setup['bundle']['id'], channel='stable'))


@when('the first credential tries to report for the second integration')
def another(context):
    w = context.world
    event = dict(w.delivery_event(), connectionId=w.other_integration['id'])
    w.call('POST', w.root + '/connections/' + w.other_integration['id'] + '/receipts', event, actor='receipt-writer', expected=403)


@when('the app submits a report with {invalid}')
def bad_report(context, invalid):
    w = context.world
    event = w.delivery_event()
    if invalid == 'an old occurrence time': event['occurredAt'] = (datetime.now(timezone.utc) - timedelta(days=2)).isoformat()
    elif invalid == 'a mismatched digest': event['digest'] = 'sha256:' + 'b' * 64
    elif invalid == 'a download from cache': event['stage'] = 'downloaded'
    elif invalid == 'a partial channel mapping': event['channel'] = 'stable'
    else: raise AssertionError(invalid)
    w.call('POST', w.integration_path + '/receipts', event, actor='receipt-writer', expected=(400,403))


@then('the observation is rejected')
def reject_observation(context):
    w = context.world
    assert w.last_status in (400,403)
    assert w.call('GET', w.integration_path + '/receipts')['items'] == []


@when('I revoke that credential')
def revoke_credential(context):
    w = context.world
    w.call('POST', w.integration_path + '/credentials/' + w.credential['id'] + '/revoke', {})


@when('it requests the published bytes')
def revoked_read(context):
    w = context.world
    w.call('GET', w.bundle + '/versions/' + w.original['version']['id'] + '/payload', actor='content-reader', expected=403)


@given('I issued both credential kinds')
def both(context):
    context.world.issue('content-read')
    context.world.issue('receipt-write')


@when('I revoke the integration')
def revoke_integration(context):
    w = context.world
    w.call('POST', w.integration_path + '/revoke', {})


@then('neither credential can read or report')
def revoked(context):
    w = context.world
    w.call('GET', w.channel, actor='content-reader', expected=403)
    w.call('POST', w.integration_path + '/receipts', w.delivery_event(), actor='receipt-writer', expected=403)


@when('I issue a read credential using an operation ID')
def issue_keyed(context):
    w = context.world
    w.issue_key = uuid.uuid4().hex
    w.issue('content-read', key=w.issue_key)


@when('I retry that same issuance operation')
def retry_issue(context):
    w = context.world
    w.call('POST', w.integration_path + '/credentials', dict(kind='content-read'), key=w.issue_key, expected=409)


@then('issuance is not repeated and the original credential ID is recoverable')
def recover_id(context):
    w = context.world
    assert w.last['error']['code'] == 'credential_already_issued'
    assert w.last['error']['details'] == dict(credentialId=w.credential['id'],kind='content-read',revokedAt=None)
    assert 'secret' not in w.last['error']['details']
    entry = next(i for i in w.call('GET', w.root + '/connections')['items'] if i['id'] == w.integration['id'])
    assert len(entry['credentials']) == 1
    assert entry['credentials'][0]['id'] == w.credential['id']


@then('integration listings disclose no credential secret')
def no_secrets(context):
    w = context.world
    listing = json.dumps(w.call('GET', w.root + '/connections'))
    assert w.credential['secret'] not in listing
    assert 'secret_hash' not in listing
