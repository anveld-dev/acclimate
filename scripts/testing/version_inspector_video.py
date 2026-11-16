#!/usr/bin/env python3
"""Record one continuous historical-content session with agent-browser; no models."""
import argparse
import json
import subprocess
import sys
import uuid
from pathlib import Path
ROOT=Path(__file__).resolve().parents[2];sys.path.insert(0,str(ROOT))
from scripts.bdd.world import World
from scripts.bdd.run import pg_bin
from scripts.testing.version_inspector_layouts import seed
from scripts.testing.desktop_layouts import build_fingerprint


def main(args):
    out=args.output.resolve();out.mkdir(parents=True,exist_ok=False,mode=0o700)
    w=World(pg_bin(args.pg_bin));session='inspector-'+uuid.uuid4().hex[:8]
    prefix=['agent-browser','--session',session,'--ignore-https-errors'];log=[];active=False
    def run(*cmd):
        r=subprocess.run([*prefix,*cmd],capture_output=True,text=True,timeout=45)
        if r.returncode:raise RuntimeError('agent-browser '+cmd[0]+': '+r.stderr[:500])
        if cmd[0]=='snapshot':
            log.append(r.stdout);(out/'snapshots.txt').write_text('\n\n'.join(log))
        return r.stdout
    def snap():run('snapshot','-i')
    def click(name,role='button'):
        snap();run('find','role',role,'click','--name',name,'--exact');run('wait','700')
    def search(query):
        snap();run('fill','input[aria-label="Find a version entry"]',query);run('wait','700')
    before=build_fingerprint()
    try:
        seed(w);w.sensitive_fixture=True;b=w.browser()
        run('open',b.base+'/auth/login');snap();run('find','label','Fixture subject','fill','operator');click('Sign in to fixture');run('wait','--load','networkidle')
        run('set','viewport','1440','900');run('open',b.base+b.bundle_path('releases'));run('wait','--load','networkidle');snap()
        source=out/'inspector.webm';run('record','start',str(source));active=True;run('wait','1000')
        # Stay on one page while recording: navigation can reset CDP frame timestamps.
        click('Inspect content for revision 1');run('wait','--fn','!!document.querySelector(".version-inspector-source")');run('wait','1200')
        search('shared.md');click('Open skills/b/references/shared.md','treeitem');click('Clear search')
        run('focus','button[aria-label="Copy content"]');run('wait','900');click('Copy content')
        click('Version details');run('wait','1200');run('screenshot',str(out/'desktop-metadata.png'));click('Version details')
        search('data.json');click('Open skills/a/references/data.json','treeitem');click('Clear search');run('wait','1000')
        search('no matching entry');run('wait','1000');click('Clear search')
        search('shared.md');click('Open skills/a/references/shared.md','treeitem');click('Clear search');run('wait','1000');run('screenshot',str(out/'unicode-source.png'))
        click('Close');run('wait','800')
        run('record','stop');active=False
        probe=json.loads(subprocess.check_output(['ffprobe','-v','error','-show_entries','format=duration','-of','json',str(source)]));duration=float(probe['format']['duration']);assert duration>2
        stretch=max(1,min(6,42/duration));video=out/'inspector.mp4'
        subprocess.run(['ffmpeg','-v','error','-i',str(source),'-vf',f'setpts={stretch}*PTS','-an','-c:v','libx264','-crf','20','-pix_fmt','yuv420p','-movflags','+faststart',str(video)],check=True)
        probe=json.loads(subprocess.check_output(['ffprobe','-v','error','-show_entries','format=duration:stream=width,height,codec_name','-of','json',str(video)]))
        assert before==build_fingerprint(),'Build changed during recording'
        (out/'summary.json').write_text(json.dumps(dict(tool='agent-browser',passed=True,fixtureOnly=True,modelCalls=0,sourceBuildSha256=before,rawDuration=duration,playbackStretch=stretch,probe=probe,states=['release entry','historical tree','nested duplicate selection','search and clear','copy tooltip','version identity','JSON syntax','no results','Unicode source','return to release'],limits=['Disposable PostgreSQL/OIDC and fixture source, no real workspace edits.','Playback may be slowed for readability; viewport and page stay fixed during capture. Narrow layouts are qualified separately.']),indent=2)+'\n')
        (out/'snapshots.txt').write_text('\n\n'.join(log))
    finally:
        if active:subprocess.run([*prefix,'record','stop'],capture_output=True,timeout=30)
        subprocess.run([*prefix,'close'],capture_output=True,timeout=30);w.close()

if __name__=='__main__':
    p=argparse.ArgumentParser(description=__doc__);p.add_argument('--pg-bin');p.add_argument('--output',type=Path,required=True);main(p.parse_args())
