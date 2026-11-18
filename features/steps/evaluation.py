from behave import given, when, then


@given('I request evaluation of the saved snapshot')
@when('I request evaluation of the saved snapshot')
def request(context):
    context.world.request_evaluation()


@given('the request is waiting for an evaluator')
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
@when('the same evaluator submits corrected evidence')
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
    w.completed_comparison = w.call('GET', w.bundle + '/comparisons/' + current['comparisonId'])
    assert w.completed_comparison['complete'] is True


@then('both retry-review repetitions score the exact parent 0 and the exact candidate 1')
def paired_retry_scores(context):
    w = context.world
    report = w.completed_comparison
    for key in ['parentVersionId', 'parentDigest', 'candidateVersionId', 'candidateDigest']:
        assert report[key] == w.settings[key]
    scores = sorted((pair['caseId'], pair['repetition'], pair['parent']['reward'], pair['candidate']['reward'])
                    for pair in report['results'])
    assert scores == [('retry-review', 0, 0, 1), ('retry-review', 1, 0, 1)], scores


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
    assert current['comparisonId'] is None


@when('a different attempt tries to start')
def competing(context):
    w = context.world
    w.call('POST', w.evaluation_path + '/start', dict(attemptId='competing-attempt'), actor='evaluator', expected=409)


@then('the competing attempt is rejected')
@then('completion is rejected')
def denied_finish(context):
    assert context.world.last['error']['code'] == 'evaluation_conflict'


@when("another writer tries to finish that request")
def other_finish(context):
    context.world.finish(actor='other', expected=409)


@when('the evaluator submits evidence with a changed {setting}')
def changed(context, setting):
    context.world.comparison(changed=setting, expected=400)


@then('the evidence submission is rejected as invalid')
def mismatch(context):
    w = context.world
    assert w.last['error']['code'] == 'invalid_content'
    assert w.call('GET', w.bundle + '/comparisons')['items'] == []


@when('the evaluator submits these paired grades')
def incomplete(context):
    w = context.world
    w.submitted_pairs = []
    for row in context.table:
        reward = row['candidate reward']
        w.submitted_pairs.append(dict(
            caseId=row['case'], repetition=int(row['repetition']),
            parent=dict(executionStatus='completed', gradingStatus='scored', reward=float(row['parent reward'])),
            candidate=dict(executionStatus=row['candidate execution'], gradingStatus=row['candidate grading'],
                           reward=None if reward == 'unknown' else float(reward)),
        ))
    w.comparison(results=w.submitted_pairs)


@then('the failed request retains the submitted grades and the ungraded candidate arm')
def incomplete_retained(context):
    w = context.world
    current = w.call('GET', w.evaluation_path)
    report = w.call('GET', w.bundle + '/comparisons/' + w.report['id'])
    assert current['status'] == 'failed'
    assert current['comparisonId'] == report['id']
    assert report['complete'] is False
    rows = {(row['caseId'], row['repetition']): row for row in report['results']}
    assert len(report['results']) == len(rows) == len(w.submitted_pairs)
    for pair in w.submitted_pairs:
        key = (pair['caseId'], pair['repetition'])
        for arm in ('parent', 'candidate'):
            actual = {field: rows[key][arm][field] for field in pair[arm]}
            assert actual == pair[arm], (key, arm, actual, pair[arm])


@when('the evaluator submits evidence without usage')
def no_usage(context):
    context.world.comparison(outcome='without usage')


@then('both arms of every requested case and repetition retain unknown usage')
def unknown(context):
    w = context.world
    report = w.call('GET', w.bundle + '/comparisons/' + w.report['id'])
    expected = sorted((case['caseId'], case['repetition']) for case in w.settings['expectedCases'])
    actual = sorted((row['caseId'], row['repetition']) for row in report['results'])
    assert expected and actual == expected, (actual, expected)
    for row in report['results']:
        for arm in ('parent', 'candidate'):
            assert row[arm]['usage'] is None, (row['caseId'], row['repetition'], arm)


@given('the request is running with submitted evidence')
def running_with_evidence(context):
    w = context.world
    w.start_attempt()
    w.comparison()
    assert w.report['complete'] is True


@when('I interrupt the request with a reason')
def interrupt(context):
    w = context.world
    w.interruption_reason = 'Operator stopped the fixture experiment.'
    w.call('POST', w.evaluation_path + '/interrupt', dict(reason=w.interruption_reason))


@then('the evaluator cannot start the interrupted request')
def late_start(context):
    w = context.world
    result = w.call('POST', w.evaluation_path + '/start', dict(attemptId=w.attempt), actor='evaluator', expected=409)
    assert result['error']['code'] == 'evaluation_conflict'


@then('no attempt or evaluator has been assigned')
def no_attempt(context):
    w = context.world
    current = w.call('GET', w.evaluation_path)
    assert current['attemptId'] is None and current['evaluatorPrincipal'] is None


@then('the original evaluator cannot finish with its submitted evidence')
def late_finish(context):
    w = context.world
    persisted = w.call('GET', w.evaluation_path)
    assert persisted['attemptId'] == w.attempt and persisted['evaluatorPrincipal'] == 'evaluator'
    result = w.finish(expected=409)
    assert result['error']['code'] == 'evaluation_conflict'


@then('the request is still interrupted with its reason and no linked comparison')
def interrupted(context):
    w = context.world
    current = w.call('GET', w.evaluation_path)
    assert current['status'] == 'interrupted'
    assert current['error'] == w.interruption_reason
    assert current['comparisonId'] is None


@then('new evidence for the interrupted request is rejected')
def late_evidence(context):
    w = context.world
    w.comparison(expected=409)
    assert w.last['error']['code'] == 'evaluation_conflict'


@when('it repeats completion with the same comparison')
def repeat_finish(context):
    w = context.world
    assert w.finish() == w.finished
