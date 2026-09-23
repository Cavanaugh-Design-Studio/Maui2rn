import { createServer } from 'node:http';
import { randomBytes } from 'node:crypto';
import { readFile, realpath } from 'node:fs/promises';
import path from 'node:path';
import type { Proposal } from './model.js';
import { readJson, safeRelative, sha256, writeJson } from './util.js';

const escapeHtml = (value:string) => value.replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;').replaceAll('"','&quot;').replaceAll("'",'&#39;');

export async function reviewProposal(proposalFile:string, port=0):Promise<{url:string;proposalId:string}> {
  const proposal=await readJson<Proposal>(proposalFile);
  if (!/^[a-f0-9]{16}$/.test(proposal.id) || proposal.files.some(f=>sha256(f.content)!==f.sha256)) throw new Error('Invalid proposal contents');
  const root=await realpath(proposal.appRoot);
  const expected=path.join(root,'.maui2rn','proposals',`${proposal.id}.json`);
  if (await realpath(proposalFile)!==await realpath(expected)) throw new Error('Proposal must be saved under the target app');
  const files=await Promise.all(proposal.files.map(async f=>{
    const relative=safeRelative(f.path);
    const target=path.resolve(root,relative);
    if (!target.startsWith(root+path.sep)) throw new Error('Invalid target path');
    let before='(new file)';
    try {
      if ((await realpath(target)).startsWith(root+path.sep)) before=(await readFile(target,'utf8')).slice(0,150_000);
      else before='(path outside app; review in CLI)';
    } catch (error) { if ((error as NodeJS.ErrnoException).code!=='ENOENT') before='(unable to read current file)'; }
    return {path:relative,sha256:f.sha256,risk:f.risk,before,after:f.content.slice(0,150_000),truncated:f.content.length>150_000};
  }));
  const token=randomBytes(32).toString('hex');
  const payload=JSON.stringify({id:proposal.id,findings:proposal.findings,files}).replaceAll('<','\\u003c');
  const server=createServer(async (request,response)=>{
    const host=request.headers.host ?? '';
    const address=server.address();
    const boundPort=typeof address==='object'&&address?address.port:port;
    if (host!==`127.0.0.1:${boundPort}`) { response.writeHead(403).end(); return; }
    const url=new URL(request.url??'/',`http://${host}`);
    if (url.searchParams.get('token')!==token) { response.writeHead(403).end(); return; }
    if (request.method==='GET'&&url.pathname==='/') {
      response.writeHead(200,{'Content-Type':'text/html; charset=utf-8','Cache-Control':'no-store','Content-Security-Policy':"default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; connect-src 'self'; base-uri 'none'; form-action 'none'"});
      response.end(`<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>maui2rn review ${escapeHtml(proposal.id)}</title><style>body{font:15px system-ui;max-width:1500px;margin:24px auto;padding:0 16px;color:#182536}h1{margin-bottom:4px}.finding{padding:8px;border-left:4px solid #cc6030;background:#fff3ea;margin:6px 0}article{border:1px solid #bdc8d4;border-radius:8px;margin:18px 0;padding:12px}.cols{display:grid;grid-template-columns:1fr 1fr;gap:12px}pre{white-space:pre-wrap;overflow-wrap:anywhere;background:#f3f5f8;padding:12px;max-height:350px;overflow:auto}button{padding:10px 15px;background:#155eef;color:white;border:0;border-radius:5px;cursor:pointer}button:disabled{background:#8798b1}small{color:#516276}@media(max-width:800px){.cols{grid-template-columns:1fr}}</style><h1>Migration proposal ${escapeHtml(proposal.id)}</h1><p>Review every file and the findings before recording approval. Approval saves a receipt; it does not apply files.</p><div id="app"></div><script>const data=${payload};const token=${JSON.stringify(token)};const app=document.getElementById('app');const approved=new Set();function el(tag,text){const e=document.createElement(tag);e.textContent=text;return e}app.append(el('h2','Findings'));for(const finding of data.findings){const row=el('div',finding.severity.toUpperCase()+' '+finding.code+': '+finding.message);row.className='finding';app.append(row)}app.append(el('h2','Files'));for(const file of data.files){const box=el('article','');box.append(el('h3',file.path+' · '+file.risk+' risk'));box.append(el('small','SHA-256 '+file.sha256+(file.truncated?' · preview truncated; inspect proposal JSON before approval':'')));const cols=el('div','');cols.className='cols';for(const [label,content] of [['Current',file.before],['Proposed',file.after]]){const section=el('section','');section.append(el('h4',label),el('pre',content));cols.append(section)}box.append(cols);const button=el('button','Approve this file');button.onclick=()=>{approved.add(file.path);button.textContent='Approved';button.disabled=true;finish.disabled=approved.size!==data.files.length};box.append(button);app.append(box)}const finish=el('button','Record complete review');finish.disabled=true;finish.onclick=async()=>{finish.disabled=true;const response=await fetch('/approve?token='+token,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({files:[...approved]})});finish.textContent=response.ok?'Review receipt saved. You can close this tab.':'Could not save review receipt';};app.append(finish);</script></html>`);
      return;
    }
    if (request.method==='POST'&&url.pathname==='/approve') {
      if (request.headers.origin!==`http://127.0.0.1:${boundPort}` || request.headers['content-type']!=='application/json') { response.writeHead(403).end(); return; }
      let body='';
      for await (const chunk of request) { body+=String(chunk); if (body.length>20_000) { response.writeHead(413).end(); return; } }
      try {
        const approved=JSON.parse(body) as {files:string[]};
        if (!Array.isArray(approved.files)||approved.files.length!==files.length||files.some(f=>!approved.files.includes(f.path))) throw new Error('Incomplete review');
        await writeJson(path.join(root,'.maui2rn','reviews',`${proposal.id}.json`),{proposalId:proposal.id,files:Object.fromEntries(files.map(f=>[f.path,f.sha256])),reviewedAt:new Date().toISOString()});
        response.writeHead(200,{'Content-Type':'application/json'}).end('{"saved":true}');
        server.close();
      } catch { response.writeHead(400).end(); }
      return;
    }
    response.writeHead(404).end();
  });
  await new Promise<void>((resolve,reject)=>{server.once('error',reject);server.listen(port,'127.0.0.1',resolve);});
  const address=server.address();
  if (!address||typeof address==='string') throw new Error('Review server unavailable');
  return {url:`http://127.0.0.1:${address.port}/?token=${token}`,proposalId:proposal.id};
}
