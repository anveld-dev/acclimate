"""Faults at disposable browser boundaries, with exact committed-write assertions."""
from behave import when, then
from playwright.sync_api import expect
from features.steps.console import page


@when('credential recovery cleanup fails after successful issuance')
def cleanup_failure(context):
    w=context.world
    p=page(context)
    p.evaluate('''integration => {
      const original=Storage.prototype.removeItem;
      window.__credentialCleanupFailures=[];
      Storage.prototype.removeItem=function(key) {
        if (this===sessionStorage && key.startsWith('acclimate.credential-recovery.v1:') && key.includes(integration)) {
          window.__credentialCleanupFailures.push(key);
          throw new DOMException('Acceptance fixture cleanup failure','SecurityError');
        }
        return original.call(this,key);
      };
    }''',w.integration['id'])
    p.get_by_role('button',name='Create read credential',exact=True).click()
    expect(p.get_by_role('dialog',name='Save this credential now',exact=True)).to_be_visible()
    failures=p.evaluate('window.__credentialCleanupFailures')
    assert len(failures)==1 and w.integration['id'] in failures[0]
    secret=p.get_by_label('One-time credential secret',exact=True).input_value()
    assert secret.startswith('aci_')
    w.cleanup_failure_secret=secret
    w.h.tokens['cleanup-issued']=secret


@then('its one-time secret remains visible and usable without storing or issuing another secret')
def cleanup_secret_kept(context):
    w=context.world
    p=page(context)
    expect(p.get_by_label('One-time credential secret',exact=True)).to_have_value(w.cleanup_failure_secret)
    secret=p.get_by_label('One-time credential secret',exact=True)
    secret.focus()
    assert secret.evaluate('el=>el.selectionStart===0 && el.selectionEnd===el.value.length')
    assert w.call('GET',w.channel,actor='cleanup-issued')['version']==w.original['version']
    rows=w.call('GET',w.root+'/connections',actor='admin')['items']
    integration=next(row for row in rows if row['id']==w.integration['id'])
    assert len(integration['credentials'])==1 and not integration['credentials'][0]['revokedAt']
    stored=p.evaluate('JSON.stringify([Object.entries(sessionStorage),Object.entries(localStorage)])')
    assert w.cleanup_failure_secret not in stored and 'aci_' not in stored
    p.get_by_role('button',name='I saved it · close',exact=True).click()
    expect(p.get_by_label('One-time credential secret',exact=True)).to_have_count(0)
    assert w.call('GET',w.channel,actor='cleanup-issued')['version']==w.original['version']
