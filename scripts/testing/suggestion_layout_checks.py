"""Focused real-service checks for the suggestion brief and record inspection."""
import json
from scripts.testing.compact_console import improvement_server_function_path
from urllib.parse import parse_qs,urlsplit
from playwright.sync_api import expect
from scripts.bdd.layout import capture_layout
from scripts.testing.compact_console import visit
from scripts.testing.suggestion_layouts import LONG_PATH


def verify(w,b,p,out,checks):
    p.set_viewport_size(dict(width=1440,height=1000))
    route=b.bundle_path('changes',proposal='new');visit(p,b,route)
    form=p.get_by_role('region',name='Suggest a change',exact=True)
    submit=form.get_by_role('button',name='Request suggestion',exact=True)
    expect(submit).to_be_disabled();expect(form).to_contain_text('Required:')
    expect(form).to_contain_text('whole parent bundle, including reusable memory')
    expect(form).to_contain_text('Editable paths restrict changes, not reading.')
    expect(form.get_by_role('checkbox',name='Authorize bundle disclosure',exact=True)).not_to_be_checked()
    expect(form.get_by_label('Search editable paths',exact=True)).to_have_count(0)
    source=form.get_by_role('button',name='Source release details',exact=True)
    content=form.locator('[data-slot="disclosure-content"]')
    expect(content).to_be_hidden();source.focus();p.keyboard.press('Enter');expect(content).to_be_visible();expect(source).to_be_focused()
    expect(content).to_contain_text(w.original['version']['id']);expect(content).to_contain_text(w.original['version']['digest'])
    capture_layout(p,out,'source-details-expanded')
    p.keyboard.press('Enter');expect(content).to_be_hidden()
    hypothesis=form.get_by_label('Hypothesis',exact=True);hypothesis.fill('   ')
    consent=form.get_by_role('checkbox',name='Authorize bundle disclosure',exact=True)
    consent.check();form.get_by_role('checkbox',name='AGENTS.md',exact=True).check();expect(submit).to_be_disabled()
    hypothesis.fill('Keep the original operation identity.');expect(submit).to_be_enabled()
    consent.uncheck();expect(submit).to_be_disabled();consent.check()
    before_requests=len(w.provider.requests)
    back=p.get_by_role('link',name='Back to changes',exact=True);back.click()
    guard=p.get_by_role('alertdialog',name='Leave current edits?',exact=True);expect(guard).to_be_visible()
    capture_layout(p,out,'dirty-navigation-guard');p.keyboard.press('Escape');expect(guard).to_be_hidden()
    expect(hypothesis).to_have_value('Keep the original operation identity.');expect(consent).to_be_checked()
    assert len(w.provider.requests)==before_requests,'Editing/consent/navigation must not submit'
    back.click();guard.get_by_role('button',name='Leave editor',exact=True).click();expect(form).to_have_count(0)
    checks.append('Visible whole-bundle disclosure, initially unchecked consent, whitespace/path/consent gates, keyboard source collapse and dirty-navigation cancellation without requests')

    for width in [1440,1024,390,320]:
        p.set_viewport_size(dict(width=width,height=1000));visit(p,b,route)
        scope=form.locator('.suggestion-scope');long_box=scope.get_by_role('checkbox',name=LONG_PATH,exact=True)
        long_box.focus();p.keyboard.press('Space');expect(long_box).to_be_checked()
        geometry=form.locator('.suggestion-composer-grid').evaluate("e=>({width:e.closest('.proposal-page').clientWidth,columns:getComputedStyle(e).gridTemplateColumns.split(' ').length})")
        assert geometry['columns']==(2 if geometry['width']>=800 else 1),geometry
        assert p.evaluate('document.documentElement.scrollWidth<=innerWidth+1')
        assert scope.evaluate('e=>e.scrollWidth<=e.clientWidth+1')
        capture_layout(p,out,f'checked-long-path-{width}')
    checks.append('Long-path checkbox Space operation, wrapping and actual container-based split/stack at 1440/1024/390/320')

    p.set_viewport_size(dict(width=1440,height=1000))
    large_route=b.bundle_path('changes',bundle_id=w.large['bundle']['id'],proposal='new')
    visit(p,b,large_route)
    search=form.get_by_label('Search editable paths',exact=True)
    chosen='memory/context-17.md'
    form.get_by_role('checkbox',name=chosen,exact=True).check()
    form.get_by_role('checkbox',name='AGENTS.md',exact=True).check()
    search.fill('nothing-matches');expect(form.get_by_text('No matching paths.',exact=True)).to_be_visible()
    expect(form.locator('.suggestion-path-summary')).to_contain_text('2 selected outside search')
    expect(form.locator('.suggestion-path-list').get_by_role('checkbox')).to_have_count(0)
    capture_layout(p,out,'scope-no-matches-retained-selection')
    form.get_by_role('button',name='Clear search',exact=True).click();expect(search).to_be_focused()
    expect(form.get_by_role('checkbox',name=chosen,exact=True)).to_be_checked()
    expect(form.get_by_role('checkbox',name='AGENTS.md',exact=True)).to_be_checked()
    search.fill('context-17');expect(form.locator('.suggestion-path-list').get_by_role('checkbox')).to_have_count(1)
    expect(form.locator('.suggestion-path-summary')).to_contain_text('1 selected outside search')
    form.get_by_role('button',name='Clear search',exact=True).click()
    assert form.locator('.suggestion-path-list').evaluate('e=>e.scrollHeight>e.clientHeight && e.clientHeight<=322')
    capture_layout(p,out,'large-scope-checklist')
    # Constrain evidence width independently of viewport to verify the layout contract.
    host=p.locator('.proposal-page');host.evaluate("e=>e.style.width='430px'")
    p.wait_for_function("getComputedStyle(document.querySelector('.suggestion-composer-grid')).gridTemplateColumns.split(' ').length===1")
    assert form.evaluate('e=>e.scrollWidth<=e.clientWidth+1');capture_layout(p,out,'composer-embedded-430')
    host.evaluate("e=>e.style.width=''")
    hypothesis_text='Use the original receipt after a timeout.\nPreserve the operation key exactly.'
    evidence_text='A timed-out operation later returned a receipt.\nA fresh retry duplicated the effect.'
    form.get_by_label('Hypothesis',exact=True).fill(hypothesis_text)
    form.get_by_label('Authorized evidence (one item per line)',exact=True).fill(evidence_text)
    form.get_by_role('checkbox',name='Authorize bundle disclosure',exact=True).check()
    large_base=w.root+'/bundles/'+w.large['bundle']['id'];before=w.call('GET',large_base+'/channels/stable')
    capture_layout(p,out,'ready-request-1440')
    submit.click();p.wait_for_function("new URL(location.href).searchParams.get('proposal') && new URL(location.href).searchParams.get('proposal')!=='new'")
    proposal_id=parse_qs(urlsplit(p.url).query)['proposal'][0]
    expect(p.get_by_role('region',name='Saved change review',exact=True)).to_contain_text('Suggestion ready',timeout=20000)
    record=w.call('GET',large_base+'/proposals/'+proposal_id)
    assert record['status']=='succeeded' and record['candidate']
    prompt=json.loads(w.provider.requests[-1]['messages'][0]['content'])
    assert prompt['request']['allowedPaths']==[chosen,'AGENTS.md'],prompt['request']['allowedPaths']
    assert prompt['request']['hypothesis']==hypothesis_text
    assert prompt['request']['evidence']==evidence_text.split('\n')
    assert len(prompt['parent']['files'])==len(w.files)+24
    assert any(f['path']=='memory/team.md' for f in prompt['parent']['files'])
    assert w.call('GET',large_base+'/channels/stable')==before,'Suggestion must not publish'
    capture_layout(p,out,'actual-provider-candidate-handoff')
    checks.append('Large-list search preserves hidden selections and order; exact multiline request reaches localhost provider with whole parent bundle and creates a candidate without publication')

    visit(p,b,b.bundle_path('changes'))
    drafts=p.get_by_role('region',name='Saved drafts',exact=True)
    records=p.get_by_role('region',name='Suggestions',exact=True)
    draft_trigger=drafts.locator('.change-queue-trigger');record_trigger=records.locator('.change-queue-trigger')
    expect(draft_trigger).to_have_attribute('aria-expanded','false');expect(record_trigger).to_have_attribute('aria-expanded','false')
    draft_trigger.click();expect(draft_trigger).to_have_attribute('aria-expanded','true');expect(record_trigger).to_have_attribute('aria-expanded','false')
    record_trigger.click();expect(record_trigger).to_have_attribute('aria-expanded','true')
    draft_trigger.click();expect(draft_trigger).to_have_attribute('aria-expanded','false');expect(record_trigger).to_have_attribute('aria-expanded','true')
    checks.append('Saved drafts and Suggestions queues start collapsed and expand independently')
    for width in [1440,390,320]:
        p.set_viewport_size(dict(width=width,height=1000))
        records=p.get_by_role('region',name='Suggestions',exact=True)
        if records.locator('.change-queue-trigger').get_attribute('aria-expanded')!='true':records.locator('.change-queue-trigger').click()
        expect(records).to_contain_text('Ready to review')
        expect(records.locator('.change-record-row')).to_have_count(2)
        assert records.locator('.change-record-row').evaluate_all("rows=>rows.every(e=>getComputedStyle(e).gridTemplateColumns.split(' ').length===1)")
        assert records.locator('[data-slot=badge]').evaluate_all('items=>items.every(e=>e.scrollHeight<=e.clientHeight+1 && e.scrollWidth<=e.clientWidth+1)')
        assert records.locator('.change-record-copy').evaluate_all('items=>items.every(e=>e.scrollWidth<=e.clientWidth+1)')
        records.scroll_into_view_if_needed();capture_layout(p,out,f'entry-records-{width}')
    p.set_viewport_size(dict(width=1440,height=1000))
    checks.append('Suggestion entry records use independent full-width identity/date and status/detail rows with unclipped badges at desktop and narrow widths')
    for value in w.proposals:
        trigger=p.get_by_role('button',name='Suggestion details for '+value['id'],exact=True)
        trigger.hover();expect(p.get_by_role('tooltip')).to_contain_text(value['id'])
        trigger.focus();expect(p.get_by_role('tooltip')).to_contain_text(value['id']);p.keyboard.press('Escape')
        p.keyboard.press('Enter')
        dialog=p.get_by_role('dialog',name='Suggestion details · '+value['id'],exact=True)
        expect(dialog).to_be_visible();expect(p.get_by_role('tooltip')).to_be_hidden()
        expect(dialog).to_contain_text(value['id']);expect(dialog).to_contain_text(value['parentVersionId'])
        for _ in range(8):
            p.keyboard.press('Tab');assert dialog.evaluate('e=>e.contains(document.activeElement)')
        capture_layout(p,out,'record-dialog-'+value['status'])
        p.keyboard.press('Escape');expect(dialog).to_be_hidden();expect(trigger).to_be_focused()
    p.set_viewport_size(dict(width=320,height=900))
    trigger=p.get_by_role('button',name='Suggestion details for '+w.proposals[0]['id'],exact=True);trigger.click()
    dialog=p.get_by_role('dialog');assert dialog.evaluate('e=>e.scrollWidth<=e.clientWidth+1');capture_layout(p,out,'record-dialog-320')
    p.keyboard.press('Escape');expect(trigger).to_be_focused()
    checks.append('Record details have full unique identities, hover/focus tooltips, labelled dialogs, keyboard containment, Escape/focus return and narrow wrapping')

    # A failed background read must remain visible while its queue is closed.
    records=p.get_by_role('region',name='Suggestions',exact=True)
    records.locator('.change-queue-trigger').click()
    expect(records.locator('.change-queue-trigger')).to_have_attribute('aria-expanded','false')
    pattern='**'+improvement_server_function_path()+'*'
    p.route(pattern,lambda route:route.abort('failed'))
    try:
        expect(records.get_by_role('alert')).to_be_visible(timeout=15000)
        expect(records.locator('.change-queue-content')).to_be_hidden()
        capture_layout(p,out,'closed-suggestion-polling-error')
        records.locator('.change-queue-trigger').click()
        expect(records.locator('.change-record-row')).to_have_count(2)
        expect(records).to_contain_text('Ready to review')
        capture_layout(p,out,'retained-suggestions-during-outage')
    finally:p.unroute(pattern)
    expect(records.get_by_role('alert')).to_have_count(0,timeout=15000)
    expect(records.locator('.change-record-row')).to_have_count(2)
    checks.append('Closed suggestion queue surfaces background transport failure, preserves saved rows when opened and clears the error after polling recovers')

    visit(p,b,b.bundle_path('changes',proposal=w.proposals[1]['id']))
    result=p.get_by_role('region',name='Saved change review',exact=True)
    expect(result).to_contain_text('Suggestion failed');expect(result).to_contain_text('did not produce a candidate')
    expect(result.get_by_role('link',name='Start a new suggestion',exact=True)).to_be_visible()
    capture_layout(p,out,'failed-suggestion-next-step')
    w.sign_in('viewer','suggestion-layout-viewer')
    w.call('PUT',w.root+'/memberships/'+w.sessions['viewer']['userId'],dict(role='viewer'),actor='_browser-operator')
    context=b.browser.new_context(ignore_https_errors=True,viewport=dict(width=1440,height=1000))
    try:
        b.sign_in(context,'suggestion-layout-viewer');vp=context.new_page();vp.on('pageerror',lambda error:b.errors.append(str(error)))
        visit(vp,b,route);expect(vp.get_by_text('You have read-only access. Open an existing suggestion to inspect it.',exact=True)).to_be_visible()
        expect(vp.locator('.proposal-workspace')).to_have_count(0)
        visit(vp,b,b.bundle_path('changes',proposal=w.proposals[1]['id']))
        expect(vp.get_by_role('region',name='Saved change review',exact=True)).to_contain_text('Suggestion failed')
        expect(vp.get_by_role('link',name='Start a new suggestion',exact=True)).to_have_count(0)
        capture_layout(vp,out,'read-only-suggestion-result')
    finally:context.close()
    checks.append('Actual provider rejection has no candidate and an honest next step; read-only users inspect existing results but cannot start a request')
