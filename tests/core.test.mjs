import test from 'node:test';
import assert from 'node:assert/strict';
import {parseCategories, categoryColor, blankBoard, validateBoard, screenToWorld, zoomAt, revealNote, focusNoteView, continueList, PALETTES} from '../board-core.js';

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

test('phone focus fits the actual note and keeps a lower caret above the keyboard', () => {
  for (const width of [320, 390, 430]) {
    const rect = {x: -400, y: 700, width: Math.min(344, width - 32), height: 220};
    const view = focusNoteView(rect, {width});
    assert.ok(rect.x * view.zoom + view.x >= 15.99);
    assert.ok((rect.x + rect.width) * view.zoom + view.x <= width - 15.99);
    const caret = {x: rect.x + 30, y: rect.y + 600, width: 2, height: 24};
    const typingView = revealNote(view, caret, {width, height: 235}, false, 16);
    assert.equal(typingView.zoom, view.zoom);
    assert.ok(caret.y * typingView.zoom + typingView.y >= 23.99);
    assert.ok((caret.y + caret.height) * typingView.zoom + typingView.y <= 219.01);
  }
});

test('an oversized card stays reachable on a narrow board without moving the card', () => {
  const rect = {x: 500, y: -100, width: 344, height: 800};
  const original = {...rect};
  const view = revealNote({x: 0, y: 0, zoom: 1}, rect, {width: 320, height: 500}, true);
  assert.ok((rect.x + rect.width) * view.zoom + view.x <= 304.01);
  assert.equal(rect.y * view.zoom + view.y, 24);
  assert.deepEqual(rect, original);
});

const sample = () => ({...blankBoard(), notes: [{id: 'one', type: 'note', category: 'Gone from file', title: 'Gone from file', text: '<script>text only</script>', x: -20, y: 500, tilt: 1, width: 300}]});

test('exports round trip text, arbitrary positions, width, appearance, and removed categories', () => {
  const input = {...sample(), theme: 'dark', palette: 'cividis', name: 'My thoughts'};
  assert.deepEqual(validateBoard(JSON.parse(JSON.stringify(input))), input);
});

test('manual note height survives saving and import, with safe size limits', () => {
  const input = sample();
  input.notes[0].height = 340;
  assert.deepEqual(validateBoard(JSON.parse(JSON.stringify(input))), input);
  input.notes[0].height = 1;
  assert.equal(validateBoard(input).notes[0].height, 120);
  input.notes[0].height = 1e6;
  assert.equal(validateBoard(input).notes[0].height, 2000);
});

test('bad imports are rejected without silently dropping notes', () => {
  assert.throws(() => validateBoard({version: 9, notes: []}));
  assert.throws(() => validateBoard({...sample(), notes: [...sample().notes, ...sample().notes]}));
  const bad = sample(); bad.notes[0].x = Infinity;
  assert.throws(() => validateBoard(bad));
  const wrong = sample(); wrong.notes[0].text = {html: 'no'};
  assert.throws(() => validateBoard(wrong));
});
