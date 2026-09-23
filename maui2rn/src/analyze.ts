import path from 'node:path';
import { XMLParser } from 'fast-xml-parser';
import type { Finding, MauiModel, MauiPage, MauiProject, XmlNode } from './model.js';
import { boundedText, existingRoot, filesUnder } from './util.js';
import { roslynClasses } from './roslyn.js';

const xml = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: '', textNodeName: '#text', parseAttributeValue: false, parseTagValue: false, trimValues: true, processEntities: false });
const supported = new Set(['ContentPage','Grid','VerticalStackLayout','HorizontalStackLayout','StackLayout','ScrollView','Label','Entry','Editor','Button','Switch','CollectionView','Frame','Border','ActivityIndicator','Image','SearchBar']);
function nodes(value: unknown): XmlNode[] {
  if (!value || typeof value !== 'object') return [];
  const result: XmlNode[] = [];
  for (const [key, raw] of Object.entries(value)) {
    if (key === '#text' || key.startsWith('?') || key.startsWith('!')) continue;
    for (const item of Array.isArray(raw) ? raw : [raw]) {
      if (item == null) continue;
      const obj = typeof item === 'object' ? item as Record<string, unknown> : { '#text': item };
      const attributes: Record<string,string> = {};
      const childrenObj: Record<string,unknown> = {};
      for (const [k,v] of Object.entries(obj)) {
        if (k === '#text') continue;
        if (typeof v !== 'object' || k.startsWith('xmlns') || k.includes(':') && !Array.isArray(v)) attributes[k] = String(v);
        else childrenObj[k] = v;
      }
      result.push({ name: key, attributes, children: nodes(childrenObj), text: obj['#text'] == null ? undefined : String(obj['#text']) });
    }
  }
  return result;
}
function localName(name: string): string { return name.split(':').at(-1) ?? name; }
function walk(node: XmlNode, visit: (node: XmlNode) => void): void { visit(node); node.children.forEach(child => walk(child, visit)); }
function getAttr(node: XmlNode, key: string): string | undefined { return Object.entries(node.attributes).find(([k]) => localName(k) === key)?.[1]; }
async function selectedProjects(input: string, root: string, allProjects: string[]): Promise<string[]> {
  const ext=path.extname(input).toLowerCase();
  if (ext !== '.sln' && ext !== '.csproj') return allProjects;
  if (ext === '.sln') {
    const text=await boundedText(input);
    const names=[...text.matchAll(/^Project\([^\n]+?=\s*"[^"]+",\s*"([^"]+\.csproj)"/gm)].map(m=>path.resolve(root,m[1].replaceAll('\\','/')));
    const selected=allProjects.filter(p=>names.includes(p));
    if (!selected.length) throw new Error('Solution contains no project within its directory');
    return selected;
  }
  const found=allProjects.find(p=>p===input);
  if (!found) throw new Error('Project is outside analysis root');
  return [found];
}
export async function analyze(input: string): Promise<MauiModel> {
  const absolute = path.resolve(input);
  const root = await existingRoot(path.extname(absolute) ? path.dirname(absolute) : absolute);
  const all = await filesUnder(root);
  const csprojs = await selectedProjects(absolute,root,all.filter(f => f.endsWith('.csproj')));
  if (!csprojs.length) throw new Error('No .csproj found under input');
  const source=all.filter(f=>csprojs.some(p=>f.startsWith(path.dirname(p)+path.sep)||f===p));
  const findings: Finding[] = [];
  const projects: MauiProject[] = [];
  for (const f of csprojs) {
    const text = await boundedText(f);
    const data = nodes(xml.parse(text));
    const packages: {name:string;version?:string}[]=[];
    const references: string[]=[];
    for (const top of data) walk(top,n=>{
      if (n.name==='PackageReference') {
        const name=getAttr(n,'Include'); if (name) packages.push({name,version:getAttr(n,'Version')??n.children.find(c=>c.name==='Version')?.text});
      }
      if (n.name==='ProjectReference') { const ref=getAttr(n,'Include'); if (ref) references.push(ref); }
    });
    const frameworks = [...text.matchAll(/<TargetFrameworks?>([^<]+)<\/TargetFrameworks?>/g)].flatMap(x => x[1].split(';'));
    projects.push({ path: path.relative(root,f).replaceAll('\\','/'), name: path.basename(f,'.csproj'), targetFrameworks: frameworks, packages, references });
  }
  const selectedSources = new Set(source.map(f=>path.relative(root,f).replaceAll('\\','/')));
  const roslyn = await roslynClasses(root);
  const classes = roslyn.classes.filter(c=>selectedSources.has(c.source));
  const pages: MauiPage[] = [];
  const shellFiles = source.filter(f => /(?:AppShell|Shell)\.xaml$/i.test(f));
  const routes: { route: string; page: string }[] = [];
  for (const f of shellFiles) {
    const roots = nodes(xml.parse(await boundedText(f)));
    for (const top of roots) walk(top, n => {
      const route = getAttr(n,'Route'); const template = getAttr(n,'ContentTemplate');
      if (route && template) { const page = template.match(/(?:\w+:)?([A-Za-z_][A-Za-z0-9_]*)\s*}?$/)?.[1]; if (page) routes.push({route,page}); }
    });
  }
  for (const f of source.filter(f => f.endsWith('.xaml') && !/(?:App|AppShell|Shell)\.xaml$/i.test(f))) {
    const parsed = nodes(xml.parse(await boundedText(f)));
    const rootNode = parsed[0]; if (!rootNode) continue;
    if (localName(rootNode.name) !== 'ContentPage') continue;
    const source = path.relative(root,f).replaceAll('\\','/');
    const id = path.basename(f,'.xaml'); const bindings = new Set<string>(), commands = new Set<string>();
    let hasUnsupported = false;
    walk(rootNode, n => {
      const name = localName(n.name);
      if (!supported.has(name) && !name.includes('.') && !n.name.startsWith('x:')) { hasUnsupported = true; findings.push({code:'UNSUPPORTED_CONTROL',severity:'high',message:`${name} requires manual conversion`,source}); }
      for (const [k,v] of Object.entries(n.attributes)) for (const match of v.matchAll(/\{Binding\s+([A-Za-z_][A-Za-z0-9_]*)/g)) (localName(k) === 'Command' ? commands : bindings).add(match[1]);
    });
    const dataType = getAttr(rootNode,'DataType')?.split(':').at(-1);
    const vm = classes.find(c => c.name === dataType) ?? classes.find(c => c.name === `${id}ViewModel` || c.name === `${id.replace(/Page$/, '')}ViewModel`);
    pages.push({id,source,title:getAttr(rootNode,'Title') ?? id,root:rootNode,bindings:[...bindings].sort(),commands:[...commands].sort(),route:routes.find(r => r.page === id)?.route,viewModel:vm?.name});
    if (!vm && bindings.size) findings.push({code:'VIEWMODEL_UNRESOLVED',severity:'medium',message:`No matching ViewModel found for ${id}`,source});
    if (vm) {
      for (const field of bindings) if (!vm.properties.some(p=>p.name===field)) findings.push({code:'BINDING_UNRESOLVED',severity:'high',message:`${vm.name}.${field} was not found`,source});
      for (const command of commands) if (!vm.properties.some(p=>p.name===command) && !vm.commands?.some(c=>c.name===command)) findings.push({code:'COMMAND_UNRESOLVED',severity:'high',message:`${vm.name}.${command} was not found`,source});
    }
    if (hasUnsupported) findings.push({code:'PAGE_REVIEW',severity:'high',message:`Review generated output for ${id}`,source});
  }
  for (const p of projects) for (const pkg of p.packages) if (!/^(Microsoft\.Maui|CommunityToolkit\.Maui|Microsoft\.Extensions)/.test(pkg.name)) findings.push({code:'PACKAGE_REVIEW',severity:'medium',message:`Map package ${pkg.name} manually`,source:p.path});
  const viewModels = classes.filter(c => /ViewModel$/.test(c.name) || c.bases.some(b => /ObservableObject|BaseViewModel/.test(b)));
  const services = classes.filter(c => /Service$/.test(c.name));
  const unsupportedControls = findings.filter(f => f.code === 'UNSUPPORTED_CONTROL').length;
  return { schemaVersion:1, root, input:absolute, analysisMode:roslyn.analysisMode, projects, pages, classes, routes, findings, coverage:{pages:pages.length,supportedPages:pages.filter(p=>!findings.some(f=>f.code==='PAGE_REVIEW'&&f.source===p.source)).length,unsupportedControls,viewModels:viewModels.length,services:services.length},createdAt:new Date().toISOString() };
}
