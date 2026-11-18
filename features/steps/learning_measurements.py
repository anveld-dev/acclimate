"""Application-reported measurements and the resulting managed selection decisions."""
from behave import given, when, then

from scripts.bdd.learning import install_enrollment, report_failed_job, wait_for_round


def enroll_measured(w, grader, case_ids, *, admissions, policies=None):
    w.learning_path = w.integration_path + '/learning'
    audit = w.sdk('reviewDescriptors', cohorts={'audit': {'duplicate-review': 'duplicated effects'}})['audit']
    enrollment = dict(
        installationId='application-evaluator', permittedPaths=['AGENTS.md'], maxProposalAdmissions=admissions,
        automaticRollout=False, evaluatorPrincipal='evaluator', outcomePrincipal='other', audits=[audit],
        development=dict(datasetRevision=grader + '-cases-v1', graderRevision=grader, runtime={'executor': 'application'},
                         expectedCases=[dict(caseId=case, repetition=rep) for case in case_ids for rep in range(2)]))
    if policies is not None:
        enrollment['selectionPolicies'] = policies
    install_enrollment(w, enrollment)
    w.budget_before = w.call('GET', w.learning_path)
    w.outcome_id = report_failed_job(w, w.original_delivery, lesson=dict(path='AGENTS.md', instruction='Review retries.'))


@given('a connection evaluates partial-credit review tasks and allows a second proposal')
def partial_credit(context):
    enroll_measured(context.world, 'partial-credit-v1', ['retry-review'], admissions=2)


@when('its evaluator reports these paired review results')
def measured_pairs(context):
    w = context.world
    w.first_round = wait_for_round(w, 'development')
    request_id = w.first_round['developmentRequestId']
    w.evaluation_path = w.bundle + '/evaluation-requests/' + request_id
    w.attempt = 'measured-jobs'
    w.start_attempt()
    report = {k: w.started[k] for k in ('parentVersionId', 'parentDigest', 'candidateVersionId', 'candidateDigest',
                                        'runtime', 'datasetRevision', 'graderRevision', 'expectedCases')}
    def scored(value, status):
        return dict(reward=float(value), executionStatus=status, gradingStatus='scored', usage={'costUsd': 0})
    report['evaluation'] = dict(requestId=request_id, attemptId=w.attempt)
    report['results'] = [dict(caseId=row['case'], repetition=int(row['repetition']),
                              parent=scored(row['parent'], 'completed'),
                              candidate=scored(row['candidate'], row['candidate status'])) for row in context.table]
    w.report = w.call('POST', w.bundle + '/comparisons', report, actor='evaluator')
    assert w.finish()['status'] == 'completed'


@then('the next proposal receives two score gains, zero score regressions and two task failures')
def partial_credit_feedback(context):
    import json
    w = context.world
    rejected = wait_for_round(w, 'rejected')
    assert rejected['reason'] == 'Maximum candidate task failures exceeded'
    wait_for_round(w, 'development', attempt=2)
    _, second = w.provider.requests
    evidence = json.loads(second['messages'][0]['content'])['request']['evidence']
    assert [line for line in evidence if line.startswith('Prior candidate ')] == [
        f"Prior candidate {rejected['candidateVersionId']} failed development: "
        '2 improved pairs and 0 regressed pairs across 2 scored pairs. Candidate task failures: 2.']


@then('the failed development round consumes no audit or release')
def no_audit_or_release(context):
    w = context.world
    rejected = wait_for_round(w, 'rejected')
    assert rejected['developmentComparisonId'] == w.report['id']
    assert rejected['auditRequestId'] is None and rejected['promotionId'] is None
    assert w.call('GET', w.learning_path)['remainingAudits'] == w.budget_before['remainingAudits']
    assert w.call('GET', w.history_path)['items'] == w.original_history


@given('development requires every critical request to finish within 100 milliseconds')
def protected_latency(context):
    latency = dict(schemaVersion=1, id='request-latency', revision='1',
                   metric=dict(name='Latency', unit='ms', direction='lower'), aggregation='equal-case-means',
                   minimumMeanImprovement=1, maximumCaseRegression=0, requiredCases=[])
    policies = dict(development=dict(latency, minimumRepetitionsPerCase=2, protectedCaseThresholds={'critical': 100}),
                    audit=dict(latency, minimumMeanImprovement=0))
    enroll_measured(context.world, 'elapsed-ms-v1', ['fast', 'critical'], admissions=1, policies=policies)


@then('the mean latency falls to 50 milliseconds and the round is {state} with {remaining:d} audits remaining')
def latency_decision(context, state, remaining):
    w = context.world
    rows = w.report['results']
    assert len(rows) == 4 and all(row['parent']['reward'] == 100 for row in rows)
    assert sum(row['candidate']['reward'] for row in rows) / len(rows) == 50
    decision = wait_for_round(w, state)
    assert decision['developmentComparisonId'] == w.report['id']
    if state == 'rejected':
        assert decision['reason'] == 'Protected case threshold failed' and decision['auditRequestId'] is None
    else:
        assert state == 'audit'
        work = w.call('GET', w.learning_path + '/work', actor='evaluator')
        assert [item['evaluationRequestId'] for item in work['items']] == [decision['auditRequestId']]
    assert w.budget_before['remainingAudits'] == 1
    assert w.call('GET', w.learning_path)['remainingAudits'] == remaining
    assert w.call('GET', w.history_path)['items'] == w.original_history
