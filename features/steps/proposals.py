import time
from behave import given, when, then


@given('a published bundle with instructions and approved reusable memory')
def resources(context):
    context.world.publish_initial('', files=[dict(path='AGENTS.md',kind='instruction',text='Review code.'),dict(path='memory/team.md',kind='memory',text='Approved shared project context.')])


@given('the provider fixture tries to edit unselected memory')
def outside(context):
    context.world.provider.mode = 'outside-paths'


@given('the provider fixture is unavailable')
def unavailable(context):
    context.world.provider.mode = 'unavailable'


@given('proposal generation is not configured')
def disabled(context):
    w = context.world
    for key in list(w.h.env):
        if key.startswith('ACCLIMATE_MODEL'): del w.h.env[key]
    w.h.restart()


@when('I request a proposal that may edit only "{path}"')
def propose(context, path):
    w = context.world
    w.proposal = w.call('POST', w.bundle + '/proposals', dict(parentVersionId=w.original['version']['id'],allowedPaths=[path],hypothesis='Improve retry review.',evidence=['Explicit authorized fixture evidence.']))
    deadline = time.monotonic() + 10
    while time.monotonic() < deadline:
        w.proposal = w.call('GET', w.bundle + '/proposals/' + w.proposal['id'])
        if w.proposal['status'] in ('succeeded', 'failed'):
            break
        time.sleep(.05)
    assert w.proposal['status'] in ('succeeded', 'failed'), 'Proposal did not reach a terminal state'


@then('the proposal succeeds with a candidate changing only "{path}"')
def candidate(context, path):
    w = context.world
    assert w.proposal['status'] == 'succeeded'
    candidate = w.proposal['candidate']
    assert candidate['parentVersionId'] == w.original['version']['id']
    before = w.call('GET', w.bundle + '/versions/' + w.original['version']['id'] + '/payload')
    after = w.call('GET', w.bundle + '/versions/' + candidate['id'] + '/payload')
    changed = [entry['path'] for entry, original in zip(after['files'], before['files']) if entry != original]
    assert changed == [path]
    assert after['files'][0]['text'] == 'Review retries and duplicated effects.'
    assert w.proposal['rationale']


@then('the proposal fails without a candidate')
def failed(context):
    w = context.world
    assert w.proposal['status'] == 'failed'
    assert w.proposal['candidate'] is None
    assert w.proposal['error']


@then('the same proposal is discoverable in the scoped proposal list')
def found(context):
    w = context.world
    items = w.call('GET', w.bundle + '/proposals')['items']
    assert any(item['id'] == w.proposal['id'] and item['status'] == 'succeeded' for item in items)
