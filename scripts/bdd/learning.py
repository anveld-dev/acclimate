"""Connected-learning fixtures using the public service, SDK and installed review cases."""
import time
import uuid


def wait_for_round(w, state, *, attempt=1):
    deadline = time.monotonic() + 30
    while time.monotonic() < deadline:
        rounds = w.call('GET', w.learning_path)['rounds']
        for row in rounds:
            if row['outcomeId'] == w.outcome_id and row['attempt'] == attempt:
                if row['state'] == state:
                    return row
                assert row['state'] not in ('rejected', 'promoted'), (row['state'], row['reason'])
        time.sleep(0.1)
    raise AssertionError(f'Round for {w.outcome_id}, attempt {attempt}, did not reach {state}')


def review_enrollment(w, *, automatic=False, development=None, audit=None):
    w.learning_path = w.integration_path + '/learning'
    w.cohorts = {
        'development': development or {'retry-review': 'retries', 'backoff-review': 'backoff'},
        'audit': audit or {'duplicate-review': 'duplicated effects', 'idempotency-review': 'idempotency'},
    }
    if automatic:
        w.cohorts['reserve'] = {'timeout-review': 'timeout'}
    descriptors = w.sdk('reviewDescriptors', cohorts=w.cohorts)
    audits = [value for phase, value in descriptors.items() if phase != 'development']
    quality = dict(schemaVersion=2, id='review-development', revision='1',
                   metric=dict(name='coverage', unit='reward', direction='higher'),
                   aggregation='equal-case-means', maximumCaseRegression=0,
                   minimumMeanImprovement=-0.2, requiredCases=[])
    return dict(
        selectionPolicies=dict(development=quality,
                               audit=dict(quality, id='review-audit', nonInferiorityMargin=0.75)),
        installationId='review-fixture', permittedPaths=['AGENTS.md'], maxProposalAdmissions=4 if automatic else 1,
        automaticRollout=automatic, automaticRollback=True,
        development=descriptors['development'], audits=audits,
        evaluatorPrincipal='evaluator', outcomePrincipal='other')


def calibrate(w):
    deadline = time.monotonic() + 10
    while time.monotonic() < deadline:
        assignments = w.call('GET', w.learning_path + '/work', actor='evaluator')['items']
        item = next((item for item in assignments if item['phase'] == 'calibration'), None)
        if item:
            break
        time.sleep(0.05)
    else:
        raise AssertionError('Baseline calibration was not assigned')
    request_id = item['evaluationRequestId']
    w.evaluation_path = w.bundle + '/evaluation-requests/' + request_id
    w.attempt = 'baseline-calibration'
    w.start_attempt()
    report = {k: w.started[k] for k in ('parentVersionId', 'parentDigest', 'candidateVersionId', 'candidateDigest',
                                       'runtime', 'datasetRevision', 'graderRevision', 'expectedCases')}
    assert report['parentVersionId'] == report['candidateVersionId']
    outcome = dict(executionStatus='completed', gradingStatus='scored', reward=0)
    report['evaluation'] = dict(requestId=request_id, attemptId=w.attempt)
    report['results'] = [dict(**case, parent=outcome, candidate=outcome) for case in report['expectedCases']]
    w.report = w.call('POST', w.bundle + '/comparisons', report, actor='evaluator')
    assert w.finish()['status'] == 'completed'


def install_enrollment(w, enrollment):
    w.call('PUT', w.learning_path, enrollment)
    calibrate(w)
    w.original_delivery = w.call('GET', w.channel, actor='content-reader')
    w.history_path = w.bundle + '/channels/learn-' + w.integration['id'] + '/promotions'
    w.original_history = w.call('GET', w.history_path)['items']


def enroll_reviews(w, **cohorts):
    install_enrollment(w, review_enrollment(w, **cohorts))


def report_failed_job(w, delivery, *, expected=None, **teaching):
    outcome_id = str(uuid.uuid4())
    w.call('POST', w.learning_path + '/outcomes', dict(
        outcomeId=outcome_id, versionId=delivery['version']['id'], digest=delivery['version']['digest'],
        deliveryRevision=delivery['revision'], status='failed', **teaching), actor='other', expected=expected)
    return outcome_id


def grade_phase(w, phase, *, attempt=1):
    request_id = wait_for_round(w, phase, attempt=attempt)[phase + 'RequestId']
    w.evaluation_path = w.bundle + '/evaluation-requests/' + request_id
    w.attempt = phase + '-attempt'
    w.start_attempt()
    w.report = w.sdk('evaluate', actor='evaluator', reviewCases=w.cohorts[phase],
                     settings=dict(w.started, evaluation=dict(requestId=request_id, attemptId=w.attempt)))


def grade_through_audit(w):
    w.outcome_id = report_failed_job(w, w.original_delivery,
        lesson=dict(path='AGENTS.md', instruction='Review retries and duplicated effects.'))
    grade_phase(w, 'development')
    assert w.finish()['status'] == 'completed'
    grade_phase(w, 'audit')
