import uuid

from behave import when, then


@when('the source republishes the withdrawn bytes under a new version ID')
def republish_withdrawn(context):
    w = context.world
    withdrawn = w.served['version']
    payload = w.call('GET', w.bundle + '/versions/' + withdrawn['id'] + '/payload')
    w.alias = w.call('POST', w.bundle + '/versions', dict(parentVersionId=withdrawn['id'], payload=payload))
    assert w.alias['id'] != withdrawn['id'] and w.alias['digest'] == withdrawn['digest']
    source = w.manual_release(version=w.alias)
    w.restore_target = dict(kind='source', versionId=w.alias['id'], revision=source['revision'])
    w.restore_request = dict(restoreId=str(uuid.uuid4()), expectedRevision=w.restored_delivery['revision'],
                             target=w.restore_target, reason='Replayed all original jobs with the repaired application.')
    w.before_restore = w.call('GET', w.history_path)['items']


def requirements(w, version):
    path = w.learning_path + '/field-requalifications/' + version['id']
    return w.call('GET', path, actor='evaluator')


def assert_blocked(w):
    assert w.restore_target not in w.call('GET', w.learning_path)['restoreTargets']
    result = w.call('POST', w.learning_path + '/restore', w.restore_request, expected=409)
    assert 'requalification' in result['error']['message']
    assert w.call('GET', w.channel, actor='content-reader') == w.restored_delivery
    assert w.call('GET', w.history_path)['items'] == w.before_restore


@then('the eight original field jobs block restoring those bytes')
def original_field_jobs(context):
    w = context.world
    original = requirements(w, w.served['version'])
    alias = requirements(w, w.alias)
    w.required_jobs = alias['pendingOutcomeIds']
    assert len(w.required_jobs) == 8 and set(w.required_jobs) == set(w.private_field_jobs)
    assert original['pendingOutcomeIds'] == w.required_jobs and alias['failedOutcomeIds'] == []
    assert alias['baselineRevision'] == w.restored_delivery['revision']
    assert_blocked(w)


def replay(w, outcome_id):
    result = w.sdk('replayFieldJob', actor='evaluator', connectionId=w.integration['id'],
                   versionId=w.alias['id'], digest=w.alias['digest'], baselineRevision=w.restored_delivery['revision'],
                   outcomeId=outcome_id, fieldJob=w.private_field_jobs[outcome_id], defaultChecks=['.ts'])
    assert result == dict(accepted=True, verdict='pass'), result


@when('the application repairs its default code check and replays seven original jobs')
def replay_three(context):
    w = context.world
    for job in w.required_jobs[:7]:
        replay(w, job)


@then('the outstanding job still blocks restore on the current delivery revision')
def outstanding_job(context):
    w = context.world
    assert requirements(w, w.alias)['pendingOutcomeIds'] == w.required_jobs[7:]
    assert_blocked(w)


@when('the last original job passes and the reviewer retries the restore after restart')
def restore_requalified(context):
    w = context.world
    replay(w, w.required_jobs[-1])
    state = requirements(w, w.alias)
    assert state['pendingOutcomeIds'] == state['failedOutcomeIds'] == []
    assert requirements(w, w.served['version'])['pendingOutcomeIds'] == w.required_jobs
    assert w.restore_target in w.call('GET', w.learning_path)['restoreTargets']
    w.restoration = w.call('POST', w.learning_path + '/restore', w.restore_request)
    w.h.restart()
    assert w.call('POST', w.learning_path + '/restore', w.restore_request) == w.restoration


@then('the connection serves the requalified version with exactly one new release')
def requalified_delivery(context):
    w = context.world
    served = w.call('GET', w.channel, actor='content-reader')
    release, *older = w.call('GET', w.history_path)['items']
    assert older == w.before_restore and release['id'] == w.restoration['id']
    assert served['version'] == release['version'] == w.alias
    assert int(served['revision']) == int(w.restored_delivery['revision']) + 1
