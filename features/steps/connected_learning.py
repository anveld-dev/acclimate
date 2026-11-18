import json
import uuid

from behave import given, when, then

from scripts.bdd.learning import enroll_reviews, grade_phase, grade_through_audit, report_failed_job, review_enrollment, wait_for_round


@given('a job missed retry guidance before the connection released that guidance')
def earlier_failed_job(context):
    w = context.world
    enroll_reviews(w, automatic=True)
    job = w.sdk('delivery', actor='content-reader')
    required_guidance = 'retries'
    assert required_guidance not in job['instruction']
    w.delayed_job = report_failed_job(w, job)
    w.private_review_cases = {w.delayed_job: required_guidance}
    grade_through_audit(w)
    assert w.finish()['status'] == 'completed'
    promoted = wait_for_round(w, 'promoted')
    w.current_job = w.sdk('delivery', actor='content-reader')
    assert w.current_job['version']['id'] == promoted['candidateVersionId']
    assert int(w.current_job['revision']) == int(job['revision']) + 1
    w.before_correction = w.call('GET', w.learning_path)
    assert w.before_correction['remainingAudits'] > 0
    assert w.before_correction['proposalAdmissions'] < w.before_correction['maxProposalAdmissions']
    w.history_before_correction = w.call('GET', w.history_path)['items']
    w.delayed_lookup = w.learning_path + '/outcomes/' + w.delayed_job


def add_late_correction(w):
    correction_id = str(uuid.uuid4())
    w.call('POST', w.learning_path + '/corrections', dict(
        outcomeId=w.delayed_job, correctionId=correction_id,
        feedback=dict(expected='Flag retries.', observed='The original review omitted retries.')), actor='other')
    return correction_id


def submit_recheck(w, assignment, verdict, expected=None):
    body = {key: assignment[key] for key in ('correctionId', 'versionId', 'revision', 'digest')}
    return w.call('POST', w.learning_path + '/rechecks', dict(**body, verdict=verdict), actor='evaluator', expected=expected)


@when('the evaluator rechecks its correction with {evidence} private evidence')
def delayed_recheck(context, evidence):
    w = context.world
    w.correction_id = add_late_correction(w)
    queued, = w.call('GET', w.delayed_lookup)['corrections']
    assert queued['state'] == 'awaiting_baseline_recheck'
    work = w.call('GET', w.learning_path + '/work', actor='evaluator')
    assignment, = work['rechecks']
    job = w.current_job
    assert assignment['correctionId'] == w.correction_id and assignment['outcomeId'] == w.delayed_job
    assert assignment['versionId'] == job['version']['id'] and assignment['revision'] == job['revision']
    assert assignment['digest'] == job['version']['digest']
    if evidence == 'unavailable':
        del w.private_review_cases[w.delayed_job]
    else:
        assert evidence == 'available'
    requirement = w.private_review_cases.get(assignment['outcomeId'])
    verdict = 'unavailable'
    if requirement is not None:
        pinned = w.sdk('delivery', actor='content-reader', versionId=assignment['versionId'])
        assert pinned['version']['digest'] == assignment['digest']
        verdict = 'resolved' if requirement in pinned['instruction'] else 'reproduced'
    w.original_recheck = assignment
    w.recheck_receipt = submit_recheck(w, assignment, verdict)


def assert_correction(w, state):
    job = w.call('GET', w.delayed_lookup)
    assert job['status'] == 'failed'
    assert (job['versionId'], job['deliveryRevision']) == (w.original_delivery['version']['id'], w.original_delivery['revision'])
    assert job['currentDelivery'] == dict(versionId=w.current_job['version']['id'], revision=w.current_job['revision'])
    correction, = job['corrections']
    assert correction['correctionId'] == w.correction_id and correction['state'] == state
    assert correction['roundId'] is None and correction['release'] is None


@then('the original job still records its failure and the correction is {state}')
def correction_outcome(context, state):
    context.world.expected_correction_state = state
    assert_correction(context.world, state)


@then('after restart the correction keeps its state without consuming proposals, audits or releases')
def correction_survives(context):
    w = context.world
    w.h.restart()
    assert_correction(w, w.expected_correction_state)
    current = w.call('GET', w.learning_path)
    for field in ('proposalAdmissions', 'remainingAudits'):
        assert current[field] == w.before_correction[field], field
    assert [r['id'] for r in current['rounds']] == [r['id'] for r in w.before_correction['rounds']]
    assert w.call('GET', w.history_path)['items'] == w.history_before_correction
    work = w.call('GET', w.learning_path + '/work', actor='evaluator')
    assert work['active'] and not work['rechecks'] and not work['items']


@given('a review proposal gained retry guidance but lost code-review guidance in development')
def failed_development(context):
    w = context.world
    w.audit_case = 'held-out-verbatim-instruction'
    enroll_reviews(w, automatic=True, development={
        'code-review': 'code', 'retry-review': 'retries', 'logging-review': 'logging',
    }, audit={w.audit_case: 'Review code.'})
    summary = '2 improved pairs and 2 regressed pairs across 6 scored pairs.'

    def propose_from_evidence(request):
        if any(line.endswith(summary) for line in request['evidence']):
            return 'Review code for retries.'
        return 'Review retries.'

    w.provider.replacement = propose_from_evidence
    w.outcome_id = report_failed_job(w, w.original_delivery,
        lesson=dict(path='AGENTS.md', instruction='Revise retry guidance.'))
    grade_phase(w, 'development')
    deltas = [(p['caseId'], p['candidate']['reward'] - p['parent']['reward']) for p in w.report['results']]
    assert sorted(deltas) == [('code-review', -1)] * 2 + [('logging-review', 0)] * 2 + [('retry-review', 1)] * 2
    assert w.finish()['status'] == 'completed'
    rejected = wait_for_round(w, 'rejected')
    assert rejected['developmentComparisonId'] == w.report['id'] and rejected['auditRequestId'] is None
    w.permitted_history = f"Prior candidate {rejected['candidateVersionId']} failed development: {summary}"


def development_history(request):
    prompt = json.loads(request['messages'][0]['content'])
    return [line for line in prompt['request']['evidence'] if line.startswith('Prior candidate ')]


@when('the proposer receives the measured development feedback and tries again')
def second_proposal(context):
    w = context.world
    grade_phase(w, 'development', attempt=2)
    first, retry = w.provider.requests
    assert development_history(first) == []
    assert development_history(retry) == [w.permitted_history]


@then('the revised instructions preserve code review and gain retry guidance')
def useful_retry(context):
    w = context.world
    scores = sorted((p['caseId'], p['parent']['reward'], p['candidate']['reward']) for p in w.report['results'])
    assert scores == [('code-review', 1, 1)] * 2 + [('logging-review', 0, 0)] * 2 + [('retry-review', 0, 1)] * 2
    assert w.finish()['status'] == 'completed'


@when('the independent audit rejects that candidate and another correction asks for a proposal')
def later_proposal(context):
    w = context.world
    grade_phase(w, 'audit', attempt=2)
    assert [(p['caseId'], p['parent']['reward'], p['candidate']['reward']) for p in w.report['results']] == [
        (w.audit_case, 1, 0), (w.audit_case, 1, 0)]
    assert w.finish()['status'] == 'completed'
    w.audit_rejection = wait_for_round(w, 'rejected', attempt=2)
    assert w.audit_rejection['auditComparisonId'] == w.report['id'] and w.audit_rejection['promotionId'] is None
    w.outcome_id = report_failed_job(w, w.original_delivery,
        lesson=dict(path='AGENTS.md', instruction='Review logging as well.'))
    wait_for_round(w, 'development')


@then('the proposer receives only the permitted development history and no held-out case')
def private_audit(context):
    w = context.world
    _, _, later = w.provider.requests
    prompt = json.loads(later['messages'][0]['content'])
    assert prompt['request']['hypothesis'] == 'Review logging as well.'
    baseline = w.original_delivery['version']
    allowed = [f"Connection task ended failed using version {baseline['id']} ({baseline['digest']}).",
               w.permitted_history]
    assert sorted(prompt['request']['evidence']) == sorted(allowed), prompt['request']['evidence']
    for private_value in (w.audit_case, w.audit_rejection['candidateVersionId'], w.audit_rejection['auditComparisonId']):
        assert private_value not in json.dumps(later), private_value
    assert w.call('GET', w.history_path)['items'] == w.original_history


@when('I register the same review task for development and audit under different case names')
def renamed_audit(context):
    w = context.world
    w.review_development = {'development-retry': 'retries'}
    request = review_enrollment(w, automatic=True, development=w.review_development, audit={'held-out-retry': 'retries'})
    w.overlap_error = w.call('PUT', w.learning_path, request, expected=409)['error']


@then('the overlapping enrollment is refused before a release or proposal')
def overlapping_enrollment(context):
    w = context.world
    assert 'overlap' in w.overlap_error['message']
    w.call('GET', w.learning_path, expected=404)
    delivery = w.call('GET', w.channel, actor='content-reader')
    assert delivery['version'] == w.original['version'] and delivery['revision'] == w.original['revision']
    assert not w.provider.requests


@when('I replace the audit with a different review task that has the same expected answer')
def distinct_audit(context):
    w = context.world
    enroll_reviews(w, automatic=True, development=w.review_development, audit={'held-out-duplicates': 'duplicated effects'})
    grade_through_audit(w)
    assert w.finish()['status'] == 'completed'


@then('both tasks independently improve and the connection releases the candidate')
def verified_distinct_audit(context):
    w = context.world
    released = wait_for_round(w, 'promoted')
    for phase, task in [('development', 'development-retry'), ('audit', 'held-out-duplicates')]:
        comparison = w.call('GET', w.bundle + '/comparisons/' + released[phase + 'ComparisonId'])
        assert [(p['caseId'], p['repetition'], p['parent']['reward'], p['candidate']['reward'])
                for p in comparison['results']] == [(task, 0, 0, 1), (task, 1, 0, 1)]
    assert w.call('GET', w.channel, actor='content-reader')['version']['id'] == released['candidateVersionId']


@when('another recheck is in flight when a reviewer restores the original instructions')
def restore_with_pending_recheck(context):
    w = context.world
    assert_correction(w, 'private_evidence_unavailable')
    peer_id = add_late_correction(w)
    work = w.call('GET', w.learning_path + '/work', actor='evaluator')
    w.inflight_recheck, = work['rechecks']
    assert w.inflight_recheck['correctionId'] == peer_id
    assert w.inflight_recheck['revision'] == w.original_recheck['revision']
    original = w.original_delivery
    w.restoration = w.call('POST', w.learning_path + '/restore', dict(
        restoreId=str(uuid.uuid4()), expectedRevision=w.current_job['revision'],
        target=dict(kind='delivery', versionId=original['version']['id'], revision=original['revision']),
        reason='Restore the previously reviewed instructions.'))


@then('the old recorded verdict is recoverable and a new stale verdict cannot settle either correction')
def fresh_rechecks(context):
    w = context.world
    assert submit_recheck(w, w.original_recheck, 'unavailable') == w.recheck_receipt
    stale = submit_recheck(w, w.inflight_recheck, 'resolved', expected=409)
    assert 'current delivery' in stale['error']['message']
    work = w.call('GET', w.learning_path + '/work', actor='evaluator')
    assignments = {a['correctionId']: a for a in work['rechecks']}
    assert set(assignments) == {w.correction_id, w.inflight_recheck['correctionId']}
    assert all(a['revision'] == w.restoration['revision'] and a['versionId'] == w.restoration['version']['id']
               for a in assignments.values())
    w.fresh_recheck = assignments[w.correction_id]
    assert w.call('GET', w.learning_path)['proposalAdmissions'] == w.before_correction['proposalAdmissions']


@when('the recovered private evidence reproduces the original failure on the restored revision')
def reproduce_parked_case(context):
    w = context.world
    assignment = w.fresh_recheck
    current = w.sdk('delivery', actor='content-reader')
    assert current['version']['digest'] == assignment['digest'] and current['revision'] == assignment['revision']
    w.private_review_cases[w.delayed_job] = 'retries'
    assert w.private_review_cases[assignment['outcomeId']] not in current['instruction']
    receipt = submit_recheck(w, assignment, 'reproduced')
    assert receipt['accepted'] and submit_recheck(w, assignment, 'reproduced') == receipt


@then('exactly one proposal is admitted against the newly restored baseline')
def readmitted_correction(context):
    w = context.world
    w.outcome_id = w.delayed_job
    candidate = wait_for_round(w, 'development')
    assert candidate['correctionId'] == w.correction_id
    assert candidate['parentVersionId'] == w.fresh_recheck['versionId']
    enrollment = w.call('GET', w.learning_path)
    assert [r['id'] for r in enrollment['rounds'] if r['correctionId'] == w.correction_id] == [candidate['id']]
    assert enrollment['proposalAdmissions'] == w.before_correction['proposalAdmissions'] + 1
    assert enrollment['remainingAudits'] == w.before_correction['remainingAudits']
    assert w.call('GET', w.channel, actor='content-reader')['revision'] == w.restoration['revision']
