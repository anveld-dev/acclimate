"""Record a disposable workspace walkthrough using agent-browser, never model calls."""
import json
import subprocess
import uuid
from pathlib import Path


def record(w,b,routes,out):
    session='acclimate-workspace-'+uuid.uuid4().hex[:8]
    prefix=['agent-browser','--session',session,'--ignore-https-errors']
    log=[]
    def run(*args):
        result=subprocess.run([*prefix,*args],text=True,capture_output=True,timeout=45)
        # No secret issuance is performed or credential material printed in this walkthrough.
        if result.returncode: raise AssertionError('agent-browser '+args[0]+' failed: '+result.stderr[:500])
        if args[0]=='snapshot': log.append(result.stdout)
        return result.stdout
    def snapshot():run('snapshot','-i')
    def click(role,name):
        snapshot();run('find','role',role,'click','--name',name,'--exact');run('wait','500')
    def open_view(name):
        run('open',b.base+routes[name]);run('wait','--load','networkidle');snapshot();run('wait','700')
    video=out/'workspace-walkthrough.webm'
    active=False
    try:
        run('open',b.base+'/auth/login');snapshot()
        run('find','label','Fixture subject','fill','operator')
        click('button','Sign in to fixture');run('wait','--load','networkidle')
        run('set','viewport','1440','1000')
        open_view('bundles')
        run('record','start',str(video));active=True
        run('wait','900')
        run('hover','a[aria-label="Connections"]');run('wait','650')
        snapshot();run('find','label','Find a bundle','fill','Payment');run('wait','650');snapshot()
        run('find','label','Find a bundle','fill','');run('wait','500')
        click('button','New bundle');run('scroll','down','500');run('wait','900')
        open_view('members')
        # Open one identity disclosure from an observed, current snapshot.
        snapshot();run('find','first','.workspace-member-row [data-slot="disclosure-trigger"]','click');run('wait','700')
        snapshot();run('find','first','.member-role-trigger','click');run('wait','700');run('press','Escape')
        click('button','Invite member');snapshot();run('find','label','Email','fill','new.teammate@example.test')
        run('select','#membership-role','editor');run('wait','900');click('button','Cancel')
        snapshot();run('find','first','.member-actions-trigger','click');click('menuitem','Remove access');run('wait','900');click('button','Keep member')
        open_view('connections');click('button','New connection');run('wait','900');click('button','Cancel')
        open_view('connection-detail')
        click('button','Connection ID');run('wait','650');click('button','Connection ID')
        click('button','Optional delivery reports & credentials');run('scroll','down','300');run('wait','900')
        snapshot();run('find','first','.connection-credential-row button','click');run('wait','900');click('button','Cancel')
        run('scrollintoview','.connection-reports-panel');run('wait','700')
        snapshot();run('find','first','.connection-report-trigger','click');run('wait','1000')
        run('screenshot',str(out/'recorded-report-details.png'))
        open_view('members');run('set','viewport','1024','900');run('wait','700')
        run('set','viewport','390','844');run('wait','800');run('scroll','down','650');run('wait','800')
        run('set','viewport','1440','1000');open_view('bundles');run('wait','1000')
        run('record','stop');active=False
        probe=subprocess.run(['ffprobe','-v','error','-show_entries','format=duration:stream=width,height,codec_name','-of','json',str(video)],capture_output=True,text=True,check=True)
        metadata=json.loads(probe.stdout)
        assert float(metadata['format']['duration'])>5
        readable=out/'workspace-walkthrough.mp4'
        subprocess.run(['ffmpeg','-v','error','-i',str(video),'-vf','setpts=5*PTS','-an','-c:v','libx264','-crf','20','-pix_fmt','yuv420p','-movflags','+faststart',str(readable)],check=True)
        metadata['playbackRate']=0.2
        metadata['readableVideo']=readable.name
        (out/'video-summary.json').write_text(json.dumps(dict(recorded=True,tool='agent-browser',fixtureOnly=True,modelCalls=0,noSecretIssuance=True,video=video.name,metadata=metadata),indent=2)+'\n')
        (out/'walkthrough-snapshots.txt').write_text('\n\n'.join(log))
        return video
    finally:
        if active:
            subprocess.run([*prefix,'record','stop'],capture_output=True,timeout=30)
        subprocess.run([*prefix,'close'],capture_output=True,timeout=30)
