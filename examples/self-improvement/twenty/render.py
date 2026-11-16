#!/usr/bin/env python3
"""Render retained twenty-round evidence. No server or model calls."""
import argparse
import csv
import html
import json
import os
from pathlib import Path


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--output', type=Path, required=True)
    parser.add_argument('--large-run',type=Path,action='append',default=[])
    args = parser.parse_args()
    root = args.output.resolve()
    def read(name, default=None):
        path = root / name
        return json.loads(path.read_text()) if path.exists() else default
    progress = read('progress.json', {})
    rounds = read('rounds.json', progress.get('history', progress.get('rounds', [])))
    if not isinstance(rounds, list):
        rounds = []
    summary = read('summary.json')
    failure = read('failure.json')
    raw_audit = read('final-audit-evaluation.json')
    audit = summary.get('audit') if summary else ({key: raw_audit[key] for key in ('parent', 'candidate')} if raw_audit else None)
    future = {'future':summary['future'],'control':summary['control']} if summary else read('future-job.json')
    large_runs=[]
    for folder in args.large_run:
        folder=folder.resolve()
        def external(name):
            f=folder/name
            return json.loads(f.read_text()) if f.exists() else None
        result=external('result.json')
        if result:
            large_runs.append({'name':folder.name,'result':result,'summary':external('summary.json'),'delivery':external('delivery.json'),'failed':(folder/'failure.json').exists()})
    if large_runs and large_runs[-1]['delivery']:
        future=large_runs[-1]['delivery']
    initial = read('initial-development.json', [])
    initial_score = sum(row['grade']['correct'] for row in initial)
    accepted = sum(bool(row.get('accepted')) for row in rounds)
    data = {
        'rounds': [{key: row.get(key) for key in ('round', 'accepted', 'parent', 'candidate', 'parentBytes', 'candidateBytes', 'newUnsafe', 'error')} for row in rounds],
        'summary': summary, 'audit': audit, 'future': future, 'largeRuns':large_runs, 'initial': initial_score,
        'status': 'Passed' if summary and summary.get('passed') else 'Failed final gate' if failure else 'Running',
        'completed': len(rounds), 'accepted': accepted,
    }
    os.umask(0o077)
    with (root / 'rounds.csv').open('w', newline='') as stream:
        writer = csv.writer(stream)
        writer.writerow(['round', 'accepted', 'parent_correct', 'candidate_correct', 'parent_unsafe', 'candidate_unsafe', 'parent_bytes', 'candidate_bytes', 'error'])
        for row in rounds:
            writer.writerow([row['round'], row.get('accepted', False), row.get('parent', {}).get('correct'), row.get('candidate', {}).get('correct'), row.get('parent', {}).get('unsafe'), row.get('candidate', {}).get('unsafe'), row.get('parentBytes'), row.get('candidateBytes'), row.get('error', '')])
    payload = json.dumps(data).replace('<', '\\u003c')
    template = '''<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Twenty-round learning evidence</title><style>
*{box-sizing:border-box}body{margin:0;font-family:var(--font-sans,system-ui);color:var(--foreground,CanvasText)}button{font:inherit;font-size:13px;color:inherit;background:transparent;border:1px solid var(--border,ButtonBorder);border-radius:var(--radius,6px);padding:7px 10px;cursor:pointer}button[aria-pressed=true]{background:var(--secondary,ButtonFace);border-color:var(--ring,Highlight)}button:disabled{opacity:.5;cursor:default}button:focus-visible,summary:focus-visible{outline:2px solid var(--ring,Highlight);outline-offset:3px}.controls{display:flex;gap:6px;flex-wrap:wrap;margin:13px 0}.status,.note,.legend{font-size:13px;line-height:1.55;color:var(--muted-foreground,GrayText)}.status strong{color:var(--foreground,CanvasText)}.legend{display:flex;gap:17px;flex-wrap:wrap}.key{display:inline-block;width:13px;height:3px;vertical-align:middle;margin-right:5px;background:var(--chart-1,Highlight)}.key.parent{background:var(--chart-2,LinkText)}svg{display:block;width:100%;height:246px;overflow:visible}svg text{font-family:var(--font-sans,system-ui);font-size:12px;fill:var(--muted-foreground,GrayText)}.grid{stroke:var(--border,ButtonBorder);stroke-width:1}.parent-line{stroke:var(--chart-2,LinkText);fill:none;stroke-width:2;stroke-dasharray:4 4}.selected-line{stroke:var(--chart-1,Highlight);fill:none;stroke-width:2.5}.accepted{fill:var(--success,Highlight);stroke:var(--success,Highlight)}.rejected{fill:var(--background,Canvas);stroke:var(--destructive,Mark);stroke-width:1.8}.bars{height:146px;display:grid;align-content:start;gap:23px;padding-top:25px}.bar-row{display:grid;grid-template-columns:109px 1fr 65px;gap:10px;align-items:center;font-size:13px}.track{height:28px;background:var(--secondary,ButtonFace);border-radius:4px;overflow:hidden}.fill{height:28px;background:var(--chart-2,LinkText)}.fill.learned{background:var(--chart-1,Highlight)}.value{white-space:nowrap;font-size:15px;font-variant-numeric:tabular-nums}.note{margin:13px 0 15px}.table-wrap{overflow:auto}table{width:100%;border-collapse:collapse;font-size:12px;white-space:nowrap}th,td{padding:7px 8px;text-align:left;border-bottom:1px solid var(--border,ButtonBorder);font-variant-numeric:tabular-nums}summary{cursor:pointer;font-size:13px}details{border-top:1px solid var(--border,ButtonBorder);padding-top:12px;margin-top:12px}.limits{font-size:12px;line-height:1.5;color:var(--muted-foreground,GrayText);margin:12px 0 0}[hidden]{display:none!important}@media(max-width:420px){svg text{font-size:22px}.bar-row{grid-template-columns:94px 1fr 72px}.legend{gap:10px}}
</style></head><body><div class="status" id="status"></div><div class="controls" role="group" aria-label="Evidence view"><button data-view="search" aria-pressed="true">20-round search</button><button data-view="audit" aria-pressed="false">20-round audit</button><button data-view="future" aria-pressed="false">After release</button></div><div id="search"><div class="legend"><span><i class="key parent"></i>Current parent</span><span><i class="key"></i>Selected after the pair</span><span>● accepted · ○ rejected candidate</span></div><svg id="plot" viewBox="0 0 700 246" role="img" aria-label="Exact correct development decisions over twenty search rounds"></svg></div><div id="bars" class="bars" hidden></div><p class="note" id="note"></p><details><summary>Inspect the 20 search rounds</summary><div class="table-wrap"><table><thead><tr><th>Round</th><th>Decision</th><th>Parent</th><th>Candidate</th><th>Unsafe</th><th>Text bytes</th></tr></thead><tbody id="rows"></tbody></table></div></details><p class="limits">Luna only · synthetic v2 policy · approved feedback · separate final audit. Repeated decisions are not independent incidents.</p><script>
const data=__DATA__,ns='http://www.w3.org/2000/svg';
function svg(tag,attrs,text){const e=document.createElementNS(ns,tag);Object.entries(attrs).forEach(([k,v])=>e.setAttribute(k,String(v)));if(text!==undefined)e.textContent=text;document.getElementById('plot').append(e);return e}
const x=n=>43+n/20*633,y=n=>208-n/24*175;
for(const n of [0,6,12,18,24]){svg('line',{x1:43,y1:y(n),x2:676,y2:y(n),class:'grid'});svg('text',{x:31,y:y(n)+4,'text-anchor':'end'},String(n))}
for(const n of [0,5,10,15,20])svg('text',{x:x(n),y:232,'text-anchor':'middle'},String(n));
svg('text',{x:43,y:16},'Correct / 24');svg('text',{x:676,y:232,'text-anchor':'end'},'');
const valid=data.rounds.filter(r=>r.parent&&r.candidate);if(valid.length){svg('path',{d:valid.map((r,i)=>(i&&r.round===valid[i-1].round+1?'L':'M')+x(r.round)+' '+y(r.parent.correct)).join(' '),class:'parent-line'});svg('path',{d:'M'+x(0)+' '+y(data.initial)+' '+valid.map((r,i)=>(r.round===(i?valid[i-1].round:0)+1?'L':'M')+x(r.round)+' '+y((r.accepted?r.candidate:r.parent).correct)).join(' '),class:'selected-line'});for(const r of valid){const dot=svg('circle',{cx:x(r.round),cy:y(r.candidate.correct),r:4.2,class:r.accepted?'accepted':'rejected'});const title=document.createElementNS(ns,'title');title.textContent='Round '+r.round+': '+(r.accepted?'accepted':'rejected')+', parent '+r.parent.correct+'/24, candidate '+r.candidate.correct+'/24, unsafe '+r.candidate.unsafe;dot.append(title)}}
document.getElementById('status').innerHTML='<strong>'+data.status+'</strong> · '+data.completed+'/20 rounds · '+data.accepted+' accepted';
for(const r of data.rounds){const row=document.createElement('tr');for(const value of [r.round,r.error?'error':r.accepted?'accept':'reject',r.parent?r.parent.correct+'/24':'—',r.candidate?r.candidate.correct+'/24':'—',r.candidate?r.candidate.unsafe:'—',r.candidateBytes??'—']){const cell=document.createElement('td');cell.textContent=value;row.append(cell)}document.getElementById('rows').append(row)}
function show(view){document.querySelectorAll('button[data-view]').forEach(b=>b.setAttribute('aria-pressed',String(b.dataset.view===view)));document.getElementById('search').hidden=view!=='search';const bars=document.getElementById('bars');bars.hidden=view==='search';bars.replaceChildren();if(view==='search'){document.getElementById('note').textContent='Same 24 development incidents, freshly run for both versions each round. Selected scores can fluctuate even when the files stay unchanged. Incomplete answers count as zero and can create noisy apparent gains. These are tuning results; the separate audit is the release check.';return}const s=view==='audit'?data.audit:data.future,values=view==='audit'?{before:s.parent.correct,after:s.candidate.correct,total:s.candidate.total}: {before:s.control.correct,after:s.future.correct,total:s.future.total};for(const [label,value,learned]of [['Original setup',values.before,false],['Learned files',values.after,true]]){const row=document.createElement('div');row.className='bar-row';const name=document.createElement('span');name.textContent=label;const track=document.createElement('div');track.className='track';track.setAttribute('aria-hidden','true');const fill=document.createElement('div');fill.className='fill'+(learned?' learned':'');fill.style.width=(100*value/values.total)+'%';track.append(fill);const metric=document.createElement('strong');metric.className='value';metric.textContent=value+' / '+values.total;row.append(name,track,metric);bars.append(row)}document.getElementById('note').textContent=view==='audit'?'32 fresh incident instances with new rule combinations, currencies and regions, repeated twice per setup. Final candidate unsafe decisions: '+s.candidate.unsafe+'.':'Fresh SDK job after release versus a pinned-original control on the same eight new incidents. The existing channel cache was warmed immediately before promotion.'}
for(let i=0;i<data.largeRuns.length;i++){const button=document.createElement('button');button.dataset.view='large-'+i;button.textContent=i===0?'First large audit':'Repaired large audit';button.setAttribute('aria-pressed','false');document.querySelector('.controls').append(button)}
const showSmall=show;show=function(view){if(!view.startsWith('large-')){document.getElementById('status').textContent=view==='future'&&data.largeRuns.length&&data.future?'Delivery check · '+data.largeRuns[data.largeRuns.length-1].name:data.status+' · '+data.completed+'/20 rounds · '+data.accepted+' accepted';showSmall(view);return}const run=data.largeRuns[Number(view.slice(6))],r=run.result;document.querySelectorAll('button[data-view]').forEach(b=>b.setAttribute('aria-pressed',String(b.dataset.view===view)));document.getElementById('search').hidden=true;const bars=document.getElementById('bars');bars.hidden=false;bars.replaceChildren();for(const [label,value,learned]of [['Original files',r.baseline.correct,false],['Learned files',r.learned.correct,true]]){const row=document.createElement('div');row.className='bar-row';const name=document.createElement('span');name.textContent=label;const track=document.createElement('div');track.className='track';track.setAttribute('aria-hidden','true');const fill=document.createElement('div');fill.className='fill'+(learned?' learned':'');fill.style.width=(100*value/r.learned.total)+'%';track.append(fill);const metric=document.createElement('strong');metric.className='value';metric.textContent=value+' / '+r.learned.total;row.append(name,track,metric);bars.append(row)}const contradictions=r.learned.consistency.reduce((n,c)=>n+c.violations,0),checks=r.learned.consistency.reduce((n,c)=>n+c.expected,0);document.getElementById('status').textContent=(run.summary?'Passed':run.failed||!r.passed?'Gate failed':'Audit passed; delivery pending')+' · '+run.name;document.getElementById('note').textContent='Unsafe decisions: '+r.baseline.unsafe+' → '+r.learned.unsafe+'. Learned setup contradictions: '+contradictions+'/'+checks+' repeated-event checks. '+r.metrics.baseEvents+' base events + '+(r.metrics.incidentViews-r.metrics.baseEvents)+' alternate views, repeated twice; '+r.metrics.records.toLocaleString()+' receipt records across '+r.metrics.files+' files ('+(r.metrics.inputBytes/1e6).toFixed(1)+' MB).';};
document.querySelectorAll('button[data-view]').forEach(b=>{b.disabled=b.dataset.view==='audit'?!data.audit:b.dataset.view==='future'?!data.future:false;b.addEventListener('click',()=>show(b.dataset.view))});show(data.largeRuns.length?'large-'+(data.largeRuns.length-1):'search');
</script></body></html>'''
    (root / 'results.html').write_text(template.replace('__DATA__', payload))
    lines = ['# Twenty-round learning evidence', '', f"Status: {data['status']}. Completed {len(rounds)}/20 rounds; accepted {accepted} candidates.", '', '| Round | Decision | Parent | Candidate | Candidate unsafe | Bytes |', '| --- | --- | --- | --- | --- | --- |']
    for row in rounds:
        lines.append(f"| {row['round']} | {'error' if row.get('error') else 'accept' if row.get('accepted') else 'reject'} | {row.get('parent', {}).get('correct', '—')}/24 | {row.get('candidate', {}).get('correct', '—')}/24 | {row.get('candidate', {}).get('unsafe', '—')} | {row.get('candidateBytes', '—')} |")
    if audit and not summary:
        lines += ['', '## Final audit (release blocked)', '', f"Original {audit['parent']['correct']}/64, with {audit['parent']['unsafe']} unsafe decisions. Learned {audit['candidate']['correct']}/64, with {audit['candidate']['unsafe']} unsafe decisions. 32 distinct incident instances, two repetitions per setup."]
    if summary:
        lines += ['', '## Final checks', '', f"Audit: original {summary['audit']['parent']['correct']}/64; learned {summary['audit']['candidate']['correct']}/64, with {summary['audit']['candidate']['unsafe']} unsafe decisions. There are 32 distinct incident instances and two repetitions.", '', f"Fresh job: learned {summary['future']['correct']}/8; pinned original {summary['control']['correct']}/8. SDK turns: {summary['lunaCalls']} (each may contain multiple model/tool steps). USD cost unknown."]
        candidate = read('release-candidate.json')
        original = read('parent.json')
        import difflib
        old = {f['path']: f['text'] for f in original['payload']['files']}
        changes = []
        allowed = {'AGENTS.md', 'skills/payment-triage/SKILL.md', 'memory/gateway.md'}
        for file in candidate['payload']['files']:
            if file['path'] not in allowed or not isinstance(file['text'], str):
                raise ValueError('Unexpected exported bundle path or text')
            dest = root / 'learned-bundle' / file['path']
            dest.parent.mkdir(parents=True, mode=0o700, exist_ok=True)
            dest.write_text(file['text'])
            changes.extend(difflib.unified_diff(old[file['path']].splitlines(keepends=True), file['text'].splitlines(keepends=True), fromfile='original/'+file['path'], tofile='learned/'+file['path']))
        (root / 'learned-files.diff').write_text(''.join(changes))
    if large_runs:
        lines += ['', '## Large audits', '']
        for study in large_runs:
            r=study['result']
            lines += [f"- {study['name']}: original {r['baseline']['correct']}/{r['baseline']['total']}; learned {r['learned']['correct']}/{r['learned']['total']}; learned unsafe {r['learned']['unsafe']}; contradictions {sum(c['violations'] for c in r['learned']['consistency'])}/{sum(c['expected'] for c in r['learned']['consistency'])}. Status: {'passed' if study['summary'] else 'failed or not yet qualified'}."]
            if study['delivery']:
                d=study['delivery'];lines += [f"  Fresh SDK job: {d['future']['correct']}/{d['future']['total']}; pinned original {d['control']['correct']}/{d['control']['total']}."]
    if failure:
        lines += ['', '## Failure', '', str(failure['error']), '', 'The final gate did not pass; no successful release is claimed.']
    lines += ['', 'This is one synthetic policy domain. All contract facts were available from round one; development was adaptively reused. The final audit was separate. Existing application workspaces were untouched.', '']
    (root / 'report.md').write_text('\n'.join(lines))
    print(root / 'results.html')


if __name__ == '__main__':
    main()
