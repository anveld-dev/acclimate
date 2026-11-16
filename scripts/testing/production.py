"""Private test configuration for the real production service (no authentication bypass).

The CLI accepts its arguments as JSON on stdin so callers never put credentials in
command-line arguments. It never reads dotenv, user configuration or a database URL.
"""
import json
import os
import sys


def service_env(*, database_url, bind, tokens, login_token, console_token,
                project='product-gate', issuer='https://identity.example.invalid', base_env=None):
    env = {k: v for k, v in (os.environ if base_env is None else base_env).items()
           if not k.startswith(('ACCLIMATE_', 'CONSOLE_')) and k not in
           ('DATABASE_URL', 'EVALUATION_TEST_DATABASE_URL', 'ACCLIMATE_TEST_DATABASE_URL')}
    grants = [dict(token=token, principalId=principal,
                   projectId='other-' + project if principal == 'outsider' else project,
                   rights=['read'] if principal in ('viewer', 'outsider') else
                   ['read', 'write'] if principal in ('evaluator', 'other') else
                   ['read', 'write', 'propose', 'promote'])
              for principal, token in tokens.items()
              if principal not in ('login-authority', 'console-transport')]
    env.update(DATABASE_URL=database_url, ACCLIMATE_BIND=bind,
               ACCLIMATE_AUTH=json.dumps(grants), ACCLIMATE_LOGIN_TOKEN=login_token,
               ACCLIMATE_CONSOLE_TOKEN=console_token, ACCLIMATE_OIDC_ISSUER=issuer,
               ACCLIMATE_OPERATORS=json.dumps([dict(issuer=issuer, subject='operator')]))
    return env


if __name__ == '__main__':
    print(json.dumps(service_env(**json.load(sys.stdin))))
