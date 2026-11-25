from behave import when, then


def adapter(context,action,**options):
    w=context.world
    w.identity_result=w.sdk(action,issuer=w.issuer,loginToken=w.login_token,consoleToken=w.console_token,**options)


@when('I complete a valid sign-in callback')
def valid(context):
    adapter(context,'identityLogin')


@then('a secure HttpOnly session cookie is returned and Rust recognizes the person')
def secure(context):
    result=context.world.identity_result
    assert result['status']==303 and result['secure'] is True
    assert result['sessionStatus']==200 and result['subject']=='browser-person'


@then('replaying the callback is rejected')
def replay(context):
    assert context.world.identity_result['replay']==400


@when('a sign-in callback has {invalid}')
def invalid(context,invalid):
    adapter(context,'identityInvalid',invalid=invalid)


@then('no session cookie is issued')
def none(context):
    result=context.world.identity_result
    assert result['status'] in (400,503)
    assert result['sessionIssued'] is False


@when('a signed-in browser receives a cross-site logout request')
def cross(context):
    adapter(context,'identityCrossSite')


@then('logout is rejected and the original session remains valid')
def original(context):
    assert context.world.identity_result==dict(status=403,sessionStatus=200)


@when('a signed-in browser submits same-origin logout')
def logout(context):
    adapter(context,'identityLogout')


@then('the old cookie no longer authorizes identity reads')
def revoked(context):
    assert context.world.identity_result==dict(status=303,sessionStatus=401)


@when('I sign in after the prior cookie was revoked')
def renew(context):
    adapter(context,'identityRenew')


@then('a new valid cookie identifies the same person')
def replaced(context):
    assert context.world.identity_result==dict(oldStatus=401,status=303,changed=True,sessionStatus=200,samePerson=True)
