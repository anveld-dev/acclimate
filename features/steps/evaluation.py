from behave import given, when, then


@given('I request evaluation of the saved snapshot')
@when('I request evaluation of the saved snapshot')
def request(context):
    context.world.request_evaluation()


@then('the request is waiting for an application evaluator')
def waiting(context):
    w = context.world
    result = w.call('GET', w.evaluation_path)
    assert result['status'] == 'requested'
    assert result['evaluatorPrincipal'] is None
    assert result['comparisonId'] is None
    assert result['requireBoundEvidence'] is True


@then('its version identities and cases are fixed')
def fixed(context):
    w = context.world
    result = w.call('GET', w.evaluation_path)
    for key in ['parentVersionId', 'parentDigest', 'candidateVersionId', 'candidateDigest', 'datasetRevision', 'runtime', 'graderRevision', 'expectedCases']:
        assert result[key] == w.settings[key], f'Request changed {key}'


@given('the evaluator starts an attempt')
@when('the evaluator starts an attempt')
def start(context):
    context.world.start_attempt()


@when('the application compares both versions using the SDK')
def sdk_compare(context):
    w = context.world
    w.start_attempt()
    w.report = w.sdk('evaluate', actor='evaluator', settings=dict(**w.settings, evaluation=dict(requestId=w.evaluation['id'], attemptId=w.attempt)))


@given('the evaluator submits complete fixture evidence')
def complete(context):
    context.world.comparison()


@when('the same evaluator finishes the request')
def finish(context):
    context.world.finished = context.world.finish()


@then('the request is completed with the submitted comparison')
def finished(context):
    w = context.world
    current = w.call('GET', w.evaluation_path)
    assert current['status'] == 'completed'
    assert current['comparisonId'] == w.report['id']
    assert w.call('GET', w.bundle + '/comparisons/' + w.report['id'])['complete'] is True


@then('the comparison preserves both exact version digests')
def identities(context):
    w = context.world
    for key in ['parentVersionId', 'parentDigest', 'candidateVersionId', 'candidateDigest']:
        assert w.report[key] == w.settings[key]
    assert len(w.report['results']) == 2


@when('it repeats the same start request')
def replay_start(context):
    w = context.world
    w.repeated = w.call('POST', w.evaluation_path + '/start', dict(attemptId=w.attempt), actor='evaluator')


@then('the same attempt remains running')
@then('the original attempt remains running')
def running(context):
    w = context.world
    current = w.call('GET', w.evaluation_path)
    assert current['status'] == 'running'
    assert current['attemptId'] == w.attempt
    assert current['evaluatorPrincipal'] == 'evaluator'


@when('a different attempt tries to start')
def competing(context):
    w = context.world
    w.call('POST', w.evaluation_path + '/start', dict(attemptId='competing-attempt'), actor='evaluator', expected=409)


@then('the competing attempt is rejected')
@then('completion is rejected')
def denied_finish(context):
    assert context.world.last_status in (400, 403, 409)


@when("another writer tries to finish that request")
def other_finish(context):
    context.world.finish(actor='other', expected=409)


@when('the evaluator submits evidence with a changed {setting}')
def changed(context, setting):
    context.world.comparison(changed=setting, expected=400)


@when('tries to finish using that evidence')
def mismatch(context):
    assert context.world.last_status == 400  # Bound mismatch is rejected at submission, before it can be linked.


@when('the evaluator submits {outcome} evidence')
def incomplete(context, outcome):
    context.world.comparison(outcome=outcome)


@then('the request is failed with its incomplete evidence still inspectable')
def incomplete_retained(context):
    w = context.world
    current = w.call('GET', w.evaluation_path)
    report = w.call('GET', w.bundle + '/comparisons/' + w.report['id'])
    assert current['status'] == 'failed'
    assert current['comparisonId'] == report['id']
    assert report['complete'] is False


@when('the evaluator submits evidence without usage')
def no_usage(context):
    context.world.comparison(outcome='without usage')


@then('the comparison retains unknown usage')
def unknown(context):
    w = context.world
    report = w.call('GET', w.bundle + '/comparisons/' + w.report['id'])
    assert all(pair[arm]['usage'] is None for pair in report['results'] for arm in ['parent', 'candidate'])


@given('the request is {state}')
def current_state(context, state):
    if state == 'running':
        context.world.start_attempt()
    else:
        assert state == 'requested'


@when('I interrupt the request with a reason')
def interrupt(context):
    w = context.world
    w.call('POST', w.evaluation_path + '/interrupt', dict(reason='Operator stopped the fixture experiment.'))


@then('it stays interrupted after restart')
def interrupted(context):
    w = context.world
    w.h.restart()
    assert w.call('GET', w.evaluation_path)['status'] == 'interrupted'


@then('late start or completion is rejected')
def late(context):
    w = context.world
    w.call('POST', w.evaluation_path + '/start', dict(attemptId=w.attempt), actor='evaluator', expected=409)
    w.comparison(expected=409)


@when('it repeats completion with the same comparison')
def repeat_finish(context):
    w = context.world
    assert w.finish() == w.finished
