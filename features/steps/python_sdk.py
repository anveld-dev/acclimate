from behave import given, when, then


@given('a Python application prepared the stable release')
@when('a Python application prepares the stable release')
def prepare(context):
    context.world.python_result=context.world.sdk('pythonDelivery')


@then('Python receives "{text}" and the exact released digest')
def exact(context,text):
    w=context.world
    assert w.python_result['instruction']==text
    assert w.python_result['version']==w.original['version']


@when('Python requests the release without offline permission')
def offline_denied(context):
    context.world.python_result=context.world.sdk('pythonDelivery')


@then('Python delivery fails without returning content')
def fails(context):
    assert 'error' in context.world.python_result
    assert 'instruction' not in context.world.python_result


@when('Python explicitly permits bounded offline delivery')
def allowed(context):
    context.world.python_result=context.world.sdk('pythonDelivery',offline=True)


@when('a Python application saves two generations and records comparison evidence')
def author(context):
    context.world.python_result = context.world.sdk('pythonAuthor')


@then('Python preserves both saved generations and the connected job still receives the seed')
def saved_candidate(context):
    w = context.world
    result = w.python_result
    assert result['comparison']['candidateVersionId'] == result['draft']['snapshotVersion']['id']
    assert [entry['generation'] for entry in result['history']['items']] == [2, 1]
    assert w.sdk('pythonDelivery')['version'] == w.original['version']


@when('Python prepares and explicitly reports its own session start')
def reporting(context):
    w=context.world
    w.python_result=w.sdk('pythonDelivery',actor='content-reader',reporting=True,connectionId=w.integration['id'],receiptToken=w.write_credential['secret'],observerToken=w.h.tokens['operator'])


@then('Python observations identify the verified version without content')
def reports(context):
    w=context.world
    assert w.python_result['instruction']=='Review code.'
    items=w.call('GET',w.integration_path+'/receipts')['items']
    assert {item['stage'] for item in items}=={'resolved','downloaded','verified','prepared','started'}
    assert all(item['versionId']==w.original['version']['id'] and 'content' not in item for item in items)


@when('Python starts its application with an unavailable reporting credential')
def reporting_denied(context):
    w = context.world
    w.python_result = w.sdk('pythonDelivery', reporting=True, connectionId=w.integration['id'])


@then('Python delivery and app start succeed with pending optional observations')
def reporting_isolated(context):
    w = context.world
    assert w.python_result['instruction'] == 'Review code.'
    assert w.python_result['started'] is True
    assert w.python_result['pending'] > 0
    assert w.call('GET', w.integration_path + '/receipts')['items'] == []
