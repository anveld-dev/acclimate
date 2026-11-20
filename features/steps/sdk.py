from behave import given, when, then


@given('an application resolved and prepared the stable release')
@when('an application resolves and prepares the stable release')
def deliver(context):
    w = context.world
    w.delivery = w.sdk('delivery')
    assert 'error' not in w.delivery


@then('its prepared instruction file contains "{text}"')
def instruction(context, text):
    assert context.world.delivery.get('instruction') == text


@then('its selected version and digest match the original release')
def selected(context):
    w = context.world
    assert w.delivery['version'] == w.original['version']


@when('I published the saved draft manually')
def publish_manual(context):
    w=context.world
    current=w.call('GET',w.channel)
    w.published=w.call('POST',w.draft_path+'/publish',dict(expectedGeneration=w.draft['generation'],expectedRevision=current['revision'],unevaluatedReason='Operator reviewed this edit manually.'))


@when('a fresh job requests the original version by ID')
def pin(context):
    w = context.world
    w.delivery = w.sdk('delivery', versionId=w.original['version']['id'])


@then('the latest channel still contains the newer release')
def current(context):
    w = context.world
    assert w.call('GET', w.channel)['version'] == w.draft['snapshotVersion']


@when('the service becomes unavailable')
def offline(context):
    context.world.h.stop_service()


@when('the application requests delivery without offline permission')
def no_offline(context):
    context.world.delivery = context.world.sdk('delivery')


@then('delivery fails rather than returning cached content')
def fails(context):
    w = context.world
    assert w.delivery.get('error')
    assert 'instruction' not in w.delivery


@when('the application permits bounded offline delivery')
def allow_offline(context):
    context.world.delivery = context.world.sdk('delivery', offline=True)


@then('the returned mapping is marked stale')
def stale(context):
    assert context.world.delivery['stale'] is True


@when('another SDK identity requests bounded offline delivery')
def other_identity(context):
    context.world.delivery = context.world.sdk('delivery', actor='other', offline=True)


@then('no cached mapping is disclosed')
def no_mapping(context):
    assert context.world.delivery.get('error')
    assert 'instruction' not in context.world.delivery


@given('that integration cached the published release')
def integration_cache(context):
    w = context.world
    w.delivery = w.sdk('delivery', actor='content-reader')
    assert w.delivery['version'] == w.original['version']


@when('that integration requests bounded offline delivery')
def integration_offline(context):
    w = context.world
    w.prepared_before_request = set(w.sdk_directory.glob('prepared-*'))
    w.delivery = w.sdk('delivery', actor='content-reader', offline=True)


@then('delivery is denied despite the cached files')
def denied_cache(context):
    w = context.world
    assert w.delivery['error']['status'] == 403
    assert 'instruction' not in w.delivery
    assert set(w.sdk_directory.glob('prepared-*')) == w.prepared_before_request


@when('an application edits its prepared instruction file')
def edited(context):
    context.world.sdk('editJob')


@when('it prepares the same release for another job')
def next_job(context):
    context.world.delivery = context.world.sdk('delivery')


@then('the second job receives "{text}"')
def clean(context, text):
    assert context.world.delivery['instruction'] == text


@when("an application prepares into a folder with its own instructions")
def collision(context):
    context.world.delivery = context.world.sdk('collision')


@then('preparation is rejected and the existing instructions stay unchanged')
def collision_safe(context):
    assert context.world.delivery == dict(rejected=True,instruction='Application instructions.')


@when('the application cleans up a prepared workspace containing its own note')
def cleanup(context):
    context.world.delivery = context.world.sdk('cleanup')


@then('prepared files are removed and the note remains')
def owned_cleanup(context):
    assert context.world.delivery == dict(instructionExists=False,note='Keep this note.')


@given('the bundle contains an instruction and a packaged skill')
def skill_bundle(context):
    w = context.world
    w.publish_initial('',files=[dict(path='AGENTS.md',kind='instruction',text='Review code.'),dict(path='skills/review/SKILL.md',kind='skill',text='---\nname: review\ndescription: Review saved changes.\n---\nCheck retries.')])


@when('the application prepares it for {plugin}')
def native(context, plugin):
    context.world.delivery = context.world.sdk('native', plugin=plugin)


@then('the native instruction is named "{name}" and the skill is present')
def mapped(context, name):
    w = context.world
    assert w.delivery['instructionName'] == name
    assert w.delivery['instruction'] == 'Review code.'
    assert w.delivery['skillPaths'] == ['SKILL.md']


@given('the bundle also contains reusable memory')
def memory(context):
    context.world.publish_initial('',files=[dict(path='AGENTS.md',kind='instruction',text='Review code.'),dict(path='memory/team.md',kind='memory',text='Approved reusable memory.')])


@when('Cursor preparation has {approval} memory approval')
def memory_policy(context, approval):
    context.world.delivery = context.world.sdk('native', plugin='cursor', approveMemory=approval=='explicit')


@then('exactly {count:d} memory resources are staged')
def memory_count(context, count):
    assert context.world.delivery['memoryCount'] == count


@when('the application prepares content during a reporting outage and recovers {when} the retry window')
def recover_reporting(context, when):
    w = context.world
    assert when in ('within', 'after')
    w.reporting = w.sdk('recoverReporting', connectionId=w.integration['id'], readerToken=w.read_credential['secret'],
                        receiptToken=w.write_credential['secret'], expired=when == 'after')


@then('the prepared file is usable while the service has no receipt for it')
def prepared_during_outage(context):
    observed = context.world.reporting
    assert observed['instruction'] == 'Review code.'
    assert observed['pendingBefore'] == 4 and observed['receivedBefore'] == []
    assert observed['preparedEvent']['stage'] == 'prepared'


@then('recovery records the original prepared event exactly once')
def recovered_preparation(context):
    w = context.world
    observed = w.reporting
    assert observed['pendingAfter'] == 0
    assert observed['sentAfter'] == observed['originalEvents']
    items = w.call('GET', w.integration_path + '/receipts')['items']
    assert sorted(item['stage'] for item in items) == ['downloaded', 'prepared', 'resolved', 'verified']
    receipt, = [item for item in items if item['stage'] == 'prepared']
    for field in ('eventId', 'occurredAt', 'versionId', 'digest'):
        assert receipt[field] == observed['preparedEvent'][field], field
    assert receipt['versionId'] == w.original['version']['id']


@when('the application reports resolution, verification, preparation and its own start')
def explicit_reports(context):
    w = context.world
    w.delivery = w.sdk('delivery',actor='content-reader',reporting=True,receiptToken=w.write_credential['secret'],connectionId=w.integration['id'],started=True)


@then('exactly those observed stages are recorded for the selected version')
def stages(context):
    w = context.world
    items = w.call('GET', w.integration_path + '/receipts')['items']
    assert {item['stage'] for item in items} == {'resolved','downloaded','verified','prepared','started'}
    assert len(items) == 5
    assert all(item['versionId'] == w.original['version']['id'] for item in items)


@then('recovery drops every expired event without sending another request')
def dropped(context):
    w = context.world
    assert w.reporting['pendingAfter'] == 0 and w.reporting['sentAfter'] == []
    assert w.call('GET', w.integration_path + '/receipts')['items'] == []


@when('the SDK retries a grader that changes its input before failing')
def grader_mutation(context):
    w = context.world
    w.delivery = w.sdk('compareMutation',parentVersionId=w.original['version']['id'],candidateVersionId=w.draft['snapshotVersion']['id'],mutation='grader')


@then('execution happened once per version and both retries saw the original output')
def independent(context):
    result = context.world.delivery
    assert result['executions'] == 2
    assert result['observed'] == [['first','second']] * 4
    assert result['report']['results'][0]['parent']['reward'] == 2
    assert result['report']['results'][0]['candidate']['reward'] == 2


@when('the caller changes version and runtime labels during comparison')
def input_mutation(context):
    w = context.world
    w.delivery = w.sdk('compareMutation',parentVersionId=w.original['version']['id'],candidateVersionId=w.draft['snapshotVersion']['id'],mutation='identities')


@then('the SDK report still names the versions and settings it executed')
def fixed_inputs(context):
    result = context.world.delivery
    for key,value in result['original'].items():
        assert result['report'][key] == value, key
