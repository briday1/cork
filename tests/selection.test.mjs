import test from 'node:test';
import assert from 'node:assert/strict';
import {selectionBounds, notesInSelection, tapesInSelection} from '../selection-core.js';
import {screenToWorld} from '../board-core.js';

test('selection boxes work in every drag direction', () => {
  for (const [a, b] of [
    [{x: 20, y: 30}, {x: 240, y: 180}], [{x: 240, y: 180}, {x: 20, y: 30}],
    [{x: 20, y: 180}, {x: 240, y: 30}], [{x: 240, y: 30}, {x: 20, y: 180}],
  ]) assert.deepEqual(selectionBounds(a, b), {left: 20, top: 30, right: 240, bottom: 180});
});

test('box selection includes intersecting paper of every type and leaves the data unchanged', () => {
  const notes = [
    {id: 'note', type: 'note', x: 40, y: 50, width: 248, height: 184},
    {id: 'card', type: 'card', x: 330, y: 50, width: 344, height: 250},
    {id: 'photo', type: 'image', x: 40, y: 400, width: 286, height: 348},
    {id: 'folder', type: 'folder', x: 400, y: 400, width: 300, height: 218},
    {id: 'outside', type: 'note', x: 900, y: 50, width: 248, height: 184},
  ];
  const original = structuredClone(notes);
  assert.deepEqual(notesInSelection(notes, {left: 200, top: 200, right: 500, bottom: 500}), ['note', 'card', 'photo', 'folder']);
  assert.deepEqual(notes, original);
});

test('tilted paper is selected precisely without selecting its empty bounding-box corner', () => {
  const paper = [{id: 'tilted', x: 100, y: 100, width: 248, height: 184, tilt: 3}];
  assert.deepEqual(notesInSelection(paper, {left: 92, top: 94, right: 95, bottom: 97}), []);
  assert.deepEqual(notesInSelection(paper, {left: 94, top: 250, right: 110, bottom: 265}), ['tilted']);
  assert.deepEqual(notesInSelection(paper, {left: 200, top: 160, right: 205, bottom: 165}), ['tilted']);
});

test('selection after panning and zooming uses world coordinates and full resized height', () => {
  const view = {x: 800, y: -100, zoom: .5};
  const bounds = selectionBounds(screenToWorld({x: 520, y: 390}, view), screenToWorld({x: 540, y: 410}, view));
  const paper = [{id: 'tall', x: -600, y: 0, width: 248, height: 1100, tilt: -2}];
  assert.deepEqual(notesInSelection(paper, bounds), ['tall']);
  assert.deepEqual(notesInSelection([], bounds), []);
});


test('box selection finds tape strips including angled ones without selecting empty corners', () => {
  const tapes = [{id:'diagonal', x1:0, y1:0, x2:200, y2:200}, {id:'horizontal', x1:300, y1:100, x2:500, y2:100}];
  assert.deepEqual(tapesInSelection(tapes, {left:90, top:90, right:110, bottom:110}), ['diagonal']);
  assert.deepEqual(tapesInSelection(tapes, {left:0, top:180, right:10, bottom:190}), []);
  assert.deepEqual(tapesInSelection(tapes, {left:350, top:90, right:360, bottom:110}), ['horizontal']);
});
