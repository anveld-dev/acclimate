import time
from behave import given, when, then
from scripts.bdd.provider import proposal_prompt


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
    w.proposal_parent = w.call('GET', w.bundle + '/versions/' + w.original['version']['id'] + '/payload')
    w.proposal = w.call('POST', w.bundle + '/proposals', dict(parentVersionId=w.original['version']['id'],allowedPaths=path.split(", "),hypothesis='Improve retry review.',evidence=['Explicit authorized fixture evidence.']))
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
    parent = w.call('GET', w.bundle + '/versions/' + w.original['version']['id'] + '/payload')
    assert parent == w.proposal_parent, 'Proposal generation changed the published parent'
    after = w.call('GET', w.bundle + '/versions/' + candidate['id'] + '/payload')
    expected = {entry['path']: entry for entry in w.proposal_parent['files']}
    revised_text = 'Review retries and duplicated effects.'
    assert expected[path]['text'] != revised_text
    expected[path] = dict(expected[path], text=revised_text)
    actual = {entry['path']: entry for entry in after['files']}
    assert len(after['files']) == len(actual), 'Candidate contains duplicate paths'
    assert actual == expected, (actual, expected)
    assert w.proposal['rationale']


@then('the proposal fails without a candidate')
def failed(context):
    w = context.world
    assert w.proposal['status'] == 'failed'
    assert w.proposal['candidate'] is None
    assert w.proposal['error']


@then('the service rejects the returned memory edit as outside the allowed paths')
def rejected_path(context):
    w = context.world
    assert dict(path='memory/team.md', oldText='Approved shared project context.',
                newText='Review retries and duplicated effects.') in w.provider.returned_edits
    assert w.proposal['error'] == 'provider edit is outside allowed paths', w.proposal['error']


@then('the service reports a provider request failure')
def failed_request(context):
    w = context.world
    assert w.provider.requests and not w.provider.returned_edits
    assert w.proposal['error'] == 'provider request failed', w.proposal['error']


@then('the same proposal is discoverable in the scoped proposal list')
def found(context):
    w = context.world
    items = w.call('GET', w.bundle + '/proposals')['items']
    assert any(item['id'] == w.proposal['id'] and item['status'] == 'succeeded' for item in items)

@given('the provider fixture uses {mode} proposal output')
def proposal_mode(context, mode):
    context.world.provider.mode = mode


@then('the candidate replaces the old memory note with the new note')
def superseded(context):
    w = context.world
    candidate = w.proposal['candidate']
    payload = w.call('GET', w.bundle + '/versions/' + candidate['id'] + '/payload')
    files = {entry['path']: entry for entry in payload['files']}
    assert 'memory/team.md' not in files
    assert files['memory/team-v2.md']['text'] == 'Review retry safety.'
    assert files['AGENTS.md']['text'] == 'Review code.'


@then('the proposal was retried with the byte-growth error')
def growth_retried(context):
    first, second = context.world.provider.requests
    assert proposal_prompt(first)['parserError'] is None
    assert proposal_prompt(second)['parserError'] == 'Candidate exceeds proposal byte-growth limit'
