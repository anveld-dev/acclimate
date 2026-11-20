from behave import when, then


@when('the evaluator stages the withdrawn bytes under a new version ID')
def stage_withdrawn(context):
    w = context.world
    withdrawn = w.served['version']
    payload = w.call('GET', w.bundle + '/versions/' + withdrawn['id'] + '/payload')
    w.alias = w.call('POST', w.bundle + '/versions', dict(parentVersionId=withdrawn['id'], payload=payload))
    assert w.alias['id'] != withdrawn['id'] and w.alias['digest'] == withdrawn['digest']
    w.before_restore = w.call('GET', w.history_path)['items']


def requirements(w, version):
    path = w.learning_path + '/field-requalifications/' + version['id']
    return w.call('GET', path, actor='evaluator')


def assert_rollback_still_served(w):
    assert w.call('GET', w.channel, actor='content-reader') == w.restored_delivery
    assert w.call('GET', w.history_path)['items'] == w.before_restore


@then('the candidate must replay the eight original field jobs')
def original_field_jobs(context):
    w = context.world
    original = requirements(w, w.served['version'])
    alias = requirements(w, w.alias)
    w.required_jobs = alias['pendingOutcomeIds']
    assert len(w.required_jobs) == 8 and set(w.required_jobs) == set(w.private_field_jobs)
    assert original['pendingOutcomeIds'] == w.required_jobs and alias['failedOutcomeIds'] == []
    assert alias['baselineRevision'] == w.restored_delivery['revision']
    assert_rollback_still_served(w)


def replay(w, outcome_id):
    result = w.sdk('replayFieldJob', actor='evaluator', connectionId=w.integration['id'],
                   versionId=w.alias['id'], digest=w.alias['digest'], baselineRevision=w.restored_delivery['revision'],
                   outcomeId=outcome_id, fieldJob=w.private_field_jobs[outcome_id], defaultChecks=['.ts'])
    assert result == dict(accepted=True, verdict='pass'), result


@when('the application repairs its default code check and replays seven original jobs')
def replay_seven(context):
    w = context.world
    for job in w.required_jobs[:7]:
        replay(w, job)


@then('the outstanding job still blocks requalification on the current delivery revision')
def outstanding_job(context):
    w = context.world
    assert requirements(w, w.alias)['pendingOutcomeIds'] == w.required_jobs[7:]
    assert_rollback_still_served(w)


@when('the last original job passes and the service restarts')
def finish_replays(context):
    w = context.world
    replay(w, w.required_jobs[-1])
    w.h.restart()


@then('the candidate is requalified and the connection still serves the automatic rollback')
def requalified_candidate(context):
    w = context.world
    state = requirements(w, w.alias)
    assert state['pendingOutcomeIds'] == state['failedOutcomeIds'] == []
    assert requirements(w, w.served['version'])['pendingOutcomeIds'] == w.required_jobs
    assert_rollback_still_served(w)
