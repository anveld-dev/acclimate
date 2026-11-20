from behave import given, when, then
from scripts.productization.qualify import payload


@given('a published bundle containing "{text}"')
def published(context, text):
    context.world.publish_initial(text)


@given('I have saved a draft containing "{text}"')
@when('I save a draft containing "{text}"')
def save(context, text):
    context.world.save_new(text)


@when('the service restarts')
def restart(context):
    context.world.h.restart()


@then('I can reopen the same saved snapshot containing "{text}"')
def reopen(context, text):
    w = context.world
    reopened = w.h.call('GET', w.draft_path)
    assert reopened == w.saved, 'Restart changed the saved draft identity'
    assert w.draft_text(reopened) == text


@then('the source still contains only the original release')
def unchanged_release(context):
    w = context.world
    seed, = w.call('GET', w.channel + '/releases')['items']
    assert seed['version'] == w.original['version'] and seed['revision'] == w.original['revision']


@given('I save another generation containing "{text}"')
@when('I save another generation containing "{text}"')
def another_save(context, text):
    context.world.save_again(text)


@then('draft history contains both snapshots with their original text')
def history(context):
    w = context.world
    entries = w.call('GET', w.draft_path + '/history')['items']
    assert [item['generation'] for item in entries] == [2, 1]
    assert [w.call('GET', w.bundle + '/versions/' + item['version']['id'] + '/payload')['files'][0]['text'] for item in entries] == ['Review duplicate retries.', 'Review retries.']
    assert all(item['version']['parentVersionId'] == w.original['version']['id'] for item in entries)


@when('an older tab tries to save "{text}"')
def stale_save(context, text):
    w = context.world
    w.call('POST', w.draft_path + '/save', dict(expectedGeneration=w.previous['generation'], payload=payload(text)), expected=409)


@then('the save is rejected with a conflict')
def conflict(context):
    assert context.world.last_status == 409


@then('the draft still contains "{text}"')
def retained(context, text):
    w = context.world
    reopened = w.call('GET', w.draft_path)
    assert reopened['snapshotVersion']['id'] == w.saved['snapshotVersion']['id']
    assert w.draft_text(reopened) == text


@when('I retry the identical save with its original operation ID')
def retry(context):
    w = context.world
    w.replayed = w.call('POST', w.last_path, w.last_body, key=w.last_key)


@then('I get the same saved snapshot')
def replayed(context):
    assert context.world.replayed == context.world.saved


@then('draft history contains exactly {count:d} snapshots')
def count_history(context, count):
    w = context.world
    assert len(w.call('GET', w.draft_path + '/history')['items']) == count


@when('the response to saving "{text}" is lost')
def lost_response(context, text):
    w = context.world
    w.save_again(text)
    w.saved = w.draft = None  # Discard the successful response; only the key/request survive.


@when('the short-lived response cache expires')
def expire_cache(context):
    # Fault injection only: advance the fixture cache deadline, never assert via SQL.
    context.world.h.sql("UPDATE idempotency SET expires_at=now()-interval '1 second'")


@then('the original operation ID recovers the saved snapshot containing "{text}"')
def recover(context, text):
    w = context.world
    outcome = w.call('GET', w.root + '/operations/' + w.last_key)
    assert outcome['status'] == 'committed'
    w.saved = w.draft = outcome['result']
    assert w.draft['generation'] == 2
    assert w.draft_text() == text


@when('I reuse that save operation ID for "{text}"')
def changed_retry(context, text):
    from scripts.productization.qualify import payload
    w = context.world
    w.call('POST', w.last_path, dict(expectedGeneration=w.last_body['expectedGeneration'], payload=payload(text)), key=w.last_key, expected=409)


@when('another writer looks up my save operation')
def other_lookup(context):
    w = context.world
    w.lookup = w.call('GET', w.root + '/operations/' + w.last_key, actor='other')


@then('no committed result is disclosed')
def hidden(context):
    assert context.world.lookup['status'] == 'not_observed'
    assert 'result' not in context.world.lookup


@when('I discard the saved draft')
def discard(context):
    w = context.world
    w.draft = w.call('POST', w.draft_path + '/discard', dict(expectedGeneration=w.draft['generation']))


@then('the draft is listed as discarded')
def discarded(context):
    w = context.world
    items = w.call('GET', w.channel + '/drafts?status=all')['items']
    assert any(item['id'] == w.draft['id'] and item['status'] == 'discarded' for item in items)


@when('I try to publish the discarded draft')
@when('I try to publish the saved draft manually')
def publish_rejected(context):
    w = context.world
    w.call('POST', w.draft_path + '/publish', dict(expectedGeneration=w.draft['generation'], expectedRevision=w.original['revision'], unevaluatedReason='Manual request'), expected=404)


@then('publication is rejected')
def rejected(context):
    assert context.world.last_status == 404


@when('I try to save {invalid} content')
def invalid_edit(context, invalid):
    w = context.world
    w.call('POST', w.draft_path + '/save', dict(expectedGeneration=w.draft['generation'], payload=w.invalid_payload(invalid)), expected=(400, 413))


@then('the content is rejected')
def invalid_content(context):
    assert context.world.last_status in (400, 413)


@given('I have saved {count:d} independent drafts')
def independent(context, count):
    w = context.world
    w.all_drafts = []
    for n in range(count):
        w.save_new('Draft ' + str(n))
        w.all_drafts.append(w.draft['id'])


@when('I browse saved drafts one page at a time')
def paginate(context):
    w = context.world
    cursor = None
    w.listed = []
    for _ in range(10):
        result = w.call('GET', w.channel + '/drafts?limit=1' + ('&cursor=' + cursor if cursor else ''))
        w.listed.extend(item['id'] for item in result['items'])
        cursor = result['nextCursor']
        if not cursor:
            break
    assert cursor is None, 'Draft pagination did not terminate'


@then('all {count:d} drafts are returned once')
def all_once(context, count):
    w = context.world
    assert len(w.listed) == count
    assert set(w.listed) == set(w.all_drafts)


@then('the saved draft remains available')
def available(context):
    w = context.world
    assert w.call('GET', w.draft_path)['status'] == 'open'
