#!/usr/bin/env python3
"""Configure an existing local Keycloak realm to capture mail in Mailpit.

This never imports or resets a realm. Supply KC_ADMIN_PASSWORD through a private
environment; neither it nor the short-lived admin token is written to output.
"""
import argparse
import json
import os
from urllib.parse import urlencode, urlsplit
from urllib.request import Request, urlopen


def mail_settings(smtp_host):
    return dict(smtpServer=dict(host=smtp_host, port='1025', **{'from': 'noreply@acclimate.local'},
        fromDisplayName='Acclimate', ssl='false', starttls='false', auth='false'),
        registrationAllowed=True, registrationEmailAsUsername=True, verifyEmail=True, resetPasswordAllowed=True)


def configure(server, realm, username, password, smtp_host='127.0.0.1'):
    parsed = urlsplit(server)
    if parsed.scheme != 'http' or parsed.hostname not in ('localhost', '127.0.0.1') or parsed.path not in ('', '/'):
        raise RuntimeError('This helper only configures a loopback Keycloak admin endpoint')
    if realm != 'acclimate' or smtp_host not in ('127.0.0.1', 'mailpit'):
        raise RuntimeError('Expected the local acclimate realm and Mailpit host')
    body = urlencode(dict(client_id='admin-cli', grant_type='password', username=username, password=password)).encode()
    with urlopen(Request(server + '/realms/master/protocol/openid-connect/token', data=body), timeout=15) as response:
        token = json.load(response)['access_token']
    headers = {'Authorization': 'Bearer ' + token, 'Content-Type': 'application/json'}
    url = server + '/admin/realms/' + realm
    settings = mail_settings(smtp_host)
    with urlopen(Request(url, data=json.dumps(settings).encode(), method='PUT', headers=headers), timeout=15) as response:
        assert response.status == 204
    with urlopen(Request(url, headers=headers), timeout=15) as response:
        value = json.load(response)
        assert all(value[key] == expected for key, expected in settings.items())
    return headers


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--server', default='http://127.0.0.1:8180')
    parser.add_argument('--realm', default='acclimate')
    parser.add_argument('--smtp-host', default='127.0.0.1', choices=['127.0.0.1', 'mailpit'])
    args = parser.parse_args()
    configure(args.server, args.realm, os.environ.get('KC_ADMIN_USERNAME', 'bootstrap-admin'), os.environ['KC_ADMIN_PASSWORD'], args.smtp_host)
    print('Local Keycloak configured: Mailpit SMTP, registration, verified email and password reset.')


if __name__ == '__main__':
    try:
        main()
    except Exception:
        raise SystemExit('Could not configure local Keycloak mail. Check the private admin settings; no credentials were logged.') from None
