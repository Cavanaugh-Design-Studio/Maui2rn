import path from 'node:path';
import type { Finding, Proposal } from './model.js';
import { readJson, sha256, writeJson } from './util.js';

export type ResolvedFinding = {id:string;evidence:string;resolvedAt:string};
export const findingId = (finding: Finding): string => sha256(`${finding.code}\n${finding.source ?? ''}\n${finding.message}`).slice(0,16);
export async function currentFindings(appRoot: string): Promise<Finding[]> {
  const root=path.resolve(appRoot);
  try {
    const manifest=await readJson<{applied:string[]}>(path.join(root,'.maui2rn','manifest.json'));
    const id=manifest.applied.at(-1);
    if (id) return (await readJson<Proposal>(path.join(root,'.maui2rn','proposals',`${id}.json`))).findings;
  } catch(e) { if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e; }
  return (await readJson<{findings:Finding[]}>(path.join(root,'src','domain','migrationReport.json'))).findings;
}
export async function resolutions(appRoot: string): Promise<ResolvedFinding[]> {
  try { return await readJson<ResolvedFinding[]>(path.join(appRoot,'.maui2rn','resolutions.json')); }
  catch(e) { if ((e as NodeJS.ErrnoException).code==='ENOENT') return []; throw e; }
}
export async function resolveFinding(appRoot: string, id: string, evidence: string): Promise<ResolvedFinding> {
  if (!/^[a-f0-9]{16}$/.test(id)) throw new Error('Invalid finding id');
  if (evidence.trim().length<10 || evidence.length>2000) throw new Error('Evidence must be 10-2000 characters');
  const findings=await currentFindings(appRoot);
  if (!findings.some(f=>findingId(f)===id)) throw new Error('Finding is not in the current applied proposal');
  const existing=await resolutions(appRoot);
  const resolution={id,evidence:evidence.trim(),resolvedAt:new Date().toISOString()};
  await writeJson(path.join(appRoot,'.maui2rn','resolutions.json'),[...existing.filter(x=>x.id!==id),resolution]);
  return resolution;
}
