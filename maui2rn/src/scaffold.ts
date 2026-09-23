import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { rnVersion } from './convert.js';
import { sha256, writeJson } from './util.js';

const require = createRequire(import.meta.url);
export async function scaffold(appName: string, directory: string, skipInstall = false): Promise<string> {
  if (!/^[A-Z][A-Za-z0-9]{1,49}$/.test(appName)) throw new Error('App name must be 2-50 alphanumeric characters and begin with a capital letter');
  const target = path.resolve(directory);
  if (existsSync(target)) throw new Error(`Target already exists: ${target}`);
  const cliPackage = require.resolve('@react-native-community/cli/package.json');
  const cli = path.join(path.dirname(cliPackage),'build','bin.js');
  const args = [cli,'init',appName,'--directory',target,'--version',rnVersion,'--pm','npm','--skip-git-init','true','--install-pods','false'];
  if (skipInstall) args.push('--skip-install');
  await new Promise<void>((resolve,reject) => {
    const child = spawn(process.execPath,args,{stdio:'inherit',shell:false,windowsHide:true});
    child.on('error',reject);
    child.on('close',code => code === 0 ? resolve() : reject(new Error(`React Native CLI exited ${code}`)));
  });
  if (!existsSync(path.join(target,'android')) || !existsSync(path.join(target,'ios'))) throw new Error('React Native CLI did not create both native projects');
  await writeJson(path.join(target,'.maui2rn','bootstrap.json'),{
    schemaVersion:1, reactNative:rnVersion,
    files:{'App.tsx':sha256(await readFile(path.join(target,'App.tsx'))),'package.json':sha256(await readFile(path.join(target,'package.json'))),'jest.config.js':sha256(await readFile(path.join(target,'jest.config.js')))}
  });
  return target;
}
