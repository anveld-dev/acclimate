#!/usr/bin/env python3
"""Add real API-backed example records; never execute a model or change user data."""
import argparse
import copy
import hashlib
import http.cookiejar
from html.parser import HTMLParser
import json
from pathlib import Path
import ssl
import sys
from urllib.error import HTTPError
from urllib.parse import urlencode, urljoin, urlsplit
from urllib.request import Request, build_opener, HTTPCookieProcessor, HTTPSHandler, urlopen

ROOT = Path(__file__).resolve().parents[2]
PROJECT = 'acclimate-examples'
NAME = 'Example workspace'
SOURCE = 'Acclimate example workspace v1'
RUNTIME = dict(source='simulated-example', executor='example-seed', model='none', configId='example-seed', configRevision='1')
CASES = ['ambiguous-timeout', 'already-succeeded', 'declined-payment', 'duplicate-webhook', 'missing-idempotency-key', 'refund-request']


def entry(path, kind, text):
    return dict(path=path, kind=kind, text=text.strip()+'\n')


def skill(name, description, text):
    return entry(f'skills/{name}/SKILL.md', 'skill', f'---\nname: {name}\ndescription: {description}\n---\n\n{text}')


PAYMENTS = [
    entry('AGENTS.md', 'instruction', '''# Payment operations\n\nHelp the operations team investigate payment and refund requests. Read the relevant skill and approved memory before recommending an action. Keep customer-facing replies short and explain the next step.\n\nBefore retrying an uncertain payment, check its latest status. Ask for the original request ID when it is missing. Escalate unsupported cases rather than guessing.\n\nThis is example content. Evaluation records in this workspace are simulated examples; no payment, model or external service was called.'''),
    skill('investigate-retry', 'Investigate ambiguous payment retries without duplicating charges.', '''# Investigate a retry\n\n1. Read references/payment-states.md.\n2. Find the original payment request and current provider status.\n3. If it already succeeded, report the existing result.\n4. If the outcome is unknown, explain what remains uncertain and hand off for investigation.\n\nUse references/customer-reply.md to write the update.'''),
    entry('skills/investigate-retry/references/payment-states.md', 'skill', '''# Payment states\n\n- Succeeded: return the recorded transaction; do not charge again.\n- Declined: explain the decline and ask for another payment method.\n- Pending: wait for the provider confirmation.\n- Unknown after timeout: look up the original request before taking another action.\n\nA network timeout is not evidence that a charge failed.'''),
    entry('skills/investigate-retry/references/customer-reply.md', 'skill', '''# Customer update\n\nSay what we can confirm, what we are checking, and when the customer should hear back. Never promise a refund or another attempt before the payment state is known.'''),
    skill('review-refund', 'Check refund eligibility and route exceptions to a human.', '''# Review a refund\n\nRead references/refund-checklist.md. Match the payment, customer and currency. Explain eligibility and the next step; do not submit a live refund from this example setup.'''),
    entry('skills/review-refund/references/refund-checklist.md', 'skill', '''# Refund checklist\n\nCheck settled amount, previous refunds, remaining refundable amount and the customer's stated reason. Escalate disputed payments, mismatched currencies and already-refunded charges.'''),
    entry('memory/payment-policy.md', 'memory', '''# Approved payment policy\n\nPreserve the original idempotency key for every retry of the same request. Look up existing outcomes before taking action. A new customer intent needs a new request, not a reused key.'''),
    entry('memory/escalation-rules.md', 'memory', '''# Escalation rules\n\nEscalate an unknown state that remains unresolved after provider lookup, any suspected duplicate charge, and refund requests above the approved limit. Include the original request ID and the facts already checked.'''),
    entry('memory/example-data.md', 'memory', '''# About these examples\n\nAll evaluation outputs, scores and lifecycle states in this workspace are deliberately simulated to exercise the product UI. They are not benchmark claims. No model, customer system, charge or refund was executed.'''),
]
SUPPORT = [
    entry('AGENTS.md', 'instruction', '''# Customer support\n\nAnswer from approved product context. Distinguish confirmed facts from a hypothesis. Avoid asking customers to repeat information already in the conversation. Use the triage skill for an unclear issue and the handoff skill when a specialist is needed.\n\nThis bundle is editable example content.'''),
    skill('triage-issue', 'Turn a vague report into a focused support next step.', '''# Triage an issue\n\nSummarize the customer's goal in one sentence. Check references/triage-checklist.md, then ask only the most useful missing question. End with a concrete next step.'''),
    entry('skills/triage-issue/references/triage-checklist.md', 'skill', '''# Triage checklist\n\nWhat was expected? What actually happened? When did it start? Is one person or the whole team affected? Prefer a safe diagnostic step before changing configuration.'''),
    skill('specialist-handoff', 'Prepare a concise handoff that preserves useful context.', '''# Specialist handoff\n\nInclude the problem, scope, timeline, evidence and actions already tried. State the decision needed. Keep credentials and personal data out of the handoff.'''),
    entry('memory/tone.md', 'memory', '''# Support voice\n\nBe direct, calm and helpful. Own the next step. Do not add a cheerful opener when the customer reports an outage.'''),
    entry('memory/privacy.md', 'memory', '''# Privacy boundary\n\nNever request a password, access token or full payment details. Ask for a redacted screenshot or a non-secret request identifier instead.'''),
]
REVIEW = [
    entry('AGENTS.md', 'instruction', '''# Code review\n\nReview the changed behavior and surrounding contracts. Report actionable correctness issues with a concrete failure path. Prefer a short explanation and a targeted fix over broad refactoring.\n\nThis is example content for a background review agent.'''),
    skill('review-change', 'Find meaningful correctness issues in a patch.', '''# Review a change\n\nRead references/review-checklist.md. Identify the user-visible behavior, follow the state transitions and check the error paths. Run the smallest relevant existing test when practical. Explain the impact of every finding.'''),
    entry('skills/review-change/references/review-checklist.md', 'skill', '''# Review checklist\n\nCheck authorization, input boundaries, retry identity, partial writes and compatibility. Verify whether a failure is reachable before reporting it. A style preference alone is not a correctness finding.'''),
    skill('write-regression-test', 'Capture a bug through an observable behavior.', '''# Write a regression test\n\nUse the public boundary that exposes the bug. Make the test fail for the reported reason, then verify the intended behavior. Avoid tests that duplicate private implementation details.'''),
    entry('memory/review-standard.md', 'memory', '''# Review standard\n\nUse a concise title, affected location, trigger, impact and suggested direction. Say when a conclusion is an inference. Do not claim that a test ran when it did not.'''),
    entry('memory/repository-conventions.md', 'memory', '''# Repository conventions\n\nReuse the existing error and transaction helpers. Keep protocol changes backward compatible. Add a migration for persistent data changes and document recovery behavior.'''),
]
BUNDLES = [('payments', 'Payment operations', PAYMENTS), ('support', 'Customer support', SUPPORT), ('review', 'Code review', REVIEW)]


class LoginForm(HTMLParser):
    def __init__(self):
        super().__init__(); self.action = None; self.fields = {}; self.active = False
    def handle_starttag(self, tag, attrs):
        a = dict(attrs)
        if tag == 'form' and a.get('id') == 'kc-form-login':
            self.active = True; self.action = a.get('action')
        if tag == 'input' and self.active and a.get('type') == 'hidden' and a.get('name'):
            self.fields[a['name']] = a.get('value', '')
    def handle_endtag(self, tag):
        if tag == 'form': self.active = False


class Api:
    def __init__(self, args):
        self.base = args.service_url.rstrip('/'); self.origin = args.console_origin.rstrip('/')
        for url in (self.base, self.origin):
            if urlsplit(url).hostname not in ('localhost', '127.0.0.1'):
                raise RuntimeError('This local example seeder only permits loopback targets')
        config = json.loads(args.credentials_file.read_text())
        jar = http.cookiejar.CookieJar()
        self.context = ssl.create_default_context(cafile=str(args.ca_file))
        opener = build_opener(HTTPCookieProcessor(jar), HTTPSHandler(context=self.context))
        with opener.open(self.origin+'/auth/login?'+urlencode({'returnTo':'/'}), timeout=20) as response:
            form = LoginForm(); form.feed(response.read().decode())
        action = urljoin(self.origin, form.action or '')
        if not form.action or urlsplit(action).scheme != 'https' or urlsplit(action).hostname not in ('localhost', '127.0.0.1') or urlsplit(action).port != 8443:
            raise RuntimeError('Expected the existing local Keycloak login form')
        fields = dict(form.fields, username=config['username'], password=config['userPassword'])
        with opener.open(Request(action, data=urlencode(fields).encode()), timeout=30) as response:
            response.read()
        sessions = [c.value for c in jar if c.name == 'acclimate_session']
        if len(sessions) != 1:
            raise RuntimeError('Real Keycloak sign-in did not produce one console session')
        self.session = sessions[0]; self.transport = config['consoleToken']
        self.call('GET', '/v1/auth/session')

    def call(self, method, path, body=None, *, key=None, allow_missing=False):
        headers = {'Content-Type':'application/json', 'Authorization':'Bearer '+self.transport, 'X-Acclimate-Session':self.session}
        if method != 'GET': headers['Idempotency-Key'] = key or 'example-v1-'+hashlib.sha256((path+json.dumps(body,sort_keys=True)).encode()).hexdigest()[:40]
        data = json.dumps(body, separators=(',', ':')).encode() if body is not None else None
        try:
            with urlopen(Request(self.base+path, method=method, data=data, headers=headers), timeout=30) as response:
                raw = response.read(); return json.loads(raw) if raw else None
        except HTTPError as error:
            if error.code == 404 and allow_missing: return None
            try: code = json.loads(error.read()).get('error',{}).get('code','unknown')
            except Exception: code = 'unknown'
            raise RuntimeError(f'API {method} failed with HTTP {error.code} ({code})') from None

    def pages(self, path):
        items = []; cursor = None; seen = set()
        while True:
            query = {'limit':100}
            if cursor: query['cursor'] = cursor
            page = self.call('GET',path+'?'+urlencode(query)); items.extend(page['items']); cursor = page.get('nextCursor')
            if not cursor: return items
            if cursor in seen: raise RuntimeError('Repeated API pagination cursor')
            seen.add(cursor)

    def close(self):
        self.call('DELETE', '/v1/auth/session')


def arm(score=None, *, status='completed', grading='scored', error=None, known_cost=True):
    return dict(executionStatus=status, gradingStatus=grading, reward=score,
                usage={'costUsd':0} if known_cost else None,
                outputRef='Simulated example evidence — no agent or payment was executed.', error=error)


def evaluation_plan():
    improved = list(zip([0, .5, 1, .5, 0, 1], [1, 1, 1, 1, .5, 1]))
    regressed = list(zip([0, .5, 1, .5, 0, 1], [0, 0, 1, 0, 0, .5]))
    return [('improved', improved), ('regressed', regressed), ('incomplete', improved), ('task-failed', improved), ('requested', None), ('interrupted', None)]


def seed(api, manifest):
    projects = api.pages('/v1/projects')
    project = next((p for p in projects if p['id'] == PROJECT), None)
    if project and project['name'] != NAME: raise RuntimeError('The reserved example workspace ID belongs to other data')
    if not project: api.call('POST','/v1/projects',dict(id=PROJECT,name=NAME))
    root = '/v1/projects/'+PROJECT
    bundles = api.pages(root+'/bundles'); manifest.update(projectId=PROJECT, workspaceName=NAME, bundles={})
    for slug, name, files in BUNDLES:
        matches = [b for b in bundles if b['name'] == name]
        if len(matches) > 1: raise RuntimeError('Example bundle name is ambiguous')
        if matches:
            bundle = matches[0]
            if bundle.get('origin') != 'example' or bundle.get('sourceLabel') != SOURCE:
                raise RuntimeError('A matching bundle is not owned by this example seed')
            route = root+'/bundles/'+bundle['id']; resolution = api.call('GET',route+'/channels/stable')
            payload = api.call('GET',route+'/versions/'+resolution['version']['id']+'/payload')
            if payload != dict(schemaVersion=1,files=files):
                raise RuntimeError('An example release was changed; refusing to overwrite or reseed it')
        else:
            setup = api.call('POST',root+'/bundle-setups',dict(name=name,origin='example',sourceLabel=SOURCE,channel='stable',payload=dict(schemaVersion=1,files=files),reason='Initial example content. Simulated workspace for exploring Acclimate; no external system or model was called.'))
            bundle = setup['bundle']; route = root+'/bundles/'+bundle['id']; resolution = setup['resolution']
        record = dict(id=bundle['id'],name=name,files=len(files),contentUrl=api.origin+f'/w/{PROJECT}/bundles/{bundle["id"]}/channels/stable/content',drafts=[])
        manifest['bundles'][slug] = record
        drafts = api.pages(route+'/channels/stable/drafts')
        parent = resolution['version']
        variations = [('retry-safety','\n## Retry safety update\n\nAfter an ambiguous timeout, reuse the original idempotency key. Look up the existing outcome before trying again. Never create a new request solely because the first response was lost.\n'),('clearer-handoff','\n## Handoff update\n\nEnd an escalation with the owner, the decision needed and the next update time. Keep unknown facts explicit.\n')]
        if slug != 'payments': variations = variations[1:]
        for label, extra in variations:
            candidate_files = copy.deepcopy(files); candidate_files[0]['text'] += extra
            payload = dict(schemaVersion=1,files=candidate_files)
            found = None
            for draft in drafts:
                actual = api.call('GET',route+'/versions/'+draft['snapshotVersion']['id']+'/payload')
                if actual == payload and draft.get('status') == 'open': found = draft; break
            if found is None:
                found = api.call('POST',route+'/channels/stable/drafts',dict(baseVersionId=parent['id'],baseRevision=resolution['revision'],payload=payload))
            draft = found; candidate = draft['snapshotVersion']
            draft_info = dict(id=draft['id'],label=label,candidateVersionId=candidate['id'],url=api.origin+f'/w/{PROJECT}/bundles/{bundle["id"]}/changes?'+urlencode(dict(channel='stable',draft=draft['id'])))
            record['drafts'].append(draft_info)
            if slug != 'payments' or label != 'retry-safety': continue
            requests = api.pages(route+'/evaluation-requests'); draft_info['evaluations'] = []
            expected = [dict(caseId=case,repetition=0) for case in CASES]
            for scenario, scores in evaluation_plan():
                dataset = 'example-payment-retry-v1-'+scenario
                request = next((r for r in requests if r['candidateVersionId']==candidate['id'] and r['datasetRevision']==dataset),None)
                settings = dict(parentVersionId=parent['id'],parentDigest=parent['digest'],candidateVersionId=candidate['id'],candidateDigest=candidate['digest'],datasetRevision=dataset,runtime=RUNTIME,graderRevision='example-simulated-review-v1',expectedCases=expected)
                if request is None: request = api.call('POST',route+'/evaluation-requests',dict(**settings,requireBoundEvidence=True))
                request_route = route+'/evaluation-requests/'+request['id']; attempt = 'example-seed-v1-'+scenario
                if scenario == 'interrupted' and request['status']=='requested':
                    request = api.call('POST',request_route+'/interrupt',dict(reason='Simulated example: operator stopped this request before execution. No agent was run.'))
                elif scores is not None and request['status'] in ('requested','running'):
                    if request['status']=='requested': request = api.call('POST',request_route+'/start',dict(attemptId=attempt))
                    if request['attemptId'] != attempt: raise RuntimeError('An example evaluation is now owned by another execution; leaving it unchanged')
                    results=[]
                    for index, (old,new) in enumerate(scores):
                        if scenario=='incomplete' and index==5: continue
                        parent_arm = arm(old,known_cost=index!=4); candidate_arm = arm(new)
                        if scenario=='incomplete' and index==3: candidate_arm=arm(grading='missing',error='Simulated example: grader response is missing.',known_cost=False)
                        if scenario=='task-failed' and index==0: candidate_arm=arm(0,status='task_failed',error='Simulated example: candidate could not resolve the original request.')
                        results.append(dict(**expected[index],parent=parent_arm,candidate=candidate_arm))
                    comparison_body = dict(**settings,evaluation=dict(requestId=request['id'],attemptId=attempt),results=results)
                    reports = api.pages(route+'/comparisons')
                    report = next((r for r in reports if r.get('evaluation') == comparison_body['evaluation']), None)
                    if report is not None:
                        report = api.call('GET',route+'/comparisons/'+report['id'])
                        if any(report.get(key) != value for key,value in comparison_body.items()):
                            raise RuntimeError('An existing example comparison has different evidence; leaving it unchanged')
                    else:
                        report = api.call('POST',route+'/comparisons',comparison_body)
                    request = api.call('POST',request_route+'/finish',dict(attemptId=attempt,comparisonId=report['id']))
                info = dict(id=request['id'],scenario=scenario,status=request['status'],comparisonId=request.get('comparisonId'))
                info['url'] = api.origin+f'/w/{PROJECT}/bundles/{bundle["id"]}/changes?'+urlencode(dict(channel='stable',draft=draft['id'],generation=draft['generation'],candidate=candidate['id'],**({'comparison':request['comparisonId']} if request.get('comparisonId') else {})))
                draft_info['evaluations'].append(info)
    manifest.update(simulatedEvidence=True,paidModelCalls=0,providerCalls=0,externalSystemWrites=0)
    return manifest


def main():
    parser=argparse.ArgumentParser(description=__doc__)
    state=ROOT/'.local/keycloak-stack'
    parser.add_argument('--credentials-file',type=Path,default=state/'credentials.json')
    parser.add_argument('--ca-file',type=Path,default=state/'localhost.crt')
    parser.add_argument('--console-origin',default='https://localhost:3443')
    parser.add_argument('--service-url',default='http://127.0.0.1:3000')
    parser.add_argument('--output',type=Path,default=ROOT/'.local/example-workspace.json')
    args=parser.parse_args(); api=None
    try:
        api=Api(args); result=seed(api,{})
        args.output.parent.mkdir(parents=True,exist_ok=True,mode=0o700)
        args.output.write_text(json.dumps(result,indent=2)+'\n'); args.output.chmod(0o600)
        print(json.dumps(result,indent=2))
        return 0
    except Exception as error:
        # Exceptions from identity redirects may contain credentials or one-time codes.
        # Only controlled application errors are safe to report.
        print('Example seed failed: '+(str(error) if isinstance(error,RuntimeError) else type(error).__name__),file=sys.stderr)
        return 1
    finally:
        if api:
            try: api.close()
            except Exception: pass


if __name__=='__main__': raise SystemExit(main())
