import test from 'node:test';
import assert from 'node:assert/strict';
import {parseCategories, categoryColor, blankBoard, validateBoard, screenToWorld, zoomAt, continueList, PALETTES} from '../board-core.js';

test('category files accept BOM, CRLF, whitespace, and case-insensitive duplicates', () => {
  assert.deepEqual(parseCategories('\uFEFFIdeas\r\n\r\n Questions  \r\nideas\n#This is a category\n'), ['Ideas', 'Questions', '#This is a category']);
});

test('100 categories get 100 distinct HSV colors, without repeating the endpoint', () => {
  const categories = Array.from({length: 100}, (_, i) => `Category ${i + 1}`);
  assert.equal(new Set(categories.map(c => categoryColor(c, categories, 'hsv'))).size, 100);
  for (const palette of Object.keys(PALETTES)) {
    for (const c of [...categories, 'Removed category']) assert.doesNotMatch(categoryColor(c, categories, palette), /NaN|undefined/);
  }
  assert.equal(blankBoard().palette, 'hsv');
});

test('zoom preserves the world point under the cursor and clamps the range', () => {
  const view = {x: -143, y: 78, zoom: .7};
  const point = {x: 400, y: 220};
  const before = screenToWorld(point, view);
  const after = screenToWorld(point, zoomAt(view, 1.5, point));
  assert.ok(Math.abs(before.x - after.x) < 1e-9);
  assert.ok(Math.abs(before.y - after.y) < 1e-9);
  assert.equal(zoomAt(view, 99, point).zoom, 2);
  assert.equal(zoomAt(view, .01, point).zoom, .25);
});

test('bullets and numbered lists continue, and empty bullets end the list', () => {
  assert.deepEqual(continueList('• First', 7), {text: '• First\n• ', cursor: 10});
  assert.deepEqual(continueList('9. Nine', 7), {text: '9. Nine\n10. ', cursor: 12});
  assert.deepEqual(continueList('• First\n• ', 10), {text: '• First\n', cursor: 8});
  assert.equal(continueList('plain text', 10), null);
  assert.equal(continueList('• First', 2, 7), null);
});

const sample = () => ({...blankBoard(), notes: [{id: 'one', type: 'note', category: 'Gone from file', title: 'Gone from file', text: '<script>text only</script>', x: -20, y: 500, tilt: 1, width: 300}]});

test('exports round trip text, arbitrary positions, width, appearance, and removed categories', () => {
  const input = {...sample(), theme: 'dark', palette: 'cividis', name: 'My thoughts'};
  assert.deepEqual(validateBoard(JSON.parse(JSON.stringify(input))), input);
});

test('bad imports are rejected without silently dropping notes', () => {
  assert.throws(() => validateBoard({version: 9, notes: []}));
  assert.throws(() => validateBoard({...sample(), notes: [...sample().notes, ...sample().notes]}));
  const bad = sample(); bad.notes[0].x = Infinity;
  assert.throws(() => validateBoard(bad));
  const wrong = sample(); wrong.notes[0].text = {html: 'no'};
  assert.throws(() => validateBoard(wrong));
});
