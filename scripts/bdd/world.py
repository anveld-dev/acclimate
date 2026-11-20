"""Disposable real-service fixture shared by executable behavior scenarios."""
import json
import secrets
import uuid
from pathlib import Path
from scripts.productization.qualify import Harness, ROOT, payload


class World:
    def __init__(self, pg_bin):
        self.h = Harness(pg_bin)
        self.actor="operator"
        self.sessions={}
        self._base_env=dict(self.h.env)
        self._tokens=dict(self.h.tokens, viewer=secrets.token_hex(32))

    def start(self):
        self.h.start()

    def fresh_scenario(self, scenario):
        self.close_scenario()
        for key in list(vars(self)):
            if key not in {"h","_base_env","_tokens","dev_console"}: delattr(self,key)
        self.h.env=dict(self._base_env)
        self.h.tokens=dict(self._tokens)
        self.actor="operator"
        self.sessions={}
        self.h.project = 'bdd-' + uuid.uuid4().hex
        self.h.env['ACCLIMATE_AUTH'] = json.dumps([
            dict(token=token, principalId=principal,
                 workspaceId='outside-' + self.h.project if principal == 'outsider' else self.h.project,
                 rights=['read'] if principal in ('viewer', 'outsider') else ['read', 'write'] if principal in ('evaluator','other') else ['read', 'write', 'propose', 'promote'])
            for principal, token in self.h.tokens.items()
        ])
        if 'provider_fixture' in scenario.effective_tags:
            from scripts.bdd.provider import ProviderFixture
            self.provider = ProviderFixture()
            self.h.env.update(ACCLIMATE_MODEL_ENDPOINT=self.provider.url,ACCLIMATE_MODEL_TOKEN='fixture-only',ACCLIMATE_MODEL='gpt-6-luna')
        if 'learning' in scenario.effective_tags:
            self.h.env['ACCLIMATE_LEARNING_MAX_STEPS_BETWEEN_AUDITS'] = '1'
        self.h.restart()
        self.root = '/v1/workspaces/' + self.h.project
        if 'hosted' in scenario.effective_tags: self.hosted()

    def close_scenario(self):
        for name in ['browser_fixture','provider','mailpit']:
            resource=getattr(self,name,None)
            if resource:
                resource.close()
                setattr(self,name,None)

    def close(self):
        self.close_scenario()
        self.h.close()

    def publish_initial(self, text, origin='created', files=None):
        self.setup = self.call('POST', self.root + '/bundle-setups', dict(
            name='BDD bundle', origin=origin, channel='stable',
            payload=dict(schemaVersion=1, files=files) if files is not None else payload(text),
            reason='Explicit behavior-test initial release.'
        ))
        self.bundle = self.root + '/bundles/' + self.setup['bundle']['id']
        self.channel = self.bundle + '/channels/stable'
        self.original = self.setup['resolution']

    def save_new(self, text):
        self.last_key = uuid.uuid4().hex
        self.last_path = self.channel + '/drafts'
        self.last_body = dict(baseVersionId=self.original['version']['id'], baseRevision=self.original['revision'], payload=payload(text))
        self.draft = self.call('POST', self.last_path, self.last_body, key=self.last_key)
        self.draft_path = self.channel + '/drafts/' + self.draft['id']
        self.saved = dict(self.draft)

    def draft_text(self, draft=None):
        version = (draft or self.draft)['snapshotVersion']['id']
        return self.call('GET', self.bundle + '/versions/' + version + '/payload')['files'][0]['text']

    def call(self, method, path, body=None, **options):
        from scripts.bdd.client import request
        return request(self, method, path, body, **options)

    def save_again(self, text):
        self.previous = dict(self.draft)
        self.last_key = uuid.uuid4().hex
        self.last_path = self.draft_path + '/save'
        self.last_body = dict(expectedGeneration=self.draft['generation'], payload=payload(text))
        self.draft = self.call('POST', self.last_path, self.last_body, key=self.last_key)
        self.saved = dict(self.draft)

    def manual_release(self, version=None, reason='Explicit manual test release.'):
        current = self.call('GET', self.channel)
        return self.call('POST', self.channel + '/releases', dict(
            versionId=(version or self.draft['snapshotVersion'])['id'],
            expectedRevision=current['revision'], unevaluatedReason=reason))

    def invalid_payload(self, invalid):
        value = payload('Rejected fixture.')
        if invalid == 'path traversal':
            value['files'][0]['path'] = '../escape.md'
        elif invalid == 'colliding paths':
            value['files'].append(dict(path='agents.md', kind='instruction', text='Collision.'))
        elif invalid == 'unsupported schema':
            value['schemaVersion'] = 99
        elif invalid == 'no entries':
            value['files'] = []
        elif invalid == 'an oversized entry':
            value['files'][0]['text'] = 'x' * (256 * 1024 + 1)
        else:
            raise AssertionError('Unknown invalid fixture: ' + invalid)
        return value

    def request_evaluation(self):
        self.settings = dict(
            parentVersionId=self.original['version']['id'], parentDigest=self.original['version']['digest'],
            candidateVersionId=self.draft['snapshotVersion']['id'], candidateDigest=self.draft['snapshotVersion']['digest'],
            datasetRevision='bdd-reviews-v1', runtime={'executor': 'fixture', 'model': 'none'},
            graderRevision='contains-retries-v1', expectedCases=[dict(caseId='retry-review', repetition=n) for n in range(2)])
        self.evaluation = self.call('POST', self.bundle + '/evaluation-requests', dict(**self.settings, requireBoundEvidence=True))
        self.evaluation_path = self.bundle + '/evaluation-requests/' + self.evaluation['id']
        self.attempt = 'fixture-attempt'

    def start_attempt(self):
        self.started = self.call('POST', self.evaluation_path + '/start', dict(attemptId=self.attempt), actor='evaluator')

    def comparison(self, outcome='complete', changed=None, expected=None, results=None):
        import copy
        report = copy.deepcopy(self.settings)
        report['evaluation'] = dict(requestId=self.evaluation['id'], attemptId=self.attempt)
        if changed == 'dataset': report['datasetRevision'] = 'different-dataset'
        elif changed == 'runtime': report['runtime']['executor'] = 'different-executor'
        elif changed == 'grader': report['graderRevision'] = 'different-grader'
        if results is None:
            good = dict(executionStatus='completed', gradingStatus='scored', reward=1, usage={'costUsd': 0})
            if outcome == 'without usage': good.pop('usage')
            results = [] if outcome == 'missing grades' else [
                dict(**case, parent=copy.deepcopy(good), candidate=copy.deepcopy(good))
                for case in report['expectedCases']
            ]
        report['results'] = results
        if changed == 'case inventory':
            # The original result rows are still valid for this larger declaration.
            report['expectedCases'].append(dict(caseId='unrequested-case', repetition=0))
        elif changed == 'result case':
            report['results'][0]['caseId'] = 'unrequested-case'
        self.report = self.call('POST', self.bundle + '/comparisons', report, actor='evaluator', expected=expected)

    def finish(self, actor='evaluator', expected=None):
        return self.call('POST', self.evaluation_path + '/finish', dict(attemptId=self.attempt, comparisonId=self.report['id']), actor=actor, expected=expected)

    def publish_evidence(self, expected=None):
        current = self.call('GET', self.channel)
        return self.call('POST', self.draft_path + '/publish', dict(expectedGeneration=self.draft['generation'], expectedRevision=current['revision'], comparisonId=self.report['id']), expected=expected)

    def sdk(self, action, actor="operator", **options):
        import subprocess
        if not hasattr(self,'sdk_directory'):
            self.sdk_directory=self.h.dir / ('sdk-' + uuid.uuid4().hex)
            self.sdk_directory.mkdir(mode=0o700)
        target=self.sdk_directory
        config = dict(action=action, baseUrl=self.h.base, token=self.h.tokens[actor], scope='bdd-'+actor,
                      workspaceId=self.h.project, bundleId=getattr(self, 'setup', {}).get('bundle', {}).get('id'), directory=str(target), **options)
        if action in ('delivery', 'editJob', 'collision', 'cleanup', 'native', 'pythonDelivery') and hasattr(self, 'integration'):
            config.setdefault('connectionId', self.integration['id'])
        path = target / 'config.json'
        path.write_text(json.dumps(config))
        path.chmod(0o600)
        import sys
        env=dict(self.h.env)
        if action.startswith('python'):
            env['PYTHONPATH']=str(ROOT/'python')
            command=[sys.executable,str(ROOT/'scripts/bdd/python_consumer.py'),str(path)]
        elif action.startswith('identity'):
            command=['node','--import','tsx',str(ROOT/'scripts/bdd/identity_consumer.mjs'),str(path)]
        else:
            command=['node',str(ROOT/'scripts/bdd/sdk_consumer.mjs'),str(path)]
        process = subprocess.run(command, cwd=ROOT, env=env, capture_output=True, text=True)
        assert process.returncode == 0, 'SDK fixture failed: ' + process.stderr[-2000:]
        return json.loads(process.stdout.strip().splitlines()[-1])

    def create_integration(self):
        self.integration = self.call('POST', self.root + '/connections', dict(displayName='BDD application', bundleId=self.setup['bundle']['id'], channel='stable'))
        self.integration_path = self.root + '/connections/' + self.integration['id']

    def issue(self, kind, key=None):
        self.credential = self.call('POST', self.integration_path + '/credentials', dict(kind=kind), key=key)
        name = 'content-reader' if kind == 'content-read' else 'receipt-writer'
        self.h.tokens[name] = self.credential['secret']
        if kind == 'content-read': self.read_credential = dict(self.credential)
        else: self.write_credential = dict(self.credential)

    def delivery_event(self):
        from datetime import datetime, timezone
        return dict(eventId=str(uuid.uuid4()), connectionId=self.integration['id'], workspaceId=self.h.project,
                    bundleId=self.setup['bundle']['id'], versionId=self.original['version']['id'], digest=self.original['version']['digest'],
                    stage='verified', source='cache', occurredAt=datetime.now(timezone.utc).isoformat())

    def hosted(self):
        # Compatibility name retained for the existing acceptance vocabulary.
        # Every scenario uses production authentication; browser scenarios add TLS/OIDC.
        self.h.identity()
        self.login_token, self.console_token, self.issuer = self.h.login_token, self.h.console_token, self.h.issuer
        self.h.tokens['login-authority'] = self.login_token
        self.h.tokens['console-transport'] = self.console_token

    def enable_email(self):
        if getattr(self, "mailpit", None): return
        from scripts.testing.mail import MailpitFixture
        self.mailpit = MailpitFixture(self.h.dir)
        self.h.env.update(ACCLIMATE_SMTP_HOST="127.0.0.1", ACCLIMATE_SMTP_PORT=str(self.mailpit.smtp_port), ACCLIMATE_SMTP_TLS="none", ACCLIMATE_SMTP_FROM="Acclimate <noreply@acclimate.local>", ACCLIMATE_CONSOLE_ORIGIN="https://console.fixture.invalid")
        self.h.restart()

    def sign_in(self, actor, subject):
        if not hasattr(self, 'issuer'):
            self.hosted()
        self.sessions[actor] = self.call('POST', '/v1/auth/sessions', dict(issuer=self.issuer,subject=subject), actor='login-authority')
        if not hasattr(self, 'subjects'): self.subjects = {}
        self.subjects[actor] = subject

    def personal_projects(self, actor):
        """Read the complete current membership list, including later cursor pages."""
        from urllib.parse import urlencode
        projects, cursor, seen = [], None, set()
        while True:
            route = '/v1/workspaces?' + urlencode(dict(limit=100, **({'cursor': cursor} if cursor else {})))
            page = self.call('GET', route, actor=actor)
            projects.extend(page['items'])
            cursor = page.get('nextCursor')
            if not cursor:
                return projects
            assert cursor not in seen, 'Workspace membership pagination repeated a cursor'
            seen.add(cursor)

    def prepare_browser_identity(self):
        self.hosted()
        actor = getattr(self, 'browser_actor', 'admin' if 'admin' in self.sessions else 'operator')
        subject = getattr(self, 'subjects', {}).get(actor, actor)
        if subject == 'operator':
            # Machine grants register projects but never confer browser membership.
            # Adopt through the same audited operator authority as production.
            self.sign_in('_browser-operator', 'operator')
            projects = self.personal_projects('_browser-operator')
            if not any(project['id'] == self.h.project for project in projects):
                self.call('POST', '/v1/auth/workspace-adoptions', dict(workspaceId=self.h.project,
                    reason='Explicit adoption of disposable acceptance-test workspace.'), actor='_browser-operator')
        return subject

    def create_workspace(self):
        project = 'people-' + uuid.uuid4().hex
        self.new_project = self.call('POST', '/v1/workspaces', dict(id=project,name='People workspace '+project), actor='admin')
        self.h.project = project
        self.root = '/v1/workspaces/' + project
        self.actor = 'admin'

    def browser(self):
        if not getattr(self, 'browser_fixture', None):
            from scripts.bdd.browser import BrowserFixture
            self.browser_fixture = BrowserFixture(self)
        return self.browser_fixture
