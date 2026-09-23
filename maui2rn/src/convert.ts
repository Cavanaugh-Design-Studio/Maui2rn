import { readFile, mkdir, writeFile, realpath, lstat, rename, unlink, stat } from 'node:fs/promises';
import path from 'node:path';
import type { Finding, MauiClass, MauiModel, MauiPage, Proposal, ProposedFile, Severity, XmlNode } from './model.js';
import { json, readJson, safeRelative, sha256, slug, writeJson } from './util.js';
import { nativeIntegrationPlan } from './native.js';

const rnVersion = '0.87.1';
const navigationPackages = {
  '@react-navigation/native': '7.4.1',
  '@react-navigation/native-stack': '7.19.2',
  'react-native-screens': '4.28.0',
  'react-native-safe-area-context': '5.10.0'
};
const name = (value: string) => value.split(':').at(-1) ?? value;
const attr = (node: XmlNode, key: string) => Object.entries(node.attributes).find(([k]) => name(k) === key)?.[1];
const binding = (value?: string) => value?.match(/^\{Binding\s+([A-Za-z_][A-Za-z0-9_]*)(?:[,}])/ )?.[1];
const q = (value: string) => JSON.stringify(value);
const indent = (depth: number) => '  '.repeat(depth);

type RenderContext = { page: MauiPage; model:MauiModel; vm?:MauiClass; findings: Finding[]; use: Set<string>; state: Set<string>; commands: Set<string> };
function expression(value: string | undefined, context: RenderContext): string {
  if (!value) return q('');
  const property = binding(value);
  if (property) { context.state.add(property); return `String(state.${slug(property)} ?? '')`; }
  if (value.includes('{Binding')) { context.findings.push({code:'COMPLEX_BINDING',severity:'high',message:`Binding ${value} needs manual conversion`,source:context.page.source}); return q(''); }
  return q(value);
}
function children(node: XmlNode, context: RenderContext, depth: number): string { return node.children.map(n => render(n,context,depth)).join('\n'); }
function render(node: XmlNode, context: RenderContext, depth = 0): string {
  const tag = name(node.name), pad = indent(depth);
  if (tag.includes('.')) return children(node,context,depth);
  if (tag === 'ContentPage' || tag === 'VerticalStackLayout' || tag === 'StackLayout' || tag === 'Grid' || tag === 'Frame' || tag === 'Border' || tag === 'HorizontalStackLayout') {
    context.use.add('View');
    const style = tag === 'HorizontalStackLayout' ? ' style={styles.row}' : ' style={styles.block}';
    return `${pad}<View${style}>\n${children(node,context,depth+1)}\n${pad}</View>`;
  }
  if (tag === 'ScrollView') { context.use.add('ScrollView'); return `${pad}<ScrollView contentContainerStyle={styles.block}>\n${children(node,context,depth+1)}\n${pad}</ScrollView>`; }
  if (tag === 'Label') { context.use.add('Text'); return `${pad}<Text style={styles.text}>{${expression(attr(node,'Text') ?? node.text,context)}}</Text>`; }
  if (tag === 'Entry' || tag === 'Editor' || tag === 'SearchBar') {
    context.use.add('TextInput');
    const property = binding(attr(node,'Text')); if (property) context.state.add(property);
    const change = property ? ` onChangeText={value => setState(previous => ({...previous, ${slug(property)}: value}))}` : '';
    const value = property ? `String(state.${slug(property)} ?? '')` : expression(attr(node,'Text'),context);
    const multiline = tag === 'Editor' ? ' multiline' : '';
    const validations=context.vm?.properties.find(p=>p.name===property)?.validation ?? [];
    const required=validations.some(v=>v.kind==='Required');
    if (validations.some(v=>v.kind!=='Required')) context.findings.push({code:'VALIDATION_REVIEW',severity:'high',message:`Implement all validation rules for ${property}`,source:context.page.source});
    if (required) context.use.add('Text');
    const input=`${pad}<TextInput style={styles.input} placeholder={${q(attr(node,'Placeholder') ?? '')}} value={${value}}${change}${multiline} />`;
    return required && property ? `${pad}<View>\n${input}\n${pad}  {!String(state.${slug(property)} ?? '').trim() && <Text style={styles.warning}>${slug(property)} is required</Text>}\n${pad}</View>` : input;
  }
  if (tag === 'Switch') {
    context.use.add('Switch'); const property = binding(attr(node,'IsToggled')); if (property) context.state.add(property);
    const value = property ? `Boolean(state.${slug(property)})` : attr(node,'IsToggled') === 'True' ? 'true' : 'false';
    const change = property ? ` onValueChange={value => setState(previous => ({...previous, ${slug(property)}: value}))}` : '';
    return `${pad}<Switch value={${value}}${change} />`;
  }
  if (tag === 'Button') {
    context.use.add('Pressable'); context.use.add('Text');
    const command = binding(attr(node,'Command'));
    if (command) context.commands.add(command);
    const definition=context.vm?.commands?.find(c=>c.name===command);
    const actionable=Boolean(definition?.supported && definition.actions.length && definition.actions.every(a=>a.kind==='set'&&context.vm?.properties.some(p=>p.name===a.target)||a.kind==='navigate'&&context.model.routes.some(r=>r.route===a.value)));
    if (!command) context.findings.push({code:'BUTTON_ACTION_UNRESOLVED',severity:'high',message:'Button has no convertible command',source:context.page.source});
    const required=context.vm?.properties.filter(p=>p.validation?.some(v=>v.kind==='Required')).map(p=>slug(p.name)) ?? [];
    required.forEach(p=>context.state.add(p));
    const disabled=required.length ? ` disabled={${required.map(p=>`!String(state.${p} ?? '').trim()`).join(' || ')}}` : '';
    const label=expression(attr(node,'Text'),context);
    return `${pad}<Pressable accessibilityRole="button" style={styles.button}${actionable ? ` onPress={() => onCommand(${q(command!)})}`+disabled : ' disabled'}><Text style={styles.buttonText}>{${actionable ? label : `String(${label}) + ' (migration pending)'`}}</Text></Pressable>`;
  }
  if (tag === 'CollectionView') {
    context.use.add('FlatList'); context.use.add('Text');
    const property = binding(attr(node,'ItemsSource'));
    if (property) context.state.add(property);
    const key = context.vm?.properties.find(p=>p.name===property)?.itemKey;
    context.findings.push({code:'LIST_TEMPLATE_REVIEW',severity:'medium',message:'Review CollectionView item template, keys, and selection behavior',source:context.page.source});
    if (!key) context.findings.push({code:'LIST_KEY_UNRESOLVED',severity:'high',message:`No stable key found for ${property ?? 'CollectionView'}`,source:context.page.source});
    return `${pad}<FlatList data={${property ? `Array.isArray(state.${slug(property)}) ? state.${slug(property)} : []` : '[]'}} keyExtractor={${key ? `(item) => String((item as Record<string, unknown>)[${q(key)}])` : '(_, index) => String(index)'}} renderItem={({item}) => <Text style={styles.text}>{String(item)}</Text>} />`;
  }
  if (tag === 'ActivityIndicator') { context.use.add('ActivityIndicator'); return `${pad}<ActivityIndicator />`; }
  if (tag === 'Image') {
    context.use.add('Text'); context.findings.push({code:'ASSET_REVIEW',severity:'high',message:`Map image asset ${attr(node,'Source') ?? ''}`,source:context.page.source});
    return `${pad}<Text accessibilityLabel={${q(attr(node,'Source') ?? 'image')}}>Image asset pending</Text>`;
  }
  context.findings.push({code:'UNSUPPORTED_CONTROL',severity:'high',message:`${tag} requires manual implementation`,source:context.page.source});
  context.use.add('Text');
  return `${pad}<Text style={styles.warning}>{${q(`Unsupported MAUI control: ${tag}`)}}</Text>`;
}
function screen(page: MauiPage, model:MauiModel): { content: string; findings: Finding[]; risk: Severity } {
  const vm = model.classes.find(c=>c.name===page.viewModel);
  const context: RenderContext = {page,model,vm,findings:[],use:new Set(['StyleSheet']),state:new Set(),commands:new Set()};
  const markup = render(page.root,context,2);
  const fields = [...context.state].map(p => {
    const type=vm?.properties.find(x=>x.name===p)?.type ?? '';
    const initial=/^(?:bool|Boolean)(?:\?)?$/.test(type) ? 'false' : /^(?:int|long|double|float|decimal|short|byte|Int32|Int64)(?:\?)?$/.test(type) ? '0' : /(?:List|IEnumerable|ICollection|ObservableCollection|\[\])/.test(type) ? '[]' : "''";
    return `${slug(p)}: ${initial}`;
  }).join(', ');
  const stateLine = context.state.size ? `  const [state, setState] = useState<Record<string, unknown>>({${fields}});\n` : '';
  const cases = [...context.commands].map(command => {
    const definition=vm?.commands?.find(c=>c.name===command);
    if (!definition?.supported) { context.findings.push({code:'COMMAND_REVIEW',severity:'high',message:`Implement ${command} behavior`,source:page.source}); return `      case ${q(command)}: return; // Migration pending`; }
    const actions:string[]=[];
    for (const action of definition.actions) {
      if (action.kind==='navigate') {
        const route=model.routes.find(r=>r.route===action.value);
        if (!route) { context.findings.push({code:'COMMAND_ROUTE_UNRESOLVED',severity:'high',message:`Route ${action.value} is not registered`,source:page.source}); continue; }
        actions.push(`navigation.navigate(${q(slug(action.value))});`);
      } else if (action.kind==='set' && /^[A-Za-z_][A-Za-z0-9_]*$/.test(action.target) && vm?.properties.some(p=>p.name===action.target)) {
        const value=action.valueType==='number'||action.valueType==='boolean' ? action.value : action.valueType==='null' ? 'null' : q(action.value);
        actions.push(`setState(previous => ({...previous, ${slug(action.target)}: ${value}}));`);
      } else context.findings.push({code:'COMMAND_ACTION_UNRESOLVED',severity:'high',message:`Review ${command} action ${action.kind}`,source:page.source});
    }
    if (!actions.length) context.findings.push({code:'COMMAND_REVIEW',severity:'high',message:`Implement ${command} behavior`,source:page.source});
    return `      case ${q(command)}: ${actions.join(' ')} return;`;
  });
  const needsNavigation=cases.some(c=>c.includes('navigation.navigate'));
  const commandLine = context.commands.size ? `  const onCommand = (command: string) => {\n    switch (command) {\n${cases.join('\n')}\n    }\n  };\n` : '';
  if (context.state.size) context.use.add('useState');
  const react = context.use.has('useState') ? `import {useState} from 'react';\n` : '';
  const navigationImport=needsNavigation ? `import {useNavigation} from '@react-navigation/native';\n` : '';
  const navigationLine=needsNavigation ? `  const navigation = useNavigation<any>();\n` : '';
  context.use.delete('useState');
  const imports = [...context.use].sort().join(', ');
  const content = `${react}${navigationImport}import {${imports}} from 'react-native';\n\nexport function ${slug(page.id)}Screen() {\n${stateLine}${navigationLine}${commandLine}  return (\n${markup}\n  );\n}\n\nconst styles = StyleSheet.create({\n  block: { flex: 1, padding: 12, gap: 8 },\n  row: { flexDirection: 'row', gap: 8, alignItems: 'center' },\n  text: { fontSize: 16, color: '#17212b' },\n  input: { borderColor: '#8b99a8', borderWidth: 1, borderRadius: 6, padding: 10, minHeight: 44 },\n  button: { backgroundColor: '#155eef', borderRadius: 6, padding: 12, minHeight: 44 },\n  buttonText: { color: '#fff', fontWeight: '600', textAlign: 'center' },\n  warning: { color: '#9f311b', padding: 8 }\n});\n`;
  return {content,findings:context.findings,risk:context.findings.some(f=>f.severity==='high')?'high':'medium'};
}
function appFile(pages: MauiPage[]): string {
  const ordered = [...pages].sort((a,b)=>a.id.localeCompare(b.id));
  const imports = ordered.map(p => `import {${slug(p.id)}Screen} from './src/features/${slug(p.id)}/${slug(p.id)}Screen';`).join('\n');
  const screens = ordered.map(p => `      <Stack.Screen name=${q(slug(p.route ?? p.id))} component={${slug(p.id)}Screen} options={{title: ${q(p.title)}}} />`).join('\n');
  return `import React from 'react';\nimport {NavigationContainer} from '@react-navigation/native';\nimport {createNativeStackNavigator} from '@react-navigation/native-stack';\n${imports}\n\nconst Stack = createNativeStackNavigator();\nexport default function App() {\n  return <NavigationContainer><Stack.Navigator>\n${screens}\n  </Stack.Navigator></NavigationContainer>;\n}\n`;
}
function jestConfigFile(): string {
  return `module.exports = {\n  preset: '@react-native/jest-preset',\n  transformIgnorePatterns: ['node_modules/(?!(@react-navigation|react-native|@react-native|react-native-screens|react-native-safe-area-context)/)'],\n};\n`;
}
function serviceFile(service: MauiClass): string {
  const methods=service.methods.filter(m=>!m.name.startsWith('get_')&&!m.name.startsWith('set_'));
  return `/** Migration scaffold for ${service.namespace}.${service.name} (${service.source}).\n * Review API contracts, auth, retries, cancellation, and platform behavior before use. */\nexport class ${slug(service.name)} {\n  constructor(private readonly baseUrl: string) {}\n${methods.map(m=>{
    const calls=service.httpCalls?.filter(c=>c.owner===m.name) ?? [];
    const call=calls.length===1 && calls[0].verb==='GET' && ['GetStringAsync','GetFromJsonAsync'].includes(calls[0].method) ? calls[0] : undefined;
    if (!call) return `  async ${slug(m.name)}(..._args: unknown[]): Promise<unknown> {\n    throw new Error(${q(`${service.name}.${m.name} migration pending`)});\n  }`;
    const response=call.method==='GetStringAsync'?'response.text()':'response.json()';
    return `  async ${slug(m.name)}(signal?: AbortSignal): Promise<unknown> {\n    const url = new URL(${q(call.url)}, this.baseUrl);\n    const response = await fetch(url.toString(), {method: 'GET', signal});\n    if (!response.ok) throw new Error(${q(`${service.name}.${m.name} HTTP `)} + response.status);\n    return ${response};\n  }`;
  }).join('\n')}\n}\n`;
}
function file(relative: string, content: string, risk: Severity, source?: string): ProposedFile { return {path:safeRelative(relative),content,sha256:sha256(content),risk,source}; }
export async function propose(model: MauiModel, appRoot: string): Promise<Proposal> {
  if (model.schemaVersion !== 1) throw new Error('Unsupported model schema');
  if (!(await stat(path.join(appRoot,'android'))).isDirectory() || !(await stat(path.join(appRoot,'ios'))).isDirectory()) throw new Error('App is missing native React Native project directories');
  const packagePath = path.join(appRoot,'package.json');
  const pkg = JSON.parse(await readFile(packagePath,'utf8')) as Record<string,unknown>;
  const deps = (pkg.dependencies ?? {}) as Record<string,string>;
  if (deps['react-native'] !== rnVersion) throw new Error(`Expected React Native ${rnVersion} template`);
  pkg.dependencies = {...deps,...navigationPackages};
  const files: ProposedFile[] = [file('package.json',json(pkg),'medium')];
  const findings = [...model.findings];
  const nativePlan=await nativeIntegrationPlan(model);
  for (const item of nativePlan) findings.push({code:'NATIVE_INTEGRATION',severity:'high',message:`${item.id}: ${item.approach}; ${item.verification}`,source:item.sources[0]});
  if (!model.pages.length) findings.push({code:'NO_PAGES',severity:'high',message:'No ContentPage files found; app navigation requires manual design'});
  for (const page of model.pages) {
    const output = screen(page,model); findings.push(...output.findings);
    files.push(file(`src/features/${slug(page.id)}/${slug(page.id)}Screen.tsx`,output.content,output.risk,page.source));
  }
  for (const service of model.classes.filter(c=>/Service$/.test(c.name))) {
    findings.push({code:'SERVICE_REVIEW',severity:'high',message:`Implement and test ${service.name} business behavior`,source:service.source});
    files.push(file(`src/data/services/${slug(service.name)}.ts`,serviceFile(service),'high',service.source));
  }
  files.push(file('App.tsx',appFile(model.pages),'medium'));
  files.push(file('jest.config.js',jestConfigFile(),'medium'));
  files.push(file('src/domain/migrationReport.json',json({source:model.root,coverage:model.coverage,findings}),'low'));
  files.push(file('src/domain/nativeIntegrationPlan.json',json({schemaVersion:1,integrations:nativePlan}),'medium'));
  files.push(file('src/domain/parityManifest.json',json({schemaVersion:1,pages:model.pages.map(p=>({source:p.source,screen:`src/features/${slug(p.id)}/${slug(p.id)}Screen.tsx`,route:p.route,bindings:p.bindings,commands:p.commands,manualDeviceChecks:['Open screen','Enter data and validate errors','Activate commands','Verify navigation and service results','Check accessibility and offline behavior']}))}),'medium'));
  const generated = new Set<string>();
  for (const entry of files) { if (generated.has(entry.path.toLowerCase())) throw new Error(`Generated path collision: ${entry.path}`); generated.add(entry.path.toLowerCase()); }
  const modelHash = sha256(json(model));
  const id = sha256(modelHash + files.map(f=>f.sha256).join('')).slice(0,16);
  return {schemaVersion:1,id,modelHash,appRoot:path.resolve(appRoot),files,findings,createdAt:new Date().toISOString()};
}
type Manifest = { schemaVersion: 1; files: Record<string,string>; applied: string[] };
export async function saveProposal(proposal: Proposal): Promise<string> {
  const target = path.join(proposal.appRoot,'.maui2rn','proposals',`${proposal.id}.json`);
  await writeJson(target,proposal); return target;
}
export async function applyProposal(proposalFile: string, options: { approveHighRisk?: boolean; acceptTemplate?: boolean; reviewReceipt?:boolean } = {}): Promise<{written:string[]; findings:Finding[]}> {
  const proposal = await readJson<Proposal>(proposalFile);
  if (proposal.schemaVersion !== 1 || !Array.isArray(proposal.files)) throw new Error('Invalid proposal');
  if (!/^[a-f0-9]{16}$/.test(proposal.id)) throw new Error('Invalid proposal id');
  const root = await realpath(proposal.appRoot);
  if (root !== path.resolve(proposal.appRoot)) throw new Error('App root must be a real directory, not a symlink');
  const trustedProposal = path.join(root,'.maui2rn','proposals',`${proposal.id}.json`);
  if (await realpath(proposalFile) !== await realpath(trustedProposal)) throw new Error('Proposal must be saved under the target app');
  if ((await lstat(path.join(root,'.maui2rn'))).isSymbolicLink()) throw new Error('Migration metadata directory is a symlink');
  const manifestPath = path.join(root,'.maui2rn','manifest.json');
  let manifest: Manifest = {schemaVersion:1,files:{},applied:[]};
  try { manifest = await readJson<Manifest>(manifestPath); } catch (e) { if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e; }
  if (proposal.findings.some(f=>f.severity==='high') && !options.approveHighRisk) {
    if (!options.reviewReceipt) throw new Error('High-risk findings require --approve-high-risk after reviewing the proposal');
    const receipt=await readJson<{proposalId:string;files:Record<string,string>}>(path.join(root,'.maui2rn','reviews',`${proposal.id}.json`));
    if (receipt.proposalId!==proposal.id || proposal.files.some(f=>receipt.files[f.path]!==f.sha256)) throw new Error('Review receipt does not match exact proposal contents');
  }
  const bootstrap = options.acceptTemplate ? await readJson<{files:Record<string,string>}>(path.join(root,'.maui2rn','bootstrap.json')) : undefined;
  const pending: {target:string; file:ProposedFile; original?:string}[] = [];
  for (const entry of proposal.files) {
    const relative = safeRelative(entry.path), target = path.resolve(root,relative);
    if (!target.startsWith(root + path.sep)) throw new Error(`Escaping target: ${relative}`);
    let segment = root;
    for (const part of relative.split('/')) {
      segment = path.join(segment,part);
      try { if ((await lstat(segment)).isSymbolicLink()) throw new Error(`Symlink in target path: ${relative}`); }
      catch(e) { if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e; }
    }
    if (sha256(entry.content) !== entry.sha256) throw new Error(`Proposal hash mismatch: ${relative}`);
    let current: string | undefined;
    try { current = await readFile(target,'utf8'); } catch (e) { if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e; }
    if (current !== undefined && sha256(current) !== manifest.files[relative]) {
      if (!options.acceptTemplate || manifest.files[relative] || bootstrap?.files[relative] !== sha256(current) || !['App.tsx','package.json','jest.config.js'].includes(relative)) throw new Error(`File differs from managed version: ${relative}`);
    }
    if (current !== entry.content) pending.push({target,file:entry,original:current});
  }
  const written: typeof pending = [];
  try {
    for (const item of pending) {
      await mkdir(path.dirname(item.target),{recursive:true});
      const temp = `${item.target}.maui2rn-${process.pid}.tmp`;
      try { await writeFile(temp,item.file.content,{flag:'wx'}); await rename(temp,item.target); }
      finally { await unlink(temp).catch(()=>{}); }
      written.push(item);
    }
    for (const entry of proposal.files) manifest.files[entry.path] = entry.sha256;
    if (!manifest.applied.includes(proposal.id)) manifest.applied.push(proposal.id);
    await writeJson(manifestPath,manifest);
  } catch(e) {
    for (const item of written.reverse()) {
      if (item.original === undefined) await unlink(item.target).catch(()=>{});
      else await writeFile(item.target,item.original).catch(()=>{});
    }
    throw e;
  }
  return {written:pending.map(x=>x.file.path),findings:proposal.findings};
}
export { rnVersion };
