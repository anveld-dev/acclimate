import re
from urllib.parse import parse_qs, urlsplit

from behave import given, when, then
from playwright.sync_api import expect
from scripts.bdd.learning import enroll_reviews, grade_through_audit, report_failed_job, wait_for_round


def open_learning(w):
    browser = w.browser()
    browser.visit(browser.workspace_path('connections') + '?connection=' + w.integration['id']
                  + '&connectionTab=learning')
    return browser.page.get_by_role('region', name='Continuous learning')


def blocking_receipt(w, phase, **threshold):
    receipt = w.sdk('reportPolicy', actor='evaluator', requestId=w.round[phase + 'RequestId'],
                    policy=dict(schemaVersion=1, id=phase + '-quality', revision='1',
                                metric=dict(name='Instruction coverage', unit='reward', direction='higher'),
                                aggregation='equal-case-means', requiredCases=[],
                                maximumCaseRegression=0,
                                # The fixture has too few cases for the default paired test; these
                                # scenarios need a definite failing receipt, not an indeterminate one.
                                inference=dict(method='none'), **threshold))
    assert receipt['verdict'] == 'fail'
    assert receipt['comparisonId'] == w.round[phase + 'ComparisonId']
    return receipt


@given('a connected audit is blocked by a recorded application policy')
def audited_candidate(context):
    w = context.world
    enroll_reviews(w)
    grade_through_audit(w)
    w.round = wait_for_round(w, 'audit')
    blocking_receipt(w, 'development', minimumMeanImprovement=1.01)
    assert w.finish()['status'] == 'completed'
    w.rejected = wait_for_round(w, 'rejected')
    assert w.rejected['auditComparisonId'] and not w.rejected['promotionId']


@when('a signed-in administrator tries to approve that blocked round')
def approve_closed_round(context):
    w = context.world
    w.call('POST', w.learning_path + '/rounds/' + w.round['id'] + '/review',
           dict(approve=True), actor='admin', expected=404)


@then('the rejection and original delivery survive restart')
def rejection_survives(context):
    w = context.world
    w.h.restart()
    assert wait_for_round(w, 'rejected')['reason'] == w.rejected['reason']
    assert w.call('GET', w.channel, actor='content-reader') == w.original_delivery


@then('the connection shows the rejection reason without an approval action')
def blocked_policy_reason(context):
    w = context.world
    panel = open_learning(w)
    expand = panel.get_by_role('button', name=re.compile('Rejected · outcome ' + w.outcome_id[:8]))
    if expand.get_attribute('aria-expanded') != 'true':
        expand.click()
    expect(panel.get_by_text(w.rejected['reason'], exact=True).first).to_be_visible()
    expect(panel.get_by_role('button', name='Roll out this candidate')).to_have_count(0)


@given('an independently graded field job triggered automatic rollback')
def automatic_rollback(context):
    w = context.world
    enroll_reviews(w)
    grade_through_audit(w)
    assert w.finish()['status'] == 'completed'
    w.round = wait_for_round(w, 'promoted')
    w.served = w.call('GET', w.channel, actor='content-reader')
    assert w.served['version']['id'] == w.round['candidateVersionId']
    # Both jobs of interest used the withdrawn revision. Their verdicts arrive
    # on opposite sides of the rollback, so only one can be its cause.
    grades = []
    w.private_field_jobs = {}
    for index in range(8):
        path = f'src/review-{index}.ts'
        job = dict(changedPaths=[path, 'CHANGELOG.md'], expectedPaths=[path])
        grade = w.sdk('gradeFieldJob', actor='evaluator', connectionId=w.integration['id'],
                      readerToken=w.read_credential['secret'], receiptToken=w.write_credential['secret'],
                      outcomeToken=w.h.tokens['other'], fieldJob=job)
        assert grade.get('verdict') == 'loss', grade
        assert grade['versionId'] == w.served['version']['id']
        assert grade['parentVersionId'] == w.original_delivery['version']['id']
        grades.append(grade)
        w.private_field_jobs[grade['outcomeId']] = job
    assert len({grade['outcomeId'] for grade in grades}) == len(grades)
    audits = w.learning_path + '/field-audits'
    for grade in grades[:6]:
        assert 'rollbackPromotionId' not in w.call('POST', audits, grade, actor='evaluator')
    w.triggering_job, w.later_job = grades[6:]
    w.rollback_id = w.call('POST', audits, w.triggering_job, actor='evaluator')['rollbackPromotionId']
    assert 'rollbackPromotionId' not in w.call('POST', audits, w.later_job, actor='evaluator')
    rollback = w.call('GET', w.history_path)['items'][0]
    assert rollback['id'] == w.rollback_id and rollback['reviewer'] == 'service:connected-learning'
    w.restored_delivery = w.call('GET', w.channel, actor='content-reader')
    assert w.restored_delivery['version'] == w.original_delivery['version']
    assert int(w.restored_delivery['revision']) == int(w.served['revision']) + 1


def lookup_job(w, job):
    region = w.browser_fixture.page.get_by_role('region', name='Continuous learning')
    disclosure = region.get_by_role('button', name='Find a reported outcome', exact=True)
    if disclosure.get_attribute('aria-expanded') != 'true':
        disclosure.click()
    region.get_by_label('Application outcome ID').fill(job['outcomeId'])
    region.get_by_role('button', name='Look up outcome', exact=True).click()


@when('I look up the triggering job on the connection')
def lookup_trigger(context):
    w = context.world
    open_learning(w)
    lookup_job(w, w.triggering_job)


def expect_traced_outcome(w, *, triggered):
    region = w.browser_fixture.page.get_by_role('region', name='Continuous learning')
    served, restored = w.served, w.restored_delivery
    version = restored['version']['id']
    lines = [
        f"Job failed · served version {served['version']['id']} · revision {served['revision']}",
        f"Release {w.round['promotionId']} · revision {served['revision']} · withdrawn",
        f"Automatic rollback restored {version} · revision {restored['revision']} · release {w.rollback_id}",
        f"Current version {version} · revision {restored['revision']}",
    ]
    for line in lines:
        expect(region.get_by_text(line, exact=True)).to_be_visible()
    verdict = f"Outcome comparison · loss against control {version}"
    if triggered:
        verdict += ' · this verdict triggered automatic rollback'
    expect(region.get_by_text(verdict, exact=True)).to_be_visible()
    if not triggered:
        expect(region.get_by_text('this verdict triggered automatic rollback', exact=False)).to_have_count(0)


@then('its outcome identifies the withdrawn release, the restored revision and the triggering verdict')
def trace_trigger(context):
    expect_traced_outcome(context.world, triggered=True)


@when('I follow its audit evidence')
def follow_audit(context):
    region = context.world.browser_fixture.page.get_by_role('region', name='Continuous learning')
    region.get_by_role('link', name='Independent comparison', exact=True).click()


@then('the console opens the independent audit for the exact served candidate')
def verify_audit(context):
    w = context.world
    p = w.browser_fixture.page
    p.get_by_role('button', name='Run details', exact=True).click()
    provenance = p.get_by_role('heading', name='Run provenance').locator('..')
    for value in (w.round['auditRequestId'], w.round['auditComparisonId'], w.served['version']['id'], 'audit-v1'):
        expect(provenance).to_contain_text(value)
    query = parse_qs(urlsplit(p.url).query)
    assert query['request'] == [w.round['auditRequestId']]
    assert query['candidate'] == [w.served['version']['id']]


@when('I return and look up the job graded after the rollback')
def lookup_later_job(context):
    w = context.world
    w.browser_fixture.page.go_back()
    lookup_job(w, w.later_job)


@then('its regression identifies the same withdrawn release without claiming it triggered rollback')
def trace_later_job(context):
    expect_traced_outcome(context.world, triggered=False)


@given('a candidate improved development but lost a protected code-review instruction in audit')
def rejected_audit(context):
    w = context.world
    enroll_reviews(w, reserve=True, audit={
        'duplicate-review': 'duplicated effects', 'idempotency-review': 'idempotency',
        'code-review': 'Review code.',
    }, audit_protected_thresholds={'code-review': 1})
    grade_through_audit(w)
    assert w.finish()['status'] == 'completed'
    w.round = wait_for_round(w, 'rejected')
    assert w.round['reason'] == 'Protected case threshold failed'
    development = w.call('GET', w.bundle + '/comparisons/' + w.round['developmentComparisonId'])
    gains = sorted((p['caseId'], p['repetition'], p['candidate']['reward'] - p['parent']['reward'])
                   for p in development['results'])
    assert gains == [(case, repetition, 1) for case in ('backoff-review', 'retry-review')
                     for repetition in range(3)], gains
    assert w.round['auditComparisonId'] == w.report['id'] and w.round['promotionId'] is None


@when('I open the rejected round on the connection')
def open_rejected(context):
    w = context.world
    region = open_learning(w)
    expand = region.get_by_role('button', name=re.compile('Rejected · outcome ' + w.outcome_id[:8]))
    expect(expand).to_be_visible()
    if expand.get_attribute('aria-expanded') != 'true':
        expand.click()


@then('I see the audit rejection reason and cannot approve that round')
def visible_rejection(context):
    region = context.world.browser_fixture.page.get_by_role('region', name='Continuous learning')
    assert context.world.round['reason']
    expect(region.get_by_text(context.world.round['reason'], exact=True)).to_be_visible()
    expect(region.get_by_role('button', name='Review rollout', exact=True)).to_have_count(0)
    expect(region.get_by_role('link', name='View development comparison')).to_be_visible()


@when("I follow the round's audit evidence to the regressed case")
def open_regressed_case(context):
    w = context.world
    page = w.browser_fixture.page
    link = page.get_by_role('link', name='View independent comparison', exact=True)
    href = link.get_attribute('href')
    link.click()
    expect(page).to_have_url(w.browser_fixture.base + href)
    query = parse_qs(urlsplit(page.url).query)
    assert query['comparison'] == [w.round['auditComparisonId']]
    assert query['request'] == [w.round['auditRequestId']]
    assert query['candidate'] == [w.round['candidateVersionId']]
    cases = page.get_by_role('region', name='Evaluation case comparison')
    cases.get_by_label('Filter case results').select_option('lower')
    cases.get_by_role('button', name=re.compile(r'^code-review Rep 0')).click()


@then('the case shows the parent earned 1 and the candidate earned 0')
def displayed_regression(context):
    w = context.world
    case = w.browser_fixture.page.get_by_role('region', name='Outcomes for code-review', exact=True)
    expect(case.get_by_text('Lower reward', exact=False)).to_be_visible()
    matrix = case.get_by_role('table', name='Selected parent and candidate outcomes')
    for label, version in [('Parent', w.original_delivery['version']['id']), ('Candidate', w.round['candidateVersionId'])]:
        expect(matrix.get_by_role('columnheader', name=re.compile(label))).to_contain_text(version[:8])
    expect(matrix.get_by_role('row', name=re.compile('^Reward')).get_by_role('cell')).to_have_text(['1', '0'])


@given('an automatic rollout is waiting for its evaluator to finish a passing audit')
def pending_audit(context):
    w = context.world
    enroll_reviews(w, reserve=True)
    grade_through_audit(w)
    w.round = wait_for_round(w, 'audit')
    assert w.call('GET', w.evaluation_path)['status'] == 'running'
    assert w.report['complete']
    scores = [(p['caseId'], p['parent']['reward'], p['candidate']['reward']) for p in w.report['results']]
    assert sorted(scores) == [('duplicate-review', 0, 1)] * 3 + [('idempotency-review', 0, 1)] * 3, scores


@when('I confirm Stop learning on the connection')
def stop_active_audit(context):
    w = context.world
    region = open_learning(w)
    expect(region.get_by_text('Automatic rollout', exact=True)).to_be_visible()
    region.get_by_role('button', name='Stop learning', exact=True).click()
    dialog = w.browser_fixture.page.get_by_role('dialog', name='Stop continuous learning?')
    dialog.get_by_role('button', name='Stop learning', exact=True).click()
    expect(region.get_by_text('Stopped', exact=True)).to_be_visible()
    assert w.call('GET', w.learning_path)['stoppedAt']


@when('the evaluator delivers the late audit completion and the service restarts')
def late_completion(context):
    w = context.world
    # The stop can race the worker closing the attempt. Both orderings must fence rollout.
    w.finish(expected=(200, 409))
    w.h.restart()


@then('the stopped connection shows a rejected round and assigns no further work')
def stopped_round(context):
    w = context.world
    closed = wait_for_round(w, 'rejected')
    assert closed['id'] == w.round['id'] and closed['promotionId'] is None
    region = open_learning(w)
    expect(region.get_by_text('Stopped', exact=True)).to_be_visible()
    expect(region.get_by_role('button', name=re.compile('Rejected · outcome ' + w.outcome_id[:8]))).to_be_visible()
    expect(region.get_by_role('button', name='Review rollout', exact=True)).to_have_count(0)
    status = w.call('GET', w.learning_path)
    assert status['proposalAdmissions'] < status['maxProposalAdmissions'] and status['remainingAudits'] > 0
    report_failed_job(w, w.original_delivery, expected=409,
                      lesson=dict(path='AGENTS.md', instruction='Add timeout guidance.'))
    work = w.call('GET', w.learning_path + '/work', actor='evaluator')
    assert work['active'] is False
    for queue in ('items', 'rechecks', 'incidentReplays', 'fieldReplays'):
        assert work[queue] == [], queue


@then('the next application job uses the original revision and instructions')
def original_job(context):
    w = context.world
    job = w.sdk('delivery', actor='content-reader')
    assert job['stale'] is False and job['version'] == w.original_delivery['version']
    assert job['revision'] == w.original_delivery['revision'] and job['instruction'] == 'Review code.'
    assert w.call('GET', w.history_path)['items'] == w.original_history
