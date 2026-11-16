"""Browser invitation and new-user verification, called by the disposable Keycloak gate."""
import html
import json
import re
import secrets
import time
import uuid
from urllib.parse import urlsplit
from urllib.request import urlopen


def check_email_layout(browser, message, action, label, output):
    from playwright.sync_api import expect
    output.mkdir(parents=True,exist_ok=True)
    assert message['Text'].strip() and message['HTML'].strip()
    for width in (600,320):
        context=browser.new_context(viewport=dict(width=width,height=900))
        try:
            page=context.new_page()
            page.route('**/*',lambda route:route.abort())
            page.set_content(message['HTML'])
            expect(page.get_by_role('heading',level=1)).to_be_visible()
            button=page.get_by_role('link',name=re.compile('^'+re.escape(action)))
            expect(button).to_be_visible()
            assert page.evaluate('document.documentElement.scrollWidth <= innerWidth'), f'{label} overflows at {width}px'
            assert button.evaluate('(el)=>parseFloat(getComputedStyle(el).fontSize)')>=15
            assert button.get_attribute('href').startswith('https://')
            assert page.locator('img,script').count()==0
            page.screenshot(path=str(output/f'{label}-{width}.png'),full_page=True)
        finally:context.close()


def check_email_join(*, browser, admin_context, console_origin, issuer, project, inbox, api, admin_secret, record, output):
    from playwright.sync_api import expect
    recipient='invite-'+uuid.uuid4().hex+'@example.test'
    admin=admin_context.new_page()
    guest=browser.new_context(ignore_https_errors=True)
    phase='invite form'
    page=None
    try:
        admin.goto(console_origin+f'/w/{project}/settings/members')
        trigger=admin.get_by_role('button',name='Invite member',exact=True)
        expect(trigger).to_be_enabled(timeout=15000)
        trigger.click()
        dialog=admin.get_by_role('dialog')
        expect(dialog.get_by_label('Email',exact=True)).to_be_focused()
        dialog.get_by_label('Email',exact=True).fill(recipient)
        dialog.get_by_label('Workspace role').select_option('editor')
        dialog.get_by_role('button',name='Send invite',exact=True).click()
        expect(dialog).not_to_be_visible(timeout=15000)
        expect(trigger).to_be_focused()
        pending_row=admin.get_by_role('row').filter(has=admin.get_by_role('cell',name=recipient,exact=True))
        expect(pending_row.get_by_role('cell',name='Sent',exact=True)).to_be_visible(timeout=12000)
        expect(trigger).to_be_focused()
        record('Invitation delivery changes to Sent automatically while Invite member keeps keyboard focus')

        def message_matching(predicate):
            deadline=time.monotonic()+30
            while time.monotonic()<deadline:
                messages=json.load(urlopen(inbox+'/api/v1/messages'))['messages']
                for message in messages:
                    if any(person['Address']==recipient for person in message['To']):
                        value=json.load(urlopen(inbox+'/api/v1/message/'+message['ID']))
                        if predicate(value): return value
                time.sleep(.2)
            raise AssertionError('Expected email was not captured')

        invitation=message_matching(lambda message: '/invitations/' in message['Text'])
        link=re.search(re.escape(console_origin)+r'/invitations/[a-f0-9-]+',invitation['Text']).group()
        invite_id=link.rsplit('/',1)[-1]
        assert '<!doctype html>' in invitation['HTML'].lower()
        assert 'Join workspace' in invitation['HTML'] and 'Editor access' in invitation['HTML']
        check_email_layout(browser, invitation, 'Join workspace', 'invitation', output)
        record('Members sends a branded HTML invitation with a complete plain-text fallback')
        trigger.click()
        draft_email='unfinished-invitation@example.test'
        dialog.get_by_label('Email',exact=True).fill(draft_email)
        dialog.get_by_label('Workspace role').select_option('viewer')
        admin_navigations=[]
        admin.on('framenavigated',lambda frame: admin_navigations.append(True) if frame==admin.main_frame else None)
        page=guest.new_page()
        runtime_errors=[]
        page.on('pageerror', lambda error: runtime_errors.append(type(error).__name__))
        phase='open invitation'
        page.goto(link)
        expect(page.locator('input[name="password"]')).to_be_visible()
        phase='open registration'
        page.get_by_role('link',name='Register',exact=True).click()
        phase='fill registration'
        page.locator('input[name="email"]').fill(recipient)
        page.locator('input[name="firstName"]').fill('Invited')
        page.locator('input[name="lastName"]').fill('Teammate')
        phase='submit registration'
        page.locator('input[type="submit"], button[type="submit"]').click()
        expect(page.get_by_text('Email verification',exact=False).first).to_be_visible(timeout=15000)
        assert not any(cookie['name']=='acclimate_session' for cookie in guest.cookies(console_origin))
        record('Keycloak registration requires inbox verification before issuing an application session')
        verification=message_matching(lambda message: 'login-actions' in message['Text'])
        assert 'Verify email' in verification['HTML'] and 'Your Acclimate account' in verification['HTML']
        assert 'background:#272b30' in verification['HTML']
        check_email_layout(browser, verification, 'Verify email', 'verification', output)
        record('Keycloak verification uses the packaged email theme and its native signed link')
        urls=re.findall(r'https?://[^\s<>]+',verification['Text'])
        verification_link=next(html.unescape(url.rstrip('.,')) for url in urls if url.startswith(issuer+'/login-actions/'))
        phase='follow verification'
        page.goto(verification_link)
        # Keycloak 26.8 verifies email before allowing a new user to set a password.
        phase='set password after email verification'
        expect(page.locator('input[name="password-new"]')).to_be_visible(timeout=15000)
        password=secrets.token_urlsafe(32)
        page.locator('input[name="password-new"]').fill(password)
        page.locator('input[name="password-confirm"]').fill(password)
        page.locator('input[type="submit"], button[type="submit"]').click()
        # Keycloak may show its completion page before returning to the saved OIDC flow.
        if urlsplit(page.url).netloc!=urlsplit(console_origin).netloc:
            back=page.get_by_role('link',name=re.compile('Back to Application',re.I))
            if back.count(): back.click()
        phase='return to invitation'
        expect(page.get_by_role('button',name='Join workspace',exact=True)).to_be_visible(timeout=30000)
        assert '/invitations/'+invite_id in page.url
        secret=next(cookie['value'] for cookie in guest.cookies(console_origin) if cookie['name']=='acclimate_session')
        before=api(guest,secret,'GET',f'/v1/projects/{project}/bundles')
        assert before.status==403
        page.wait_for_load_state('networkidle')
        assert not runtime_errors, 'Invitation page had a browser runtime error'
        phase='accept invitation'
        page.get_by_role('button',name='Join workspace',exact=True).click()
        page.wait_for_url(console_origin+f'/w/{project}/bundles',timeout=15000)
        assert api(guest,secret,'GET',f'/v1/projects/{project}/bundles').status==200
        person=api(guest,secret,'GET','/v1/auth/session').json()
        members=api(admin_context,admin_secret,'GET',f'/v1/projects/{project}/memberships').json()['items']
        assert next(member for member in members if member['id']==person['userId'])['role']=='editor'
        record('Verified signup returns to the invitation; explicit Join grants editor membership in PostgreSQL')
        listed=api(admin_context,admin_secret,'GET',f'/v1/projects/{project}/invitations').json()['items']
        assert not any(value['id']==invite_id for value in listed)
        admin.bring_to_front()
        expect(dialog.get_by_label('Email',exact=True)).to_have_value(draft_email)
        expect(dialog.get_by_label('Workspace role')).to_have_value('viewer')
        dialog.get_by_role('button',name='Cancel',exact=True).click()
        expect(trigger).to_be_focused()
        joined_row=admin.get_by_role('row').filter(has=admin.get_by_text('Invited Teammate',exact=True))
        expect(joined_row.get_by_role('button',name='Role for Invited Teammate: Editor',exact=True)).to_be_visible(timeout=12000)
        expect(pending_row).to_have_count(0)
        expect(trigger).to_be_focused()
        assert not admin_navigations
        record('Members preserves an open invitation form, then updates the joined member and removes the pending invite without reload')
        # Exercise the password-reset email too; do not change a user's password.
        recovery=browser.new_context(ignore_https_errors=True)
        try:
            recovery_page=recovery.new_page()
            recovery_page.goto(console_origin+'/auth/login')
            recovery_page.get_by_role('link',name='Forgot Password?',exact=True).click()
            recovery_page.locator('input[name="username"]').fill(recipient)
            recovery_page.locator('input[type="submit"], button[type="submit"]').click()
            reset=message_matching(lambda message: 'Reset password' in message.get('HTML','') and 'login-actions' in message['Text'])
            assert 'Your Acclimate account' in reset['HTML'] and 'background:#272b30' in reset['HTML']
            check_email_layout(browser, reset, 'Reset password', 'password-reset', output)
            record('Keycloak password reset delivers a matching branded email with a text fallback')
        finally: recovery.close()
    except Exception:
        diagnostic=dict(phase=phase)
        if page:
            diagnostic.update(path=urlsplit(page.url).path, headings=page.locator('h1,h2').all_text_contents(), inputs=page.locator('input').evaluate_all('(els)=>els.map(el=>el.name)'), buttons=page.get_by_role('button').all_text_contents(), alerts=page.locator('[role=alert]').all_text_contents())
        print('Email-flow diagnostic (no tokens or passwords): '+json.dumps(diagnostic),flush=True)
        raise
    finally:
        admin.close()
        guest.close()
