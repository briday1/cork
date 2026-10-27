import test from 'node:test';
import assert from 'node:assert/strict';
import {parseCategories, parseCategoryFile, missingBoardCategories, directoryNameFromFiles, categoryColor, blankBoard, validateBoard, screenToWorld, zoomAt, revealNote, focusNoteView, continueList, PALETTES} from '../board-core.js';

test('category files accept BOM, CRLF, whitespace, and case-insensitive duplicates', () => {
  assert.deepEqual(parseCategories('\uFEFFIdeas\r\n\r\n Questions  \r\nideas\n#This is a category\n'), ['Ideas', 'Questions', '#This is a category']);
});

test('a leading asterisk marks a frequent category without changing its name or file order', () => {
  const text = '\uFEFFQuestions\r\n * Ideas \r\n*Questions\nideas\n*\n  *Inspiration\n#Still a category';
  assert.deepEqual(parseCategoryFile(text), {
    categories: ['Questions', 'Ideas', 'Inspiration', '#Still a category'],
    frequentCategories: ['Questions', 'Ideas', 'Inspiration'],
  });
  assert.deepEqual(parseCategories(text), ['Questions', 'Ideas', 'Inspiration', '#Still a category']);
  assert.deepEqual(parseCategoryFile('Ideas\nQuestions').frequentCategories, []);
});

test('directory-input fallback gets the root folder name without reading file contents', () => {
  const files = [{webkitRelativePath: 'Project files/notes.txt'}, {webkitRelativePath: 'Project files/nested/photo.png'}];
  assert.equal(directoryNameFromFiles(files), 'Project files');
  assert.equal(directoryNameFromFiles([]), null);
  assert.equal(directoryNameFromFiles([{webkitRelativePath: ''}]), null);
  assert.equal(directoryNameFromFiles([...files, {webkitRelativePath: 'Other folder/file.txt'}]), null);
});

test('undefined board categories remain usable and compare without case or surrounding spaces', () => {
  const notes = [
    {type: 'note', category: 'ideas'}, {type: 'note', category: ' Older category '},
    {type: 'note', category: 'OLDER CATEGORY'}, {type: 'note', category: 'Another'},
    {type: 'card', category: 'Card title'}, {type: 'image', category: 'Photo'},
    {type: 'folder', category: 'Folder'}, {type: 'note', category: '  '},
  ];
  const original = structuredClone(notes);
  assert.deepEqual(missingBoardCategories(notes, ['Ideas']), ['Older category', 'Another']);
  assert.deepEqual(missingBoardCategories(notes, ['Ideas', 'Older category', 'Another']), []);
  assert.deepEqual(missingBoardCategories(notes, []), ['ideas', 'Older category', 'Another']);
  assert.deepEqual(notes, original, 'finding undefined categories never rewrites notes');
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

test('all paper backgrounds survive saved board files and unknown appearances keep the cork default', () => {
  for (const theme of ['paper-cream', 'paper-sage', 'paper-blue']) {
    const input = {...sample(), theme};
    assert.deepEqual(validateBoard(JSON.parse(JSON.stringify(input))), input);
  }
  assert.equal(validateBoard({...sample(), theme:'unknown'}).theme, 'natural');
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

test('Polaroid references and captions round trip while paper size stays fixed', () => {
  const board = {...blankBoard(), notes: [{id: 'photo', type: 'image', imageId: 'original-photo', category: '', title: 'Photo.png', text: 'Caption', x: -30, y: 80, tilt: 2}]};
  assert.deepEqual(validateBoard(JSON.parse(JSON.stringify(board))), board);
  const resized = structuredClone(board); resized.notes[0].width = 700; resized.notes[0].height = 1200;
  assert.deepEqual(validateBoard(resized), board);
  const invalid = structuredClone(board); invalid.notes[0].imageId = '../anything';
  assert.throws(() => validateBoard(invalid));
  invalid.notes[0].imageId = 'photo'; invalid.notes[0].text = 'x'.repeat(121);
  assert.throws(() => validateBoard(invalid));
});

test('folder links retain their name and reference without a portable filesystem path', () => {
  const input = {...blankBoard(), notes: [{id: 'folder', type: 'folder', folderId: 'local-project', category: '', title: 'Project files', text: '', x: 120, y: -90, tilt: -1}]};
  assert.deepEqual(validateBoard(JSON.parse(JSON.stringify(input))), input);
  const invalid = structuredClone(input); delete invalid.notes[0].folderId;
  assert.throws(() => validateBoard(invalid));
});

test('connections round trip and reject self-links, duplicates, and missing endpoints', () => {
  const input = sample();
  input.notes.push({...input.notes[0], id: 'two', x: 500});
  input.connections = [{id: 'thread', from: 'one', to: 'two'}];
  assert.deepEqual(validateBoard(JSON.parse(JSON.stringify(input))), input);
  for (const link of [{id: 'bad', from: 'one', to: 'one'}, {id: 'bad', from: 'one', to: 'missing'}, {id: 'duplicate', from: 'two', to: 'one'}]) {
    assert.throws(() => validateBoard({...input, connections: [...input.connections, link]}));
  }
});

test('bad imports are rejected without silently dropping notes', () => {
  assert.throws(() => validateBoard({version: 9, notes: []}));
  assert.throws(() => validateBoard({...sample(), notes: [...sample().notes, ...sample().notes]}));
  const bad = sample(); bad.notes[0].x = Infinity;
  assert.throws(() => validateBoard(bad));
  const wrong = sample(); wrong.notes[0].text = {html: 'no'};
  assert.throws(() => validateBoard(wrong));
});

test('mixed palettes keep adjacent categories distinct and survive board validation', () => {
  const categories = Array.from({length:20}, (_, i) => `Category ${i}`);
  for (const palette of ['mix-bright', 'mix-pastel', 'mix-earth', 'mix-vivid']) {
    const colors = categories.map(name => categoryColor(name, categories, palette));
    assert.equal(new Set(colors.slice(0, 10)).size, 10);
    for (let i = 1; i < colors.length; i++) assert.notEqual(colors[i], colors[i-1]);
    assert.deepEqual(categories.map(name => categoryColor(name, categories, palette)), colors);
    assert.equal(validateBoard({...blankBoard(), palette}).palette, palette);
  }
});
