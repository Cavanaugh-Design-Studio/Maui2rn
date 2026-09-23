import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, readdir, realpath, rename, stat, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';

export const sha256 = (input: string | Buffer): string => createHash('sha256').update(input).digest('hex');
export const json = (value: unknown): string => JSON.stringify(value, null, 2) + '\n';
export async function readJson<T>(file: string): Promise<T> { return JSON.parse(await readFile(file, 'utf8')) as T; }
export async function writeJson(file: string, value: unknown): Promise<void> {
  await mkdir(path.dirname(file), { recursive: true });
  const temp = `${file}.${randomUUID()}.tmp`;
  try { await writeFile(temp,json(value),{flag:'wx'}); await rename(temp,file); }
  finally { await unlink(temp).catch(()=>{}); }
}
export function safeRelative(value: string): string {
  if (!value || path.isAbsolute(value) || value.includes('\\') || value.split('/').some(x => x === '..' || x === '.' || !x)) throw new Error(`Unsafe relative path: ${value}`);
  return value;
}
export function inside(root: string, target: string): boolean { const rel = path.relative(root, target); return rel === '' || (!rel.startsWith('..' + path.sep) && rel !== '..' && !path.isAbsolute(rel)); }
export async function existingRoot(value: string): Promise<string> { const p = await realpath(value); if (!(await stat(p)).isDirectory()) throw new Error(`Not a directory: ${p}`); return p; }
export async function filesUnder(root: string, maxFiles = 10000): Promise<string[]> {
  const out: string[] = [];
  async function walk(dir: string): Promise<void> {
    for (const item of await readdir(dir, { withFileTypes: true })) {
      if (['bin','obj','node_modules','.git','.vs'].includes(item.name)) continue;
      const full = path.join(dir, item.name);
      if (item.isSymbolicLink()) continue;
      if (item.isDirectory()) await walk(full);
      else if (item.isFile()) { out.push(full); if (out.length > maxFiles) throw new Error(`Input exceeds ${maxFiles} files`); }
    }
  }
  await walk(root); return out.sort();
}
export function slug(input: string): string { return input.replace(/[^A-Za-z0-9_]/g, '_').replace(/^\d/, '_$&') || 'Unnamed'; }
export async function boundedText(file: string, maxBytes = 2_000_000): Promise<string> { const size = (await stat(file)).size; if (size > maxBytes) throw new Error(`File too large: ${file}`); return readFile(file, 'utf8'); }
