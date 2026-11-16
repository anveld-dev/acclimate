"""Check a reviewed behavior inventory against an actual Behave JSON result."""
import json
import re
from collections import defaultdict
from pathlib import Path


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
            row['cases']+=1
    return rows


def assess(inventory, results):
    observed=defaultdict(list)
    for feature in results:
        for scenario in feature.get('elements',[]):
            ids=[tag for tag in scenario.get('tags',[]) if tag in inventory]
            for identifier in ids:
                steps=scenario.get('steps',[])
                passed=scenario.get('status')=='passed' and bool(steps) and all(s.get('result',{}).get('status')=='passed' for s in steps)
                observed[identifier].append(passed)
    return {key:dict(**spec,ran=len(observed[key]),passed=sum(observed[key]),covered=len(observed[key])==spec['cases'] and all(observed[key])) for key,spec in inventory.items()}


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
