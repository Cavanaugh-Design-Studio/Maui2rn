import { realpath } from 'node:fs/promises';
import path from 'node:path';
import type { MauiModel } from './model.js';
import { boundedText, safeRelative } from './util.js';

type Recipe = { id:string; pattern:RegExp; reactNative:string; verification:string; approach:string };
const recipes:Recipe[]=[
  {id:'secure-storage',pattern:/\bSecureStorage\b/,reactNative:'A maintained secure storage package or a reviewed TurboModule backed by Keychain and Android Keystore',approach:'Preserve key names, migration, access control, and backup behavior',verification:'Write/read/delete on both devices; reinstall and backup restore checks'},
  {id:'preferences',pattern:/\bPreferences\b/,reactNative:'A maintained key value storage package',approach:'Map default values and storage keys explicitly',verification:'Persist values across app restart and upgrade'},
  {id:'file-picker',pattern:/\bFilePicker\b/,reactNative:'A maintained document picker package',approach:'Map MIME types, URI permissions, and cancellation',verification:'Pick, cancel, and reopen files on Android and iOS'},
  {id:'geolocation',pattern:/\bGeolocation\b/,reactNative:'A maintained location package or reviewed platform module',approach:'Map foreground/background permissions and accuracy',verification:'Permission denial, grant, and background behavior on devices'},
  {id:'camera',pattern:/\bMediaPicker\b|\bCamera\b/,reactNative:'A maintained camera or image picker package',approach:'Map permission and temporary file lifecycle',verification:'Capture, cancel, rotate, and low storage checks'},
  {id:'webview',pattern:/\bWebView\b/,reactNative:'react-native-webview',approach:'Audit navigation allowlist and JS bridge messages',verification:'Navigation, offline, and bridge behavior on devices'},
  {id:'sqlite',pattern:/\bSQLite\b|sqlite-net/i,reactNative:'A maintained SQLite package',approach:'Translate schema migrations and transaction semantics',verification:'Upgrade a populated database on both platforms'},
  {id:'http',pattern:/\bHttpClient\b|GetFromJsonAsync|PostAsJsonAsync/,reactNative:'fetch with an explicit typed API client',approach:'Preserve base URL, auth, cancellation, retry, and error contracts',verification:'Contract tests for status codes, auth expiry, offline and timeout'},
];

export async function nativeIntegrationPlan(model:MauiModel):Promise<{id:string;sources:string[];reactNative:string;approach:string;verification:string;status:'pending'}[]> {
  const matches=new Map(recipes.map(recipe=>[recipe.id,[] as string[]]));
  const seen=new Set<string>();
  for (const c of model.classes) {
    const relative=safeRelative(c.source);
    if (seen.has(relative)) continue;
    seen.add(relative);
    const target=path.resolve(model.root,relative);
    const actual=await realpath(target);
    if (!actual.startsWith(path.resolve(model.root)+path.sep)) throw new Error('Native analysis source escapes project');
    const contents=await boundedText(actual);
    for (const recipe of recipes) if (recipe.pattern.test(contents)) matches.get(recipe.id)!.push(relative);
  }
  const packageText=model.projects.flatMap(p=>p.packages.map(x=>x.name)).join(' ');
  return recipes.flatMap(recipe=>{
    const found=matches.get(recipe.id)!;
    if (recipe.pattern.test(packageText)) found.push(...model.projects.filter(p=>p.packages.some(x=>recipe.pattern.test(x.name))).map(p=>p.path));
    return found.length ? [{id:recipe.id,sources:[...new Set(found)],reactNative:recipe.reactNative,approach:recipe.approach,verification:recipe.verification,status:'pending' as const}] : [];
  });
}
