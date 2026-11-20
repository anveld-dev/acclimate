"""Public Python SDK consumer; only fixture configuration is accepted."""
import json
import sys
import uuid
from pathlib import Path
from acclimate import AcclimateClient, ApiError, TransportError, DeliveryError, resolve_and_cache, prepare_files, DeliveryReporter

c=json.loads(Path(sys.argv[1]).read_text())
client=AcclimateClient(c['baseUrl'],c['token'],c['scope'],retries=0,timeout=2)
p,b=c['workspaceId'],c['bundleId']
key=lambda:uuid.uuid4().hex

def delivery():
    reporter=None
    prepared=None
    if c.get('reporting'):
        rc=AcclimateClient(c['baseUrl'],c.get('receiptToken','fixture-invalid-report-token'),'python-reporter',retries=0,timeout=1)
        reporter=DeliveryReporter(rc,p,c['connectionId'])
    try:
        bundle=resolve_and_cache(client,p,b,channel='stable',cache_dir=str(Path(c['directory'])/'python-cache'),offline={'max_age_ms': 300_000} if c.get('offline') else None,reporter=reporter)
        destination=Path(c['directory'])/('python-prepared-'+key())
        prepared=prepare_files(bundle,str(destination))
        started=False
        if reporter:
            # Observe actual app output, then report that start. No provider is called.
            import subprocess
            app=subprocess.run([sys.executable,'-c',"print('app started')"],capture_output=True,text=True,check=True,timeout=5)
            started=app.stdout.strip()=='app started'
            if started:
                bundle['reporter'].report_started()
            reporter.wait(2)
        return dict(version=bundle['version'],stale=bundle['stale'],instruction=(destination/'AGENTS.md').read_text(),started=started,pending=reporter.pending_count if reporter else 0)
    finally:
        if prepared: prepared.cleanup()
        if reporter: reporter.close(0)

def author():
    resolution,_,_=client.resolve_channel(p,b,'stable')
    parent=resolution['version']
    content=dict(schemaVersion=1,files=[dict(path='AGENTS.md',kind='instruction',text='Python review retries.')])
    version=client.create_version(p,b,dict(parentVersionId=parent['id'],payload=content),key())
    published=client.create_release(p,b,'stable',dict(
        versionId=version['id'],expectedRevision=resolution['revision'],unevaluatedReason='Python fixture release'),key())
    current,_,_=client.resolve_channel(p,b,'stable')
    return dict(version=version,published=published,current=current)

try:
    result=author() if c['action']=='pythonAuthor' else delivery()
    print(json.dumps(result))
except (ApiError,TransportError,DeliveryError) as error:
    print(json.dumps(dict(error=dict(name=type(error).__name__,code=getattr(error,'code',None),status=getattr(error,'status',None)))))
