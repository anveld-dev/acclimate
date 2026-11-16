#!/usr/bin/env python3
"""Real PostgreSQL + Rust + SMTP checks, isolated from the developer database/inbox."""
import argparse
import json
import os
from pathlib import Path
import secrets
import subprocess
import sys
import tempfile
import time
from urllib.error import HTTPError
from urllib.request import Request, urlopen

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT))
from scripts.mailpit import binary
from scripts.productization.qualify import Harness, port


def qualify(pg_bin):
    h = Harness(pg_bin)
    mail = None
    checks = []
    with tempfile.TemporaryDirectory(prefix='acclimate-mail-test-') as directory:
        directory = Path(directory)
        smtp, ui = port(), port()
        log = (directory / 'mailpit.log').open('w')
        try:
            mail = subprocess.Popen([str(binary()), '--smtp', f'127.0.0.1:{smtp}', '--listen', f'127.0.0.1:{ui}', '--database', str(directory / 'messages.db'), '--disable-version-check', '--quiet'], env={key:value for key,value in os.environ.items() if not key.startswith('MP_')}, stdout=log, stderr=log)
            for _ in range(100):
                try:
                    if urlopen(f'http://127.0.0.1:{ui}/livez', timeout=1).status == 200: break
                except OSError: time.sleep(.1)
            else: raise RuntimeError('Disposable Mailpit not ready')
            h.env.update(ACCLIMATE_SMTP_HOST='127.0.0.1', ACCLIMATE_SMTP_PORT=str(smtp), ACCLIMATE_SMTP_TLS='none', ACCLIMATE_SMTP_FROM='Acclimate <noreply@acclimate.local>', ACCLIMATE_CONSOLE_ORIGIN='https://console.fixture.invalid')
            h.start()
            sessions = {}
            def call(method, path, body=None, actor='admin', status=200):
                headers={'Content-Type':'application/json','Authorization':'Bearer '+(h.login_token if actor=='login' else h.console_token)}
                if actor in sessions: headers['X-Acclimate-Session']=sessions[actor]['secret']
                try:
                    response=urlopen(Request(h.base+path, data=json.dumps(body).encode() if body is not None else None, method=method, headers=headers), timeout=20)
                except HTTPError as error: response=error
                raw=response.read()
                value=json.loads(raw) if raw else None
                assert response.status==status, f'{method} {path}: {response.status}, expected {status}; code={(value or {}).get("error",{}).get("code")}'
                return value
            def login(actor, email, verified=True):
                sessions[actor]=call('POST','/v1/auth/sessions', dict(issuer=h.issuer,subject='operator' if actor=='admin' else actor,email=email,emailVerified=verified),actor='login')
            login('admin','owner@example.test')
            project='mail-invitations'
            call('POST','/v1/projects',dict(id=project,name='Email test'))
            base=f'/v1/projects/{project}/invitations'
            def invite(email, role='editor'):
                return call('POST',base,dict(email=email,role=role))
            first=invite(' Alice@Example.test ')
            assert first['email']=='alice@example.test'
            assert invite('alice@example.test')['id']==first['id']
            call('POST',base,dict(email='alice@example.test',role='admin'),status=409)
            assert h.sql('SELECT count(*) FROM workspace_invitations')=='1'
            checks.append('Creating an invite normalizes email; repeated submission does not duplicate it')
            deadline=time.monotonic()+20
            while time.monotonic()<deadline:
                messages=json.load(urlopen(f'http://127.0.0.1:{ui}/api/v1/messages'))['messages']
                if messages: break
                time.sleep(.2)
            else: raise AssertionError('SMTP message was not captured')
            message=json.load(urlopen(f'http://127.0.0.1:{ui}/api/v1/message/'+messages[0]['ID']))
            assert f'https://console.fixture.invalid/invitations/{first["id"]}' in message['Text']
            assert message['To'][0]['Address']=='alice@example.test'
            assert '<!doctype html>' in message['HTML'].lower()
            assert f'https://console.fixture.invalid/invitations/{first["id"]}' in message['HTML']
            assert 'Editor access' in message['HTML'] and 'Join workspace' in message['HTML']
            assert 'multipart/alternative' in urlopen(f'http://127.0.0.1:{ui}/api/v1/message/'+messages[0]['ID']+'/raw').read().decode()
            checks.append('Rust SMTP sends the configured sender, recipient and HTTPS invitation link to Mailpit')
            path='/v1/invitations/'+first['id']
            login('wrong','other@example.test')
            call('GET',path,actor='wrong',status=404)
            call('POST',path+'/accept',actor='wrong',status=404)
            login('alice','alice@example.test',False)
            call('POST',path+'/accept',actor='alice',status=403)
            assert h.sql(f"SELECT count(*) FROM project_memberships WHERE project_id='{project}'")=='1'
            checks.append('Wrong email and an unverified email cannot join, even with the invitation URL')
            login('alice','alice@example.test')
            assert call('GET',path,actor='alice')['status']=='pending'
            assert h.sql(f"SELECT count(*) FROM project_memberships WHERE project_id='{project}'")=='1'
            assert call('POST',path+'/accept',actor='alice')['projectId']==project
            call('POST',path+'/accept',actor='alice')
            assert h.sql(f"SELECT role FROM project_memberships WHERE project_id='{project}' AND user_id='{sessions['alice']['userId']}'")=='editor'
            call('GET',base,actor='alice',status=403)
            call('POST',base,dict(email='blocked@example.test',role='viewer'),actor='alice',status=403)
            checks.append('Only explicit acceptance joins; acceptance is idempotent and grants exactly the invited role')
            revoked=invite('revoked@example.test')
            login('revoked','revoked@example.test')
            call('DELETE',base+'/'+revoked['id'],status=204)
            call('POST','/v1/invitations/'+revoked['id']+'/accept',actor='revoked',status=410)
            expired=invite('expired@example.test')
            login('expired','expired@example.test')
            h.sql(f"UPDATE workspace_invitations SET expires_at=now()-interval '1 second' WHERE id='{expired['id']}'")
            call('POST','/v1/invitations/'+expired['id']+'/accept',actor='expired',status=410)
            checks.append('Revoked and expired invitations cannot grant membership')
            existing=invite('existing@example.test','viewer')
            login('existing','existing@example.test')
            h.sql(f"INSERT INTO project_memberships(project_id,user_id,role) VALUES('{project}','{sessions['existing']['userId']}','admin')")
            call('POST','/v1/invitations/'+existing['id']+'/accept',actor='existing')
            assert h.sql(f"SELECT role FROM project_memberships WHERE project_id='{project}' AND user_id='{sessions['existing']['userId']}'")=='admin'
            checks.append('An older invitation cannot downgrade an existing member')
            pending=invite('recovery@example.test')
            h.stop_service()
            h.sql(f"UPDATE workspace_invitations SET delivery_status='sending',attempts=5 WHERE id='{pending['id']}'")
            h.restart()
            listed=call('GET',base)['items']
            assert next(v for v in listed if v['id']==pending['id'])['deliveryStatus']=='failed'
            h.sql(f"UPDATE workspace_invitations SET next_attempt_at=now()-interval '2 minutes' WHERE id='{pending['id']}'")
            call('POST',base+'/'+pending['id']+'/resend')
            call('POST',base+'/'+pending['id']+'/resend',status=409)
            checks.append('Attempt-limited interrupted delivery survives restart; explicit resend is throttled')
            h.stop_service()
            for key in ['ACCLIMATE_SMTP_HOST','ACCLIMATE_SMTP_PORT','ACCLIMATE_SMTP_TLS','ACCLIMATE_SMTP_FROM','ACCLIMATE_CONSOLE_ORIGIN']: h.env.pop(key)
            h.restart()
            assert call('GET',base)['available'] is False
            call('POST',base,dict(email='unavailable@example.test',role='viewer'),status=503)
            checks.append('Missing SMTP disables invitations instead of claiming mail was sent')
            return dict(ok=True,checks=checks,modelsCalled=False)
        finally:
            h.close()
            if mail:
                mail.terminate()
                mail.wait(timeout=10)
            log.close()


if __name__=='__main__':
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--pg-bin',type=Path,required=True)
    parser.add_argument('--report',type=Path,required=True)
    args=parser.parse_args()
    if args.report.exists(): raise SystemExit('Use a fresh report path')
    result=qualify(args.pg_bin)
    args.report.parent.mkdir(parents=True,exist_ok=True)
    args.report.write_text(json.dumps(result,indent=2)+'\n')
    print(f'{len(result["checks"])} email invitation checks passed; disposable PostgreSQL and SMTP, no models.')
