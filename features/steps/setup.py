from behave import when, then
from scripts.productization.qualify import payload


@when('I list the configured workspace and its bundles')
def list_workspace(context):
    w = context.world
    w.projects = w.call('GET', '/v1/projects')['items']
    w.bundles = w.call('GET', w.root + '/bundles')['items']


@then('the workspace is available and its bundle list is empty')
def empty_workspace(context):
    w = context.world
    assert any(project['id'] == w.h.project for project in w.projects)
    assert w.bundles == []


@when('I create a bundle as {origin} containing "{text}"')
def create_origin(context, origin, text):
    context.world.publish_initial(text, origin)


@then('its stored origin remains {origin}')
def origin_retained(context, origin):
    w = context.world
    bundles = w.call('GET', w.root + '/bundles')['items']
    assert bundles[0]['id'] == w.setup['bundle']['id']
    assert bundles[0]['origin'] == origin


@then('its first release is explicitly unevaluated')
def seed(context):
    w = context.world
    release = w.call('GET', w.channel + '/promotions')['items'][0]
    assert release['comparisonId'] is None
    assert release['unevaluatedReason'] == 'Explicit behavior-test initial release.'


@when('I try to create a bundle with {invalid} content')
def rejected_setup(context, invalid):
    w = context.world
    w.call('POST', w.root + '/bundle-setups', dict(name='Rejected import', origin='imported', channel='stable', payload=w.invalid_payload(invalid), reason='Explicit import.'), expected=(400, 413))


@then('the bundle list is still empty')
def no_partial(context):
    assert context.world.call('GET', context.world.root + '/bundles')['items'] == []


@when('I create a bundle with an operation ID')
def keyed_setup(context):
    import uuid
    w = context.world
    w.setup_key = uuid.uuid4().hex
    w.setup_body = dict(name='Once', origin='created', channel='stable', payload=payload('Review code.'), reason='Explicit initial release.')
    w.setup = w.call('POST', w.root + '/bundle-setups', w.setup_body, key=w.setup_key)


@when('I repeat the identical setup request')
def repeat_setup(context):
    w = context.world
    w.setup_replayed = w.call('POST', w.root + '/bundle-setups', w.setup_body, key=w.setup_key)


@then('I receive the same bundle and initial release')
def same_setup(context):
    w = context.world
    assert w.setup_replayed == w.setup


@then('the bundle list contains exactly {count:d} bundle')
def count_bundles(context, count):
    assert len(context.world.call('GET', context.world.root + '/bundles')['items']) == count


@when('an application authorized only for another project requests this bundle')
def scope_denied(context):
    w = context.world
    w.call('GET', w.bundle + '/versions/' + w.setup['version']['id'] + '/payload', actor='outsider', expected=403)


@then('access is denied')
def denied(context):
    assert context.world.last_status in (401, 403)


@when('I import content labelled "{label}"')
def labelled(context, label):
    w = context.world
    w.setup = w.call('POST', w.root + '/bundle-setups', dict(name='Labelled import', origin='imported', sourceLabel=label, channel='stable', payload=payload('Review code.'), reason='Explicit import.'))


@then('the bundle retains the source label "{label}"')
def label_retained(context, label):
    w = context.world
    assert w.call('GET', w.root + '/bundles')['items'][0]['sourceLabel'] == label
