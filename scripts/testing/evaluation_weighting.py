#!/usr/bin/env python3
"""Render researcher unequal-repetition arithmetic through real service/OIDC.

The rewards come from the recorded researcher persona. This script submits those
values as fixture results; it does not rerun that application's executor/grader.
Run only after the console build has been frozen. It never builds the application.
"""
import argparse
import json
import sys
from pathlib import Path
from types import SimpleNamespace

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT))
from playwright.sync_api import expect
from scripts.bdd.layout import capture_layout
from scripts.bdd.run import pg_bin
from scripts.bdd.world import World
from scripts.testing.compact_console import visit
from scripts.testing.desktop_layouts import build_fingerprint


def seed(w):
    w.start()
    w.fresh_scenario(SimpleNamespace(effective_tags=[]))
    w.publish_initial('Researcher browser arithmetic fixture.')
    w.save_new('Researcher candidate browser arithmetic fixture.')
    source = json.loads((ROOT / 'docs/acceptance/developer-personas-20261117/evaluation-researcher.json').read_text())
    observed = source['observedRewards']
    settings = dict(
        parentVersionId=w.original['version']['id'], parentDigest=w.original['version']['digest'],
        candidateVersionId=w.draft['snapshotVersion']['id'], candidateDigest=w.draft['snapshotVersion']['digest'],
        datasetRevision='researcher-browser-arithmetic-fixture-v1', graderRevision='recorded-rewards-v1',
        runtime=dict(executor='fixture-recorded-rewards', model='none'),
        expectedCases=[dict(caseId=row['caseId'], repetition=row['repetition']) for row in observed],
    )

    def report(missing):
        request = w.call('POST', w.bundle + '/evaluation-requests', dict(settings, requireBoundEvidence=True))
        path = w.bundle + '/evaluation-requests/' + request['id']
        attempt = 'missing-fixture' if missing else 'complete-fixture'
        w.call('POST', path + '/start', dict(attemptId=attempt), actor='evaluator')
        if not missing:
            w.call('POST', path + '/progress', dict(
                attemptId=attempt, sequence=1, phase='grading', completed=3, total=len(settings['expectedCases']) * 2,
                case=dict(caseId='critical', repetition=0),
            ), actor='evaluator')
        results = []
        for row in observed:
            def outcome(reward):
                return dict(executionStatus='completed', gradingStatus='scored', reward=reward)
            parent, candidate = outcome(row['parent']), outcome(row['candidate'])
            if missing and row['caseId'] == 'critical':
                candidate.update(gradingStatus='failed', reward=None, error='Fixture grade unavailable.')
            results.append(dict(caseId=row['caseId'], repetition=row['repetition'], parent=parent, candidate=candidate))
        comparison = w.call('POST', w.bundle + '/comparisons', dict(
            settings, evaluation=dict(requestId=request['id'], attemptId=attempt), results=results,
        ), actor='evaluator')
        w.call('POST', path + '/finish', dict(attemptId=attempt, comparisonId=comparison['id']), actor='evaluator')
        return request, comparison

    complete, partial = report(False), report(True)
    active = w.call('POST', w.bundle + '/evaluation-requests', dict(settings, requireBoundEvidence=True))
    active_path = w.bundle + '/evaluation-requests/' + active['id']
    w.call('POST', active_path + '/start', dict(attemptId='active-fixture'), actor='evaluator')
    w.call('POST', active_path + '/progress', dict(
        attemptId='active-fixture', sequence=1, phase='executing', completed=1, total=len(settings['expectedCases']) * 2,
        case=dict(caseId='routine', repetition=0),
    ), actor='evaluator')
    return observed, complete, partial, active


def expand(scope, label):
    trigger = scope.get_by_role('button', name=label, exact=True)
    if trigger.get_attribute('aria-expanded') == 'false':
        trigger.click()


def run(args):
    out = args.output.resolve()
    out.mkdir(parents=True, exist_ok=False, mode=0o700)
    before = build_fingerprint()
    w = World(pg_bin(args.pg_bin))
    checks = []
    try:
        observed, complete, partial, active = seed(w)
        b = w.browser()
        p = b.page
        for label, (request, comparison) in [('complete', complete), ('partial', partial)]:
            route = b.bundle_path('changes', candidate=w.draft['snapshotVersion']['id'], request=request['id'], comparison=comparison['id'])
            for width in [1440, 390, 320]:
                p.set_viewport_size(dict(width=width, height=1000))
                visit(p, b, route)
                p.get_by_role('tab',name='Details',exact=True).click()
                score = p.get_by_role('region', name='Observed paired rewards', exact=True)
                expect(score).to_contain_text('Observed equal-case mean')
                expect(score).to_contain_text('Unknown')
                expect(score.locator('.evaluation-score-parent strong')).to_have_text('0.7' if label == 'complete' else '0.4')
                expect(score.locator('.evaluation-score-candidate strong')).to_have_text('0.4' if label == 'complete' else '0.8')
                expect(score).to_contain_text('2 / 2 expected cases' if label == 'complete' else '1 / 2 expected cases')
                expect(score.locator('.evaluation-coverage')).to_contain_text('4 / 4' if label == 'complete' else '3 / 4')
                expect(score).to_contain_text('Complete evidence' if label == 'complete' else 'Partial evidence')
                expand(score, 'How scores are calculated')
                expect(score).to_contain_text('Repetitions are averaged within each case, then cases receive equal weight.')
                expect(score).to_contain_text('Metric direction and application policy are not available here')
                expect(score).to_contain_text('Complete evidence alone is not a win or release approval.' if label == 'complete' else 'This partial view is not an overall result.')
                p.get_by_role('tab',name='Evaluation runs',exact=False).click()
                p.locator(f'[id="evaluation-request-{request["id"]}"]').click()
                activity = p.get_by_role('region', name='Evaluator activity', exact=True)
                expect(activity).to_contain_text('Stale report' if label == 'complete' else 'No activity report')
                expand(activity, 'Report details')
                expect(activity).to_contain_text('Request status remains completed' if label == 'complete' else 'Request status remains failed')
                expect(activity).to_contain_text('that a retry is safe')
                p.get_by_role('tab',name='Details',exact=True).click()
                evidence = p.locator('.comparison-evidence')
                expect(evidence.get_by_role('button', name='Inspect case routine / 0', exact=True)).to_be_visible()
                expect(evidence.get_by_role('button', name='Inspect case critical / 0', exact=True)).to_be_visible()
                assert p.evaluate('document.documentElement.scrollWidth <= innerWidth + 1')
                capture_layout(p, out, f'{label}-equal-case-{width}')
            checks.append(f'{label}: equal-case values, per-pair coverage, unknown cost, explicit weighting and policy limits at 1440/390/320px')
        route = b.bundle_path('changes', candidate=w.draft['snapshotVersion']['id'], request=active['id'])
        for sequence, width in enumerate([1440, 390, 320], start=2):
            # Refresh the optional observation so layout work cannot age the receipt past 60s.
            w.call('POST', w.bundle + '/evaluation-requests/' + active['id'] + '/progress', dict(
                attemptId='active-fixture', sequence=sequence, phase='executing', completed=1, total=len(active['expectedCases']) * 2,
                case=dict(caseId='routine', repetition=0),
            ), actor='evaluator')
            p.set_viewport_size(dict(width=width, height=1000))
            visit(p, b, route)
            activity = p.get_by_role('region', name='Evaluator activity', exact=True)
            expect(activity).to_contain_text('Recent report at last check')
            expect(activity).to_contain_text('executing · 1 / 8')
            expect(activity).to_contain_text('Received ')
            expand(activity, 'Report details')
            expect(activity).to_contain_text('Request status remains running')
            expect(activity).to_contain_text('Last checked')
            assert p.evaluate('document.documentElement.scrollWidth <= innerWidth + 1')
            capture_layout(p, out, f'active-observation-{width}')
        checks.append('Selected active/stale/absent observations are separate from durable running/completed/failed state; no retry-safety inference')
        assert not b.errors, b.errors
        assert before == build_fingerprint(), 'Console build changed during browser evidence'
        summary = dict(
            passed=True, checks=checks, browserErrors=b.errors, sourceBuildSha256=before, modelCalls=0,
            observedRewards=observed, equalCaseMeans=dict(parent=0.70, candidate=0.40),
            pooledMeansForContrast=dict(parent=0.55, candidate=0.60),
            limits=['Recorded researcher rewards submitted as fixture results; executor/grader not rerun.',
                    'Disposable real service, PostgreSQL and fixture OIDC; no external identity or model qualification.',
                    'No selected application policy verdict or metric direction is inferred by the console.'],
        )
        (out / 'summary.json').write_text(json.dumps(summary, indent=2) + '\n')
        print(json.dumps(summary, indent=2), flush=True)
    except BaseException as error:
        if getattr(w, 'browser_fixture', None):
            w.browser_fixture.page.screenshot(path=str(out / 'failure.png'), full_page=True)
        (out / 'failure.json').write_text(json.dumps(dict(error=str(error), checks=checks), indent=2) + '\n')
        raise
    finally:
        w.close()


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--pg-bin')
    parser.add_argument('--output', required=True, type=Path)
    run(parser.parse_args())
