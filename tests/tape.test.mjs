import {test} from 'node:test';
import assert from 'node:assert/strict';
import {blankBoard, validateBoard} from '../board-core.js';

test('tape survives board validation and older boards load without it', () => {
  const board = blankBoard();
  board.tapes.push({id:'t1', color:'blue', text:'Act one', x1:-20, y1:10, x2:400, y2:70});
  assert.deepEqual(validateBoard(JSON.parse(JSON.stringify(board))).tapes, board.tapes);
  delete board.tapes;
  assert.deepEqual(validateBoard(board).tapes, []);
});
test('invalid tape is rejected instead of silently lost', () => {
  const board = blankBoard();
  board.tapes.push({id:'t1', color:'purple', text:'', x1:0, y1:0, x2:10, y2:10});
  assert.throws(() => validateBoard(board), /invalid tape/);
});

test('card and string colors survive board validation', () => {
  const board = blankBoard();
  board.notes.push({id:'a',type:'card',category:'',title:'Card',text:'',x:0,y:0,tilt:0,cardColor:'pink'}, {id:'b',type:'card',category:'',title:'Card',text:'',x:300,y:0,tilt:0,cardColor:'blue'});
  board.connections.push({id:'link',from:'a',to:'b',color:'green'});
  const saved=validateBoard(board);
  assert.equal(saved.notes[0].cardColor,'pink');
  assert.equal(saved.notes[1].cardColor,'blue');
  assert.equal(saved.connections[0].color,'green');
});

test('standalone and attached pins and their string links survive board validation', () => {
  const board = blankBoard();
  board.notes.push({id:'pin',type:'pin',category:'duck',title:'duck',text:'',x:0,y:0,tilt:0,pin:{shape:'duck',size:48,rotation:30}}, {id:'note',type:'note',category:'Ideas',title:'Ideas',text:'Hi',x:300,y:0,tilt:0,pin:{shape:'heart',size:32,rotation:-10}});
  board.connections.push({id:'thread',from:'pin',to:'note',color:'blue'});
  const saved=validateBoard(JSON.parse(JSON.stringify(board)));
  assert.deepEqual(saved.notes.map(n=>n.pin),board.notes.map(n=>n.pin));
  assert.equal(saved.connections[0].from,'pin');
  assert.throws(() => validateBoard({...board,notes:[{...board.notes[0],pin:{shape:'invalid',size:48,rotation:0}}]}), /invalid push pin/);
});

test('string geometry anchors a standalone pin at its center', async () => {
  const {connectionGeometry}=await import('../export-core.js');
  const curve=connectionGeometry({type:'pin', x:20,y:40,width:120,height:120}, {type:'note',x:300,y:100,width:200});
  assert.deepEqual(curve.from,{x:80,y:100});
});
