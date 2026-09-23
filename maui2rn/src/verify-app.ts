import { spawn } from 'node:child_process';
import { access, mkdir } from 'node:fs/promises';
import path from 'node:path';
import type { Finding } from './model.js';
import { writeJson } from './util.js';
import { currentFindings, findingId, resolutions } from './findings.js';

type Check = {passed:boolean;durationMs:number;output:string};
async function run(script: string, args: string[], cwd: string, timeoutMs: number): Promise<Check> {
  const start=Date.now();
  return new Promise(resolve=>{
    const child=spawn(process.execPath,[script,...args],{cwd,shell:false,windowsHide:true,stdio:['ignore','pipe','pipe']});
    let output='', timedOut=false;
    const append=(data:Buffer)=>{ output=(output+data.toString()).slice(-12_000); };
    child.stdout.on('data',append); child.stderr.on('data',append);
    const timer=setTimeout(()=>{timedOut=true;child.kill();},timeoutMs);
    child.on('error',e=>{clearTimeout(timer);resolve({passed:false,durationMs:Date.now()-start,output:e.message});});
    child.on('close',code=>{clearTimeout(timer);resolve({passed:code===0&&!timedOut,durationMs:Date.now()-start,output:timedOut?`Timed out after ${timeoutMs} ms\n${output}`:output});});
  });
}
async function androidBuild(root:string):Promise<Check> {
  const start=Date.now();
  return new Promise(resolve=>{
    const windows=process.platform==='win32';
    const child=spawn(windows?(process.env.ComSpec??'cmd.exe'):'./gradlew',windows?['/d','/s','/c','gradlew.bat','assembleDebug']:['assembleDebug'],{cwd:path.join(root,'android'),shell:false,windowsHide:true,stdio:['ignore','pipe','pipe']});
    let output='',timedOut=false,finished=false;
    const append=(data:Buffer)=>{output=(output+data.toString()).slice(-12_000);};
    const done=(passed:boolean,message?:string)=>{if(finished)return;finished=true;clearTimeout(timer);resolve({passed,durationMs:Date.now()-start,output:message??output});};
    child.stdout.on('data',append);child.stderr.on('data',append);
    const timer=setTimeout(()=>{timedOut=true;child.kill();},600_000);
    child.on('error',e=>done(false,e.message));
    child.on('close',code=>done(code===0&&!timedOut,timedOut?`Timed out after 600000 ms\n${output}`:undefined));
  });
}
export async function verifyApp(appRoot: string, options:{androidNative?:boolean}={}): Promise<{reportFile:string;report:{typecheck:Check;jest:Check;androidBundle:Check;iosBundle:Check;androidNative?:Check;unresolvedHigh:(Finding & {id:string})[];readyForNativeBuild:boolean}}> {
  const root=path.resolve(appRoot);
  const tsc=path.join(root,'node_modules','typescript','bin','tsc');
  const rn=path.join(root,'node_modules','react-native','cli.js');
  const jest=path.join(root,'node_modules','jest','bin','jest.js');
  await access(tsc); await access(rn); await access(jest);
  const outputRoot=path.join(root,'.maui2rn','verify');
  await mkdir(outputRoot,{recursive:true});
  const typecheck=await run(tsc,['--noEmit'],root,120_000);
  const jestCheck=typecheck.passed ? await run(jest,['--runInBand','--forceExit'],root,120_000) : {passed:false,durationMs:0,output:'Skipped after failed typecheck'};
  const bundles: Record<'android'|'ios',Check>={android:{passed:false,durationMs:0,output:'Skipped'},ios:{passed:false,durationMs:0,output:'Skipped'}};
  if (typecheck.passed) for (const platform of ['android','ios'] as const) {
    bundles[platform]=await run(rn,['bundle','--platform',platform,'--dev','false','--entry-file','index.js','--bundle-output',path.join(outputRoot,`${platform}.bundle`),'--assets-dest',path.join(outputRoot,`${platform}-assets`)],root,240_000);
  }
  const findings=await currentFindings(root);
  const resolved=new Set((await resolutions(root)).map(x=>x.id));
  const unresolvedHigh=findings.filter(f=>f.severity==='high'&&!resolved.has(findingId(f))).map(f=>({...f,id:findingId(f)}));
  const androidNative=options.androidNative ? (typecheck.passed&&bundles.android.passed ? await androidBuild(root) : {passed:false,durationMs:0,output:'Skipped after failed JavaScript checks'}) : undefined;
  const report={typecheck,jest:jestCheck,androidBundle:bundles.android,iosBundle:bundles.ios,androidNative,unresolvedHigh,readyForNativeBuild:typecheck.passed&&jestCheck.passed&&bundles.android.passed&&bundles.ios.passed&&unresolvedHigh.length===0};
  const reportFile=path.join(outputRoot,'report.json');
  await writeJson(reportFile,report);
  return {reportFile,report};
}
