import test from 'node:test';
import assert from 'node:assert/strict';
import {blankBoard, validateBoard, normalizeNoteStyle} from '../board-core.js';

test('heading and body typography round trip independently per board and per note', () => {
  const board = {...blankBoard(), noteStyle: {header:{font:'serif',size:22,weight:500},body:{font:'sans',size:15,weight:400}}, notes:[
    {id:'one',type:'note',category:'Ideas',title:'Ideas',text:'Keep text',x:10,y:20,tilt:0,style:{header:{font:'mono',size:18,weight:700},body:{size:14,weight:500}}},
    {id:'two',type:'card',category:'',title:'Card',text:'More text',x:300,y:20,tilt:0},
  ]};
  const loaded = validateBoard(JSON.parse(JSON.stringify(board)));
  assert.deepEqual(loaded,board);
  assert.equal(loaded.notes[0].style.header.font,'mono');
  assert.equal(loaded.notes[0].style.body.font,undefined);
  assert.equal(loaded.notes[1].style,undefined,'older notes retain their original typography');
  const newNoteStyle=normalizeNoteStyle(board.noteStyle);
  board.noteStyle.header.size=30;
  assert.equal(newNoteStyle.header.size,22,'new notes take a copy rather than tracking later defaults');
});

test('unsupported font names and weights are ignored; font sizes stay within bounds', () => {
  assert.deepEqual(normalizeNoteStyle({header:{font:'url(untrusted)',size:1000,weight:1200},body:{font:'mono',size:-1,weight:400}}),{header:{size:72},body:{font:'mono',size:9,weight:400}});
  assert.deepEqual(normalizeNoteStyle(null),{});
  assert.deepEqual(normalizeNoteStyle({header:{size:NaN}}),{});
});
