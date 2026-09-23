import { McpServer } from '@modelcontextprotocol/server';
import { serveStdio } from '@modelcontextprotocol/server/stdio';
import * as z from 'zod/v4';
import path from 'node:path';
import { analyze } from './analyze.js';
import { propose, saveProposal } from './convert.js';
import { scaffold } from './scaffold.js';
import { json, readJson } from './util.js';
import type { MauiModel } from './model.js';

const strPath = z.string().min(1).max(2048);
const result = (value: object) => ({content:[{type:'text' as const,text:JSON.stringify(value)}],structuredContent:value});
const error = (e: unknown) => ({content:[{type:'text' as const,text:e instanceof Error ? e.message : 'Operation failed'}],isError:true});
export function buildServer(): McpServer {
  const server = new McpServer({name:'maui2rn',version:'0.1.0'},{instructions:'Analyze MAUI projects before scaffolding. Conversion writes a proposal only. High risk proposals require explicit human review and CLI apply.'});
  server.registerTool('analyze_maui_project',{description:'Analyze a local MAUI project into a structured model and risk report',inputSchema:z.object({input:strPath}),annotations:{readOnlyHint:true,destructiveHint:false,idempotentHint:true}},async ({input}) => {
    try { const model=await analyze(input); if (json(model).length>1_000_000) throw new Error('Analysis exceeds MCP output limit; use CLI analyze --out'); return result({model}); } catch(e) {return error(e);}
  });
  server.registerTool('generate_rn_scaffold',{description:'Create a new React Native 0.87 native app at an unused path',inputSchema:z.object({name:z.string().regex(/^[A-Z][A-Za-z0-9]{1,49}$/),out:strPath,skipInstall:z.boolean().optional()}),annotations:{readOnlyHint:false,destructiveHint:false,idempotentHint:false}},async ({name,out,skipInstall}) => {
    try { const appRoot=await scaffold(name,out,skipInstall); return result({appRoot}); } catch(e) {return error(e);}
  });
  server.registerTool('prepare_conversion',{description:'Generate reviewable React Native files as a proposal without applying them',inputSchema:z.object({report:strPath,app:strPath}),annotations:{readOnlyHint:false,destructiveHint:false,idempotentHint:true}},async ({report,app}) => {
    try { const model=await readJson<MauiModel>(path.resolve(report)); const proposal=await propose(model,path.resolve(app)); const proposalPath=await saveProposal(proposal); return result({proposalPath,id:proposal.id,findings:proposal.findings.slice(0,100),findingCount:proposal.findings.length,fileCount:proposal.files.length}); } catch(e) {return error(e);}
  });
  return server;
}
serveStdio(() => buildServer());
