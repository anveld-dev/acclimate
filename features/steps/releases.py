from behave import given, when, then


@given('the saved snapshot has complete matching evidence')
def evaluated(context):
    w = context.world
    w.request_evaluation()
    w.start_attempt()
    w.comparison()
    w.finish()
    w.evaluated_snapshot = dict(w.draft['snapshotVersion'])


@when('I submit that evidence to the retired draft publication endpoint')
def retired_publish(context):
    w = context.world
    w.call('POST', w.draft_path + '/publish', dict(expectedGeneration=w.draft['generation'],
           expectedRevision=w.original['revision'], comparisonId=w.report['id']), expected=404)


@when('I submit a direct release for the saved snapshot on the original channel')
def blocked_release(context):
    w = context.world
    error = w.call('POST', w.channel + '/releases', dict(versionId=w.draft['snapshotVersion']['id'],
                   expectedRevision=w.original['revision'], unevaluatedReason='Manual change'), expected=409)
    assert error['error']['code'] == 'connected_learning_required'


@when('I try to seed the bundle again under another channel name')
def second_channel(context):
    w = context.world
    error = w.call('POST', w.bundle + '/channels/other/releases', dict(versionId=w.original['version']['id'],
                   expectedRevision='0', unevaluatedReason='Another seed'), expected=409)
    assert error['error']['code'] == 'connected_learning_required'


@when('an application resolves the source without a connection')
def missing_connection(context):
    w = context.world
    error = w.call('GET', w.channel, expected=409)
    assert error['error']['code'] == 'connected_learning_required'


@then('the source release history contains only the original seed')
def only_seed(context):
    w = context.world
    release, = w.call('GET', w.channel + '/releases')['items']
    assert release['version'] == w.original['version'] and release['revision'] == w.original['revision']
    assert w.call('GET', w.draft_path)['status'] == 'open'
