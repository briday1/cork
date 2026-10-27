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
