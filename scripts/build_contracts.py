#!/usr/bin/env python3
"""Write R0 OpenAPI from the checked-in wire shape; no runtime generation."""
import json
from pathlib import Path
ROOT = Path(__file__).resolve().parents[1]
def ref(name): return {'$ref': '#/components/schemas/' + name}
def obj(props, required=None): return {'type': 'object', 'additionalProperties': False, 'properties': props, 'required': list(props) if required is None else required}
def arr(items, **kw): return {'type': 'array', 'items': items, **kw}
def nullable(schema): return {'anyOf': [schema, {'type': 'null'}]}
string = {'type': 'string'}
nonempty = {'type': 'string', 'minLength': 1}
digest = {'type': 'string', 'pattern': '^sha256:[0-9a-f]{64}$'}
stamp = {'type': 'string', 'format': 'date-time'}
S = {}
S['BundlePayload'] = json.loads((ROOT/'contracts/bundle.schema.json').read_text()); S['BundlePayload'].pop('$schema'); S['BundlePayload'].pop('$id')
S['Bundle'] = obj({'id': string, 'name': nonempty, 'projectId': string, 'createdAt': stamp})
S['VersionMetadata'] = obj({'id': string, 'bundleId': string, 'parentVersionId': nullable(string), 'digest': digest, 'createdAt': stamp})
S['CreateBundleRequest'] = obj({'name': nonempty})
S['CreateVersionRequest'] = obj({'parentVersionId': nullable(string), 'payload': ref('BundlePayload')})
S['ChannelResolution'] = obj({'channel': string, 'revision': {'type': 'string', 'pattern': '^[1-9][0-9]*$'}, 'version': ref('VersionMetadata')})
S['PromoteRequest'] = obj({'versionId': nonempty, 'expectedRevision': {'type': 'string', 'pattern': '^(0|[1-9][0-9]*)$'}, 'comparisonId': nonempty, 'unevaluatedReason': nonempty}, ['versionId', 'expectedRevision'])
S['PromoteRequest']['oneOf'] = [{'required': ['comparisonId'], 'not': {'required': ['unevaluatedReason']}}, {'required': ['unevaluatedReason'], 'not': {'required': ['comparisonId']}}]
S['Promotion'] = obj({'id': string, 'channel': string, 'revision': string, 'version': ref('VersionMetadata'), 'previousVersionId': nullable(string), 'comparisonId': nullable(string), 'unevaluatedReason': nullable(string), 'reviewer': string, 'createdAt': stamp})
S['PromotionPage'] = obj({'items': arr(ref('Promotion')), 'nextBeforeRevision': nullable({'type':'string','pattern':'^[1-9][0-9]*$'})})
S['ProposalRequest'] = obj({'parentVersionId': nonempty, 'allowedPaths': arr(nonempty, minItems=1, maxItems=128, uniqueItems=True), 'hypothesis': nonempty, 'evidence': arr(string, maxItems=20)})
S['Proposal'] = obj({'id': string, 'parentVersionId': string, 'status': {'enum': ['queued','running','succeeded','failed']}, 'attempts': {'type':'integer','minimum':0,'maximum':3}, 'candidate': nullable(ref('VersionMetadata')), 'rationale': nullable(string), 'error': nullable(string), 'createdAt': stamp})
S['CaseKey'] = obj({'caseId': nonempty, 'repetition': {'type': 'integer', 'minimum': 0}})
S['Usage'] = obj({'inputTokens': {'type':'integer','minimum':0}, 'outputTokens': {'type':'integer','minimum':0}, 'costUsd': {'type':'number','minimum':0}}, [])
S['Outcome'] = obj({'executionStatus': {'enum':['completed','task_failed','infrastructure_failed']}, 'gradingStatus': {'enum':['scored','missing','failed']}, 'reward': nullable({'type':'number'}), 'outputRef': nullable(string), 'error': nullable(string), 'usage': nullable(ref('Usage'))})
S['CasePair'] = obj({**S['CaseKey']['properties'], 'parent': ref('Outcome'), 'candidate': ref('Outcome')})
S['ComparisonRequest'] = obj({'parentVersionId': nonempty, 'candidateVersionId': nonempty, 'parentDigest': digest, 'candidateDigest': digest, 'datasetRevision': nonempty, 'runtime': {'type':'object','additionalProperties':string,'minProperties':1}, 'graderRevision': nonempty, 'expectedCases': arr(ref('CaseKey'), minItems=1, maxItems=1000, uniqueItems=True), 'results': arr(ref('CasePair'), maxItems=1000)})
S['Comparison'] = obj({**S['ComparisonRequest']['properties'], 'id': string, 'complete': {'type':'boolean'}, 'submitter': string, 'createdAt': stamp})
S['ApiError'] = obj({'error': obj({'code': nonempty, 'message': nonempty, 'requestId': nonempty})})
prefix='/v1/projects/{projectId}'
paths={}
entries=[
('post','/bundles','createBundle','CreateBundleRequest','Bundle',201),
('post','/bundles/{bundleId}/versions','createVersion','CreateVersionRequest','VersionMetadata',201),
('get','/bundles/{bundleId}/versions/{versionId}','getVersion',None,'VersionMetadata',200),
('get','/bundles/{bundleId}/versions/{versionId}/payload','getPayload',None,'BundlePayload',200),
('get','/bundles/{bundleId}/channels/{channel}','resolveChannel',None,'ChannelResolution',200),
('get','/bundles/{bundleId}/channels/{channel}/promotions','listPromotions',None,'PromotionPage',200),
('post','/bundles/{bundleId}/channels/{channel}/promotions','promote','PromoteRequest','Promotion',201),
('post','/bundles/{bundleId}/proposals','createProposal','ProposalRequest','Proposal',202),
('get','/bundles/{bundleId}/proposals/{proposalId}','getProposal',None,'Proposal',200),
('post','/bundles/{bundleId}/comparisons','createComparison','ComparisonRequest','Comparison',201),
('get','/bundles/{bundleId}/comparisons/{comparisonId}','getComparison',None,'Comparison',200)]
for method,path,op,request,response,status in entries:
 full=prefix+path
 params=[{'name':part[1:-1], 'in':'path', 'required':True, 'schema':nonempty} for part in full.split('/') if part.startswith('{')]
 if method=='post': params.append({'name':'Idempotency-Key','in':'header','required':True,'schema':{'type':'string','minLength':1,'maxLength':128},'description':'Replay same key and exact request bytes within 24h. Different bytes conflict.'})
 if op=='listPromotions': params.extend([{'name':'limit','in':'query','schema':{'type':'integer','minimum':1,'maximum':100,'default':20}}, {'name':'beforeRevision','in':'query','schema':{'type':'string','pattern':'^[1-9][0-9]*$'},'description':'Exclusive older-than bound. Opaque cursor, newest revision first.'}])
 if op=='resolveChannel': params.append({'name':'If-None-Match','in':'header','schema':string})
 responses={str(status):{'description':'Success', 'content':{'application/json':{'schema':ref(response)}}}}
 if op=='getPayload': responses[str(status)]['description']='Exact immutable UTF-8 payload bytes; hash these bytes before JSON parsing.'
 if op=='resolveChannel':
  responses['200']['headers']={'ETag':{'schema':string,'description':'Opaque channel validator; retain the server value.'}}
  responses['304']={'description':'Unchanged mapping, no response body.','headers':{'ETag':{'schema':string}}}
 for code,desc in [(400,'Invalid content, unsupported schema, or invalid request.'),(401,'Unauthenticated.'),(403,'Project right denied.'),(404,'Scoped record not found.'),(409,'Revision, parent, or mutation-key conflict.'),(413,'Request exceeds size limit.'),(503,'Temporarily unavailable.')]:
  responses[str(code)]={'description':desc,'content':{'application/json':{'schema':ref('ApiError')}}}
 item={'operationId':op,'parameters':params,'responses':responses}
 if request:item['requestBody']={'required':True,'content':{'application/json':{'schema':ref(request)}}}
 paths.setdefault(full,{})[method]=item
paths['/health']={'get':{'operationId':'health','security':[],'responses':{'200':{'description':'Process liveness.'}}}}
spec={'openapi':'3.1.0','info':{'title':'Acclimate content service','version':'0.1.0','description':'R0. App-reported comparisons; native execution stays with the app. See contracts/IMPLEMENTATION.md for semantic validation, limits and promotion rules.'},'security':[{'bearerAuth':[]}],'paths':paths,'components':{'securitySchemes':{'bearerAuth':{'type':'http','scheme':'bearer'}},'schemas':S}}
# JSON is valid YAML 1.2; this keeps generation dependency-free.
(ROOT/'contracts/openapi.yaml').write_text(json.dumps(spec,indent=2)+'\n')
