import {STORAGE_KEY, parseCategories, categoryColor, blankBoard, screenToWorld, zoomAt, validateBoard, continueList} from './board-core.js';

const $ = id => document.getElementById(id);
const viewport = $('viewport');
const world = $('board-world');
const storageKey = `${STORAGE_KEY}:${location.pathname.replace(/index\.html$/, '')}`;
let board = blankBoard();
let categories = [];
let selected = null;
let placement = null;
let pointer = null;
let handMode = false;
let spaceHeld = false;
let gesture = null;
let categoryLoadFailed = false;
let saveTimer;
let toastTimer;
let pendingImport;
let savingBlocked = false;
let startupProblem = '';
const undoStack = [];
const redoStack = [];
const noteElements = new Map();
const activePointers = new Map();

try {
  const saved = localStorage.getItem(storageKey);
  if (saved) board = validateBoard(JSON.parse(saved));
} catch (error) {
  savingBlocked = true;
  startupProblem = 'Saved board could not be opened. Export is available; the stored copy has not been overwritten.';
  console.warn('Cork could not load the saved board:', error.message);
}

function icon(name) {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  const use = document.createElementNS(svg.namespaceURI, 'use');
  use.setAttribute('href', `#i-${name}`);
  svg.append(use);
  svg.setAttribute('aria-hidden', 'true');
  return svg;
}

function setSaveStatus(text, error = false) {
  $('save-status').textContent = text;
  $('save-status').classList.toggle('is-error', error);
}

function saveNow() {
  clearTimeout(saveTimer);
  if (savingBlocked) return setSaveStatus('Saving paused — export your board', true);
  try {
    localStorage.setItem(storageKey, JSON.stringify(board));
    setSaveStatus('Saved in this browser');
  } catch {
    setSaveStatus('Could not save — please export', true);
    toast('Browser storage is unavailable or full. Export your board to keep it.');
  }
}

function saveSoon() {
  if (savingBlocked) return setSaveStatus('Saving paused — export your board', true);
  setSaveStatus('Saving…');
  clearTimeout(saveTimer);
  saveTimer = setTimeout(saveNow, 250);
}

function record() {
  undoStack.push(JSON.stringify(board));
  if (undoStack.length > 70) undoStack.shift();
  redoStack.length = 0;
  updateHistory();
}

function updateHistory() {
  $('undo').disabled = !undoStack.length;
  $('redo').disabled = !redoStack.length;
}

function historyStep(from, to) {
  if (!from.length) return;
  cancelPlacement();
  document.activeElement?.blur();
  to.push(JSON.stringify(board));
  board = validateBoard(JSON.parse(from.pop()));
  selected = null;
  renderBoard();
  updateHistory();
  saveNow();
}

function toast(message, withUndo = false) {
  clearTimeout(toastTimer);
  $('toast-message').textContent = message;
  $('toast-undo').hidden = !withUndo;
  $('toast').hidden = false;
  toastTimer = setTimeout(() => { $('toast').hidden = true; }, 6000);
}

function colorFor(category) { return categoryColor(category, categories, board.palette); }

async function loadCategories() {
  categoryLoadFailed = false;
  $('retry-categories').hidden = true;
  try {
    const response = await fetch(new URL('./categories.txt', import.meta.url), {cache: 'no-store'});
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    categories = parseCategories(await response.text());
  } catch (error) {
    categoryLoadFailed = true;
    categories = [];
    console.warn('Cork could not load categories.txt:', error.message);
  }
  renderCategories();
  renderPalette();
  updateNoteColors();
}

function renderCategories() {
  const list = $('category-list');
  list.replaceChildren();
  const query = $('category-search').value.trim().toLocaleLowerCase();
  const shown = categories.filter(category => category.toLocaleLowerCase().includes(query));
  const counts = new Map();
  for (const note of board.notes) if (note.type === 'note') counts.set(note.category, (counts.get(note.category) || 0) + 1);
  for (const category of shown) {
    const button = document.createElement('button');
    button.className = 'category-row';
    button.classList.toggle('is-active', placement?.type === 'note' && placement.category === category);
    button.style.setProperty('--note-color', colorFor(category));
    button.setAttribute('aria-pressed', String(placement?.type === 'note' && placement.category === category));
    button.setAttribute('aria-label', `Place a ${category} note`);
    const chip = document.createElement('span'); chip.className = 'color-chip'; chip.setAttribute('aria-hidden', 'true');
    const label = document.createElement('span'); label.className = 'category-label'; label.textContent = category;
    const count = document.createElement('span'); count.className = 'category-count'; count.textContent = counts.get(category) || '';
    button.append(chip, label, count);
    button.addEventListener('click', () => startPlacement('note', category));
    list.append(button);
  }
  $('category-total').textContent = categories.length;
  $('random-note').disabled = !categories.length;
  $('empty-start').disabled = !categories.length;
  $('category-message').hidden = Boolean(categories.length);
  $('category-message').textContent = categoryLoadFailed ? 'Couldn’t load categories.txt. You can still use index cards.' : 'Add one category per line in categories.txt to get started. Index cards are ready to use.';
  $('retry-categories').hidden = !categoryLoadFailed;
  if (categories.length && !shown.length) {
    const empty = document.createElement('p'); empty.className = 'no-results'; empty.textContent = 'No matching categories.'; list.append(empty);
  }
}

function renderPalette() {
  $('palette').value = board.palette;
  $('theme').value = board.theme;
  document.body.dataset.theme = board.theme;
  const preview = $('palette-preview'); preview.replaceChildren();
  for (let i = 0; i < 9; i++) {
    const swatch = document.createElement('span');
    const dummy = Array.from({length: 9}, (_, index) => String(index));
    swatch.style.background = categoryColor(String(i), dummy, board.palette);
    preview.append(swatch);
  }
}

function updateNoteColors() {
  for (const note of board.notes) noteElements.get(note.id)?.style.setProperty('--note-color', colorFor(note.category));
  if (placement) $('placement-preview').style.setProperty('--note-color', colorFor(placement.category));
}

function updateCounts() {
  $('note-count').textContent = `${board.notes.length} ${board.notes.length === 1 ? 'note' : 'notes'}`;
  $('empty-state').hidden = Boolean(board.notes.length);
}

function applyView() {
  const v = board.view;
  world.style.transform = `translate(${v.x}px, ${v.y}px) scale(${v.zoom})`;
  $('zoom-reset').textContent = `${Math.round(v.zoom * 100)}%`;
  $('zoom-in').disabled = v.zoom >= 2;
  $('zoom-out').disabled = v.zoom <= .25;
  if (placement && pointer) movePreview(pointer);
}

function localPoint(event) {
  const rect = viewport.getBoundingClientRect();
  return {x: event.clientX - rect.left, y: event.clientY - rect.top};
}

function setSelected(id) {
  if (selected) noteElements.get(selected)?.classList.remove('is-selected');
  selected = id;
  if (id) noteElements.get(id)?.classList.add('is-selected');
}

function bringForward(id) {
  const index = board.notes.findIndex(note => note.id === id);
  if (index < 0 || index === board.notes.length - 1) return;
  board.notes.push(board.notes.splice(index, 1)[0]);
  board.notes.forEach((note, i) => { if (noteElements.has(note.id)) noteElements.get(note.id).style.zIndex = String(i + 1); });
  saveSoon();
}

function autosize(note, element) {
  const baseWidth = note.type === 'card' ? 344 : 248;
  const maxAutoWidth = note.type === 'card' ? 480 : 370;
  const longest = Math.max(0, ...`${note.type === 'card' ? note.title : note.category}\n${note.text}`.split('\n').map(line => line.length));
  const width = note.width || Math.min(maxAutoWidth, Math.max(baseWidth, 42 + longest * 6.1));
  element.style.width = `${width}px`;
  for (const area of element.querySelectorAll('textarea')) {
    area.style.height = '0px';
    area.style.height = `${Math.max(area.classList.contains('note-content') ? 92 : 22, area.scrollHeight)}px`;
  }
}

function actionButton(label, iconName, callback) {
  const button = document.createElement('button');
  button.type = 'button'; button.title = label; button.setAttribute('aria-label', label); button.append(icon(iconName));
  button.addEventListener('pointerdown', e => e.stopPropagation());
  button.addEventListener('click', event => { event.stopPropagation(); callback(); });
  return button;
}

function buildNote(note, index) {
  const element = document.createElement('article');
  element.className = `note${note.type === 'card' ? ' index-card' : ''}`;
  element.dataset.noteId = note.id;
  element.style.left = `${note.x}px`; element.style.top = `${note.y}px`;
  element.style.zIndex = String(index + 1);
  element.style.setProperty('--tilt', `${note.tilt}deg`);
  element.style.setProperty('--note-color', colorFor(note.category));
  element.setAttribute('aria-label', note.type === 'card' ? 'Index card' : `${note.category} note`);
  const handle = document.createElement('div');
  handle.className = 'note-drag'; handle.tabIndex = 0; handle.setAttribute('role', 'button');
  handle.setAttribute('aria-label', `Move ${note.type === 'card' ? 'index card' : note.category + ' note'}. Drag or use arrow keys.`);
  handle.append(icon('grip'));
  const pin = document.createElement('span'); pin.className = 'pin'; handle.append(pin);
  element.append(handle);
  let title;
  if (note.type === 'card') {
    title = document.createElement('textarea'); title.value = note.title; title.rows = 1;
    title.placeholder = 'A thought…'; title.setAttribute('aria-label', 'Index card title');
    title.addEventListener('focus', record);
    title.addEventListener('input', () => { note.title = title.value; autosize(note, element); saveSoon(); });
  } else {
    title = document.createElement('h2'); title.textContent = note.category;
  }
  title.className = `note-title${note.type === 'card' ? ' note-title-input' : ''}`;
  const content = document.createElement('textarea');
  content.className = 'note-content'; content.rows = 3; content.value = note.text;
  content.placeholder = note.type === 'card' ? 'Let it spill out…' : 'What’s on your mind?';
  content.setAttribute('aria-label', note.type === 'card' ? 'Index card content' : `${note.category} note content`);
  content.addEventListener('focus', record);
  content.addEventListener('input', () => { note.text = content.value; autosize(note, element); saveSoon(); });
  content.addEventListener('keydown', event => {
    if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) {
      const result = continueList(content.value, content.selectionStart, content.selectionEnd);
      if (result) {
        event.preventDefault();
        content.value = result.text; content.setSelectionRange(result.cursor, result.cursor);
        note.text = content.value; autosize(note, element); saveSoon();
      }
    }
  });
  const actions = document.createElement('div'); actions.className = 'note-actions';
  actions.append(
    actionButton('Add bullets', 'list', () => addBullets(note, content, element)),
    actionButton('Duplicate note', 'copy', () => duplicateNote(note)),
    actionButton('Delete note', 'trash', () => removeNote(note.id)),
  );
  const resize = document.createElement('button'); resize.className = 'note-resize';
  resize.setAttribute('aria-label', 'Resize note width. Drag or use left and right arrow keys.');
  resize.title = 'Drag to change width; double-click for automatic sizing';
  resize.addEventListener('dblclick', () => { record(); delete note.width; autosize(note, element); saveSoon(); });
  resize.addEventListener('keydown', event => {
    if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return;
    event.preventDefault(); record(); note.width = Math.max(190, Math.min(800, element.offsetWidth + (event.key === 'ArrowRight' ? 10 : -10))); autosize(note, element); saveSoon();
  });
  handle.addEventListener('keydown', event => {
    const direction = {ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1]}[event.key];
    if (!direction) return;
    event.preventDefault(); record();
    const step = event.shiftKey ? 1 : 10;
    note.x += direction[0] * step; note.y += direction[1] * step;
    element.style.left = `${note.x}px`; element.style.top = `${note.y}px`; saveSoon();
  });
  element.addEventListener('pointerdown', () => { setSelected(note.id); bringForward(note.id); });
  element.append(title, content, actions, resize);
  noteElements.set(note.id, element);
  world.append(element);
  autosize(note, element);
  return element;
}

function renderBoard() {
  world.replaceChildren(); noteElements.clear();
  $('board-name').value = board.name;
  board.notes.forEach(buildNote);
  renderCategories(); renderPalette(); updateCounts(); applyView();
}

function randomCategory() {
  if (!categories.length) return;
  let options = categories;
  if (categories.length > 1 && placement?.type === 'note') options = categories.filter(c => c !== placement.category);
  const random = new Uint32Array(1); crypto.getRandomValues(random);
  startPlacement('note', options[Math.floor((random[0] / 4294967296) * options.length)]);
}

function setSidebar(open) {
  $('sidebar').classList.toggle('is-open', open);
  $('sidebar-scrim').hidden = !open;
  $('toggle-sidebar').setAttribute('aria-expanded', String(open));
}

function startPlacement(type, category = '') {
  handMode = false; spaceHeld = false;
  updateHandMode(); setSelected(null);
  placement = {type, category};
  viewport.classList.add('is-placing');
  $('placement-preview').hidden = false;
  $('placement-preview').classList.toggle('index-preview', type === 'card');
  $('placement-preview').style.setProperty('--note-color', colorFor(category));
  $('preview-title').textContent = type === 'card' ? 'Notes' : category;
  $('preview-hint').textContent = matchMedia('(pointer:coarse)').matches ? 'Tap to pin it here' : 'Click to pin it here';
  $('placement-label').textContent = type === 'card' ? 'Pick a spot for your index card' : `Pick a spot for “${category}”`;
  $('placement-bar').hidden = false;
  $('empty-state').classList.add('placing');
  setSidebar(false); renderCategories();
  pointer = {x: viewport.clientWidth / 2 - (type === 'card' ? 100 : 70), y: viewport.clientHeight / 2 - 80};
  movePreview(pointer);
}

function movePreview(point) {
  const preview = $('placement-preview');
  preview.style.left = `${point.x}px`; preview.style.top = `${point.y}px`;
  preview.style.transform = `scale(${board.view.zoom}) rotate(-2deg)`;
}

function cancelPlacement() {
  placement = null; viewport.classList.remove('is-placing');
  $('placement-preview').hidden = true; $('placement-bar').hidden = true;
  $('empty-state').classList.remove('placing'); renderCategories();
}

function placeNote(point) {
  if (!placement) return;
  record();
  const location = screenToWorld(point, board.view);
  const note = {id: crypto.randomUUID(), type: placement.type, category: placement.category, title: placement.type === 'card' ? 'Notes' : placement.category, text: '', x: location.x, y: location.y, tilt: (Math.random() - .5) * 2.4};
  board.notes.push(note);
  const element = buildNote(note, board.notes.length - 1);
  cancelPlacement(); setSelected(note.id); updateCounts(); saveNow();
  // Keep a newly placed note within reach when pinning near a viewport edge.
  const right = (note.x + element.offsetWidth + 15) * board.view.zoom + board.view.x;
  const bottom = (note.y + element.offsetHeight + 90) * board.view.zoom + board.view.y;
  if (right > viewport.clientWidth) board.view.x -= right - viewport.clientWidth;
  if (bottom > viewport.clientHeight) board.view.y -= bottom - viewport.clientHeight;
  applyView(); saveSoon();
  requestAnimationFrame(() => element.querySelector('.note-content').focus({preventScroll: true}));
}

function removeNote(id) {
  record(); board.notes = board.notes.filter(n => n.id !== id);
  noteElements.get(id)?.remove(); noteElements.delete(id); setSelected(null);
  renderCategories(); updateCounts(); saveNow(); toast('Note removed.', true);
}

function duplicateNote(note) {
  record();
  const copy = {...note, id: crypto.randomUUID(), x: note.x + 28, y: note.y + 28};
  board.notes.push(copy); const element = buildNote(copy, board.notes.length - 1);
  setSelected(copy.id); updateCounts(); renderCategories(); saveNow();
  element.querySelector('.note-content').focus({preventScroll: true});
}

function addBullets(note, content, element) {
  record();
  const start = content.selectionStart; const end = content.selectionEnd;
  const from = content.value.lastIndexOf('\n', Math.max(-1, start - 1)) + 1;
  let until = content.value.indexOf('\n', end);
  if (until === -1) until = content.value.length;
  const lines = content.value.slice(from, until).split('\n');
  const already = lines.every(line => /^\s*[-*•] /.test(line));
  const replacement = lines.map(line => already ? line.replace(/^(\s*)[-*•] /, '$1') : /^\s*[-*•] /.test(line) ? line : `• ${line}`).join('\n');
  content.setRangeText(replacement, from, until, 'end');
  note.text = content.value; autosize(note, element); saveSoon(); content.focus({preventScroll: true});
}

function updateHandMode() {
  viewport.classList.toggle('hand-mode', handMode || spaceHeld);
  $('pan-mode').setAttribute('aria-pressed', String(handMode));
}

function changeZoom(factor, point = {x: viewport.clientWidth / 2, y: viewport.clientHeight / 2}) {
  board.view = zoomAt(board.view, board.view.zoom * factor, point); applyView(); saveSoon();
}

function fitView() {
  if (!board.notes.length) { board.view = {x: 0, y: 0, zoom: 1}; applyView(); saveSoon(); return; }
  const rects = board.notes.map(n => ({x: n.x, y: n.y, w: noteElements.get(n.id).offsetWidth, h: noteElements.get(n.id).offsetHeight}));
  const left = Math.min(...rects.map(r => r.x)); const top = Math.min(...rects.map(r => r.y));
  const right = Math.max(...rects.map(r => r.x + r.w)); const bottom = Math.max(...rects.map(r => r.y + r.h));
  const zoom = Math.max(.25, Math.min(1, (viewport.clientWidth - 70) / (right - left), (viewport.clientHeight - 150) / (bottom - top)));
  board.view = {zoom, x: (viewport.clientWidth - (right - left) * zoom) / 2 - left * zoom, y: 38 - top * zoom + Math.max(0, (viewport.clientHeight - 150 - (bottom - top) * zoom) / 2)};
  applyView(); saveSoon();
}

viewport.addEventListener('pointerdown', event => {
  if (event.target.closest('.board-footer, .placement-bar')) return;
  if (event.button !== 0 && event.button !== 1) return;
  activePointers.set(event.pointerId, localPoint(event));
  if (activePointers.size === 2) {
    if (gesture?.element) gesture.element.classList.remove('is-dragging', 'is-resizing');
    const [a, b] = [...activePointers.values()];
    gesture = {type: 'pinch', distance: Math.hypot(b.x - a.x, b.y - a.y), center: {x: (a.x + b.x) / 2, y: (a.y + b.y) / 2}, view: {...board.view}, moved: true};
    viewport.setPointerCapture(event.pointerId); return;
  }
  const point = localPoint(event);
  const noteElement = event.target.closest('.note');
  const controls = event.target.closest('.note-actions, .note-content, .note-title-input');
  if (placement) {
    gesture = {type: 'place', start: point, moved: false}; viewport.setPointerCapture(event.pointerId); return;
  }
  if (controls && !handMode && !spaceHeld) return;
  const note = noteElement && board.notes.find(n => n.id === noteElement.dataset.noteId);
  if (note && !handMode && !spaceHeld) {
    const resize = event.target.closest('.note-resize');
    if (!resize && !event.target.closest('.note-drag')) return;
    gesture = {type: resize ? 'resize' : 'note', start: point, note, element: noteElement, x: note.x, y: note.y, width: noteElement.offsetWidth, moved: false};
    event.preventDefault();
  } else {
    document.activeElement?.blur(); setSelected(null);
    gesture = {type: 'pan', start: point, view: {...board.view}, moved: false};
    event.preventDefault();
  }
  viewport.setPointerCapture(event.pointerId);
});

viewport.addEventListener('pointermove', event => {
  const point = localPoint(event); pointer = point;
  if (activePointers.has(event.pointerId)) activePointers.set(event.pointerId, point);
  if (placement && !gesture?.moved) movePreview(point);
  if (!gesture) return;
  if (gesture.type === 'pinch') {
    if (activePointers.size < 2) return;
    const [a, b] = [...activePointers.values()];
    const center = {x: (a.x + b.x) / 2, y: (a.y + b.y) / 2};
    const distance = Math.hypot(b.x - a.x, b.y - a.y);
    board.view = zoomAt(gesture.view, gesture.view.zoom * distance / Math.max(1, gesture.distance), gesture.center);
    board.view.x += center.x - gesture.center.x; board.view.y += center.y - gesture.center.y;
    applyView(); return;
  }
  const dx = point.x - gesture.start.x; const dy = point.y - gesture.start.y;
  if (!gesture.moved && Math.hypot(dx, dy) < 4) return;
  if (!gesture.moved) {
    gesture.moved = true;
    if (gesture.type === 'note' || gesture.type === 'resize') record();
  }
  if (gesture.type === 'place') { movePreview(point); return; }
  if (gesture.type === 'pan') {
    board.view.x = gesture.view.x + dx; board.view.y = gesture.view.y + dy;
    viewport.classList.add('is-panning'); applyView();
  } else if (gesture.type === 'note') {
    gesture.note.x = gesture.x + dx / board.view.zoom; gesture.note.y = gesture.y + dy / board.view.zoom;
    gesture.element.style.left = `${gesture.note.x}px`; gesture.element.style.top = `${gesture.note.y}px`; gesture.element.classList.add('is-dragging');
  } else if (gesture.type === 'resize') {
    gesture.note.width = Math.max(190, Math.min(800, gesture.width + dx / board.view.zoom));
    gesture.element.classList.add('is-resizing'); autosize(gesture.note, gesture.element);
  }
});

function endGesture(event) {
  activePointers.delete(event.pointerId);
  if (!gesture) return;
  if (gesture.type === 'place' && event.type !== 'pointercancel') placeNote(localPoint(event));
  if (gesture.element) gesture.element.classList.remove('is-dragging', 'is-resizing');
  viewport.classList.remove('is-panning');
  gesture = null;
  if (viewport.hasPointerCapture(event.pointerId)) viewport.releasePointerCapture(event.pointerId);
  saveSoon();
}
viewport.addEventListener('pointerup', endGesture);
viewport.addEventListener('pointercancel', endGesture);
viewport.addEventListener('pointerleave', () => { if (placement && !gesture) $('placement-preview').hidden = true; });
viewport.addEventListener('pointerenter', () => { if (placement) $('placement-preview').hidden = false; });
viewport.addEventListener('wheel', event => {
  if (event.target.closest('.note-content, .note-title-input') && !event.ctrlKey && !event.metaKey) return;
  event.preventDefault();
  if (event.ctrlKey || event.metaKey) changeZoom(Math.exp(-event.deltaY * .006), localPoint(event));
  else {
    const scale = event.deltaMode === 1 ? 18 : event.deltaMode === 2 ? viewport.clientHeight : 1;
    if (event.shiftKey) board.view.x -= (event.deltaY || event.deltaX) * scale;
    else { board.view.x -= event.deltaX * scale; board.view.y -= event.deltaY * scale; }
    applyView(); saveSoon();
  }
}, {passive: false});

$('category-search').addEventListener('input', renderCategories);
$('random-note').addEventListener('click', randomCategory);
$('empty-start').addEventListener('click', randomCategory);
$('add-card').addEventListener('click', () => startPlacement('card'));
$('cancel-placement').addEventListener('click', cancelPlacement);
$('retry-categories').addEventListener('click', loadCategories);
$('palette').addEventListener('change', () => { record(); board.palette = $('palette').value; renderCategories(); renderPalette(); updateNoteColors(); saveNow(); });
$('theme').addEventListener('change', () => { record(); board.theme = $('theme').value; renderPalette(); saveNow(); });
$('board-name').addEventListener('focus', record);
$('board-name').addEventListener('input', () => { board.name = $('board-name').value; saveSoon(); });
$('board-name').addEventListener('blur', () => { if (!board.name.trim()) { board.name = 'My board'; $('board-name').value = board.name; saveSoon(); } });
$('board-name').addEventListener('keydown', e => { if (e.key === 'Enter') e.target.blur(); });
$('undo').addEventListener('click', () => historyStep(undoStack, redoStack));
$('redo').addEventListener('click', () => historyStep(redoStack, undoStack));
$('toast-undo').addEventListener('click', () => { historyStep(undoStack, redoStack); $('toast').hidden = true; });
$('zoom-in').addEventListener('click', () => changeZoom(1.2));
$('zoom-out').addEventListener('click', () => changeZoom(1 / 1.2));
$('zoom-reset').addEventListener('click', () => { board.view = zoomAt(board.view, 1, {x: viewport.clientWidth / 2, y: viewport.clientHeight / 2}); applyView(); saveSoon(); });
$('fit-view').addEventListener('click', fitView);
$('pan-mode').addEventListener('click', () => { cancelPlacement(); handMode = !handMode; updateHandMode(); });
$('reset-view').addEventListener('click', () => { board.view = {x: 0, y: 0, zoom: 1}; applyView(); saveSoon(); closeMenu(); });
$('toggle-sidebar').addEventListener('click', () => setSidebar(!$('sidebar').classList.contains('is-open')));
$('sidebar-scrim').addEventListener('click', () => setSidebar(false));

function closeMenu() { $('board-menu').hidden = true; $('board-menu-button').setAttribute('aria-expanded', 'false'); }
$('board-menu-button').addEventListener('click', () => { const open = $('board-menu').hidden; $('board-menu').hidden = !open; $('board-menu-button').setAttribute('aria-expanded', String(open)); });
document.addEventListener('click', event => { if (!event.target.closest('.menu-wrap')) closeMenu(); });
$('show-help').addEventListener('click', () => { setSidebar(false); $('help-dialog').showModal(); });
$('close-help').addEventListener('click', () => $('help-dialog').close());
$('help-done').addEventListener('click', () => $('help-dialog').close());

$('export-board').addEventListener('click', () => {
  const blob = new Blob([JSON.stringify({...board, exportedAt: new Date().toISOString()}, null, 2)], {type: 'application/json'});
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  const name = board.name.replace(/[^a-z0-9 _-]/gi, '').trim() || 'cork-board';
  link.href = url; link.download = `${name}-${new Date().toISOString().slice(0, 10)}.json`;
  document.body.append(link); link.click(); link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10000);
  closeMenu(); toast('Board exported. Keep the JSON file as your backup.');
});
$('import-board').addEventListener('click', () => { closeMenu(); $('import-file').click(); });
$('import-file').addEventListener('change', async event => {
  const file = event.target.files[0]; event.target.value = '';
  if (!file) return;
  try {
    if (file.size > 10 * 1024 * 1024) throw new Error('Choose a board file smaller than 10 MB.');
    pendingImport = validateBoard(JSON.parse(await file.text()));
    $('import-summary').textContent = `“${pendingImport.name}” contains ${pendingImport.notes.length} ${pendingImport.notes.length === 1 ? 'note' : 'notes'}.`;
    $('import-dialog').showModal();
  } catch (error) { pendingImport = null; toast(error instanceof SyntaxError ? 'That file isn’t a valid Cork JSON export. Nothing was changed.' : error.message); }
});
$('cancel-import').addEventListener('click', () => { pendingImport = null; $('import-dialog').close(); });
$('import-dialog').addEventListener('cancel', () => { pendingImport = null; });
$('confirm-import').addEventListener('click', () => {
  if (!pendingImport) return;
  record(); cancelPlacement(); board = pendingImport; pendingImport = null;
  $('import-dialog').close(); setSelected(null); renderBoard();
  saveNow(); toast('Board imported.', true);
});

document.addEventListener('keydown', event => {
  const editing = event.target.matches('textarea, input, select, [contenteditable=true]');
  if (event.key === 'Escape') { cancelPlacement(); closeMenu(); setSidebar(false); return; }
  if (editing || document.querySelector('dialog[open]')) return;
  if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'z') { event.preventDefault(); historyStep(event.shiftKey ? redoStack : undoStack, event.shiftKey ? undoStack : redoStack); return; }
  if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'y') { event.preventDefault(); historyStep(redoStack, undoStack); return; }
  if (event.ctrlKey || event.metaKey || event.altKey) return;
  if (event.key.toLowerCase() === 'r') { event.preventDefault(); randomCategory(); }
  else if (event.key.toLowerCase() === 'i') { event.preventDefault(); startPlacement('card'); }
  else if (event.key === '/') { event.preventDefault(); setSidebar(true); $('category-search').focus(); }
  else if (event.key === ' ') { event.preventDefault(); spaceHeld = true; updateHandMode(); }
  else if ((event.key === 'Delete' || event.key === 'Backspace') && selected) { event.preventDefault(); removeNote(selected); }
  else if (event.key === 'Enter' && placement) { event.preventDefault(); placeNote(pointer || {x: viewport.clientWidth / 2, y: viewport.clientHeight / 2}); }
});
document.addEventListener('keyup', event => { if (event.key === ' ') { spaceHeld = false; updateHandMode(); } });
window.addEventListener('blur', () => { spaceHeld = false; updateHandMode(); });
window.addEventListener('pagehide', saveNow);
document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'hidden') saveNow(); });
window.addEventListener('storage', event => {
  if (event.key !== storageKey || !event.newValue) return;
  clearTimeout(saveTimer); savingBlocked = true;
  setSaveStatus('Changed in another tab — saving paused', true);
  toast('This board changed in another tab. Export this copy if needed, then reload to use the latest saved board.');
});
window.addEventListener('resize', () => { if (window.innerWidth > 680) setSidebar(false); applyView(); });

renderBoard();
loadCategories();
if (startupProblem) { setSaveStatus('Saved board unavailable — saving paused', true); toast(startupProblem); }
