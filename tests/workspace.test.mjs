import test from 'node:test';
import assert from 'node:assert/strict';
import {blankBoard} from '../board-core.js';
import {boardKeys, readWorkspace, writeWorkspace, readWorkspaceBoard, boardStamp, duplicateBoardSnapshot} from '../workspace.js';
import {readBoardFile, writeBoardFile} from '../board-file.js';

const storage = () => {
  const values = new Map();
  return {getItem: key => values.get(key) ?? null, setItem: (key, value) => values.set(key, value)};
};

test('existing board and categories keep their original storage and file-handle keys', () => {
  const cache = storage(), base = 'cork:/one/';
  const old = {...blankBoard(), name: 'Existing board', view: {x: -80, y: 40, zoom: 1.4}};
  cache.setItem(base, JSON.stringify(old));
  cache.setItem(`${base}:categories`, 'unchanged category cache');
  const workspace = readWorkspace(cache, base);
  assert.equal(workspace.activeId, 'original');
  assert.deepEqual(boardKeys(base, 'original'), {board: base, categories: `${base}:categories`, file: `${base}:file`});
  assert.deepEqual(readWorkspaceBoard(cache, base, workspace.activeId), old);
  writeWorkspace(cache, base, workspace);
  assert.equal(cache.getItem(`${base}:categories`), 'unchanged category cache');
  assert.equal(cache.getItem(base), JSON.stringify(old));
});

test('open tabs, active board, and file pairs persist separately across visits', () => {
  const cache = storage(), base = 'cork:/one/';
  const workspace = readWorkspace(cache, base);
  workspace.boards.push({id: 'second', name: 'Work', open: true, file: {name: 'work.json', token: 'work-file', stamp: 'saved', modified: 42, size: 99}});
  workspace.activeId = 'second';
  cache.setItem(boardKeys(base, 'second').board, JSON.stringify({...blankBoard(), name: 'Work'}));
  cache.setItem(boardKeys(base, 'second').categories, 'Work categories');
  cache.setItem(boardKeys(base, 'original').categories, 'Personal categories');
  writeWorkspace(cache, base, workspace);
  assert.deepEqual(readWorkspace(cache, base), workspace);
  assert.equal(readWorkspaceBoard(cache, base, 'second').name, 'Work');
  assert.equal(cache.getItem(boardKeys(base, 'original').categories), 'Personal categories');
  assert.equal(readWorkspace(cache, 'cork:/another/').activeId, 'original');
});

test('closed boards from earlier versions are no longer tracked', () => {
  const cache = storage(), base = 'cork:/one/';
  const old = readWorkspace(cache, base);
  old.boards.push({id:'closed',name:'Old closed board',open:false,file:null});
  writeWorkspace(cache, base, old);
  const restored = readWorkspace(cache, base);
  assert.deepEqual(restored.boards.map(entry => entry.id), ['original']);
  writeWorkspace(cache, base, restored);
  assert.ok(!cache.getItem(`${base}:workspace`).includes('Old closed board'));
});

test('broken tab lists and broken boards remain untouched for recovery', () => {
  const cache = storage();
  cache.setItem('base:workspace', '{invalid');
  assert.throws(() => readWorkspace(cache, 'base'));
  assert.equal(cache.getItem('base:workspace'), '{invalid');
  cache.setItem('base', '{invalid board');
  assert.throws(() => readWorkspaceBoard(cache, 'base', 'original'));
  assert.equal(cache.getItem('base'), '{invalid board');
  cache.setItem('base:workspace', JSON.stringify({version: 1, activeId: 'same', boards: [{id:'same',name:'A',open:true},{id:'same',name:'B',open:true}]}));
  assert.throws(() => readWorkspace(cache, 'base'), /tabs/);
});

test('file-change comparisons recognize edits, undo, and camera changes', () => {
  const board = blankBoard(), original = boardStamp(board);
  const copy = structuredClone(board);
  assert.equal(boardStamp({...copy, notes:[], noteStyle:{}}), original, 'unused defaults do not count as file edits');
  assert.equal(boardStamp({view:copy.view,connections:[],notes:[],theme:copy.theme,palette:copy.palette,name:copy.name,version:1}), original, 'property order does not count as a file edit');
  assert.equal(boardStamp(copy), original);
  copy.name = 'Changed'; assert.notEqual(boardStamp(copy), original);
  copy.name = board.name; assert.equal(boardStamp(copy), original);
  copy.view.zoom = 1.1; assert.notEqual(boardStamp(copy), original);
});

test('duplicating a board copies its content and text styles without sharing mutable state', () => {
  const board = {...blankBoard(), name:'Show', noteStyle:{header:{font:'serif'}}, notes:[
    {id:'idea',type:'note',category:'Ideas',title:'Ideas',text:'Original approach',x:30,y:40,tilt:1,style:{body:{size:16}}},
    {id:'photo',type:'image',category:'',title:'Photo',text:'Caption',x:400,y:40,tilt:0,imageId:'original-image'},
  ],connections:[{id:'link',from:'idea',to:'photo'}]};
  const copy = duplicateBoardSnapshot(board,['Show','Show copy']);
  assert.equal(copy.name,'Show copy 2');
  assert.deepEqual(copy.connections,board.connections);
  assert.equal(copy.notes[1].imageId,'original-image','immutable image assets can be reused');
  copy.notes[0].text='Another approach'; copy.notes[0].style.body.size=22; copy.noteStyle.header.font='mono'; copy.connections.length=0;
  assert.equal(board.notes[0].text,'Original approach'); assert.equal(board.notes[0].style.body.size,16);
  assert.equal(board.noteStyle.header.font,'serif'); assert.equal(board.connections.length,1);
});

test('board file input validates without replacing an existing board', async () => {
  const source = {...blankBoard(), name: 'From disk'};
  const loaded = await readBoardFile(new File([JSON.stringify(source)], 'board.json'));
  assert.deepEqual(loaded.board, source);
  await assert.rejects(readBoardFile(new File(['not JSON'], 'bad.json')), /valid Cork/);
  await assert.rejects(readBoardFile({size: 101 * 1024 * 1024}), /100 MB/);
  await assert.rejects(readBoardFile(new File(['{"version":99}'], 'bad.json')));
});

test('saving checks external edits, closes successful writes, and aborts failed writes', async () => {
  let file = {name: 'work.json', lastModified: 10, size: 12}, writes = [], closes = 0, aborts = 0;
  const stream = {write: async value => writes.push(value), close: async () => { closes++; file = {...file, lastModified: 11, size: 20}; }, abort: async () => aborts++};
  const handle = {getFile: async () => file, createWritable: async () => stream};
  const saved = await writeBoardFile(handle, 'contents', {modified: 10, size: 12});
  assert.deepEqual(saved, {name: 'work.json', modified: 11, size: 20});
  assert.deepEqual(writes, ['contents']); assert.equal(closes, 1);
  await assert.rejects(writeBoardFile(handle, 'wrong', {modified: 10, size: 12}), /changed outside Cork/);
  assert.equal(writes.length, 1, 'external edits are never overwritten');
  stream.write = async () => { throw new Error('disk full'); };
  await assert.rejects(writeBoardFile(handle, 'failed'), /disk full/);
  assert.equal(aborts, 1);
});
