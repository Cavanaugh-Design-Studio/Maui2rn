import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { MauiClass } from './model.js';

const project = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../analyzer/MauiRoslyn.csproj');
async function processOutput(command: string, args: string[], timeoutMs: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { shell: false, windowsHide: true, stdio: ['ignore','pipe','pipe'] });
    let stdout = '', stderr = '';
    const timer = setTimeout(() => child.kill(), timeoutMs);
    child.stdout.on('data', b => { stdout += b; if (stdout.length > 40_000_000) child.kill(); });
    child.stderr.on('data', b => { stderr += b; if (stderr.length > 2_000_000) child.kill(); });
    child.on('error', e => { clearTimeout(timer); reject(e); });
    child.on('close', code => { clearTimeout(timer); code === 0 ? resolve(stdout) : reject(new Error(`${command} exited ${code}: ${stderr.slice(-2000) || stdout.slice(-2000)}`)); });
  });
}
export async function roslynClasses(root: string): Promise<{analysisMode:'semantic'|'syntax';classes:MauiClass[]}> {
  await processOutput('dotnet', ['build', project, '--configuration','Release','--nologo','--verbosity','quiet'], 120_000);
  const dll = path.join(path.dirname(project), 'bin', 'Release', 'net9.0', 'MauiRoslyn.dll');
  return JSON.parse(await processOutput('dotnet', [dll, root], 120_000)) as {analysisMode:'semantic'|'syntax';classes:MauiClass[]};
}
