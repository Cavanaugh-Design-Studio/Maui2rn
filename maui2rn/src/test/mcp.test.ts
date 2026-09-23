import assert from 'node:assert/strict';
import { test } from 'node:test';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';

const here = path.dirname(fileURLToPath(import.meta.url));
const cli = path.resolve(here,'../cli.js');
const fixture = path.resolve(here,'../../fixtures/SampleMaui');
test('MCP stdio negotiates modern protocol and analyzes fixture',async () => {
  const client = new Client({name:'maui2rn-test',version:'1.0.0'},{versionNegotiation:{mode:'auto'}});
  const transport = new StdioClientTransport({command:process.execPath,args:[cli,'mcp']});
  try {
    await client.connect(transport);
    assert.equal(client.getProtocolEra(),'modern');
    const list=await client.listTools();
    assert.ok(list.tools.some(t=>t.name==='analyze_maui_project'));
    assert.ok(!list.tools.some(t=>t.name==='apply_conversion'));
    const report=await client.callTool({name:'analyze_maui_project',arguments:{input:fixture}});
    assert.equal(report.isError,undefined);
    const data=report.structuredContent as {model:{pages:unknown[]}};
    assert.equal(data.model.pages.length,1);
    const invalid=await client.callTool({name:'analyze_maui_project',arguments:{input:''}});
    assert.equal(invalid.isError,true);
  } finally { await client.close(); }
});
