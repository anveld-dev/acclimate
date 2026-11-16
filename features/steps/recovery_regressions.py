"""Faults at disposable browser boundaries, with exact committed-write assertions."""
import json
import re
import time
from urllib.parse import quote
from behave import given, when, then
from playwright.sync_api import expect
from scripts.bdd.editor import expect_editor_value
from features.steps.console import page, saved_draft
from features.steps.remediation_recovery import records, TEXT_A
from scripts.bdd.interactions import open_details, submit_and_wait
from scripts.productization.qualify import payload


@when('I revert the uncertain browser text to its previously displayed saved text and check the result')
def revert_before_lookup(context):
    w=context.world
    p=page(context)
    submitted=json.loads(w.recovery_records[0][1])
    body=json.loads(submitted['body'])
    w.reverted_text='Initial saved fixture.' if 'expectedGeneration' in body else 'Review code.'
    field=p.get_by_role('textbox', name='Content', exact=True)
    field.fill(w.reverted_text)
    field.evaluate("el=>el.dataset.recoveryInstance='reverted-editor'")
    # This is the regression trigger: text equals the editor's old saved base,
    # although it differs from the already committed submitted snapshot.
    expect(p.get_by_text(re.compile(r'\bUnsaved changes\b'))).to_have_count(0)
    submit_and_wait(p,p.get_by_role('button',name='Check result',exact=True))
    expect(p.get_by_role('button',name='Check result',exact=True)).to_have_count(0)


@then('the committed snapshot remains text A while the same editor keeps the reverted text as unsaved')
def reverted_is_later_edit(context):
    w=context.world
    p=page(context)
    expect(p).to_have_url(w.before_retry_url)
    field=p.get_by_role('textbox', name='Content', exact=True)
    expect(field).to_have_attribute('data-recovery-instance','reverted-editor')
    expect_editor_value(field, w.reverted_text)
    expect(p.locator('.draft-status p[data-unsaved="true"]')).to_contain_text(f"Generation {w.recovered_draft['generation']} saved · Unsaved changes")
    expect(p.get_by_role('button',name='Save draft',exact=True)).to_be_enabled()
    assert records(p)==[]
    assert saved_draft(w)==w.recovered_draft
    assert w.draft_text(w.recovered_draft)==TEXT_A
    assert w.call('GET',w.channel)['version']==w.original['version']


@when('the browser loses a successfully submitted suggestion response')
def lose_proposal(context):
    w=context.world
    b=w.browser()
    b.visit(b.bundle_path('changes',proposal='new'))
    p=b.page
    p.get_by_label('Hypothesis',exact=True).fill('Submitted fixture hypothesis.')
    p.get_by_label('Authorized evidence (one item per line)',exact=True).fill('Submitted fixture evidence.')
    p.get_by_role('checkbox',name='AGENTS.md',exact=True).check()
    p.get_by_role('checkbox',name='Authorize bundle disclosure',exact=True).check()
    dropped=[]
    def drop(route):
        request=route.request
        if request.method=='POST' and 'submitFrozen' in (request.post_data or '') and not dropped:
            # Take the in-flight DOM proof immediately, then always settle the
            # route. Waiting for locator assertions inside a route callback can
            # leave the request held if an assertion raises.
            proof=p.evaluate("""() => ({
              texts:[...document.querySelectorAll('main textarea')].map(el=>({value:el.value,disabled:el.disabled})),
              paths:!!document.querySelector('[role=checkbox][aria-label="AGENTS.md"]:disabled'),
              consent:!!document.querySelector('[role=checkbox][aria-label="Authorize bundle disclosure"]:disabled')
            })""")
            response=route.fetch()
            assert response.ok
            dropped.append(proof)
            route.abort('failed')
        else:
            route.continue_()
    p.route('**/*',drop)
    try:
        p.get_by_role('button',name='Request suggestion',exact=True).click()
        expect(p.get_by_role('button',name='Check result',exact=True)).to_be_enabled()
    finally:
        p.unroute('**/*',drop)
    assert len(dropped)==1,'The actual submitted suggestion response was not faulted'
    proof=dropped[0]
    assert proof['texts']==[dict(value='Submitted fixture hypothesis.',disabled=True),dict(value='Submitted fixture evidence.',disabled=True)],proof
    assert proof['paths'] and proof['consent'],proof
    w.proposal_recovery_records=records(p)
    assert len(w.proposal_recovery_records)==1
    w.proposal_record=json.loads(w.proposal_recovery_records[0][1])
    assert w.proposal_record['action']==w.bundle+'/proposals'
    frozen=json.loads(w.proposal_record['body'])
    assert frozen['hypothesis']=='Submitted fixture hypothesis.'
    assert frozen['evidence']==['Submitted fixture evidence.']
    rows=w.call('GET',w.bundle+'/proposals')['items']
    assert len(rows)==1
    w.uncertain_proposal=rows[0]
    w.proposal_form_url=p.url


@when('I change the suggestion hypothesis and evidence before {recovery}')
def later_proposal_form(context,recovery):
    w=context.world
    p=page(context)
    p.get_by_label('Hypothesis',exact=True).fill('Later browser hypothesis remains mine.')
    p.get_by_label('Hypothesis',exact=True).evaluate("el=>el.dataset.recoveryInstance='later-proposal-form'")
    p.get_by_label('Authorized evidence (one item per line)',exact=True).fill('Later evidence must never be submitted by recovery.')
    assert records(p)==w.proposal_recovery_records
    expect(p.get_by_role('button',name='Request suggestion',exact=True)).to_be_disabled()
    if recovery=='retrying exactly':
        open_details(p,'Recovery details')
        p.get_by_role('button',name='Retry exact submitted snapshot',exact=True).click()
    else:
        assert recovery=='checking its result'
        p.get_by_role('button',name='Check result',exact=True).click()
    expect(p.get_by_role('button',name='Check result',exact=True)).to_have_count(0)


@then('the earlier suggestion is reconciled once and my later suggestion form stays intact')
def later_proposal_retained(context):
    w=context.world
    p=page(context)
    expect(p).to_have_url(w.proposal_form_url)
    expect(p.get_by_label('Hypothesis',exact=True)).to_have_attribute('data-recovery-instance','later-proposal-form')
    expect(p.get_by_label('Hypothesis',exact=True)).to_have_value('Later browser hypothesis remains mine.')
    expect(p.get_by_label('Authorized evidence (one item per line)',exact=True)).to_have_value('Later evidence must never be submitted by recovery.')
    expect(p.get_by_role('checkbox',name='Authorize bundle disclosure',exact=True)).to_be_checked()
    expect(p.get_by_role('checkbox',name='AGENTS.md',exact=True)).to_be_checked()
    expect(p.get_by_role('button',name='Request suggestion',exact=True)).to_be_enabled()
    assert records(p)==[]
    rows=w.call('GET',w.bundle+'/proposals')['items']
    assert len(rows)==1 and rows[0]['id']==w.uncertain_proposal['id']
    deadline=time.monotonic()+10
    while not w.provider.requests and time.monotonic()<deadline:
        time.sleep(.05)
    assert len(w.provider.requests)==1
    sent=json.loads(w.provider.requests[0]['messages'][0]['content'])['request']
    assert sent['hypothesis']=='Submitted fixture hypothesis.'
    assert sent['evidence']==['Submitted fixture evidence.']
    assert w.call('GET',w.channel)['version']==w.original['version']


@given('an older historical release exists before the uncertain draft')
def historical_recovery_fixture(context):
    w=context.world
    version=w.call('POST',w.bundle+'/versions',dict(parentVersionId=w.original['version']['id'],payload=payload('Review code. Published history before recovery.')))
    w.manual_release(version,reason='Explicit historical-release fixture before the uncertain draft.')
    w.original=w.call('GET',w.channel)
    assert w.original['revision']=='2'
    w.foreign_baseline_revision=w.original['revision']


@when('I leave the uncertain editor for {destination}')
def leave_pending_editor(context,destination):
    w=context.world
    p=page(context)
    w.foreign_destination=destination
    p.get_by_role('link',name=re.compile(r'^Evaluate saved generation \d+$') if destination=='Review release' else destination,exact=True).click()
    expect(p.get_by_role('heading',name='Leave current edits?',exact=True)).to_be_visible()
    p.get_by_role('button',name='Leave editor',exact=True).click()
    notice=p.get_by_role('region',name='Pending submission from another page',exact=True)
    expect(notice).to_be_visible()
    expect(notice.get_by_role('button',name='Check result',exact=True)).to_be_visible()
    assert records(p)==w.recovery_records


@then('that page blocks new writes until its notice checks the original save result')
def foreign_result(context):
    w=context.world
    p=page(context)
    if w.foreign_destination=='Review release':
        open_details(p,'Set up evaluation request')
        expect(p.get_by_role('button',name='Create evaluation request',exact=True)).to_be_disabled()
        open_details(p,'Publish without evaluation')
        p.get_by_label('Manual release reason',exact=True).fill('This must remain blocked by the original pending save.')
        expect(p.get_by_role('button',name='Review manual release',exact=True)).to_be_disabled()
    else:
        assert w.foreign_destination=='Releases'
        row=p.get_by_role('article').filter(has=p.get_by_role('heading',name='Revision 1',exact=True))
        # Revision 1 is a real historical release, so its restoration would be
        # available without the unrelated pending save.
        expect(p.get_by_role('heading',name='Revision 2',exact=True)).to_be_visible()
        expect(row.get_by_role('button',name=re.compile(r'^Restore revision '))).to_be_disabled()
    record=json.loads(w.recovery_records[0][1])
    lookup=w.root+'/operations/'+record['key']+'?operationPath='+quote(record['action'],safe='')
    before=w.call('GET',lookup,actor='_browser-operator')
    assert before['status']=='committed'
    p.get_by_role('region',name='Pending submission from another page',exact=True).get_by_role('button',name='Check result',exact=True).click()
    expect(p.get_by_role('region',name='Pending submission from another page',exact=True)).to_have_count(0)
    assert records(p)==[]
    after=w.call('GET',lookup,actor='_browser-operator')
    assert after==before,'The foreign notice must reconcile the original command without closing another route'
    current=saved_draft(w)
    assert current==w.recovered_draft and current['generation']==2
    assert len(w.call('GET',w.channel+'/drafts')['items'])==1
    assert w.call('GET',w.channel)['revision']==w.foreign_baseline_revision
    assert w.call('GET',w.channel)['version']==w.original['version']
    assert w.call('GET',w.bundle+'/evaluation-requests')['items']==[]


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
    rows=w.call('GET',w.root+'/integrations',actor='admin')['items']
    integration=next(row for row in rows if row['id']==w.integration['id'])
    assert len(integration['credentials'])==1 and not integration['credentials'][0]['revokedAt']
    stored=p.evaluate('JSON.stringify([Object.entries(sessionStorage),Object.entries(localStorage)])')
    assert w.cleanup_failure_secret not in stored and 'aci_' not in stored
    p.get_by_role('button',name='I saved it · close',exact=True).click()
    expect(p.get_by_label('One-time credential secret',exact=True)).to_have_count(0)
    assert w.call('GET',w.channel,actor='cleanup-issued')['version']==w.original['version']
