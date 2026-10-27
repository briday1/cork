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

test('all arrow pin colors round-trip without losing existing arrows', () => {
  for (const shape of ['arrow','arrow-blue','arrow-yellow','arrow-green']) {
    const board=blankBoard(); board.notes.push({id:shape,type:'pin',category:shape,title:shape,text:'',x:0,y:0,tilt:0,pin:{shape,size:48,rotation:0}});
    assert.equal(validateBoard(board).notes[0].pin.shape,shape);
  }
});

test('the ordinary board pin is preserved when saving and reopening', () => {
  const board=blankBoard(); board.notes.push({id:'ordinary',type:'pin',category:'board-pin',title:'board-pin',text:'',x:0,y:0,tilt:0,pin:{shape:'board-pin',size:48,rotation:0}});
  assert.equal(validateBoard(JSON.parse(JSON.stringify(board))).notes[0].pin.shape,'board-pin');
});

test('a pin attached away from a note’s main pin survives save and keeps its own string', () => {
  const board=blankBoard();
  const note={id:'paper',type:'note',category:'Ideas',title:'Ideas',text:'',x:100,y:100,tilt:0};
  const pin={id:'extra',type:'pin',category:'heart',title:'heart',text:'',x:130,y:160,tilt:0,pin:{shape:'heart',size:48,rotation:0},parentId:'paper',offsetX:30,offsetY:60};
  const other={id:'other',type:'pin',category:'duck',title:'duck',text:'',x:500,y:160,tilt:0,pin:{shape:'duck',size:48,rotation:0}};
  board.notes.push(note,pin,other); board.connections.push({id:'link',from:'extra',to:'other'});
  const saved=validateBoard(JSON.parse(JSON.stringify(board)));
  assert.equal(saved.notes[1].parentId,'paper'); assert.equal(saved.notes[1].offsetX,30); assert.equal(saved.connections[0].from,'extra');
  assert.throws(()=>validateBoard({...board,notes:[pin,other]}),/missing item/);
});

test('string anchors stay at the rotational center for standalone and attached-item pins', async () => {
  const {connectionGeometry}=await import('../export-core.js');
  for (const rotation of [0,45,90,180]) {
    const standalone={type:'pin',x:100,y:200,width:120,height:120,pin:{shape:'arrow',size:70,rotation}};
    const item={type:'note',x:300,y:100,width:200,tilt:0,pin:{shape:'arrow',size:70,rotation}};
    const curve=connectionGeometry(standalone,item);
    assert.deepEqual(curve.from,{x:160,y:260});
    assert.deepEqual(curve.to,{x:400,y:115});
  }
});

test('a music note pin survives saving and reopening', () => {
  const board=blankBoard(); board.notes.push({id:'music',type:'pin',category:'music',title:'music',text:'',x:0,y:0,tilt:0,pin:{shape:'music',size:48,rotation:0}});
  assert.equal(validateBoard(JSON.parse(JSON.stringify(board))).notes[0].pin.shape,'music');
});
