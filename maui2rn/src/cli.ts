#!/usr/bin/env node
import { Command } from 'commander';
import path from 'node:path';
import { analyze } from './analyze.js';
import { applyProposal, propose, saveProposal } from './convert.js';
import { scaffold } from './scaffold.js';
import { assist } from './assist.js';
import { verifyApp } from './verify-app.js';
import { reviewProposal } from './review.js';
import { currentFindings, findingId, resolveFinding, resolutions } from './findings.js';
import { readJson, writeJson } from './util.js';
import type { MauiModel, Proposal } from './model.js';

const program = new Command();
program.name('maui2rn').description('Reviewable .NET MAUI to React Native migration harness').version('0.2.0');
program.command('analyze').argument('<input>', 'MAUI solution, project, or directory').option('-o, --out <file>', 'report JSON').action(async (input,opts) => {
  const model = await analyze(input);
  const file = path.resolve(opts.out ?? path.join(process.cwd(),'maui2rn-report.json'));
  await writeJson(file,model);
  console.log(JSON.stringify({report:file,coverage:model.coverage,findings:model.findings.length}));
});
program.command('scaffold').requiredOption('--name <name>', 'React Native app name').requiredOption('--out <directory>', 'new app directory').option('--skip-install', 'skip npm install for offline/template review').action(async opts => {
  const target = await scaffold(opts.name,opts.out,Boolean(opts.skipInstall));
  console.log(JSON.stringify({appRoot:target,reactNative:'0.87.1',dependenciesInstalled:!opts.skipInstall}));
});
program.command('convert').requiredOption('--report <file>', 'analysis report').requiredOption('--app <directory>', 'React Native app').action(async opts => {
  const model = await readJson<MauiModel>(path.resolve(opts.report));
  const proposal = await propose(model,path.resolve(opts.app));
  const file = await saveProposal(proposal);
  console.log(JSON.stringify({proposal:file,id:proposal.id,files:proposal.files.length,highRisk:proposal.findings.filter(f=>f.severity==='high').length,findings:proposal.findings.length}));
});
program.command('assist').requiredOption('--report <file>', 'analysis report').requiredOption('--proposal <file>', 'conversion proposal').requiredOption('--page <name>', 'MAUI page id').description('Run read-only Codex specialists and save a revised proposal').action(async opts => {
  const output=await assist(path.resolve(opts.report),path.resolve(opts.proposal),opts.page);
  console.log(JSON.stringify(output));
});
program.command('review').requiredOption('--proposal <file>', 'exact proposal to review').option('--port <number>', 'localhost port', '0').description('Open a local visual review with per-file approval').action(async opts => {
  console.log(JSON.stringify(await reviewProposal(path.resolve(opts.proposal),Number(opts.port))));
});
program.command('apply').requiredOption('--proposal <file>', 'exact proposal to apply').option('--approve-high-risk', 'acknowledge high risk findings after review').option('--review-receipt', 'use a complete visual review receipt').option('--accept-template', 'replace unmodified React Native template files').action(async opts => {
  const result = await applyProposal(path.resolve(opts.proposal),{approveHighRisk:Boolean(opts.approveHighRisk),reviewReceipt:Boolean(opts.reviewReceipt),acceptTemplate:Boolean(opts.acceptTemplate)});
  console.log(JSON.stringify(result));
});
program.command('status').requiredOption('--app <directory>', 'React Native app').action(async opts => {
  const root = path.resolve(opts.app);
  const manifest = await readJson<{files:Record<string,string>;applied:string[]}>(path.join(root,'.maui2rn','manifest.json'));
  const resolved=new Set((await resolutions(root)).map(x=>x.id));
  const findings=(await currentFindings(root)).map(f=>({...f,id:findingId(f),resolved:resolved.has(findingId(f))}));
  console.log(JSON.stringify({appRoot:root,managedFiles:Object.keys(manifest.files).length,applied:manifest.applied,findings},null,2));
});
program.command('resolve').requiredOption('--app <directory>', 'React Native app').requiredOption('--id <id>', 'finding id from status').requiredOption('--evidence <text>', 'specific fix and verification evidence').description('Record human resolution of one migration finding').action(async opts => {
  console.log(JSON.stringify(await resolveFinding(path.resolve(opts.app),opts.id,opts.evidence)));
});
program.command('verify-app').requiredOption('--app <directory>', 'installed React Native app').option('--android-native', 'also run Gradle assembleDebug (requires Android SDK)').description('Typecheck and Metro bundle both platforms, then report unresolved risks').action(async opts => {
  const output=await verifyApp(path.resolve(opts.app),{androidNative:Boolean(opts.androidNative)});
  console.log(JSON.stringify({report:output.reportFile,typecheck:output.report.typecheck.passed,jest:output.report.jest.passed,androidBundle:output.report.androidBundle.passed,iosBundle:output.report.iosBundle.passed,androidNative:output.report.androidNative?.passed,unresolvedHigh:output.report.unresolvedHigh.length,readyForNativeBuild:output.report.readyForNativeBuild}));
  if (!output.report.readyForNativeBuild || output.report.androidNative?.passed===false) process.exitCode=1;
});
program.command('mcp').description('serve MCP over stdio').action(async () => { await import('./mcp.js'); });
program.parseAsync().catch(e => { console.error(e instanceof Error ? e.message : String(e)); process.exitCode=1; });
