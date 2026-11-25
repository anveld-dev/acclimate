from behave import when, then
from scripts.productization.local_recovery import qualify


@when('the local stack experiences a stalled and a dropped ownership connection')
def recover(context):
    w = context.world
    w.local_recovery = qualify(w.h, w.setup, w)


@then('each replacement serves the exact stored release through the same console')
def exact_release(context):
    result = context.world.local_recovery
    assert [row['fault'] for row in result['observations']] == ['timeout', 'terminated connection']
    assert result['original'] == context.world.original
    for row in result['observations']:
        assert row['channel'] == result['original']
        assert row['consoleStatus'] == 200


@then('an intentional local shutdown still succeeds')
def clean_shutdown(context):
    assert context.world.local_recovery['shutdown'] == 0
    assert context.world.local_recovery['consoleStopped'] is True
