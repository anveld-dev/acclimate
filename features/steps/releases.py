from behave import given, when, then


@given('the saved snapshot has complete matching evidence')
def evaluated(context):
    w = context.world
    w.request_evaluation()
    w.start_attempt()
    w.comparison()
    w.finish()
    w.evaluated_snapshot = dict(w.draft['snapshotVersion'])


@given('the saved snapshot has incomplete evidence')
def partial(context):
    w = context.world
    w.request_evaluation()
    w.start_attempt()
    w.comparison(outcome='missing grades')
    w.finish()


@when('I publish that draft using its evidence')
def publish(context):
    w = context.world
    w.published = w.publish_evidence()


@then('the channel points to the evaluated snapshot')
def exact(context):
    w = context.world
    assert w.call('GET', w.channel)['version'] == w.evaluated_snapshot


@then('release history records the comparison and previous version')
def evidence_history(context):
    w = context.world
    latest = w.call('GET', w.channel + '/releases')['items'][0]
    assert latest['comparisonId'] == w.report['id']
    assert latest['previousVersionId'] == w.original['version']['id']


@then('the draft is closed as published')
def closed(context):
    w = context.world
    assert w.call('GET', w.draft_path)['status'] == 'published'


@when('I try to publish that newer generation with the older evidence')
@when('I try to publish that draft using its incomplete evidence')
def bad_publication(context):
    context.world.publish_evidence(expected=409)


@given('I published the saved draft manually')
@when('I publish the saved draft with reason "{reason}"')
def manual(context, reason='Operator reviewed this edit manually.'):
    w = context.world
    w.manual_reason = reason
    current = w.call('GET', w.channel)
    w.published = w.call('POST', w.draft_path + '/publish', dict(expectedGeneration=w.draft['generation'], expectedRevision=current['revision'], unevaluatedReason=reason))


@then('release history records that manual reason without a comparison')
def manual_history(context):
    w = context.world
    latest = w.call('GET', w.channel + '/releases')['items'][0]
    assert latest['unevaluatedReason'] == w.manual_reason
    assert latest['comparisonId'] is None


@when('I try to publish without evidence or a reason')
def no_reason(context):
    w = context.world
    w.call('POST', w.draft_path + '/publish', dict(expectedGeneration=w.draft['generation'], expectedRevision=w.original['revision']), expected=400)


@given('I roll back to the original version with a reason')
@when('I roll back to the original version with a reason')
def rollback(context):
    w = context.world
    w.rolled_back = w.manual_release(w.original['version'], reason='Operator rolled back this release.')


@then('future applications resolve the original content at a new revision')
def original_at_new_revision(context):
    w = context.world
    result = w.call('GET', w.channel)
    assert result['version'] == w.original['version']
    assert result['revision'] == '3'


@then('rollback appears in release history')
def recorded_rollback(context):
    w = context.world
    latest = w.call('GET', w.channel + '/releases')['items'][0]
    assert latest['unevaluatedReason'] == 'Operator rolled back this release.'
    assert latest['previousVersionId'] == w.draft['snapshotVersion']['id']


@when('I browse release history one revision at a time')
def release_pages(context):
    w = context.world
    before = None
    w.decisions = []
    for _ in range(10):
        page = w.call('GET', w.channel + '/releases?limit=1' + ('&beforeRevision=' + before if before else ''))
        w.decisions.extend(page['items'])
        before = page['nextBeforeRevision']
        if not before: break
    assert before is None


@then('all {count:d} release decisions are returned once')
def every_release(context, count):
    decisions = context.world.decisions
    assert len(decisions) == count
    assert [item['revision'] for item in decisions] == ['3', '2', '1']
    assert len({item['id'] for item in decisions}) == count


@when('a read-only application tries to publish the draft')
def viewer(context):
    w = context.world
    w.call('POST', w.draft_path + '/publish', dict(expectedGeneration=w.draft['generation'], expectedRevision=w.original['revision'], unevaluatedReason='Not authorized.'), actor='viewer', expected=403)
