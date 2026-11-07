import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { Script } from 'node:vm';
import ts from 'typescript';

class TAbstractFile { constructor(path) { this.path = path; } }
class TFile extends TAbstractFile { constructor(path, data) { super(path); this.data = data; } get stat() { return {size:this.data.byteLength, mtime:[...new Uint8Array(this.data)].reduce((a,b)=>a+b,0)}; } }
class TFolder extends TAbstractFile { children = []; }
const notices = [];
const module = { exports: {} };
const code = ts.transpileModule(readFileSync(new URL('../src/operationHistory.ts', import.meta.url), 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 } }).outputText;
new Script(`((require, exports) => {${code} })`).runInThisContext()(() => ({ TFile, TFolder, normalizePath: path => path.replace(/\/+/g,'/'), Notice: class { constructor(text) { notices.push(text); } } }), module.exports);
const { OperationHistory } = module.exports;

function setup() {
  const map = new Map([['', new TFolder('')]]);
  const data = text => new TextEncoder().encode(text).buffer;
  const rebuild = () => { for (const file of map.values()) if (file instanceof TFolder) file.children = [...map.values()].filter(child => child.path && child !== file && child.path.split('/').slice(0,-1).join('/') === file.path); };
  const app = { vault: {
    getAbstractFileByPath: path => map.get(path),
    readBinary: async file => file.data.slice(0),
    createFolder: async path => { if (map.has(path)) throw Error('collision'); const file = new TFolder(path); map.set(path,file); rebuild(); return file; },
    createBinary: async (path, bytes) => { if (map.has(path)) throw Error('collision'); const file = new TFile(path,bytes); map.set(path,file); rebuild(); return file; },
  }, fileManager: {
    renameFile: async (file, target) => { if (map.has(target)) throw Error('collision'); const old = file.path; const affected = [...map.values()].filter(f => f.path === old || f.path.startsWith(old+'/')); for (const f of affected) map.delete(f.path); for (const f of affected) { f.path = target + f.path.slice(old.length); map.set(f.path,f); } rebuild(); },
    trashFile: async file => { for (const key of [...map.keys()]) if (key === file.path || key.startsWith(file.path+'/')) map.delete(key); rebuild(); },
  }};
  return { app, map, data, history: new OperationHistory(app) };
}

test('move supports repeated undo/redo and rejects an occupied destination', async () => {
  const {app,map,data,history:h} = setup();
  const file = await app.vault.createBinary('a.md',data('hello'));
  await h.run('Rename', () => h.move(file,'b.md'));
  await h.replay(); assert.ok(map.has('a.md')); assert.equal(h.redoLabel,'Rename');
  await h.replay(true); assert.ok(map.has('b.md'));
  await app.vault.createBinary('a.md',data('other'));
  await h.replay(); assert.ok(map.has('b.md')); assert.equal(h.undoLabel,'Rename');
});
test('deleting a folder restores binary files and empty folders', async () => {
  const {app,map,data,history:h} = setup();
  const folder = await app.vault.createFolder('folder');
  await app.vault.createFolder('folder/empty');
  await app.vault.createBinary('folder/image.bin',data('binary'));
  await h.run('Delete', () => h.trash(folder)); assert.ok(!map.has('folder'));
  await h.replay(); assert.ok(map.has('folder/empty')); assert.equal(new TextDecoder().decode(map.get('folder/image.bin').data),'binary');
  await h.replay(true); assert.ok(!map.has('folder'));
});
test('group selection is one reversible operation', async () => {
  const {app,map,data,history:h} = setup();
  const a = await app.vault.createBinary('a.md',data('a'));
  const b = await app.vault.createBinary('b.md',data('b'));
  await h.run('Group',async () => { await app.vault.createFolder('group'); await h.created('group'); await h.move(a,'group/a.md'); await h.move(b,'group/b.md'); });
  await h.replay(); assert.ok(!map.has('group')); assert.ok(map.has('a.md')); assert.ok(map.has('b.md'));
  await h.replay(true); assert.ok(map.has('group/a.md')); assert.ok(map.has('group/b.md')); assert.ok(!map.has('a.md'));
  await h.replay(); assert.ok(map.has('a.md')); assert.ok(!map.has('group'));
});
test('created/imported content cannot be removed after editing or adding children', async () => {
  const {app,map,data,history:h} = setup();
  await h.run('Create',async () => { await app.vault.createBinary('a.md',data('')); await h.created('a.md'); });
  map.get('a.md').data = data('new writing');
  await h.replay(); assert.ok(map.has('a.md')); assert.equal(h.undoLabel,'Create');
});
test('batch preflight prevents partial undo when one item changed', async () => {
  const {app,map,data,history:h} = setup();
  const a = await app.vault.createBinary('a',data('a')), b = await app.vault.createBinary('b',data('b'));
  await app.vault.createFolder('target');
  await h.run('Move',async () => { await h.move(a,'target/a'); await h.move(b,'target/b'); });
  map.get('target/a').data = data('changed'); await h.replay();
  assert.ok(map.has('target/a')); assert.ok(map.has('target/b')); assert.ok(!map.has('b'));
});
test('failed batch preserves completed steps; new work clears redo; calls serialize', async () => {
  const {app,map,data,history:h} = setup();
  const a = await app.vault.createBinary('a',data('a'));
  await h.run('Partial',async () => { await h.move(a,'b'); throw Error('stop'); });
  await h.replay(); assert.ok(map.has('a'));
  await h.run('New',() => h.move(a,'c')); assert.equal(h.redoLabel,undefined);
  let release; const gate = new Promise(resolve => {release=resolve;});
  const running = h.run('Wait',()=>gate); let ran = false;
  await h.run('Concurrent',async()=>{ran=true;}); assert.equal(ran,false);
  release(); await running;
});

test('interrupted folder restore rolls back and can be retried', async () => {
  const {app,map,data,history:h} = setup();
  const folder = await app.vault.createFolder('folder');
  await app.vault.createBinary('folder/a',data('a')); await app.vault.createBinary('folder/b',data('b'));
  await h.run('Delete',()=>h.trash(folder));
  const create = app.vault.createBinary;
  app.vault.createBinary = async (path,bytes) => { if (path === 'folder/b') throw Error('disk error'); return create(path,bytes); };
  await h.replay(); assert.ok(!map.has('folder')); assert.equal(h.undoLabel,'Delete');
  app.vault.createBinary = create; await h.replay(); assert.ok(map.has('folder/b')); assert.equal(h.undoLabel,undefined);
});

test('linked files can be grouped and repeatedly undone despite automatic link updates', async () => {
  const {app,map,data,history:h} = setup();
  const a = await app.vault.createBinary('a.md',data('[[b.md]]'));
  const b = await app.vault.createBinary('b.md',data('B'));
  const rename = app.fileManager.renameFile;
  app.fileManager.renameFile = async (file,to) => {
    const from=file.path; await rename(file,to);
    for(const item of map.values()) if(item instanceof TFile) item.data=data(new TextDecoder().decode(item.data).replaceAll(`[[${from}]]`,`[[${to}]]`));
  };
  await h.run('Group',async()=>{await app.vault.createFolder('g');await h.created('g');await h.move(a,'g/a.md');await h.move(b,'g/b.md');});
  await h.replay(); assert.ok(map.has('a.md')); assert.ok(!map.has('g'));assert.equal(new TextDecoder().decode(a.data),'[[b.md]]');
  await h.replay(true);assert.ok(map.has('g/a.md'));assert.equal(new TextDecoder().decode(a.data),'[[g/b.md]]');
  await h.replay();assert.ok(map.has('a.md'));assert.ok(!map.has('g'));
});
test('temporary verification read failure after a move can retry undo safely', async () => {
  const {app,map,data,history:h} = setup();
  const a = await app.vault.createBinary('a',data('A')); const read=app.vault.readBinary;
  app.vault.readBinary=async()=>{throw Error('temporarily unreadable');};
  await h.run('Move',()=>h.move(a,'b')); assert.ok(map.has('b'));
  app.vault.readBinary=read;await h.replay();assert.ok(map.has('a'));
});

test('partial undo never adopts external files introduced by a failing step', async () => {
  const {app,map,data,history:h} = setup();
  const a=await app.vault.createBinary('a',data('A')),b=await app.vault.createBinary('b',data('B'));
  await h.run('Group',async()=>{await app.vault.createFolder('g');await h.created('g');await h.move(a,'g/a');await h.move(b,'g/b');});
  const rename=app.fileManager.renameFile;
  app.fileManager.renameFile=async(file,to)=>{if(to==='a'){await app.vault.createBinary('g/external',data('EXTERNAL'));throw Error('move failure');}await rename(file,to);};
  await h.replay();assert.ok(map.has('g/external'));assert.ok(map.has('b'));
  app.fileManager.renameFile=rename;await h.replay();assert.ok(map.has('g/external'));assert.ok(map.has('g/a'));
});
test('failed deletion backup keeps the original file', async () => {
  const {app,map,data,history:h} = setup();const file=await app.vault.createBinary('a',data('A'));
  app.vault.readBinary=async()=>{throw Error('read failure');};
  await h.run('Delete',()=>h.trash(file));assert.ok(map.has('a'));assert.equal(h.undoLabel,undefined);
});
test('canonical paths make root-level moves and creations reversible', async () => {
  const {app,map,data,history:h} = setup();const file=await app.vault.createBinary('a',data('A'));
  await h.run('Rename',()=>h.move(file,'//b'));await h.replay();assert.ok(map.has('a'));
  await h.run('Create',async()=>{await app.vault.createFolder('folder');await h.created('//folder');});await h.replay();assert.ok(!map.has('folder'));
});

test('a failed checkpoint read after successful partial undo remains retryable', async () => {
  const {app,map,data,history:h} = setup();const a=await app.vault.createBinary('a',data('A')),b=await app.vault.createBinary('b',data('B'));
  await app.vault.createFolder('g');await h.run('Move',async()=>{await h.move(a,'g/a');await h.move(b,'g/b');});
  const read=app.vault.readBinary,rename=app.fileManager.renameFile;let fail=false;
  app.fileManager.renameFile=async(file,to)=>{await rename(file,to);if(to==='b')fail=true;};
  app.vault.readBinary=async(file)=>{if(fail){fail=false;throw Error('checkpoint failure');}return read(file);};
  await h.replay();assert.ok(map.has('b'));assert.ok(map.has('g/a'));
  app.fileManager.renameFile=rename;await h.replay();assert.ok(map.has('a'));assert.ok(map.has('b'));
});
