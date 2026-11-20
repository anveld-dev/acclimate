from behave import given, when, then


@given('I have uploaded a version containing "{text}"')
def upload_version(context, text):
    context.world.upload_version(text)


@given('I released the uploaded version')
@when('I released the uploaded version')
def release_uploaded_version(context):
    context.world.manual_release()


@when('I try to release without a reason')
def missing_reason(context):
    w = context.world
    w.call('POST', w.channel + '/releases', dict(
        versionId=w.uploaded_version['id'], expectedRevision=w.original['revision']), expected=400)


@then('publication is rejected')
def publication_rejected(context):
    assert context.world.last_status == 400


@given("I roll back to the original version with a reason")
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
    assert latest['previousVersionId'] == w.uploaded_version['id']


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


@when('a read-only application tries to release the uploaded version')
def viewer(context):
    w = context.world
    w.call('POST', w.channel + '/releases', dict(versionId=w.uploaded_version['id'], expectedRevision=w.original['revision'], unevaluatedReason='Not authorized.'), actor='viewer', expected=403)


@then('applications still resolve the original release')
def unchanged_release(context):
    w = context.world
    assert w.call('GET', w.channel) == w.original
