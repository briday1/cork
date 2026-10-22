import {STORAGE_KEY, parseCategoryFile, missingBoardCategories, directoryNameFromFiles, categoryColor, blankBoard, screenToWorld, zoomAt, revealNote, focusNoteView, validateBoard, continueList} from './board-core.js';
import {prepareImage, putImage, getImage, exportImages, importImages, putFolder, getFolder} from './image-store.js';
import {connectionGeometry} from './export-core.js';
import {readCategoryFile, readCategoryCache, writeCategoryCache, readLinkedCategories, getCategoryHandle, putCategoryHandle} from './category-file.js';

const $ = id => document.getElementById(id);
const viewport = $('viewport');
const world = $('board-world');
const corkTexture = document.querySelector('.cork-texture');
const corkTiles = new Map();
// The photograph is 2048 × 1536: two image pixels per board unit at 100%.
const corkTileSize = {width: 1024, height: 768};
const storageKey = `${STORAGE_KEY}:${location.pathname.replace(/index\.html$/, '')}`;
const categoriesKey = `${storageKey}:categories`;
let board = blankBoard();
let categories = [];
let frequentCategories = new Set();
let categoryFile = null, categoryHandle = null, categoryText = '', categoryStatus = '';
let categoryRevision = 0, categoryBusy = false, categoriesReady = false, lastCategoryCheck = 0;
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
let pendingImages = [];
let folderPickTarget = null;
let pdfExporting = false;
let stringMode = false, stringStart = null, selectedString = null, stringFrame = 0, stringLayer;
let savingBlocked = false;
let startupProblem = '';
const undoStack = [];
const redoStack = [];
const noteElements = new Map();
const imageResources = new Map();
const folderHandles = new Map();
const activePointers = new Map();
const compactLayout = matchMedia('(max-width: 680px), (max-height: 500px) and (pointer: coarse)');
let mobileEditing = null;
let caretFrame = 0;
let largestVisibleHeight = window.innerHeight;
let lastViewportWidth = window.innerWidth;
let suppressNoteClickUntil = 0;
let desktopSidebarOpen = true;
try { desktopSidebarOpen = localStorage.getItem(`${storageKey}:sidebar`) !== 'closed'; } catch { /* Board saving reports unavailable storage. */ }

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
  setStringMode(false);
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

function colorFor(category) {
  const name = categories.find(name => name.toLocaleLowerCase() === category.trim().toLocaleLowerCase()) || category;
  return categoryColor(name, categories, board.palette);
}

function applyCategoryText(text) {
  categoryText = text;
  const parsed = parseCategoryFile(text);
  categories = parsed.categories;
  frequentCategories = new Set(parsed.frequentCategories);
  categoriesReady = true;
  categoryLoadFailed = false;
  renderCategories();
  updateNoteColors();
}

function renderCategorySource() {
  $('category-source-name').textContent = categoryFile?.name || 'Default categories';
  $('category-source-status').textContent = categoryStatus || (categoryFile ? 'Saved in this browser. Use Refresh after editing the file.' : 'Load your own .txt file to use instead.');
  $('category-source').classList.toggle('is-local', Boolean(categoryFile));
  $('refresh-categories').hidden = !categoryFile;
  $('default-categories').hidden = !categoryFile;
  $('refresh-categories').textContent = categoryHandle ? 'Refresh' : 'Reload file…';
  $('download-categories').disabled = !categoriesReady || categoryLoadFailed;
  for (const id of ['load-categories', 'refresh-categories', 'default-categories']) $(id).disabled = categoryBusy;
}

function cacheCategories() {
  try { writeCategoryCache(localStorage, categoriesKey, categoryFile); return true; }
  catch {
    categoryStatus = 'Loaded for this tab. Browser storage could not remember the list; keep your text file.';
    return false;
  }
}

async function loadDefaultCategories() {
  const revision = ++categoryRevision;
  categoryStatus = 'Loading default categories…';
  renderCategorySource();
  try {
    const response = await fetch(new URL('./categories.txt', import.meta.url), {cache: 'no-store'});
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const text = await response.text();
    if (revision !== categoryRevision) return;
    categoryStatus = '';
    applyCategoryText(text);
  } catch (error) {
    if (revision !== categoryRevision) return;
    categoryLoadFailed = true;
    categoriesReady = true;
    categories = [];
    frequentCategories.clear();
    categoryStatus = 'Couldn’t load the default list. Load a local file or retry below.';
    renderCategories(); updateNoteColors();
    console.warn('Cork could not load categories.txt:', error.message);
  }
  renderCategorySource();
}

async function loadCategories() {
  const revision = ++categoryRevision;
  categoryFile = null; categoryHandle = null; categoryBusy = false;
  try {
    categoryFile = readCategoryCache(localStorage, categoriesKey);
  } catch { /* Defaults remain available if browser storage cannot be read. */ }
  if (!categoryFile) return loadDefaultCategories();
  categoryStatus = 'Using the saved list. Checking the linked file…';
  applyCategoryText(categoryFile.text); renderCategorySource();
  try {
    const saved = await getCategoryHandle(categoriesKey);
    if (revision !== categoryRevision) return;
    // A token prevents a previous file's handle being attached to a newer list
    // if the browser could save the text but could not replace the old handle.
    if (saved?.token === categoryFile.token && typeof window.showOpenFilePicker === 'function') categoryHandle = saved.handle;
  } catch { /* The cached list also works without IndexedDB. */ }
  if (revision !== categoryRevision) return;
  if (categoryHandle) return refreshCategories(false);
  categoryStatus = 'Saved in this browser. After editing the file, use Reload file to select it again.';
  renderCategorySource();
}

async function chooseCategories() {
  if (typeof window.showOpenFilePicker !== 'function') return $('categories-file').click();
  const revision = ++categoryRevision;
  categoryBusy = true; renderCategorySource();
  try {
    const [handle] = await window.showOpenFilePicker({id: 'cork-categories', multiple: false, types: [{description: 'Categories text file', accept: {'text/plain': ['.txt']}}], ...(categoryHandle ? {startIn: categoryHandle} : {})});
    const file = await handle.getFile();
    await useCategoryFile(file, handle, revision);
  } catch (error) {
    if (revision === categoryRevision && error.name !== 'AbortError') toast(error.message || 'Could not open the categories file.');
  } finally {
    if (revision === categoryRevision) {
      categoryBusy = false; renderCategorySource();
      if (!categoriesReady) loadCategories();
    }
  }
}

async function useCategoryFile(file, handle = null, revision = ++categoryRevision) {
  const data = await readCategoryFile(file);
  if (revision !== categoryRevision) return;
  categoryFile = {version: 1, ...data, token: crypto.randomUUID()};
  categoryHandle = handle;
  categoryStatus = handle ? 'Linked to this file. Changes are checked when you return to the tab.' : 'Saved in this browser. After editing the file, use Reload file to select it again.';
  applyCategoryText(data.text);
  const remembered = cacheCategories();
  renderCategorySource();
  try {
    await putCategoryHandle(categoriesKey, handle ? {token: categoryFile.token, handle} : null);
  } catch {
    if (revision !== categoryRevision) return;
    if (remembered) categoryStatus = 'List saved in this browser. The file link could not be remembered; select it again after editing.';
    renderCategorySource();
  }
}

async function refreshCategories(askPermission = true) {
  if (!categoryFile || categoryBusy) return;
  if (!categoryHandle) { if (askPermission) return chooseCategories(); return; }
  const revision = ++categoryRevision;
  categoryBusy = true; lastCategoryCheck = Date.now(); renderCategorySource();
  try {
    const data = await readLinkedCategories(categoryHandle, askPermission);
    if (revision !== categoryRevision) return;
    if (data) {
      categoryFile = {...categoryFile, ...data};
      categoryStatus = 'Linked to this file. Changes are checked when you return to the tab.';
      applyCategoryText(data.text); cacheCategories();
    } else {
      categoryStatus = 'Using the saved list. Click Refresh to allow access to the linked file again.';
    }
  } catch {
    if (revision !== categoryRevision) return;
    categoryStatus = 'Using the saved list. The linked file couldn’t be read; use Load file to reconnect it.';
  } finally {
    if (revision === categoryRevision) { categoryBusy = false; renderCategorySource(); }
  }
}

function checkCategoryFile() {
  if (document.visibilityState !== 'hidden' && categoryHandle && !categoryBusy && Date.now() - lastCategoryCheck > 1500) refreshCategories(false);
}

function renderCategories() {
  const list = $('category-list');
  list.replaceChildren();
  const query = $('category-search').value.trim().toLocaleLowerCase();
  const shown = categories.filter(category => category.toLocaleLowerCase().includes(query));
  const missing = categoriesReady ? missingBoardCategories(board.notes, categories) : [];
  const shownMissing = missing.filter(category => category.toLocaleLowerCase().includes(query));
  const counts = new Map();
  for (const note of board.notes) if (note.type === 'note') {
    const key = note.category.trim().toLocaleLowerCase();
    counts.set(key, (counts.get(key) || 0) + 1);
  }
  const groups = frequentCategories.size ? [
    ['Frequently used', shown.filter(category => frequentCategories.has(category))],
    ['Other categories', shown.filter(category => !frequentCategories.has(category))],
  ] : [[null, shown]];
  if (shownMissing.length) groups.push(['Also on this board', shownMissing]);
  for (const [heading, names] of groups) {
    if (!names.length) continue;
    if (heading) {
      const title = document.createElement('h3'); title.className = 'category-group-title'; title.textContent = heading;
      list.append(title);
    }
    for (const category of names) {
    const button = document.createElement('button');
    button.className = 'category-row';
    button.classList.toggle('is-active', placement?.type === 'note' && placement.category === category);
    button.style.setProperty('--note-color', colorFor(category));
    button.setAttribute('aria-pressed', String(placement?.type === 'note' && placement.category === category));
    button.setAttribute('aria-label', `Place a ${category} note`);
    if (heading === 'Also on this board') button.title = 'Used on this board; not listed in the categories file. You can still use it.';
    const chip = document.createElement('span'); chip.className = 'color-chip'; chip.setAttribute('aria-hidden', 'true');
    const label = document.createElement('span'); label.className = 'category-label'; label.textContent = category;
    const count = document.createElement('span'); count.className = 'category-count'; count.textContent = counts.get(category.trim().toLocaleLowerCase()) || '';
    button.append(chip, label, count);
    button.addEventListener('click', () => startPlacement('note', category));
    list.append(button);
    }
  }
  $('category-total').textContent = categories.length + missing.length;
  $('random-note').disabled = !categories.length && !missing.length;
  $('category-message').hidden = Boolean(categories.length || missing.length) || !categoriesReady;
  $('category-message').textContent = categoryLoadFailed ? 'Couldn’t load the categories file. Load a local file or retry.' : 'The categories file is empty. Add one category per line, then reload it. Index cards are ready to use.';
  $('category-missing').hidden = !missing.length || categoryLoadFailed;
  const missingMessage = missing.length === 1 ? '1 board category isn’t in this file. It still works and is listed below.' : `${missing.length} board categories aren’t in this file. They still work and are listed below.`;
  if ($('category-missing').textContent !== missingMessage) $('category-missing').textContent = missingMessage;
  $('retry-categories').hidden = !categoryLoadFailed;
  if ((categories.length || missing.length) && !shown.length && !shownMissing.length) {
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
  $('board-tip').hidden = !board.notes.length;
  $('export-pdf').disabled = pdfExporting || !board.notes.length;
  $('add-string').disabled = board.notes.length < 2;
  if (board.notes.length < 2 && stringMode) setStringMode(false);
}

function queueStrings() {
  cancelAnimationFrame(stringFrame);
  stringFrame = requestAnimationFrame(renderStrings);
}

function setStringMode(active) {
  stringMode = active; stringStart = null;
  viewport.classList.toggle('is-connecting', active);
  $('add-string').setAttribute('aria-pressed', String(active));
  $('board-tip').textContent = active ? 'Select the first item.' : 'Scroll to zoom. Drag the cork to pan.';
  for (const element of noteElements.values()) element.classList.remove('is-string-start');
}

function chooseStringItem(id) {
  if (!stringStart) {
    stringStart = id; noteElements.get(id)?.classList.add('is-string-start');
    $('board-tip').textContent = 'Select a different item.';
    return;
  }
  if (id === stringStart) return;
  if (!board.connections.some(link => link.from === stringStart && link.to === id || link.from === id && link.to === stringStart)) {
    record(); board.connections.push({id: crypto.randomUUID(), from: stringStart, to: id}); saveNow();
  }
  setStringMode(false); renderStrings();
}

function removeString(id) {
  record(); board.connections = board.connections.filter(connection => connection.id !== id);
  selectedString = null; renderStrings(); saveNow();
}

function renderStrings() {
  if (!stringLayer?.isConnected) {
    stringLayer = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    stringLayer.classList.add('connection-layer'); stringLayer.setAttribute('aria-label', 'Connections');
    world.prepend(stringLayer);
  }
  stringLayer.replaceChildren();
  const connected = new Set(), pins = new Map();
  const svg = (tag, attributes) => {
    const node = document.createElementNS('http://www.w3.org/2000/svg', tag);
    for (const [key, value] of Object.entries(attributes)) node.setAttribute(key, value);
    return node;
  };
  for (const connection of board.connections) {
    const from = board.notes.find(note => note.id === connection.from), to = board.notes.find(note => note.id === connection.to);
    if (!from || !to) continue;
    const rect = note => ({...note, width: parseFloat(getComputedStyle(noteElements.get(note.id)).width)});
    const curve = connectionGeometry(rect(from), rect(to));
    const d = `M ${curve.from.x} ${curve.from.y} Q ${curve.control.x} ${curve.control.y} ${curve.to.x} ${curve.to.y}`;
    const group = svg('g', {class: `yarn${selectedString === connection.id ? ' is-selected' : ''}`});
    group.append(svg('path', {d, class: 'yarn-base'}), svg('path', {d, class: 'yarn-twist'}));
    const hit = svg('path', {d, class: 'connection-hit', tabindex: '0', role: 'button', 'aria-label': 'Connection. Press Delete to remove.'});
    hit.addEventListener('click', event => { event.stopPropagation(); setSelected(null); selectedString = connection.id; renderStrings(); });
    hit.addEventListener('focus', () => {
      setSelected(null); selectedString = connection.id;
      for (const yarn of stringLayer.querySelectorAll('.yarn')) yarn.classList.toggle('is-selected', yarn === group);
    });
    hit.addEventListener('keydown', event => { if (event.key === 'Delete' || event.key === 'Backspace') { event.preventDefault(); event.stopPropagation(); removeString(connection.id); } });
    group.append(hit); stringLayer.append(group);
    connected.add(from.id); connected.add(to.id); pins.set(from.id, curve.from); pins.set(to.id, curve.to);
  }
  for (const [id, point] of pins) {
    const pin = svg('g', {class: 'connection-pin', 'data-note-id': id});
    pin.append(svg('circle', {cx: point.x + 1, cy: point.y + 1.5, r: 4.3, fill: '#4c241b', opacity: '.22'}), svg('circle', {cx: point.x, cy: point.y, r: 4, fill: '#aa4a37', stroke: '#763327', 'stroke-width': '.6'}), svg('circle', {cx: point.x - 1, cy: point.y - 1, r: 1.3, fill: '#f0b3a0'}));
    stringLayer.append(pin);
  }
  for (const [id, element] of noteElements) element.classList.toggle('is-connected', connected.has(id));
}

function updateCorkTexture(view) {
  corkTexture.style.transform = world.style.transform;
  const {width, height} = corkTileSize;
  const left = Math.floor(-view.x / view.zoom / width) - 1;
  const right = Math.floor((viewport.clientWidth - view.x) / view.zoom / width) + 1;
  const top = Math.floor(-view.y / view.zoom / height) - 1;
  const bottom = Math.floor((viewport.clientHeight - view.y) / view.zoom / height) + 1;
  const visible = new Set();
  for (let row = top; row <= bottom; row++) {
    for (let column = left; column <= right; column++) {
      const key = `${column},${row}`;
      visible.add(key);
      if (corkTiles.has(key)) continue;
      const tile = document.createElement('div');
      tile.className = 'cork-tile';
      tile.style.left = `${column * width}px`;
      tile.style.top = `${row * height}px`;
      // Mirrored neighbors share the same photo edge, with no hard tile seams.
      tile.style.transform = `scale(${column % 2 ? -1 : 1}, ${row % 2 ? -1 : 1})`;
      corkTexture.append(tile);
      corkTiles.set(key, tile);
    }
  }
  for (const [key, tile] of corkTiles) {
    if (visible.has(key)) continue;
    tile.remove();
    corkTiles.delete(key);
  }
}

function applyView() {
  const v = board.view;
  world.style.transform = `translate(${v.x}px, ${v.y}px) scale(${v.zoom})`;
  updateCorkTexture(v);
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
  if (id) { selectedString = null; queueStrings(); }
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
  if (note.type === 'folder') return;
  if (note.type === 'image') {
    const caption = element.querySelector('.polaroid-caption');
    let size = 16;
    caption.style.fontSize = `${size}px`;
    while (caption.scrollHeight > caption.clientHeight + 1 && size > 8) caption.style.fontSize = `${--size}px`;
    return;
  }
  const baseWidth = note.type === 'card' ? 344 : 248;
  const maxAutoWidth = note.type === 'card' ? 480 : 370;
  const longest = Math.max(0, ...`${note.type === 'card' ? note.title : note.category}\n${note.text}`.split('\n').map(line => line.length));
  const width = note.width || Math.min(maxAutoWidth, Math.max(baseWidth, 42 + longest * 6.1));
  element.style.width = `${width}px`;
  element.classList.toggle('has-custom-height', Boolean(note.height));
  element.style.minHeight = note.height ? `${note.height}px` : '';
  for (const area of element.querySelectorAll('textarea')) {
    area.style.height = '0px';
    const isContent = area.classList.contains('note-content');
    const style = getComputedStyle(area);
    const oneLine = parseFloat(style.lineHeight) + parseFloat(style.paddingTop) + parseFloat(style.paddingBottom);
    const minimum = isContent ? (note.height ? oneLine : 92) : 22;
    area.style.height = `${Math.max(minimum, area.scrollHeight)}px`;
  }
  if (note.height) {
    const content = element.querySelector('.note-content');
    const bottom = parseFloat(getComputedStyle(element).paddingBottom);
    const available = element.clientHeight - content.offsetTop - bottom;
    content.style.height = `${Math.max(parseFloat(content.style.height), available)}px`;
  }
  if (note.type === 'card') {
    // Start the ruling below the header even when the title wraps or grows.
    const content = element.querySelector('.note-content');
    element.style.setProperty('--rule-start', `${content.offsetTop - 7}px`);
  }
  queueStrings();
}

function revealOnBoard(note, element) {
  board.view = revealNote(board.view, {x: note.x, y: note.y, width: element.offsetWidth, height: element.offsetHeight}, {width: viewport.clientWidth, height: viewport.clientHeight}, compactLayout.matches);
  applyView();
}

function updateVisibleHeight() {
  const visible = window.visualViewport;
  // Leave native browser magnification available for accessibility.
  if (visible && Math.abs(visible.scale - 1) > .01) return;
  const height = visible?.height || window.innerHeight;
  if (Math.abs(window.innerWidth - lastViewportWidth) > 40) largestVisibleHeight = height;
  else if (!mobileEditing) largestVisibleHeight = Math.max(largestVisibleHeight, height);
  lastViewportWidth = window.innerWidth;
  document.documentElement.style.setProperty('--visible-height', `${height}px`);
  document.documentElement.style.setProperty('--visible-top', `${visible?.offsetTop || 0}px`);
  document.body.classList.toggle('keyboard-open', Boolean(mobileEditing && height < largestVisibleHeight - 100));
  queueCaretReveal();
}

function queueCaretReveal() {
  cancelAnimationFrame(caretFrame);
  if (!mobileEditing || !compactLayout.matches) return;
  caretFrame = requestAnimationFrame(() => {
    if (!mobileEditing || gesture || document.activeElement !== mobileEditing.input) return;
    const {note, input} = mobileEditing;
    // Measure the real wrapping so long notes can follow the insertion point.
    const style = getComputedStyle(input);
    const mirror = document.createElement('div');
    mirror.style.cssText = 'position:absolute;top:0;left:-100000px;visibility:hidden;pointer-events:none;white-space:pre-wrap;';
    for (const property of ['fontFamily', 'fontSize', 'fontWeight', 'fontStyle', 'lineHeight', 'letterSpacing', 'textIndent', 'paddingTop', 'paddingRight', 'paddingBottom', 'paddingLeft', 'boxSizing', 'wordBreak', 'overflowWrap']) mirror.style[property] = style[property];
    mirror.style.width = `${input.clientWidth}px`;
    const cursor = input.selectionDirection === 'backward' ? input.selectionStart : input.selectionEnd;
    mirror.textContent = input.value.slice(0, cursor);
    const marker = document.createElement('span'); marker.textContent = '\u200b'; mirror.append(marker);
    document.body.append(mirror);
    const rect = {x: note.x + input.offsetLeft + marker.offsetLeft, y: note.y + input.offsetTop + marker.offsetTop - input.scrollTop, width: 2, height: parseFloat(style.lineHeight) || 24};
    mirror.remove();
    board.view = revealNote(board.view, rect, {width: viewport.clientWidth, height: viewport.clientHeight}, false, document.body.classList.contains('keyboard-open') ? 16 : 88);
    applyView(); saveSoon();
  });
}

function useMobileFocus(input, note) {
  input.addEventListener('click', () => {
    if (compactLayout.matches && Date.now() >= suppressNoteClickUntil) input.focus({preventScroll: true});
  });
  input.addEventListener('focus', () => {
    if (!compactLayout.matches) return;
    mobileEditing = {note, input}; setSelected(note.id);
    $('finish-editing').hidden = false;
    document.body.classList.add('note-editing');
    // Let the native tap position the caret before moving the camera.
    requestAnimationFrame(() => {
      if (mobileEditing?.input !== input || gesture?.moved || gesture?.type === 'pinch') return;
      const element = noteElements.get(note.id);
      board.view = focusNoteView({x: note.x, y: note.y, width: element.offsetWidth}, {width: viewport.clientWidth});
      applyView(); updateVisibleHeight(); saveSoon();
    });
  });
  input.addEventListener('input', queueCaretReveal);
  input.addEventListener('blur', () => {
    if (mobileEditing?.input !== input) return;
    mobileEditing = null; cancelAnimationFrame(caretFrame);
    $('finish-editing').hidden = true;
    document.body.classList.remove('note-editing', 'keyboard-open');
    // Keep the camera where the user was writing; pinch or Fit steps back out.
    saveSoon();
  });
}

function actionButton(label, iconName, callback) {
  const button = document.createElement('button');
  button.type = 'button'; button.title = label; button.setAttribute('aria-label', label); button.append(icon(iconName));
  button.addEventListener('pointerdown', e => e.stopPropagation());
  button.addEventListener('click', event => { event.stopPropagation(); callback(); });
  return button;
}

function getImageResource(id) {
  if (!imageResources.has(id)) imageResources.set(id, getImage(id).then(asset => ({
    ...asset, previewUrl: URL.createObjectURL(asset.thumbnail), originalUrl: URL.createObjectURL(asset.original),
  })).catch(error => { imageResources.delete(id); throw error; }));
  return imageResources.get(id);
}

function wireNoteMovement(element, note, handle) {
  handle.addEventListener('keydown', event => {
    const direction = {ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1]}[event.key];
    if (!direction) return;
    event.preventDefault(); record();
    const step = event.shiftKey ? 1 : 10;
    note.x += direction[0] * step; note.y += direction[1] * step;
    element.style.left = `${note.x}px`; element.style.top = `${note.y}px`; saveSoon();
    queueStrings();
  });
  element.addEventListener('pointerdown', () => { setSelected(note.id); bringForward(note.id); });
  element.addEventListener('focusin', () => {
    if (!compactLayout.matches) { revealOnBoard(note, element); saveSoon(); }
  });
}

function buildPolaroid(note, index) {
  const element = document.createElement('article');
  element.className = 'note polaroid'; element.dataset.noteId = note.id;
  element.style.left = `${note.x}px`; element.style.top = `${note.y}px`;
  element.style.zIndex = String(index + 1); element.style.setProperty('--tilt', `${note.tilt}deg`);
  element.setAttribute('aria-label', 'Polaroid');
  const handle = document.createElement('div'); handle.className = 'note-drag'; handle.tabIndex = 0; handle.setAttribute('role', 'button');
  handle.setAttribute('aria-label', 'Move Polaroid. Drag or use arrow keys.'); handle.append(icon('grip'));
  const pin = document.createElement('span'); pin.className = 'pin'; handle.append(pin);
  const photo = document.createElement('a'); photo.className = 'polaroid-photo'; photo.target = '_blank'; photo.rel = 'noopener noreferrer';
  photo.setAttribute('aria-label', 'Open full image in a new tab');
  const message = document.createElement('span'); message.className = 'photo-status'; message.textContent = 'Loading image…';
  const image = document.createElement('img'); image.className = 'note-image'; image.alt = note.title || 'Photo'; image.draggable = false; image.hidden = true;
  photo.append(message, image);
  photo.addEventListener('click', event => { if (Date.now() < suppressNoteClickUntil || handMode || spaceHeld || !photo.hasAttribute('href')) event.preventDefault(); });
  getImageResource(note.imageId).then(asset => {
    image.src = asset.previewUrl; image.hidden = false; message.remove(); photo.href = asset.originalUrl;
  }).catch(error => { message.textContent = 'Image unavailable'; console.warn(error.message); });
  const caption = document.createElement('textarea');
  caption.className = 'note-content polaroid-caption'; caption.rows = 2; caption.maxLength = 120; caption.value = note.text;
  caption.placeholder = 'Caption'; caption.setAttribute('aria-label', 'Polaroid caption');
  caption.addEventListener('focus', record);
  caption.addEventListener('input', () => { note.text = caption.value; autosize(note, element); saveSoon(); });
  useMobileFocus(caption, note);
  const actions = document.createElement('div'); actions.className = 'note-actions';
  actions.append(actionButton('Duplicate photo', 'copy', () => duplicateNote(note)), actionButton('Delete photo', 'trash', () => removeNote(note.id)));
  wireNoteMovement(element, note, handle);
  element.append(handle, photo, caption, actions);
  noteElements.set(note.id, element); world.append(element); autosize(note, element);
  return element;
}

function loadFolder(id) {
  if (!folderHandles.has(id)) folderHandles.set(id, getFolder(id).catch(() => null));
  return folderHandles.get(id);
}

function pickFolderFallback(note = null) {
  const input = $('folder-file');
  if (!('webkitdirectory' in input)) return toast('This browser does not provide a folder picker. Try a current desktop browser.');
  folderPickTarget = note?.id || null;
  input.value = '';
  input.click();
}

function updateFolderLink(note, id, name) {
  const element = noteElements.get(note.id);
  if (!element || note.folderId === id && note.title === name) return;
  record(); note.folderId = id; note.title = name;
  const label = element.querySelector('.folder-tab'); label.textContent = name; label.title = name;
  element.setAttribute('aria-label', `${name} folder`);
  element.querySelector('.folder-open').setAttribute('aria-label', `Open folder ${name} in the system folder dialog`);
  element.querySelector('.note-drag').setAttribute('aria-label', `Move ${name} folder. Drag or use arrow keys.`);
  saveNow();
}

async function openFolder(note) {
  if (typeof window.showDirectoryPicker !== 'function') return pickFolderFallback(note);
  try {
    const previous = await loadFolder(note.folderId);
    const handle = await window.showDirectoryPicker({id: 'cork-folder', mode: 'read', ...(previous ? {startIn: previous} : {})});
    if (previous && await handle.isSameEntry(previous)) return updateFolderLink(note, note.folderId, handle.name);
    const id = crypto.randomUUID();
    await putFolder(id, handle); folderHandles.set(id, Promise.resolve(handle));
    updateFolderLink(note, id, handle.name);
  } catch (error) { if (error.name !== 'AbortError') toast(error.message || 'Could not open the system folder dialog.'); }
}

function buildFolder(note, index) {
  const element = document.createElement('article'); element.className = 'note manila-folder'; element.dataset.noteId = note.id;
  element.style.left = `${note.x}px`; element.style.top = `${note.y}px`; element.style.zIndex = String(index + 1);
  element.style.setProperty('--tilt', `${note.tilt}deg`); element.setAttribute('aria-label', `${note.title} folder`);
  const open = document.createElement('button'); open.className = 'folder-open'; open.setAttribute('aria-label', `Open folder ${note.title} in the system folder dialog`);
  const label = document.createElement('h2'); label.className = 'folder-tab'; label.textContent = note.title; label.title = note.title;
  const face = document.createElement('span'); face.className = 'folder-face'; face.setAttribute('aria-hidden', 'true');
  open.append(label, face); open.addEventListener('click', () => { if (Date.now() >= suppressNoteClickUntil && !handMode && !spaceHeld) openFolder(note); });
  const handle = document.createElement('div'); handle.className = 'note-drag'; handle.tabIndex = 0; handle.setAttribute('role', 'button');
  handle.setAttribute('aria-label', `Move ${note.title} folder. Drag or use arrow keys.`); handle.append(icon('grip'));
  const pin = document.createElement('span'); pin.className = 'pin'; handle.append(pin);
  const actions = document.createElement('div'); actions.className = 'note-actions';
  actions.append(actionButton('Duplicate folder', 'copy', () => duplicateNote(note)), actionButton('Delete folder', 'trash', () => removeNote(note.id)));
  wireNoteMovement(element, note, handle);
  element.append(open, handle, actions); noteElements.set(note.id, element); world.append(element);
  loadFolder(note.folderId);
  return element;
}

function buildNote(note, index) {
  if (note.type === 'folder') return buildFolder(note, index);
  if (note.type === 'image') return buildPolaroid(note, index);
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
    title.placeholder = 'Title'; title.setAttribute('aria-label', 'Index card title');
    title.addEventListener('focus', record);
    title.addEventListener('input', () => { note.title = title.value; autosize(note, element); saveSoon(); });
    useMobileFocus(title, note);
  } else {
    title = document.createElement('h2'); title.textContent = note.category;
  }
  title.className = `note-title${note.type === 'card' ? ' note-title-input' : ''}`;
  const content = document.createElement('textarea');
  content.className = 'note-content'; content.rows = 3; content.value = note.text;
  content.placeholder = note.type === 'card' ? 'Card text' : 'Note text';
  content.setAttribute('aria-label', note.type === 'card' ? 'Index card content' : `${note.category} note content`);
  content.addEventListener('focus', record);
  content.addEventListener('input', () => { note.text = content.value; autosize(note, element); saveSoon(); });
  useMobileFocus(content, note);
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
  resize.setAttribute('aria-label', 'Resize note width and height. Drag or use arrow keys.');
  resize.title = 'Drag to change width and height; double-click for automatic sizing';
  resize.addEventListener('dblclick', () => { record(); delete note.width; delete note.height; autosize(note, element); saveSoon(); });
  resize.addEventListener('keydown', event => {
    const direction = {ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1]}[event.key];
    if (!direction) return;
    event.preventDefault(); record();
    const step = event.shiftKey ? 1 : 10;
    if (direction[0]) note.width = Math.max(190, Math.min(800, element.offsetWidth + direction[0] * step));
    if (direction[1]) note.height = Math.max(120, Math.min(2000, element.offsetHeight + direction[1] * step));
    autosize(note, element); saveSoon();
  });
  const resizeHeight = document.createElement('button'); resizeHeight.className = 'note-resize-height';
  resizeHeight.setAttribute('aria-label', 'Resize note height. Drag or use up and down arrow keys.');
  resizeHeight.title = 'Drag up or down to change height; double-click for automatic height';
  resizeHeight.addEventListener('dblclick', () => { record(); delete note.height; autosize(note, element); saveSoon(); });
  resizeHeight.addEventListener('keydown', event => {
    if (event.key !== 'ArrowUp' && event.key !== 'ArrowDown') return;
    event.preventDefault(); record();
    const step = event.shiftKey ? 1 : 10;
    note.height = Math.max(120, Math.min(2000, element.offsetHeight + (event.key === 'ArrowDown' ? step : -step)));
    autosize(note, element); saveSoon();
  });
  wireNoteMovement(element, note, handle);
  element.append(title, content, actions, resize, resizeHeight);
  noteElements.set(note.id, element);
  world.append(element);
  autosize(note, element);
  return element;
}

function renderBoard() {
  world.replaceChildren(); noteElements.clear();
  $('board-name').value = board.name;
  board.notes.forEach(buildNote);
  renderStrings();
  renderCategories(); renderPalette(); updateCounts(); applyView();
}

function randomCategory() {
  const available = [...categories, ...missingBoardCategories(board.notes, categories)];
  if (!available.length) return;
  let options = available;
  if (available.length > 1 && placement?.type === 'note') options = available.filter(c => c !== placement.category);
  const random = new Uint32Array(1); crypto.getRandomValues(random);
  startPlacement('note', options[Math.floor((random[0] / 4294967296) * options.length)]);
}

function setSidebar(open, remember = false) {
  open = Boolean(open);
  $('sidebar').classList.toggle('is-open', open);
  $('sidebar').classList.toggle('is-collapsed', !open);
  $('sidebar').inert = !open;
  document.body.classList.toggle('sidebar-open', open);
  $('sidebar-scrim').hidden = !open || !compactLayout.matches;
  $('toggle-sidebar').setAttribute('aria-expanded', String(open));
  if (!open) closeMenu();
  if (!open && $('sidebar').contains(document.activeElement)) $('toggle-sidebar').focus({preventScroll: true});
  if (remember && !compactLayout.matches) {
    desktopSidebarOpen = open;
    try { localStorage.setItem(`${storageKey}:sidebar`, open ? 'open' : 'closed'); } catch { /* UI preference is optional. */ }
  }
  requestAnimationFrame(() => {
    board.notes.forEach(note => autosize(note, noteElements.get(note.id)));
    applyView();
  });
}

function startPlacement(type, category = '', assetId = null, folderName = '') {
  setStringMode(false);
  handMode = false; spaceHeld = false;
  updateHandMode(); setSelected(null);
  placement = {type, category, imageId: type === 'image' ? assetId : null, folderId: type === 'folder' ? assetId : null, folderName};
  viewport.classList.add('is-placing');
  $('placement-preview').hidden = false;
  $('placement-preview').classList.toggle('index-preview', type === 'card');
  $('placement-preview').classList.toggle('photo-preview', type === 'image');
  $('placement-preview').classList.toggle('folder-preview', type === 'folder');
  $('preview-photo').hidden = type !== 'image';
  if (type === 'image') getImageResource(assetId).then(asset => { if (placement?.imageId === assetId) $('preview-photo').src = asset.previewUrl; });
  $('placement-preview').style.setProperty('--note-color', colorFor(category));
  $('preview-title').textContent = type === 'card' ? 'Notes' : type === 'image' ? '' : type === 'folder' ? folderName : category;
  $('preview-hint').textContent = matchMedia('(pointer:coarse)').matches ? 'Tap to pin it here' : 'Click to pin it here';
  $('placement-label').textContent = type === 'card' ? 'Choose a position for the index card' : type === 'image' ? 'Choose a position for the photo' : type === 'folder' ? 'Choose a position for the folder' : `Choose a position for “${category}”`;
  $('placement-bar').hidden = false;
  if (compactLayout.matches) setSidebar(false);
  renderCategories();
  const width = type === 'card' ? 344 : type === 'image' ? 286 : type === 'folder' ? 300 : 248;
  pointer = {x: Math.max(16, (viewport.clientWidth - width * board.view.zoom) / 2), y: Math.max(60, viewport.clientHeight / 2 - 100)};
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
  renderCategories();
}

function placeNote(point) {
  if (!placement) return;
  record();
  const location = screenToWorld(point, board.view);
  const note = {id: crypto.randomUUID(), type: placement.type, category: placement.category, title: placement.type === 'card' ? 'Notes' : placement.category, text: '', x: location.x, y: location.y, tilt: (Math.random() - .5) * 2.4};
  if (placement.type === 'image') { note.imageId = placement.imageId; note.title = placement.imageName || 'Photo'; }
  if (placement.type === 'folder') { note.folderId = placement.folderId; note.title = placement.folderName; }
  board.notes.push(note);
  const element = buildNote(note, board.notes.length - 1);
  cancelPlacement(); setSelected(note.id); updateCounts(); saveNow();
  revealOnBoard(note, element); saveSoon();
  const input = element.querySelector('.note-content, .folder-open');
  if (compactLayout.matches) input.focus({preventScroll: true});
  else requestAnimationFrame(() => input.focus({preventScroll: true}));
}

function removeNote(id) {
  record(); board.notes = board.notes.filter(n => n.id !== id);
  board.connections = board.connections.filter(connection => connection.from !== id && connection.to !== id);
  noteElements.get(id)?.remove(); noteElements.delete(id); setSelected(null);
  renderStrings(); renderCategories(); updateCounts(); saveNow(); toast('Item removed.', true);
}

function duplicateNote(note) {
  record();
  const copy = {...note, id: crypto.randomUUID(), x: note.x + 28, y: note.y + 28};
  board.notes.push(copy); const element = buildNote(copy, board.notes.length - 1);
  setSelected(copy.id); updateCounts(); renderCategories(); saveNow();
  revealOnBoard(copy, element); saveSoon();
  element.querySelector('.note-content, .folder-open').focus({preventScroll: true});
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
  note.text = content.value;
  element.querySelector('.note-content').value = note.text;
  autosize(note, element); saveSoon(); content.focus({preventScroll: true});
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
  if (stringMode && event.target.closest('.note')) { event.preventDefault(); event.stopPropagation(); }
}, true);
viewport.addEventListener('click', event => {
  if (!stringMode || !event.target.closest('.note')) return;
  event.preventDefault(); event.stopPropagation(); chooseStringItem(event.target.closest('.note').dataset.noteId);
}, true);
viewport.addEventListener('pointerdown', event => {
  if (event.target.closest('.board-footer, .placement-bar, .sidebar-toggle, .mobile-done, .connection-hit')) return;
  if (event.button !== 0 && event.button !== 1) return;
  activePointers.set(event.pointerId, localPoint(event));
  if (activePointers.size >= 2) {
    if (gesture?.type === 'pinch') { viewport.setPointerCapture(event.pointerId); return; }
    if (gesture?.element) gesture.element.classList.remove('is-dragging', 'is-resizing');
    if (mobileEditing) mobileEditing.input.blur();
    const [a, b] = [...activePointers.values()];
    gesture = {type: 'pinch', distance: Math.hypot(b.x - a.x, b.y - a.y), center: {x: (a.x + b.x) / 2, y: (a.y + b.y) / 2}, view: {...board.view}, moved: true};
    for (const id of activePointers.keys()) viewport.setPointerCapture(id);
    event.preventDefault(); return;
  }
  const point = localPoint(event);
  const noteElement = event.target.closest('.note');
  const controls = event.target.closest('.note-actions, .note-content, .note-title-input');
  if (placement) {
    gesture = {type: 'place', pointerId: event.pointerId, start: point, moved: false}; viewport.setPointerCapture(event.pointerId); return;
  }
  if (controls && !handMode && !spaceHeld) return;
  const note = noteElement && board.notes.find(n => n.id === noteElement.dataset.noteId);
  if (note && !handMode && !spaceHeld) {
    const resize = event.target.closest('.note-resize');
    const resizeHeight = event.target.closest('.note-resize-height');
    if (!resize && !resizeHeight && !event.target.closest('.note-drag')) return;
    gesture = {type: resize ? 'resize' : resizeHeight ? 'resize-height' : 'note', pointerId: event.pointerId, start: point, note, element: noteElement, x: note.x, y: note.y, width: noteElement.offsetWidth, height: noteElement.offsetHeight, moved: false};
    event.preventDefault();
  } else {
    document.activeElement?.blur(); setSelected(null);
    gesture = {type: 'pan', pointerId: event.pointerId, start: point, view: {...board.view}, moved: false};
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
  if (event.pointerId !== gesture.pointerId) return;
  const dx = point.x - gesture.start.x; const dy = point.y - gesture.start.y;
  if (!gesture.moved && Math.hypot(dx, dy) < 4) return;
  if (!gesture.moved) {
    gesture.moved = true;
    if (gesture.type === 'note' || gesture.type === 'resize' || gesture.type === 'resize-height') record();
  }
  if (gesture.type === 'place') { movePreview(point); return; }
  if (gesture.type === 'pan') {
    board.view.x = gesture.view.x + dx; board.view.y = gesture.view.y + dy;
    viewport.classList.add('is-panning'); applyView();
  } else if (gesture.type === 'note') {
    gesture.note.x = gesture.x + dx / board.view.zoom; gesture.note.y = gesture.y + dy / board.view.zoom;
    gesture.element.style.left = `${gesture.note.x}px`; gesture.element.style.top = `${gesture.note.y}px`; gesture.element.classList.add('is-dragging');
    queueStrings();
  } else if (gesture.type === 'resize' || gesture.type === 'resize-height') {
    if (gesture.type === 'resize') gesture.note.width = Math.max(190, Math.min(800, gesture.width + dx / board.view.zoom));
    gesture.note.height = Math.max(120, Math.min(2000, gesture.height + dy / board.view.zoom));
    gesture.element.classList.add('is-resizing'); autosize(gesture.note, gesture.element);
  }
});

function endGesture(event) {
  activePointers.delete(event.pointerId);
  if (!gesture) return;
  if (gesture.type !== 'pinch' && event.pointerId !== gesture.pointerId) return;
  if (gesture.moved || gesture.type === 'pinch') suppressNoteClickUntil = Date.now() + 350;
  if (gesture.type === 'pinch' && activePointers.size) {
    if (activePointers.size >= 2) {
      const [a, b] = [...activePointers.values()];
      gesture = {type: 'pinch', distance: Math.hypot(b.x - a.x, b.y - a.y), center: {x: (a.x + b.x) / 2, y: (a.y + b.y) / 2}, view: {...board.view}, moved: true};
    } else {
      const [[pointerId, point]] = activePointers;
      gesture = {type: 'pan', pointerId, start: point, view: {...board.view}, moved: true};
    }
    saveSoon(); return;
  }
  if (gesture.type === 'place' && event.type === 'pointerup') placeNote(localPoint(event));
  if (gesture.element) gesture.element.classList.remove('is-dragging', 'is-resizing');
  viewport.classList.remove('is-panning');
  gesture = null;
  if (viewport.hasPointerCapture(event.pointerId)) viewport.releasePointerCapture(event.pointerId);
  saveSoon();
}
window.addEventListener('pointerup', endGesture);
window.addEventListener('pointercancel', endGesture);
viewport.addEventListener('pointerleave', () => { if (placement && !gesture) $('placement-preview').hidden = true; });
viewport.addEventListener('pointerenter', () => { if (placement) $('placement-preview').hidden = false; });
viewport.addEventListener('wheel', event => {
  // Leave note text and floating controls alone; the cork itself always zooms.
  if (event.target.closest('.note-content, .note-title-input, .board-footer, .placement-bar, .sidebar-toggle, .mobile-done')) return;
  event.preventDefault();
  const unit = event.deltaMode === 1 ? 18 : event.deltaMode === 2 ? viewport.clientHeight : 1;
  // Clamp unusually large wheel ticks without losing high-resolution trackpad input.
  const delta = Math.max(-200, Math.min(200, event.deltaY * unit));
  changeZoom(Math.exp(-delta * .0025), localPoint(event));
}, {passive: false});

$('category-search').addEventListener('input', renderCategories);
$('load-categories').addEventListener('click', chooseCategories);
$('refresh-categories').addEventListener('click', () => refreshCategories());
$('categories-file').addEventListener('change', async event => {
  const file = event.target.files[0]; event.target.value = '';
  if (!file) return;
  categoryBusy = true; renderCategorySource();
  try { await useCategoryFile(file); }
  catch (error) { toast(error.message || 'Could not open the categories file.'); }
  finally {
    categoryBusy = false; renderCategorySource();
    if (!categoriesReady) loadCategories();
  }
});
$('default-categories').addEventListener('click', () => {
  categoryFile = null; categoryHandle = null; categoryText = '';
  try { writeCategoryCache(localStorage, categoriesKey, null); }
  catch { toast('Default categories will be used for this tab. Browser storage could not remember the change.'); }
  putCategoryHandle(categoriesKey, null).catch(() => {});
  loadDefaultCategories();
});
$('download-categories').addEventListener('click', () => {
  const url = URL.createObjectURL(new Blob([categoryText], {type: 'text/plain;charset=utf-8'}));
  const link = document.createElement('a');
  link.href = url; link.download = categoryFile?.name || 'categories.txt';
  document.body.append(link); link.click(); link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10000);
});
$('random-note').addEventListener('click', randomCategory);
$('add-card').addEventListener('click', () => startPlacement('card'));
$('add-image').addEventListener('click', () => $('image-file').click());
if (typeof window.showDirectoryPicker !== 'function') $('add-folder').title = 'Choose a folder. This browser asks you to select it again when opening a folder tile.';
$('add-folder').addEventListener('click', async () => {
  if (typeof window.showDirectoryPicker !== 'function') return pickFolderFallback();
  try {
    const handle = await window.showDirectoryPicker({id: 'cork-folder', mode: 'read'});
    const id = crypto.randomUUID(); await putFolder(id, handle); folderHandles.set(id, Promise.resolve(handle));
    startPlacement('folder', '', id, handle.name);
  } catch (error) { if (error.name !== 'AbortError') toast(error.message || 'Could not select this folder.'); }
});
$('folder-file').addEventListener('change', event => {
  const input = event.target;
  const name = directoryNameFromFiles(input.files);
  const target = folderPickTarget; folderPickTarget = null;
  // Use only the root folder's name; do not read or retain any selected files.
  input.value = '';
  if (!name) return toast('Choose one folder containing at least one file.');
  if (target) {
    const note = board.notes.find(item => item.id === target && item.type === 'folder');
    if (note) updateFolderLink(note, note.title === name ? note.folderId : crypto.randomUUID(), name);
  } else {
    startPlacement('folder', '', crypto.randomUUID(), name);
  }
});
$('folder-file').addEventListener('cancel', () => { folderPickTarget = null; });
$('add-string').addEventListener('click', () => {
  const active = !stringMode; cancelPlacement(); handMode = false; spaceHeld = false; updateHandMode(); setStringMode(active);
  if (compactLayout.matches) setSidebar(false);
});
$('image-file').addEventListener('change', async event => {
  const file = event.target.files[0]; event.target.value = '';
  if (!file) return;
  $('add-image').disabled = true;
  try {
    const asset = await prepareImage(file);
    await putImage(asset);
    await getImageResource(asset.id);
    startPlacement('image', '', asset.id);
    placement.imageName = asset.name;
  } catch (error) { toast(error.message || 'Could not add this image.'); }
  finally { $('add-image').disabled = false; }
});
$('cancel-placement').addEventListener('click', cancelPlacement);
$('retry-categories').addEventListener('click', loadDefaultCategories);
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
$('toggle-sidebar').addEventListener('click', () => setSidebar(true, true));
$('sidebar-scrim').addEventListener('click', () => setSidebar(false));
$('close-sidebar').addEventListener('click', () => setSidebar(false, true));
$('finish-editing').addEventListener('click', () => { document.activeElement?.blur(); mobileEditing?.input.blur(); saveNow(); });
document.addEventListener('selectionchange', queueCaretReveal);

function closeMenu() { $('board-menu').hidden = true; $('board-menu-button').setAttribute('aria-expanded', 'false'); }
$('board-menu-button').addEventListener('click', () => { const open = $('board-menu').hidden; $('board-menu').hidden = !open; $('board-menu-button').setAttribute('aria-expanded', String(open)); });
document.addEventListener('click', event => { if (!event.target.closest('.menu-wrap')) closeMenu(); });
$('show-help').addEventListener('click', () => { if (compactLayout.matches) setSidebar(false); $('help-dialog').showModal(); });
$('close-help').addEventListener('click', () => $('help-dialog').close());
$('help-done').addEventListener('click', () => $('help-dialog').close());

$('export-board').addEventListener('click', async () => {
  closeMenu();
  const snapshot = validateBoard(JSON.parse(JSON.stringify(board)));
  $('export-board').disabled = true;
  try {
  const images = await exportImages(snapshot.notes);
  const blob = new Blob([JSON.stringify({...snapshot, images, exportedAt: new Date().toISOString()}, null, 2)], {type: 'application/json'});
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  const name = snapshot.name.replace(/[^a-z0-9 _-]/gi, '').trim() || 'cork-board';
  link.href = url; link.download = `${name}-${new Date().toISOString().slice(0, 10)}.json`;
  document.body.append(link); link.click(); link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10000);
  toast('Board exported, including original images. Keep the JSON file as your backup.');
  } catch (error) { toast(`Could not export the board. ${error.message}`); }
  finally { $('export-board').disabled = false; }
});
$('export-pdf').addEventListener('click', async () => {
  closeMenu();
  if (pdfExporting || !board.notes.length) return;
  pdfExporting = true;
  $('export-pdf').disabled = true;
  $('export-pdf').setAttribute('aria-busy', 'true');
  toast('Preparing PDF…');
  try {
    const {snapshotNotes, createBoardPdf} = await import('./export-pdf.js');
    await Promise.all(board.notes.filter(note => note.type === 'image').map(note => getImageResource(note.imageId)));
    await Promise.all([...world.querySelectorAll('.note-image')].map(image => image.decode()));
    const name = board.name;
    const notes = snapshotNotes(board.notes, noteElements);
    const bytes = await createBoardPdf(name, notes, structuredClone(board.connections), (done, total) => {
      if (total > 5) toast(`Preparing PDF… ${done} of ${total} notes`);
    });
    const url = URL.createObjectURL(new Blob([bytes], {type: 'application/pdf'}));
    const link = document.createElement('a');
    const filename = name.replace(/[^a-z0-9 _-]/gi, '').trim() || 'cork-board';
    link.href = url; link.download = `${filename}-${new Date().toISOString().slice(0, 10)}.pdf`;
    document.body.append(link); link.click(); link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 60000);
    toast('PDF exported. Cropped to your notes, without the cork.');
  } catch (error) {
    console.error('Cork could not export the PDF:', error);
    toast('Couldn’t create the PDF. Your board is safe; please try again.');
  } finally {
    pdfExporting = false;
    $('export-pdf').removeAttribute('aria-busy');
    updateCounts();
  }
});
$('import-board').addEventListener('click', () => { closeMenu(); $('import-file').click(); });
$('import-file').addEventListener('change', async event => {
  const file = event.target.files[0]; event.target.value = '';
  if (!file) return;
  try {
    if (file.size > 100 * 1024 * 1024) throw new Error('Choose a board file smaller than 100 MB.');
    const data = JSON.parse(await file.text());
    pendingImport = validateBoard(data);
    pendingImages = await importImages(data, pendingImport);
    $('import-summary').textContent = `“${pendingImport.name}” contains ${pendingImport.notes.length} ${pendingImport.notes.length === 1 ? 'note' : 'notes'}.`;
    $('import-dialog').showModal();
  } catch (error) { pendingImport = null; pendingImages = []; toast(error instanceof SyntaxError ? 'That file isn’t a valid Cork JSON export. Nothing was changed.' : error.message); }
});
$('cancel-import').addEventListener('click', () => { pendingImport = null; pendingImages = []; $('import-dialog').close(); });
$('import-dialog').addEventListener('cancel', event => { if ($('confirm-import').disabled) { event.preventDefault(); return; } pendingImport = null; pendingImages = []; });
$('confirm-import').addEventListener('click', async () => {
  if (!pendingImport) return;
  $('confirm-import').disabled = true;
  $('cancel-import').disabled = true;
  try {
  for (const asset of pendingImages) await putImage(asset);
  record(); setStringMode(false); cancelPlacement(); board = pendingImport; pendingImport = null;
  pendingImages = [];
  $('import-dialog').close(); setSelected(null); renderBoard();
  saveNow(); toast('Board imported.', true);
  } catch (error) { toast(error.message); }
  finally { $('confirm-import').disabled = false; $('cancel-import').disabled = false; }
});

document.addEventListener('keydown', event => {
  const editing = event.target.matches('textarea, input, select, [contenteditable=true]');
  if (event.key === 'Escape') { setStringMode(false); cancelPlacement(); closeMenu(); if (compactLayout.matches) setSidebar(false); return; }
  if (stringMode && event.key === 'Enter' && event.target.closest('.note')) { event.preventDefault(); chooseStringItem(event.target.closest('.note').dataset.noteId); return; }
  if (editing || document.querySelector('dialog[open]')) return;
  if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'z') { event.preventDefault(); historyStep(event.shiftKey ? redoStack : undoStack, event.shiftKey ? undoStack : redoStack); return; }
  if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'y') { event.preventDefault(); historyStep(redoStack, undoStack); return; }
  if (event.ctrlKey || event.metaKey || event.altKey) return;
  if (event.key.toLowerCase() === 'r') { event.preventDefault(); randomCategory(); }
  else if (event.key.toLowerCase() === 'i') { event.preventDefault(); startPlacement('card'); }
  else if (event.key === '/') { event.preventDefault(); setSidebar(true); $('category-search').focus(); }
  else if (event.key === ' ') { event.preventDefault(); spaceHeld = true; updateHandMode(); }
  else if ((event.key === 'Delete' || event.key === 'Backspace') && selectedString) { event.preventDefault(); removeString(selectedString); }
  else if ((event.key === 'Delete' || event.key === 'Backspace') && selected) { event.preventDefault(); removeNote(selected); }
  else if (event.key === 'Enter' && placement) { event.preventDefault(); placeNote(pointer || {x: viewport.clientWidth / 2, y: viewport.clientHeight / 2}); }
});
document.addEventListener('keyup', event => { if (event.key === ' ') { spaceHeld = false; updateHandMode(); } });
window.addEventListener('blur', () => {
  spaceHeld = false; updateHandMode();
  if (gesture?.element) gesture.element.classList.remove('is-dragging', 'is-resizing');
  gesture = null; activePointers.clear(); viewport.classList.remove('is-panning');
});
window.addEventListener('pagehide', saveNow);
document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'hidden') saveNow(); else checkCategoryFile(); });
window.addEventListener('focus', checkCategoryFile);
window.addEventListener('storage', event => {
  if (event.key === categoriesKey) { loadCategories(); return; }
  if (event.key !== storageKey || !event.newValue) return;
  clearTimeout(saveTimer); savingBlocked = true;
  setSaveStatus('Changed in another tab — saving paused', true);
  toast('This board changed in another tab. Export this copy if needed, then reload to use the latest saved board.');
});
window.addEventListener('resize', () => { updateVisibleHeight(); applyView(); });
if (window.ResizeObserver) new ResizeObserver(() => updateCorkTexture(board.view)).observe(viewport);
compactLayout.addEventListener('change', () => {
  setSidebar(!compactLayout.matches && desktopSidebarOpen);
  if (!compactLayout.matches) {
    mobileEditing = null; $('finish-editing').hidden = true;
    document.body.classList.remove('note-editing', 'keyboard-open');
  }
  applyView(); updateVisibleHeight();
});
window.visualViewport?.addEventListener('resize', updateVisibleHeight);
window.visualViewport?.addEventListener('scroll', updateVisibleHeight);

renderBoard();
setSidebar(!compactLayout.matches && desktopSidebarOpen);
updateVisibleHeight();
loadCategories();
if (startupProblem) { setSaveStatus('Saved board unavailable — saving paused', true); toast(startupProblem); }
