#!/usr/bin/env python3
"""Summarize retained live learner evidence without a service or model connection."""
import argparse
import json
from collections import Counter
from pathlib import Path


def load(path):
    return json.loads(path.read_text())


def summarize(root):
    ledger = root / 'model-turns/model-calls'
    slots = [load(file) for file in (ledger / 'slots').glob('*.json')]
    usage = Counter()
    completed = failed = 0
    for slot in slots:
        call = ledger / 'calls' / slot['callId']
        result = call / 'result.json'
        if result.is_file():
            completed += 1
            usage.update({key: tokens for key, tokens in load(result)['usage'].items()
                          if tokens is not None})
        elif (call / 'failure.json').is_file():
            failed += 1

    service = load(root / 'service-records.json')
    campaigns = []
    for directory in (root, root / 'alternate'):
        views_file = directory / 'campaign-views.json'
        if not views_file.exists():
            continue
        views = load(views_file)
        comparisons = [{
            'stage': record['runtime']['acclimate.learning.stage'],
            'execution': record['runtime']['execution'],
            'comparisonId': record['id'],
            'requestId': record['evaluation']['requestId'],
            'parentVersionId': record['parentVersionId'],
            'candidateVersionId': record['candidateVersionId'],
            'datasetRevision': record['datasetRevision'],
            'pairs': [{
                'caseId': pair['caseId'],
                'repetition': pair['repetition'],
                'parent': pair['parent']['reward'],
                'candidate': pair['candidate']['reward'],
            } for pair in record['results']],
        } for record in sorted(service['comparisons'], key=lambda item: item['createdAt'])
            if record['runtime']['acclimate.learning.definition'] == views[-1]['definitionDigest']]
        decisions = [{
            'stage': decision['stage'], 'verdict': decision['verdict'], 'reason': decision['reason'],
        } for decision in views[-1]['decisions']]
        releases = [load(file)['promotion'] for file in sorted(directory.glob('*-review-and-release.json'))]
        roster = load(directory / 'audit-roster.json')
        observation = load(directory / 'observed-failure-outcome.json')
        result_digest = observation['outcome']['result']['sha256'].split(':', 1)[1]
        observation_result, = (directory / 'campaign').rglob(result_digest + '.json')
        campaigns.append({
            'observedFailure': load(observation_result),
            'auditRoster': [cohort['id'] for cohort in roster],
            'exposedAuditCohorts': [
                cohort['id'] for cohort in roster if cohort['digest'] in views[-1]['auditExposures']
            ],
            'campaignId': views[-1]['campaignId'],
            'decisions': decisions,
            'auditExposures': views[-1]['auditExposures'],
            'comparisons': comparisons,
            'promotions': [{
                'channel': release['channel'],
                'comparisonId': release['comparisonId'],
                'versionId': release['version']['id'],
                'digest': release['version']['digest'],
            } for release in releases],
            'consumerScores': [{
                'situation': probe['input']['situation'],
                'pinnedVersionId': probe['pinned']['versionId'],
                'freshVersionId': probe['fresh']['versionId'],
                'pinned': probe['pinned']['score'],
                'fresh': probe['fresh']['score'],
            } for probe in (load(file) for file in sorted(directory.glob('consumer-*.json')))],
        })
    raw = load(root / 'summary.json')
    models = raw.get('models')
    if models is None:
        models = {'proposer': raw['model'], 'harness': raw['model']}
    return {
        'rawStatus': raw['status'],
        'baselineVersionId': raw['baseline']['id'],
        'baselineDigest': raw['baseline']['digest'],
        'modelTurns': {
            'models': models,
            'cap': raw['maximumModelTurns'],
            'reserved': len(slots),
            'completed': completed,
            'failed': failed,
            'unsettled': len(slots) - completed - failed,
            'reportedTokenTotals': dict(usage),
            'providerDollarCost': None,
        },
        'campaigns': campaigns,
    }


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('evidence', type=Path)
    args = parser.parse_args()
    print(json.dumps(summarize(args.evidence), indent=2))
