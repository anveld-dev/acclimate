import { readFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { AcclimateClient } from '../../packages/sdk/src/index.js';
const args = process.argv.slice(2);
const value = (name:string) => { const i=args.indexOf(name); return i<0 ? undefined : args[i+1]; };
const file=value('--summary'); if (!file) throw new Error('--summary is required');
const summary=JSON.parse(await readFile(file,'utf8'));
const revision=value('--expected-revision');
const plan={project:summary.project,bundle:summary.bundle,channel:summary.channel,versionId:summary.candidate.id,comparisonId:summary.comparisonId,expectedRevision:revision ?? summary.channelRevision};
if (!args.includes('--apply')) console.log(JSON.stringify({plan,message:'Review the artifacts and pass --apply with --expected-revision.'},null,2));
else {
  if (!revision) throw new Error('--expected-revision is required with --apply');
  const required=(name:string)=>{const v=process.env[name];if(!v) throw new Error(`${name} is required`);return v;};
  const client=new AcclimateClient({baseUrl:required('ACCLIMATE_URL'),token:required('ACCLIMATE_TOKEN'),scope:required('ACCLIMATE_SCOPE')});
  console.log(JSON.stringify(await client.promote(plan.project,plan.bundle,plan.channel,{versionId:plan.versionId,comparisonId:plan.comparisonId,expectedRevision:revision},randomUUID()),null,2));
}
