#!/usr/bin/env python3
"""Check production Rust authority against private PostgreSQL. No live OIDC/provider login."""
import argparse
import json
import secrets
import subprocess
from urllib.request import Request,urlopen
from urllib.error import HTTPError
from qualify import Harness,ROOT,payload

parser=argparse.ArgumentParser(description=__doc__)
parser.add_argument('--pg-bin',required=True)
parser.add_argument('--skip-build',action='store_true')
args=parser.parse_args()
if not args.skip_build:
    subprocess.run(['cargo','build','--locked','--bin','acclimate-service'],cwd=ROOT,check=True)
h=Harness(args.pg_bin)
login,transport=secrets.token_hex(32),secrets.token_hex(32)
issuer='https://identity.example.invalid'
h.env.update(ACCLIMATE_OIDC_ISSUER=issuer,ACCLIMATE_LOGIN_TOKEN=login,ACCLIMATE_CONSOLE_TOKEN=transport,ACCLIMATE_OPERATORS=json.dumps([{'issuer':issuer,'subject':'operator'}]))
def call(method,path,token,body=None,session=None,status=200):
    headers={'Authorization':'Bearer '+token,'Content-Type':'application/json','Idempotency-Key':secrets.token_hex(16)}
    if session:headers['X-Acclimate-Session']=session
    try:r=urlopen(Request(h.base+path,data=json.dumps(body).encode() if body is not None else None,headers=headers,method=method),timeout=10)
    except HTTPError as e:r=e
    value=r.read()
    assert r.status==status,(method,path,r.status,'unexpected fixture response; body withheld')
    return json.loads(value) if value else None
try:
    h.start()
    call('GET','/v1/workspaces',transport,status=401)
    # SDK grants remain usable without browser sessions with production authentication.
    assert h.call('GET','/v1/workspaces')['items']
    operator=call('POST','/v1/auth/sessions',login,{'issuer':issuer,'subject':'operator'})
    member=call('POST','/v1/auth/sessions',login,{'issuer':issuer,'subject':'member'})
    call('POST','/v1/workspaces',transport,{'id':'not-allowed','name':'Denied'},member['secret'],403)
    project=call('POST','/v1/workspaces',transport,{'id':'hosted-fixture','name':'Hosted fixture'},operator['secret'])
    assert project['role']=='admin'
    entries=call('GET','/v1/workspaces',transport,session=operator['secret'])['items']
    assert any(p['id']=='hosted-fixture' and p['role']=='admin' for p in entries)
    root='/v1/workspaces/hosted-fixture'
    setup=call('POST',root+'/bundle-setups',transport,{'name':'Private hosted bundle','origin':'created','channel':'stable','payload':payload('Review fixtures.'),'reason':'Explicit authority fixture'},operator['secret'],201)
    bundle=root+'/bundles/'+setup['bundle']['id']
    membership=root+'/memberships/'+member['userId']
    call('PUT',membership,transport,{'role':'editor'},operator['secret'],204)
    call('GET',bundle+'/channels/stable',transport,session=member['secret'])
    call('PUT',membership,transport,{'role':'viewer'},operator['secret'],204)
    call('POST',bundle+'/versions',transport,{'parentVersionId':setup['version']['id'],'payload':payload('Denied edit.')},member['secret'],403)
    call('DELETE',membership,transport,session=operator['secret'],status=204)
    call('GET',bundle+'/channels/stable',transport,session=member['secret'],status=403)
    call('DELETE','/v1/auth/session',transport,session=member['secret'],status=204)
    call('GET','/v1/auth/session',transport,session=member['secret'],status=401)
    renewed=call('POST','/v1/auth/sessions',login,{'issuer':issuer,'subject':'member'},member['secret'])
    assert renewed['userId']==member['userId'] and renewed['secret']!=member['secret']
    print(json.dumps({'authority':'Rust + private PostgreSQL','checks':['no session denied','machine SDK with production authentication','operator bootstrap','nonoperator denied','dynamic project access','editor read','viewer write denied','removed membership denied','session revocation','sign-in after revoked cookie'],'liveOIDC':'not tested','errors':[]},indent=2))
finally:h.close()
