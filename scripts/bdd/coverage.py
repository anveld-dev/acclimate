"""Check a reviewed behavior inventory against an actual Behave JSON result."""
import argparse
import json
import re
from collections import defaultdict
from pathlib import Path


def example_values(scenario):
    """Behave attaches its Examples row to each expanded scenario."""
    return dict(scenario._row.as_dict()) if scenario._row is not None else None


def catalog(root):
    """Discover stories without executing them; compare with the reviewed snapshot."""
    from behave.parser import parse_file
    rows={}
    for path in sorted((Path(root)/'features').glob('*.feature')):
        for scenario in parse_file(str(path)).walk_scenarios():
            tags=scenario.effective_tags
            ids=[tag for tag in tags if re.fullmatch(r'[A-Z]+(?:-[A-Z]+)*-\d+',tag)]
            if len(ids)!=1:
                raise ValueError(f'{path.name}: every scenario needs exactly one stable behavior ID')
            name=re.sub(r' -- @.*$','',scenario.name)
            lane='runtime' if 'runtime' in tags else 'browser' if 'browser' in tags else 'sdk' if 'sdk' in tags else 'identity' if 'adapter' in tags else 'service'
            spec=dict(name=name,source=str(path.relative_to(root)),cases=0,lane=lane)
            row=rows.setdefault(ids[0],spec)
            if any(row[key]!=spec[key] for key in ['name','source','lane']):
                raise ValueError(f'{ids[0]} is reused for different behaviors')
            example = example_values(scenario)
            if example is not None:
                examples = row.setdefault('examples', [])
                if example in examples:
                    raise ValueError(f'{ids[0]} repeats the same example: {example}')
                examples.append(example)
            row['cases']+=1
    return rows


def assess(inventory, results):
    observed = defaultdict(lambda: defaultdict(list))
    for feature in results:
        for scenario in feature.get('elements',[]):
            ids=[tag for tag in scenario.get('tags',[]) if tag in inventory]
            for identifier in ids:
                steps=scenario.get('steps',[])
                passed=scenario.get('status')=='passed' and bool(steps) and all(s.get('result',{}).get('status')=='passed' for s in steps)
                key = json.dumps(scenario.get('example'), sort_keys=True)
                observed[identifier][key].append(passed)

    coverage = {}
    for identifier, spec in inventory.items():
        examples = observed[identifier]
        ran = sum(len(attempts) for attempts in examples.values())
        expected = spec.get('examples', [None])
        passed = sum(examples.get(json.dumps(row, sort_keys=True)) == [True] for row in expected)
        coverage[identifier] = dict(**spec, ran=ran, passed=passed,
                                    covered=ran == passed == spec['cases'])
    return coverage


def write_report(inventory_path,result_path,directory):
    inventory=json.loads(Path(inventory_path).read_text())
    try:
        results=json.loads(Path(result_path).read_text())
    except json.JSONDecodeError:
        # An aborted startup still produces an honest uncovered report.
        results=[]
    coverage=assess(inventory,results)
    directory=Path(directory)
    (directory/'coverage.json').write_text(json.dumps(coverage,indent=2)+'\n')
    complete=sum(row['covered'] for row in coverage.values())
    lines=['# Behavior coverage','',f'{complete}/{len(coverage)} behaviors fully passed in this run. Partial runs leave other behaviors uncovered.','',
           'These checks use fixture identity/model providers; they do not qualify live providers or model quality.','',
           '| Behavior | Layer | Cases passed / expected | Status | Scenario |','|---|---|---:|---|---|']
    for identifier,row in coverage.items():
        lines.append(f"| [{identifier}](../../{row['source']}) | {row['lane']} | {row['passed']} / {row['cases']} | {'Passed' if row['covered'] else 'Uncovered'} | {row['name']} |")
    (directory/'coverage.md').write_text('\n'.join(lines)+'\n')
    return complete==len(coverage)


def merge_shards(paths):
    features = {}
    for path in paths:
        for feature in json.loads(path.read_text()):
            location = feature['location']
            combined = features.setdefault(location, dict(feature, elements=[]))
            # Tag-filtered runs emit skipped placeholders for the other shards.
            for row in feature['elements']:
                if row.get('status') == 'skipped':
                    continue
                if row.get('type') == 'background' and row in combined['elements']:
                    continue
                combined['elements'].append(row)
    return list(features.values())


def main():
    parser = argparse.ArgumentParser(description='Combine behavior shards and require full coverage.')
    parser.add_argument('--output', required=True, type=Path)
    parser.add_argument('results', nargs='+', type=Path)
    args = parser.parse_args()
    args.output.mkdir(parents=True, exist_ok=True)
    results = args.output / 'results.json'
    results.write_text(json.dumps(merge_shards(args.results), indent=2) + '\n')
    inventory = Path(__file__).with_name('inventory.json')
    if not write_report(inventory, results, args.output):
        parser.exit(1, 'Full coverage failed. See ' + str(args.output / 'coverage.md') + '\n')


if __name__ == '__main__':
    main()
