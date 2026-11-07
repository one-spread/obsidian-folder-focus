import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import vm from 'node:vm';
import ts from 'typescript';

class TAbstractFile { constructor(path) { this.path=path;this.name=path.split('/').at(-1); } }
class TFile extends TAbstractFile { extension='md'; }
class TFolder extends TAbstractFile { children=[]; }
class FileSystemAdapter { constructor(base){this.base=base;} getBasePath(){return this.base;} }
const stubs={TAbstractFile,TFile,TFolder,FileSystemAdapter,ItemView:class{},Modal:class{},Scope:class{},Notice:class{},normalizePath:p=>p};
const modules=new Map();
function load(name) {
 if(modules.has(name)) return modules.get(name);
 const source=readFileSync(new URL(`../src/${name}.ts`,import.meta.url),'utf8');
 const code=ts.transpileModule(source,{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2020}}).outputText;
 const module={exports:{}};modules.set(name,module.exports);
 const require=specifier=>specifier==='obsidian'?stubs:load(specifier.replace('./',''));
 vm.runInNewContext(`(function(require,module,exports){${code}\n})`)(require,module,module.exports);
 return module.exports;
}
const {FolderFocusView}=load('FolderFocusView');
const {assertSafeDirectoryImport}=load('importSafety');
function fixture(read) {
 const v=Object.create(FolderFocusView.prototype);
 const a=new TFile('A/one.md');const b=new TFile('B/two.md');
 const folderA=new TFolder('A');folderA.children=[a];const folderB=new TFolder('B');folderB.children=[b];
 Object.assign(v,{filterGeneration:0,searchQuery:'needle',searchMode:'full-text',searchFoldersOnly:false,allFilesInFolder:[a],items:[a],filteredItems:[a],currentFolder:folderA,selectedIndices:new Set([0]),focusIndex:0,anchorIndex:0,folderHistory:new Map(),backPaths:[],forwardPaths:[],historyNavigation:false,app:{vault:{cachedRead:read}},getSortedItems:items=>items,renderAll(){}});
 return {v,a,b,folderB};
}
function deferred(){let resolve;const promise=new Promise(r=>{resolve=r});return {promise,resolve};}

test('navigation invalidates a pending full-text result',async()=>{
 const d=deferred();const {v,b,folderB}=fixture(()=>d.promise);
 const pending=v.applyFilter();v.setFolder(folderB);d.resolve('needle');
 assert.equal(await pending,false);assert.equal(v.currentFolder,folderB);assert.deepEqual(v.filteredItems,[b]);
});
test('a cleared search cannot be replaced by an earlier read',async()=>{
 const d=deferred();const {v,a}=fixture(()=>d.promise);const pending=v.applyFilter();
 v.searchQuery='';assert.equal(await v.applyFilter(),true);d.resolve('needle');assert.equal(await pending,false);assert.deepEqual(v.filteredItems,[a]);
});
test('the latest overlapping query wins even if the earlier one resolves last',async()=>{
 const first=deferred(),second=deferred();let reads=0;const {v,a}=fixture(()=>++reads===1?first.promise:second.promise);
 const old=v.applyFilter();v.searchQuery='latest';const current=v.applyFilter();second.resolve('latest');assert.equal(await current,true);
 first.resolve('needle');assert.equal(await old,false);assert.equal(v.filteredItems[0],a);assert.equal(v.searchQuery,'latest');
});
test('closing the view invalidates outstanding reads',async()=>{
 const d=deferred();const {v,a}=fixture(()=>d.promise);const pending=v.applyFilter();await v.onClose();d.resolve('needle');assert.equal(await pending,false);assert.deepEqual(v.filteredItems,[a]);
});
test('directory import rejects same/descendant paths and follows symlinks',async()=>{
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'ff-import-'));
 try {
  const source=path.join(root,'source');const child=path.join(source,'child');const sibling=path.join(root,'source-other');
  await fs.mkdir(child,{recursive:true});await fs.mkdir(sibling);const link=path.join(root,'link');await fs.symlink(child,link,'dir');
  await assert.rejects(assertSafeDirectoryImport(source,source,fs,path),/cannot be imported/);
  await assert.rejects(assertSafeDirectoryImport(source,child,fs,path),/cannot be imported/);
  await assert.rejects(assertSafeDirectoryImport(source,link,fs,path),/cannot be imported/);
  await assertSafeDirectoryImport(source,sibling,fs,path);await assertSafeDirectoryImport(source,root,fs,path);
 } finally {await fs.rm(root,{recursive:true,force:true});}
});
test('unsafe external import is rejected before creating a destination',async()=>{
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'ff-import-integration-'));
 try {
  await fs.mkdir(path.join(root,'A'));const {v}=fixture(async()=> '');let created=false;
  v.getDesktopModules=()=>({fs,nodePath:path});v.app.vault.adapter=new FileSystemAdapter(root);v.ensureVaultFolder=async()=>{created=true};
  await assert.rejects(v.importExternalPath(path.join(root,'A'),new TFolder('A')),/cannot be imported/);assert.equal(created,false);
 } finally {await fs.rm(root,{recursive:true,force:true});}
});


test('pathless directory entries are fully enumerated before output is created',async()=>{
 const {v}=fixture(async()=> '');let created=false,reads=0,writes=0;
 const fileEntry={isDirectory:false,isFile:true,name:'source.md'};
 const source={isDirectory:true,isFile:false,name:'source'};const nested={isDirectory:true,isFile:false,name:'nested'};
 v.readAllDirectoryEntries=async entry=>{reads++;if(created)throw Error('Source enumerated after output creation');return entry===source?[nested,fileEntry]:[fileEntry]};
 v.getFileFromEntry=async()=>({arrayBuffer:async()=>new ArrayBuffer(0)});
 v.getUniqueVaultPath=(parent,name)=>parent+'/'+name;
 v.ensureVaultFolder=async()=>{created=true};
 v.app.vault.createBinary=async()=>{writes++};v.plugin={history:{created:async()=>{}}};
 await v.importExternalEntry(source,new TFolder('target'));assert.equal(reads,2);assert.equal(writes,2);
});
