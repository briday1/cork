import {normalizeNoteStyle, NOTE_FONTS, STORAGE_KEY, parseCategoryFile, missingBoardCategories, directoryNameFromFiles, categoryColor, blankBoard, screenToWorld, zoomAt, revealNote, focusNoteView, validateBoard, continueList} from './board-core.js';
import {prepareImage, putImage, getImage, exportImages, importImages, putFolder, getFolder} from './image-store.js';
import {connectionGeometry} from './export-core.js';
import {readCategoryFile, readCategoryCache, writeCategoryCache, readLinkedCategories, getCategoryHandle, putCategoryHandle, validateCategoryText, categoriesChanged} from './category-file.js';
import {ACCOUNT_CATEGORY_NAME, categoryProfileKey, readCategoryAccount, syncCategoryProfile} from './category-profile.js';
import {DriveAutoSaveQueue} from './drive-autosave.js';
import {selectionBounds, notesInSelection, tapesInSelection} from './selection-core.js';
import {boardKeys, readWorkspace, writeWorkspace, readWorkspaceBoard, boardStamp, duplicateBoardSnapshot} from './workspace.js';
import {readBoardFile, writeBoardFile} from './board-file.js';
import {resizePaper} from './paper-core.js';
import {PAPER_TILE_SIZE, paperResolution, paintPaperTile} from './paper-texture.js';
import {GoogleDrive, DriveAuthError, DriveConflictError} from './google-drive.js';
import {googleDriveConfig} from './google-drive-config.js';

const $ = id => document.getElementById(id);
const viewport = $('viewport');
const world = $('board-world');
const corkTexture = document.querySelector('.cork-texture');
const corkTiles = new Map();
let textureVariant = '';
// The photograph is 2048 × 1536: two image pixels per board unit at 100%.
const corkTileSize = {width: 1024, height: 768};
const appKey = `${STORAGE_KEY}:${location.pathname.replace(/index\.html$/, '')}`;
let storageKey = appKey, categoriesKey = `${appKey}:categories`;
let workspace, activeSession, workspaceBlocked = false;
const sessions = new Map(), fileTasks = new Set();
let textTarget = 'new', textSelection = '';
let openingBoard = false, categoryPickSession = null, imagePickSession = null, folderPickSession = null;
let driveBusy = false, driveReady = false, driveMessage = '', driveListRevision = 0;
const drive = new GoogleDrive(googleDriveConfig, {sessionKey: `${appKey}:google-drive-session`, onChange: () => { if (!drive.connected) driveMessage = ''; updateBoardFiles(); renderCategorySource(); showSavedStatus(); }});
const driveAutoErrors = new Map();
const driveAutosave = new DriveAutoSaveQueue({ready: autoDriveReady, save: id => saveDriveBoard(false, {session: sessions.get(id), automatic: true})});
let pendingCloseId = null;
let board = blankBoard();
let categories = [];
let frequentCategories = new Set();
let categoryFile = null, categoryHandle = null, categoryText = '', categoryStatus = '';
let categoryRevision = 0, categoryBusy = false, categoriesReady = false, lastCategoryCheck = 0;
let categoryAccount = null, categoryConflict = false, categorySyncError = '', categorySaveTimer, categoryEditTimer, categoryEditKey, categoryEditText;
const selected = new Set();
const selectedStrings = new Set();
const selectedTapes = new Set();
let placement = null;
let pointer = null;
let handMode = false;
let selectMode = false;
let selectionPointerId = null;
let spaceHeld = false;
let gesture = null;
let categoryLoadFailed = false;
let saveTimer;
let toastTimer;
let folderPickTarget = null;
let pdfExporting = false;
let stringMode = false, stringStart = null, stringFrame = 0, stringLayer;
let tapeMode = false, selectedTape = null, tapeLayer;
let pinChoosing = false, selectedMainPinId = null;
let savingBlocked = false;
let startupProblem = '';
let undoStack = [];
let redoStack = [];
const noteElements = new Map();
const imageResources = new Map();
const folderHandles = new Map();
const activePointers = new Map();
const systemAppearance = matchMedia('(prefers-color-scheme: dark)');
let uiThemePreference = 'system';
try { const preference = localStorage.getItem(`${appKey}:ui-theme`); if (['system', 'light', 'dark'].includes(preference)) uiThemePreference = preference; } catch { /* System theme remains available. */ }
const compactLayout = matchMedia('(max-width: 680px), (max-height: 500px) and (pointer: coarse)');
let mobileEditing = null;
let caretFrame = 0;
let largestVisibleHeight = window.innerHeight;
let lastViewportWidth = window.innerWidth;
let suppressNoteClickUntil = 0;
let desktopSidebarOpen = true;
try { desktopSidebarOpen = localStorage.getItem(`${appKey}:sidebar`) !== 'closed'; } catch { /* Board saving reports unavailable storage. */ }

try {
  workspace = readWorkspace(localStorage, appKey);
} catch (error) {
  workspaceBlocked = true;
  workspace = {version: 1, activeId: 'original', boards: [{id: 'original', name: 'My board', open: true, file: null}]};
  startupProblem = 'Saved board tabs could not be opened. The saved copies have been left untouched.';
}
activeSession = getSession(workspace.activeId);
board = activeSession.board;
storageKey = boardKeys(appKey, activeSession.id).board;
try { categoryAccount = readCategoryAccount(localStorage, appKey); } catch { /* The local categories remain available. */ }
categoriesKey = categoryProfileKey(appKey, categoryAccount?.id);
undoStack = activeSession.undo; redoStack = activeSession.redo;
savingBlocked = activeSession.blocked;

function getSession(id) {
  if (!sessions.has(id)) {
    const session = {id, board: blankBoard(), undo: [], redo: [], blocked: false, handle: null, handleReady: false};
    try { session.board = readWorkspaceBoard(localStorage, appKey, id); }
    catch { session.blocked = true; session.problem = 'This saved board could not be opened. Its stored copy has not been overwritten.'; }
    sessions.set(id, session);
  }
  return sessions.get(id);
}

function entryFor(session = activeSession) { return workspace.boards.find(entry => entry.id === session.id); }

function rememberWorkspace() {
  if (workspaceBlocked) return false;
  try { writeWorkspace(localStorage, appKey, workspace); return true; }
  catch { toast('Board tabs could not be remembered. Save your board files before leaving.'); return false; }
}

function fileChanged(session = activeSession) {
  const file = entryFor(session)?.file;
  return Boolean(file && file.stamp !== boardStamp(session === activeSession ? board : session.board));
}

function autoDriveReady(id) {
  const session = sessions.get(id), file = session && entryFor(session)?.file;
  return Boolean(session && file?.kind === 'drive' && drive.connected && file.accountId === drive.user.permissionId && !driveBusy && !openingBoard && !workspaceBlocked && !pdfExporting && !session.blocked && !fileTasks.has(id) && !driveAutoErrors.has(id));
}

function queueDriveBoard(session = activeSession) {
  if (entryFor(session)?.file?.kind === 'drive' && fileChanged(session)) driveAutosave.schedule(session.id);
  else driveAutosave.remove(session.id);
}

function resumeDriveAutosaves() {
  for (const entry of workspace.boards) {
    if (entry.file?.kind !== 'drive' || entry.file.accountId !== drive.user?.permissionId) continue;
    const error = driveAutoErrors.get(entry.id);
    if (!(error instanceof DriveConflictError)) driveAutoErrors.delete(entry.id);
    queueDriveBoard(getSession(entry.id));
  }
  driveAutosave.resume();
}

function renderBoardTabs() {
  const list = $('board-tabs'); list.replaceChildren();
  const openCount = workspace.boards.filter(item => item.open).length;
  $('boards-section').hidden = openCount < 2 && workspace.boards.length < 4;
  $('board-tabs').hidden = openCount < 2;
  $('all-boards-button').hidden = workspace.boards.length < 4;
  $('board-total').textContent = workspace.boards.length;
  for (const entry of workspace.boards.filter(item => item.open)) {
    const row = document.createElement('div'); row.className = 'board-tab-row';
    const tab = document.createElement('button'); tab.className = 'board-tab'; tab.id = `tab-${entry.id}`;
    tab.dataset.boardId = entry.id; tab.setAttribute('role', 'tab');
    tab.setAttribute('aria-selected', String(entry.id === workspace.activeId));
    tab.setAttribute('aria-controls', 'viewport'); tab.tabIndex = entry.id === workspace.activeId ? 0 : -1;
    tab.append(icon('card'));
    const label = document.createElement('span'); label.className = 'board-tab-name'; label.textContent = entry.name || 'My board';
    const dot = document.createElement('span'); dot.className = 'board-tab-dot'; dot.setAttribute('aria-hidden', 'true');
    tab.append(label, dot); tab.addEventListener('click', () => switchBoard(entry.id));
    const duplicate = document.createElement('button'); duplicate.className = 'duplicate-board-tab'; duplicate.append(icon('copy'));
    duplicate.setAttribute('aria-label', `Duplicate ${entry.name || 'My board'} board`); duplicate.title = 'Duplicate board';
    duplicate.addEventListener('click', () => duplicateBoard(entry.id));
    const close = document.createElement('button'); close.className = 'close-board-tab'; close.append(icon('close'));
    close.setAttribute('aria-label', `Close ${entry.name || 'My board'} tab`);
    close.title = 'Close board';
    close.addEventListener('click', () => closeBoardTab(entry.id));
    row.append(tab, duplicate, close); list.append(row);
  }
  updateBoardFiles();
  requestAnimationFrame(() => $('board-tabs').querySelector('[aria-selected=true]')?.scrollIntoView?.({block: 'nearest', inline: 'nearest'}));
}

function renderAllBoards() {
  const list = $('all-boards-list'), query = $('board-search').value.trim().toLocaleLowerCase();
  list.replaceChildren();
  for (const entry of workspace.boards.filter(entry => `${entry.name} ${entry.file?.name || ''}`.toLocaleLowerCase().includes(query))) {
    const button = document.createElement('button'); button.className = 'board-list-entry';
    button.setAttribute('aria-current', String(entry.id === workspace.activeId));
    button.title = entry.file?.name || 'Saved in this browser';
    const name = document.createElement('span'); name.textContent = entry.name || 'My board';
    button.append(name);
    button.addEventListener('click', () => { switchBoard(entry.id); closeAllBoards(); });
    const duplicate = document.createElement('button'); duplicate.className = 'duplicate-board-list'; duplicate.append(icon('copy'));
    duplicate.setAttribute('aria-label', `Duplicate ${entry.name || 'My board'} from All boards`); duplicate.title = 'Duplicate board';
    duplicate.addEventListener('click', () => duplicateBoard(entry.id));
    const row = document.createElement('div'); row.className = 'board-list-row'; row.append(button, duplicate); list.append(row);
  }
  if (!list.childElementCount) { const empty = document.createElement('p'); empty.textContent = 'No matching boards.'; list.append(empty); }
}

function closeAllBoards() {
  $('all-boards-menu').hidden = true;
  $('all-boards-button').setAttribute('aria-expanded', 'false');
}

function updateBoardFiles() {
  const entry = entryFor();
  for (const tab of $('board-tabs').querySelectorAll('.board-tab')) {
    const item = workspace.boards.find(item => item.id === tab.dataset.boardId), session = sessions.get(item.id);
    tab.querySelector('.board-tab-name').textContent = item.name || 'My board';
    tab.parentElement.querySelector('.close-board-tab')?.setAttribute('aria-label', `Close ${item.name || 'My board'} tab`);
    tab.parentElement.querySelector('.duplicate-board-tab')?.setAttribute('aria-label', `Duplicate ${item.name || 'My board'} board`);
    const dirty = session ? fileChanged(session) : false;
    tab.classList.toggle('has-file-changes', dirty);
    tab.title = `${item.file?.name || 'Saved in this browser'}${dirty ? ' · Unsaved file changes' : ''}`;
  }
  $('board-file-name').textContent = entry.file ? `${entry.file.kind === 'drive' ? 'Drive · ' : ''}${entry.file.name}` : 'Browser only';
  document.querySelector('.board-file-line').hidden = !entry.file;
  $('save-board').classList.toggle('has-changes', fileChanged());
  $('board-file-name').title = entry.file ? `${entry.file.name}${fileChanged() ? ' · Unsaved file changes' : ''}` : 'Save to choose a local board JSON file';
  $('save-board').disabled = fileTasks.has(activeSession.id) || !activeSession.handleReady;
  $('save-board').textContent = fileTasks.has(activeSession.id) ? 'Saving…' : 'Save';
  $('save-board-as').disabled = fileTasks.has(activeSession.id);
  $('new-board').disabled = workspaceBlocked || pdfExporting;
  $('duplicate-board').disabled = workspaceBlocked || pdfExporting;
  $('open-board').disabled = workspaceBlocked || openingBoard || pdfExporting;
  updateDriveControls();
  driveAutosave.resume();
}

async function restoreBoardHandle(session) {
  if (session.handleReady) return;
  try {
    const file = entryFor(session).file;
    if (file && file.kind !== 'drive') {
      const saved = await getCategoryHandle(boardKeys(appKey, session.id).file);
      if (saved?.token === file.token) session.handle = saved.handle;
    }
  } catch { /* Cached boards remain available without file permissions. */ }
  session.handleReady = true;
  if (session === activeSession) updateBoardFiles();
}

function switchBoard(id) {
  closeAllBoards();
  if (id === activeSession.id) { entryFor().open = true; renderBoardTabs(); rememberWorkspace(); return; }
  if (pdfExporting) return toast('Finish the PDF export before switching boards.');
  document.activeElement?.blur(); cancelGesture(); cancelPlacement(); setStringMode(false); setSelectMode(false);
  saveNow(); activeSession.board = board; activeSession.blocked = savingBlocked;
  cancelAnimationFrame(caretFrame); mobileEditing = null;
  $('toast').hidden = true; closeMenu();
  activeSession = getSession(id); board = activeSession.board;
  workspace.activeId = id; entryFor().open = true;
  storageKey = boardKeys(appKey, id).board;
  savingBlocked = activeSession.blocked;
  undoStack = activeSession.undo; redoStack = activeSession.redo;
  selected.clear(); selectedStrings.clear(); selectedTapes.clear(); activePointers.clear();
  pointer = null; handMode = false; spaceHeld = false; updateHandMode();
  $('category-search').value = '';
  renderBoard(); updateHistory(); renderBoardTabs(); rememberWorkspace();
  renderCategories(); updateNoteColors(); restoreBoardHandle(activeSession);
  if (savingBlocked) { setSaveStatus('Saving paused — export your board', true); toast(activeSession.problem || 'This board changed in another browser tab. Reload before editing it.'); }
  else showSavedStatus();
}

function newBoard() {
  if (workspaceBlocked || pdfExporting) return;
  const id = crypto.randomUUID(), fresh = blankBoard();
  const names = new Set(workspace.boards.map(entry => entry.name));
  let number = 1; while (names.has(`Board ${number}`)) number++;
  fresh.name = `Board ${number}`;
  // Store the content before adding a tab, so a quota failure cannot replace a board.
  try { localStorage.setItem(boardKeys(appKey, id).board, JSON.stringify(fresh)); }
  catch { return toast('Browser storage is full. Save a board file before adding another tab.'); }
  workspace.boards.push({id, name: fresh.name, open: true, file: null});
  switchBoard(id); saveNow();
}

async function duplicateBoard(sourceId = activeSession.id) {
  if (workspaceBlocked || pdfExporting) return;
  document.activeElement?.blur(); saveNow(); closeMenu();
  if (!workspace.boards.some(entry => entry.id === sourceId)) return;
  const source = getSession(sourceId);
  const snapshot = duplicateBoardSnapshot(source === activeSession ? board : source.board, workspace.boards.map(entry => entry.name));
  const name = snapshot.name;
  const id = crypto.randomUUID(), keys = boardKeys(appKey, id);
  try {
    localStorage.setItem(keys.board, JSON.stringify(snapshot));
  } catch { return toast('The board could not be duplicated. Browser storage is unavailable or full.'); }
  // Images and folder handles are immutable shared resources; the board data
  // and file destination are independent. No original file is inherited.
  workspace.boards.push({id, name, open: true, file: null});
  switchBoard(id); saveNow();
  toast('Board duplicated. Save will ask for a new board file.');
}

async function closeBoardTab(id) {
  if (workspaceBlocked || pdfExporting) return;
  if (fileTasks.has(id)) return toast('Wait for this board to finish saving.');
  const session = getSession(id), entry = entryFor(session);
  if (!entry) return;
  const contents = session === activeSession ? board : session.board;
  if (session.blocked || (entry.file ? fileChanged(session) : contents.notes.length > 0)) {
    await restoreBoardHandle(session);
    if (!workspace.boards.some(entry => entry.id === id)) return;
    pendingCloseId = id;
    $('close-board-name').textContent = entry.name || 'My board';
    $('close-board-dialog').showModal();
    return;
  }
  finishCloseBoard(id);
}

function finishCloseBoard(id) {
  const entry = workspace.boards.find(item => item.id === id);
  if (!entry) return;
  if (id === activeSession.id) {
    const other = workspace.boards.find(item => item.open && item.id !== id);
    if (other) switchBoard(other.id); else newBoard();
    if (activeSession.id === id) return;
  }
  workspace.boards = workspace.boards.filter(item => item.id !== id);
  sessions.delete(id); rememberWorkspace(); renderBoardTabs();
  driveAutosave.remove(id); driveAutoErrors.delete(id);
  const keys = boardKeys(appKey, id);
  try { localStorage.removeItem(keys.board); localStorage.removeItem(keys.categories); } catch { /* The closed board is no longer in the workspace. */ }
  putCategoryHandle(keys.file, null).catch(() => {});
  putCategoryHandle(keys.categories, null).catch(() => {});
  $('board-tabs').querySelector('[aria-selected=true]')?.focus({preventScroll: true});
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

function showSavedStatus() {
  const file = entryFor()?.file, linked = file?.kind === 'drive';
  if (savingBlocked) return setSaveStatus('Saving paused — export your board', true);
  if (linked && driveAutoErrors.has(activeSession.id)) return setSaveStatus('Browser saved · Drive needs attention', true);
  if (linked && fileTasks.has(activeSession.id)) return setSaveStatus('Browser saved · Saving to Drive…');
  if (linked && fileChanged()) return setSaveStatus(!drive.connected ? 'Browser saved · Drive paused' : file.accountId !== drive.user.permissionId ? 'Browser saved · Connect this board’s account' : 'Browser saved · Drive save pending');
  setSaveStatus(linked ? 'Saved to Google Drive' : fileChanged() ? 'Browser saved · File has changes' : 'Saved in this browser');
}

function saveNow() {
  clearTimeout(saveTimer);
  if (savingBlocked) return setSaveStatus('Saving paused — export your board', true);
  try {
    localStorage.setItem(storageKey, JSON.stringify(board));
    activeSession.board = board;
    entryFor().name = board.name;
    rememberWorkspace(); updateBoardFiles(); showSavedStatus();
    queueDriveBoard(activeSession);
  } catch {
    setSaveStatus('Could not save — please export', true);
    toast('Browser storage is unavailable or full. Export your board to keep it.');
  }
}

function saveSoon() {
  if (savingBlocked) return setSaveStatus('Saving paused — export your board', true);
  setSaveStatus('Saving…');
  entryFor().name = board.name; updateBoardFiles();
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
  cancelGesture();
  setStringMode(false);
  cancelPlacement();
  document.activeElement?.blur();
  to.push(JSON.stringify(board));
  board = validateBoard(JSON.parse(from.pop()));
  setSelected(null);
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
  const byKey = new Map(categories.map(value => [value.toLocaleLowerCase(),value]));
  const ordered = (board.colorOrder || []).map(value => byKey.get(value.toLocaleLowerCase())).filter(Boolean);
  const used = new Set(ordered.map(value => value.toLocaleLowerCase()));
  const colorCategories = [...ordered, ...categories.filter(value => !used.has(value.toLocaleLowerCase()))];
  return categoryColor(name, colorCategories, board.palette);
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

function categoryDriveConnected() {
  return Boolean(categoryAccount && drive.connected && categoryAccount.id === drive.user.permissionId);
}

function categoryLocation() {
  if (!categoryAccount) return 'This browser';
  if (categoryConflict) return 'Google Drive · Needs attention';
  if (categoryBusy) return 'Google Drive · Syncing…';
  if (!categoryDriveConnected()) return 'Google Drive · Reconnect to sync';
  if (categorySyncError) return 'Google Drive · Save paused';
  if (categoriesChanged(categoryFile)) return 'Google Drive · Save pending';
  return 'Google Drive · Saved';
}

function renderCategorySource() {
  $('category-source-name').textContent = categoryFile?.name || 'Categories';
  $('category-source-location').textContent = categoryLocation();
  const account = categoryAccount?.label || 'your Google account';
  const detail = categoryAccount
    ? 'One categories file for ' + account + ', shared across all your boards. Edits save automatically' + (categoryDriveConnected() ? ' to Drive.' : ' after you reconnect.')
    : categoryHandle ? 'Linked to this text file. Changes are checked when you return. This list is shared across boards in this browser.'
    : 'Shared across boards in this browser. Connect Google Drive to keep one list with your Google account.';
  $('category-source-status').textContent = categorySyncError || categoryStatus || detail;
  $('category-source').classList.toggle('is-local', Boolean(categoryFile));
  $('refresh-categories').hidden = !categoryFile;
  $('default-categories').hidden = !categoryFile;
  $('refresh-categories').textContent = categoryAccount ? 'Refresh from Drive' : categoryHandle ? 'Refresh file' : 'Reload file…';
  $('download-categories').disabled = !categoriesReady || categoryLoadFailed;
  $('connect-category-drive').hidden = !drive.configured || categoryDriveConnected();
  $('connect-category-drive').textContent = categoryAccount ? 'Reconnect Drive' : 'Connect Google Drive';
  $('category-drive-file').hidden = !categoryFile?.drive;
  if (categoryFile?.drive) $('category-drive-file').href = 'https://drive.google.com/file/d/' + encodeURIComponent(categoryFile.drive.id) + '/view';
  for (const id of ['load-categories', 'refresh-categories', 'default-categories', 'edit-categories']) $(id).disabled = categoryBusy || (id === 'edit-categories' && !categoriesReady);
  $('category-edit-account').textContent = categoryAccount ? 'Your categories for ' + account + ', shared across all boards.' : 'Your categories are shared across all boards in this browser.';
  $('category-edit-status').textContent = categorySyncError || categoryStatus || (categoryBusy ? 'Syncing categories…' : categoriesChanged(categoryFile) && categoryAccount ? 'Saved in this browser · ' + (categoryDriveConnected() ? 'Drive save pending' : 'Waiting to reconnect') : categoryLocation());
  $('category-conflict-actions').hidden = !categoryConflict;
  $('category-use-drive').disabled = categoryBusy;
  $('category-keep-mine').disabled = categoryBusy;
  $('drive-category-status').textContent = categoryAccount ? 'Categories: ' + categoryLocation().replace('Google Drive · ', '') + '. Shared across your account’s boards.' : 'Connecting also loads or creates your account’s categories file.';
}

function cacheCategories() {
  try { writeCategoryCache(localStorage, categoriesKey, categoryFile); return true; }
  catch {
    categoryStatus = 'Loaded for this visit. Browser storage could not remember the list; download a copy before leaving.';
    return false;
  }
}

function queueCategorySync() {
  clearTimeout(categorySaveTimer);
  if (!categoryDriveConnected() || categoryConflict || categorySyncError || !categoriesChanged(categoryFile)) return;
  categorySaveTimer = setTimeout(() => syncAccountCategories(), 1600);
}

async function loadDefaultCategories(changed = false) {
  const revision = ++categoryRevision;
  categoryStatus = 'Loading default categories…';
  renderCategorySource();
  try {
    const response = await fetch(new URL('./categories.txt', import.meta.url), {cache: 'no-store'});
    if (!response.ok) throw new Error('HTTP ' + response.status);
    const text = validateCategoryText(await response.text());
    if (revision !== categoryRevision) return;
    categoryFile = {version: 1, name: categoryAccount ? (categoryFile?.drive?.name || ACCOUNT_CATEGORY_NAME) : 'categories.txt', text, token: crypto.randomUUID(), ...(categoryFile?.drive ? {drive: categoryFile.drive} : {}), ...(changed && categoryAccount ? {pending: true} : {})};
    categoryHandle = null; categoryStatus = ''; categorySyncError = ''; categoryConflict = false;
    applyCategoryText(text); cacheCategories();
    if (changed) queueCategorySync();
  } catch (error) {
    if (revision !== categoryRevision) return;
    categoryLoadFailed = true; categoriesReady = true;
    categories = []; frequentCategories.clear();
    categoryStatus = 'Couldn’t load the default list. Import a text file or retry below.';
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
    // Migrate the previously active board's list once. Future board switches
    // do not select, copy, or reload categories.
    if (!categoryFile && !categoryAccount) {
      const legacyKey = boardKeys(appKey, activeSession.id).categories;
      categoryFile = readCategoryCache(localStorage, legacyKey);
      if (categoryFile) {
        cacheCategories();
        try {
          const linked = await getCategoryHandle(legacyKey);
          if (revision !== categoryRevision) return;
          if (linked?.token === categoryFile.token) await putCategoryHandle(categoriesKey, linked);
        } catch { /* Its cached text is enough to keep the list available. */ }
      }
    }
  } catch { /* A Drive reconnect or the default list remains available. */ }
  if (revision !== categoryRevision) return;
  if (!categoryFile) return loadDefaultCategories();
  categoryStatus = ''; categorySyncError = ''; categoryConflict = false;
  applyCategoryText(categoryFile.text); renderCategorySource();
  if (categoryAccount) { queueCategorySync(); return; }
  try {
    const saved = await getCategoryHandle(categoriesKey);
    if (revision !== categoryRevision) return;
    if (saved?.token === categoryFile.token && typeof window.showOpenFilePicker === 'function') categoryHandle = saved.handle;
  } catch { /* The cached list works without file permissions. */ }
  if (revision !== categoryRevision) return;
  if (categoryHandle) return refreshCategories(false);
  renderCategorySource();
}

async function connectCategoryAccount(user) {
  flushCategoryEdits();
  const oldAccount = categoryAccount;
  const seed = !oldAccount || oldAccount.id === user.permissionId ? categoryFile : null;
  ++categoryRevision; clearTimeout(categorySaveTimer);
  categoryAccount = {id: user.permissionId, label: user.emailAddress || user.displayName || 'your Google account'};
  categoriesKey = categoryProfileKey(appKey, categoryAccount.id);
  categoryHandle = null; categoryBusy = false; categoryConflict = false; categorySyncError = ''; categoryStatus = '';
  try { localStorage.setItem(appKey + ':category-account', JSON.stringify(categoryAccount)); }
  catch { categoryStatus = 'Your account choice could not be remembered in this browser.'; }
  try { categoryFile = readCategoryCache(localStorage, categoriesKey); } catch { categoryFile = null; }
  // A second Google account starts with its own cached/Drive list or defaults;
  // categories from the previous account are never used as its seed.
  if (!categoryFile && seed) categoryFile = {...seed, name: ACCOUNT_CATEGORY_NAME, token: crypto.randomUUID(), ...(!oldAccount ? {drive: undefined, pending: false} : {})};
  if (categoryFile) { applyCategoryText(categoryFile.text); cacheCategories(); }
  else await loadDefaultCategories();
  renderCategorySource();
  return syncAccountCategories();
}

async function syncAccountCategories(prefer = 'merge') {
  clearTimeout(categorySaveTimer);
  if (!categoryDriveConnected() || categoryBusy || !categoryFile) return false;
  const key = categoriesKey, snapshot = structuredClone(categoryFile);
  categoryBusy = true; categorySyncError = ''; renderCategorySource();
  let success = false;
  try {
    const result = await syncCategoryProfile(drive, snapshot, {prefer});
    if (key !== categoriesKey) return false;
    if (categoryFile.text === snapshot.text || prefer === 'remote') {
      categoryFile = result.file; applyCategoryText(categoryFile.text);
      if (prefer === 'remote' && categoryEditKey === key) {
        $('categories-text').value = categoryFile.text; categoryEditText = categoryFile.text;
      }
    } else if (result.file.text === snapshot.text) {
      // Typing during an upload keeps the newer text and remembers the revision
      // just saved, so the following upload updates the same file safely.
      categoryFile = {...categoryFile, drive: result.file.drive, pending: true};
    } else {
      throw new DriveConflictError('The account list changed while you were editing. Choose which list to keep.');
    }
    categoryConflict = false; categoryStatus = ''; cacheCategories(); success = true;
  } catch (error) {
    if (key !== categoriesKey) return false;
    categorySyncError = error instanceof DriveConflictError ? 'Categories changed on another device. Open Edit categories to choose which list to keep.' : error.message;
    categoryConflict = error instanceof DriveConflictError;
  } finally {
    if (key === categoriesKey) {
      categoryBusy = false; lastCategoryCheck = Date.now(); renderCategorySource();
      if (success) queueCategorySync();
    }
  }
  return success;
}

async function chooseCategories() {
  if (categoryBusy) return;
  if (typeof window.showOpenFilePicker !== 'function') { categoryPickSession = categoriesKey; return $('categories-file').click(); }
  const revision = ++categoryRevision;
  categoryBusy = true; renderCategorySource();
  try {
    const [handle] = await window.showOpenFilePicker({id: 'cork-categories', multiple: false, types: [{description: 'Categories text file', accept: {'text/plain': ['.txt']}}], ...(categoryHandle ? {startIn: categoryHandle} : {})});
    if (revision !== categoryRevision) return;
    await useCategoryFile(await handle.getFile(), handle, revision);
  } catch (error) {
    if (revision === categoryRevision && error.name !== 'AbortError') toast(error.message || 'Could not open the categories file.');
  } finally {
    if (revision === categoryRevision) {
      categoryBusy = false; renderCategorySource(); queueCategorySync();
      if (!categoriesReady) loadCategories();
    }
  }
}

async function useCategoryFile(file, handle = null, revision = ++categoryRevision) {
  const data = await readCategoryFile(file);
  if (revision !== categoryRevision) return;
  const remote = categoryAccount && categoryFile?.drive;
  categoryFile = {version: 1, ...data, name: categoryAccount ? (remote?.name || ACCOUNT_CATEGORY_NAME) : data.name, token: crypto.randomUUID(), ...(remote ? {drive: remote} : {}), ...(categoryAccount ? {pending: true} : {})};
  categoryHandle = categoryAccount ? null : handle; categoryStatus = ''; categorySyncError = ''; categoryConflict = false;
  applyCategoryText(data.text); cacheCategories(); renderCategorySource();
  try { await putCategoryHandle(categoriesKey, categoryHandle ? {token: categoryFile.token, handle: categoryHandle} : null); }
  catch { /* The imported text remains available without its local file link. */ }
}

async function refreshCategories(askPermission = true) {
  if (!categoryFile || categoryBusy) return;
  if (categoryAccount) {
    flushCategoryEdits();
    if (!categoryDriveConnected()) return askPermission ? openDriveDialog() : undefined;
    return syncAccountCategories();
  }
  if (!categoryHandle) { if (askPermission) return chooseCategories(); return; }
  const revision = ++categoryRevision;
  categoryBusy = true; lastCategoryCheck = Date.now(); renderCategorySource();
  try {
    const data = await readLinkedCategories(categoryHandle, askPermission);
    if (revision !== categoryRevision) return;
    if (data) {
      categoryFile = {...categoryFile, ...data}; categoryStatus = '';
      applyCategoryText(data.text); cacheCategories();
    } else categoryStatus = 'Using the saved list. Click Refresh to allow access to the linked file again.';
  } catch {
    if (revision !== categoryRevision) return;
    categoryStatus = 'Using the saved list. The linked file couldn’t be read; import it again to reconnect.';
  } finally {
    if (revision === categoryRevision) { categoryBusy = false; renderCategorySource(); }
  }
}

function checkCategoryFile() {
  if (document.visibilityState === 'hidden' || categoryBusy || $('categories-dialog').open) return;
  const wait = categoryAccount ? 30000 : 1500;
  if ((categoryHandle || categoryDriveConnected()) && Date.now() - lastCategoryCheck > wait) refreshCategories(false);
}

function editCategories() {
  if (categoryBusy || !categoriesReady) return;
  categoryEditKey = categoriesKey; categoryEditText = categoryText;
  $('categories-text').value = categoryText; renderCategorySource();
  $('categories-dialog').showModal();
}

function flushCategoryEdits() {
  clearTimeout(categoryEditTimer);
  if (!$('categories-dialog').open) return true;
  if (categoryEditKey !== categoriesKey) { $('category-edit-status').textContent = 'The Google account changed. Copy your draft, then close and reopen the categories editor.'; return false; }
  const text = $('categories-text').value;
  if (text === categoryEditText) return true;
  try {
    validateCategoryText(text);
    if (categoryText !== categoryEditText) throw new Error('This list changed in another tab. Copy your text, then close and reopen the categories editor.');
    categoryFile = {version: 1, name: categoryFile?.name || 'categories.txt', token: crypto.randomUUID(), text, ...(categoryFile?.drive ? {drive: categoryFile.drive} : {}), ...(categoryAccount ? {pending: true} : {})};
    categoryHandle = null; categoryStatus = ''; categorySyncError = categoryConflict ? categorySyncError : '';
    ++categoryRevision; categoryEditText = text;
    applyCategoryText(text); cacheCategories(); renderCategorySource(); queueCategorySync();
    return true;
  } catch (error) { $('category-edit-status').textContent = error.message; return false; }
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

function applyInterfaceTheme() {
  const theme = uiThemePreference === 'system' ? (systemAppearance.matches ? 'dark' : 'light') : uiThemePreference;
  document.body.dataset.uiTheme = theme;
  document.documentElement.style.colorScheme = theme;
  $('ui-theme').value = uiThemePreference;
  document.querySelector('meta[name="theme-color"]').content = theme === 'dark' ? '#242520' : '#f2efe6';
}

function toggleSidebarSettings(id) {
  const open = !$(id).open;
  for (const other of ['text-settings', 'appearance-settings']) $(other).open = other === id && open;
}

function applyNoteStyle(element, style = {}, type = 'note') {
  style ||= {};
  for (const part of ['header', 'body']) {
    const values = style[part] || {};
    element.style.setProperty(`--${part}-font`, NOTE_FONTS[values.font] || NOTE_FONTS.sans);
    for (const field of ['size', 'weight']) {
      const key = `--${part}-${field}`;
      if (values[field]) element.style.setProperty(key, `${values[field]}${field === 'size' ? 'px' : ''}`);
      else element.style.removeProperty(key);
    }
    const height = `--${part}-line-height`;
    if (values.size) element.style.setProperty(height, `${Math.max(part === 'body' ? (type === 'card' ? 24 : 23) : 0, values.size * (part === 'body' ? 1.6 : 1.35))}px`);
    else element.style.removeProperty(height);
  }
}

function renderTextControls() {
  const count = selected.size, selectedOption = $('text-target').querySelector('[value=selected]');
  selectedOption.disabled = !count; selectedOption.textContent = count ? `Selected notes (${count})` : 'Selected notes';
  if (!count) textTarget = 'new';
  $('text-target').value = textTarget;
  const notes = selectedNotes();
  const styles = textTarget === 'new' ? [board.noteStyle || {}] : notes.map(note => note.style || {});
  for (const control of document.querySelectorAll('[data-text-part]')) {
    const part = control.dataset.textPart, field = control.dataset.textField;
    const values = new Set(styles.map((style, index) => {
      if (style[part]?.[field] !== undefined) return style[part][field];
      if (field === 'font') return 'sans';
      if (textTarget === 'new') return '';
      const type = notes[index].type;
      if (field === 'size') return part === 'header' ? (type === 'card' ? 19 : 16) : type === 'image' ? 16 : 13;
      return part === 'header' ? (type === 'card' ? 550 : type === 'folder' ? 600 : 650) : type === 'image' ? 550 : 400;
    }));
    const mixed = values.size > 1, value = mixed ? '' : [...values][0];
    control.value = value;
    control.classList.toggle('is-mixed', mixed);
    if (field === 'weight') control.querySelector('[value=""]').textContent = mixed ? 'Mixed' : 'Default';
    control.title = mixed ? 'Mixed values; choose a value to apply to every selected note' : control.getAttribute('aria-label');
    if (control.type === 'number') control.placeholder = mixed ? 'Mixed' : 'Auto';
  }
}

function changeTextStyle(part, field, value, recordChange = true) {
  if (field === 'size' && value !== '' && (!Number.isFinite(Number(value)) || Number(value) < 9 || Number(value) > 72)) return false;
  const targets = textTarget === 'new' ? [board] : selectedNotes();
  const key = textTarget === 'new' ? 'noteStyle' : 'style';
  const desired = value === '' ? undefined : field === 'font' ? value : Number(value);
  if (!targets.some(target => target[key]?.[part]?.[field] !== desired)) return false;
  if (recordChange) record();
  for (const target of targets) {
    const style = normalizeNoteStyle(target[key]);
    style[part] ||= {};
    if (value === '') delete style[part][field];
    else style[part][field] = field === 'font' ? value : Number(value);
    target[key] = normalizeNoteStyle(style);
    if (textTarget === 'selected') { const element = noteElements.get(target.id); applyNoteStyle(element, target.style, target.type); autosize(target, element); }
  }
  if (placement) applyNoteStyle($('placement-preview'), board.noteStyle, placement.type);
  renderTextControls(); queueStrings(); saveNow();
  return true;
}

function renderPalette() {
  $('palette').value = board.palette;
  $('theme').value = board.theme;
  $('reset-color-order').hidden = !board.colorOrder?.length;
  renderTextControls();
  document.body.dataset.theme = board.theme;
  const preview = $('palette-preview'); preview.replaceChildren();
  for (let i = 0; i < 9; i++) {
    const swatch = document.createElement('span');
    const dummy = Array.from({length: 9}, (_, index) => String(index));
    swatch.style.background = categories[i] ? colorFor(categories[i]) : categoryColor(String(i), dummy, board.palette);
    preview.append(swatch);
  }
}

function updateNoteColors() {
  for (const note of board.notes) noteElements.get(note.id)?.style.setProperty('--note-color', colorFor(note.category));
  if (placement) $('placement-preview').style.setProperty('--note-color', colorFor(placement.category));
}

function updateCounts() {
  $('note-count').textContent = `${board.notes.length} ${board.notes.length === 1 ? 'note' : 'notes'}`;
  $('export-pdf').disabled = pdfExporting || (!board.notes.length && !board.tapes.length);
  $('add-string').disabled = board.notes.length < 2;
  if (board.notes.length < 2 && stringMode) setStringMode(false);
  updateSelection();
}


const PIN_SHAPES = {'board-pin':'', classic:'📌', arrow:'', 'arrow-blue':'', 'arrow-yellow':'', 'arrow-green':'', crown:'👑', flower:'🌼', heart:'❤️', bug:'🐞', dog:'🐶', cat:'🐱', egg:'🥚', duck:'🦆', music:'🎵', check:'', cross:'', envelope:'✉️', camera:'📷', film:'🎞️', fire:'🔥', exclamation:'❗', chat:'💬', tv:'📺'};
const ARROW_PIN_COLORS = {arrow:'#c63832', 'arrow-blue':'#3266bd', 'arrow-yellow':'#e2ad1d', 'arrow-green':'#388b50'};
function setPinGlyph(element, shape) {
  element.replaceChildren();
  if (shape === 'board-pin') {
    const head=document.createElement('span'); head.setAttribute('aria-hidden','true');
    const size=element.classList.contains('pin-art') ? '23%' : '11px';
    Object.assign(head.style, {display:'inline-block', width:size, height:size, borderRadius:'50%', background:'radial-gradient(circle at 35% 25%,#ffe4d9 0 13%,#d75e48 28%,#8c2d20 72%)', boxShadow:'1px 3px 3px #30201577,inset -1px -1px 2px #57181088'});
    element.append(head); return;
  }
  if (shape === 'check' || shape === 'cross') {
    const svg=document.createElementNS('http://www.w3.org/2000/svg','svg');
    svg.setAttribute('viewBox','0 0 64 64'); svg.setAttribute('aria-hidden','true');
    const size=element.classList.contains('pin-art') ? '85%' : '24px'; svg.style.width=size; svg.style.height=size;
    const path=document.createElementNS('http://www.w3.org/2000/svg','path');
    path.setAttribute('d',shape === 'check' ? 'M 9 33 L 25 49 L 55 15' : 'M 13 13 L 51 51 M 51 13 L 13 51');
    path.setAttribute('fill','none'); path.setAttribute('stroke',shape === 'check' ? '#278843' : '#c63832');
    path.setAttribute('stroke-width','9'); path.setAttribute('stroke-linecap','round'); path.setAttribute('stroke-linejoin','round');
    svg.append(path); element.append(svg); return;
  }
  if (!Object.hasOwn(ARROW_PIN_COLORS, shape)) {
    if (!element.classList.contains('pin-art')) { element.textContent=PIN_SHAPES[shape]; return; }
    // Prevent the emoji's intrinsic width from expanding the grid track and
    // shifting the visible glyph away from the pin's rotation/connection center.
    const glyph=document.createElement('span'); glyph.textContent=PIN_SHAPES[shape];
    Object.assign(glyph.style, {display:'block', width:'100%', minWidth:'0', textAlign:'center', lineHeight:'1'});
    element.append(glyph); return;
  }
  const svg=document.createElementNS('http://www.w3.org/2000/svg','svg');
  svg.setAttribute('viewBox','0 0 64 64'); svg.setAttribute('aria-hidden','true');
  const previewSize = element.classList.contains('pin-art') ? '85%' : '24px';
  svg.style.width=previewSize; svg.style.height=previewSize;
  const path=document.createElementNS('http://www.w3.org/2000/svg','path');
  path.setAttribute('d','M 5 23 L 35 23 L 35 10 L 60 32 L 35 54 L 35 41 L 5 41 Z');
  path.setAttribute('fill',ARROW_PIN_COLORS[shape]); path.setAttribute('stroke','#321d1a'); path.setAttribute('stroke-opacity','.3'); path.setAttribute('stroke-width','1.5'); path.setAttribute('stroke-linejoin','round');
  svg.append(path); element.append(svg);
}
const CARD_COLORS = {white:'#fffef8', yellow:'#fff1af', pink:'#f9d5d7', blue:'#d4e8f4'};
const STRING_COLORS = {red:['#9e3027','#e06e57'], blue:['#245aa5','#9dc1f0'], yellow:['#b58a08','#ffe07a'], green:['#34764b','#9cdb9b'], black:['#292c30','#a2a4a7'], white:['#c8c8c0','#ffffff']};
const TAPE_COLORS = {red:'#b5252e', blue:'#2454a3', yellow:'#f1d43b', white:'#f0eee7', black:'#232527'};
function setTapeMode(active, keepSelection = false) {
  tapeMode = active; if (!keepSelection) selectedTape = null;
  viewport.classList.toggle('is-taping', active);
  $('add-tape').setAttribute('aria-pressed', String(active));
  const tape = board.tapes?.find(t => t.id === selectedTape);
  $('tape-bar').hidden = !active && !tape;
  $('tape-text-label').hidden = !tape; $('tape-duplicate').hidden = !tape; $('tape-delete').hidden = !tape; $('tape-hint').hidden = !active;
  if (tape) { $('tape-color').value = tape.color; $('tape-text').value = tape.text; }
  if (tapeLayer?.isConnected) renderTapes();
  refreshSupplyControls();
}
function updateTapeGeometry(group, tape) {
  const length = Math.hypot(tape.x2-tape.x1, tape.y2-tape.y1);
  const angle = length ? Math.atan2(tape.y2-tape.y1, tape.x2-tape.x1)*180/Math.PI : Number(group.dataset.angle || 0);
  group.dataset.angle = angle;
  group.setAttribute('transform', `translate(${tape.x1} ${tape.y1}) rotate(${angle})`);
  const seed = [...tape.id].reduce((n,c) => (n*31+c.charCodeAt(0))>>>0, 7);
  const scale = Math.min(1, length/16), a = (2 + seed%5)*scale, b = (2 + (seed>>>4)%5)*scale;
  group.querySelector('path').setAttribute('d', `M ${a} -16 L ${length-b} -16 L ${length-2*scale} -10 L ${length-b} -5 L ${length-scale} 0 L ${length-b} 6 L ${length-3*scale} 11 L ${length-b} 16 L ${a} 16 L ${2*scale} 11 L ${a} 6 L ${scale} 0 L ${a} -5 L ${2*scale} -11 Z`);
  const label = group.querySelector('text');
  if (label) { label.setAttribute('x', length/2); if (tape.text.length*9 > length-20) label.setAttribute('textLength', Math.max(1,length-20)); else label.removeAttribute('textLength'); }
  group.querySelector('[data-end="2"]')?.setAttribute('cx', length);
}
function renderTapes(preview = null) {
  if (!tapeLayer?.isConnected) { tapeLayer = document.createElementNS('http://www.w3.org/2000/svg', 'svg'); tapeLayer.classList.add('tape-layer'); world.prepend(tapeLayer); }
  tapeLayer.replaceChildren();
  const svg = (tag, attrs) => { const el = document.createElementNS('http://www.w3.org/2000/svg', tag); for (const [k,v] of Object.entries(attrs)) el.setAttribute(k,v); return el; };
  for (const tape of [...(board.tapes || []), ...(preview ? [preview] : [])]) {
    const length = Math.hypot(tape.x2-tape.x1,tape.y2-tape.y1), angle = Math.atan2(tape.y2-tape.y1,tape.x2-tape.x1)*180/Math.PI;
    const group = svg('g', {class:`tape-piece${selectedTapes.has(tape.id) ? ' is-selected' : ''}`, transform:`translate(${tape.x1} ${tape.y1}) rotate(${angle})`, 'data-tape-id':tape.id, tabindex:'0', role:'button', 'aria-label':'Tape. Select to edit or delete.'});
    const seed = [...tape.id].reduce((n,c) => (n*31+c.charCodeAt(0))>>>0, 7);
    const a = 2 + seed%5, b = 2 + (seed>>>4)%5;
    group.append(svg('path', {d:`M ${a} -16 L ${length-b} -16 L ${length-2} -10 L ${length-b} -5 L ${length-1} 0 L ${length-b} 6 L ${length-3} 11 L ${length-b} 16 L ${a} 16 L 2 11 L ${a} 6 L 1 0 L ${a} -5 L 2 -11 Z`, fill:TAPE_COLORS[tape.color], stroke:'#000', 'stroke-opacity':'.16', 'stroke-width':'1'}));
    const text = svg('text', {x:length/2, y:0, 'text-anchor':'middle', 'dominant-baseline':'central', fill:tape.color === 'white' ? '#000' : '#fff', 'font-family':'sans-serif', 'font-size':'15', 'font-weight':'600', 'pointer-events':'none', textLength:Math.max(1, length-20), lengthAdjust:'spacingAndGlyphs'});
    if (tape.text) { text.removeAttribute('textLength'); if (tape.text.length*9 > length-20) text.setAttribute('textLength', Math.max(1,length-20)); text.textContent=tape.text; group.append(text); }
    if (tape.id !== 'preview') {
      if (selectedTapes.has(tape.id)) for (const [end, x] of [['1',0], ['2',length]]) {
        const handle = svg('circle', {class:'tape-handle', cx:x, cy:0, r:8, 'data-end':end, tabindex:'0', role:'button', 'aria-label':`Move tape end ${end}. Drag or use arrow keys.`});
        handle.addEventListener('keydown', e => { const d=arrowDirection(e.key); if (!d) return; e.preventDefault(); e.stopPropagation(); record(); const step=e.shiftKey?1:10; tape['x'+end]+=d[0]*step; tape['y'+end]+=d[1]*step; renderTapes(); saveSoon(); tapeLayer.querySelector(`[data-tape-id="${tape.id}"] [data-end="${end}"]`)?.focus(); });
        group.append(handle);
      }
      group.addEventListener('keydown', e => { if ((e.key==='Enter' || e.key===' ') && e.target===group) { e.preventDefault(); e.stopPropagation(); if (!selectMode && !e.shiftKey) setSelected(null); selectedTapes.add(tape.id); selectedTape=tape.id; setTapeMode(false,true); updateSelection(); tapeLayer.querySelector(`[data-tape-id="${tape.id}"]`)?.focus(); } });
    }
    tapeLayer.append(group);
    updateTapeGeometry(group, tape);
  }
}
$('add-tape').addEventListener('click', () => { pinChoosing=false; cancelGesture(); cancelPlacement(); setStringMode(false); setSelectMode(false); handMode=false; spaceHeld=false; updateHandMode(); setSelected(null); setTapeMode(!tapeMode); if (compactLayout.matches) setSidebar(false); });
$('tape-done').addEventListener('click', () => setTapeMode(false));
$('tape-color').addEventListener('change', () => { const tape=board.tapes.find(t => t.id===selectedTape); if (tape) { record(); tape.color=$('tape-color').value; renderTapes(); saveSoon(); } });
$('tape-text').addEventListener('focus', record);
$('tape-text').addEventListener('input', () => { const tape=board.tapes.find(t => t.id===selectedTape); if (tape) { tape.text=$('tape-text').value; renderTapes(); saveSoon(); } });
$('tape-duplicate').addEventListener('click', () => {
  const tape = board.tapes.find(t => t.id === selectedTape);
  if (!tape) return;
  record();
  const copy = {...tape, id:crypto.randomUUID(), x1:tape.x1+28, y1:tape.y1+28, x2:tape.x2+28, y2:tape.y2+28};
  board.tapes.push(copy); setSelected(null); selectedTapes.add(copy.id); selectedTape=copy.id;
  setTapeMode(false, true); updateCounts(); saveNow();
});
$('tape-delete').addEventListener('click', () => { if (!selectedTape) return; removeElements(new Set(), new Set(), new Set([selectedTape])); });

function queueStrings() {
  cancelAnimationFrame(stringFrame);
  stringFrame = requestAnimationFrame(renderStrings);
}

function setStringMode(active) {
  if (active) pinChoosing = false;
  if (active) { setTapeMode(false); setSelectMode(false); setSelected(null); }
  stringMode = active; stringStart = null;
  viewport.classList.toggle('is-connecting', active);
  $('add-string').setAttribute('aria-pressed', String(active));
  updateBoardTip(); refreshSupplyControls();
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
    record(); board.connections.push({id: crypto.randomUUID(), from: stringStart, to: id, color:$('string-color').value}); saveNow();
  }
  setStringMode(false); renderStrings();
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
    const rect = note => ({...note, width: parseFloat(getComputedStyle(noteElements.get(note.id)).width), height:parseFloat(getComputedStyle(noteElements.get(note.id)).height)});
    const curve = connectionGeometry(rect(from), rect(to));
    const d = `M ${curve.from.x} ${curve.from.y} Q ${curve.control.x} ${curve.control.y} ${curve.to.x} ${curve.to.y}`;
    const group = svg('g', {class: `yarn${selectedStrings.has(connection.id) ? ' is-selected' : ''}`, 'data-connection-id': connection.id});
    const colors = STRING_COLORS[connection.color] || STRING_COLORS.red; group.style.setProperty('--yarn-color',colors[0]); group.style.setProperty('--yarn-highlight',colors[1]);
    group.append(svg('path', {d, class: 'yarn-base'}), svg('path', {d, class: 'yarn-twist'}));
    const hit = svg('path', {d, class: 'connection-hit', tabindex: '0', role: 'button', 'aria-pressed': String(selectedStrings.has(connection.id)), 'aria-label': 'Connection. Press Delete to remove.'});
    hit.addEventListener('click', event => {
      event.stopPropagation();
      if (handMode || spaceHeld || Date.now() < suppressNoteClickUntil) return;
      document.activeElement?.blur();
      const additive = event.shiftKey || selectMode;
      if (!additive) setSelected(null);
      if (additive && selectedStrings.has(connection.id)) selectedStrings.delete(connection.id);
      else selectedStrings.add(connection.id);
      updateSelection();
    });
    hit.addEventListener('focus', () => {
      if (selectedStrings.has(connection.id)) return;
      if (!selectMode) setSelected(null);
      selectedStrings.add(connection.id); updateSelection();
    });
    hit.addEventListener('keydown', event => {
      if (event.key === 'Delete' || event.key === 'Backspace') { event.preventDefault(); event.stopPropagation(); removeSelection(); }
      else if (event.key === 'Enter' || event.key === ' ') {
        event.preventDefault(); event.stopPropagation();
        if (selectedStrings.has(connection.id)) selectedStrings.delete(connection.id);
        else selectedStrings.add(connection.id);
        updateSelection();
      }
    });
    group.append(hit); stringLayer.append(group);
    connected.add(from.id); connected.add(to.id); pins.set(from.id, curve.from); pins.set(to.id, curve.to);
  }
  for (const [id, point] of pins) {
    if (board.notes.find(n => n.id === id)?.pin) continue;
    const pin = svg('g', {class: 'connection-pin', 'data-note-id': id});
    pin.append(svg('circle', {cx: point.x + 1, cy: point.y + 1.5, r: 4.3, fill: '#4c241b', opacity: '.22'}), svg('circle', {cx: point.x, cy: point.y, r: 4, fill: '#aa4a37', stroke: '#763327', 'stroke-width': '.6'}), svg('circle', {cx: point.x - 1, cy: point.y - 1, r: 1.3, fill: '#f0b3a0'}));
    stringLayer.append(pin);
  }
  for (const [id, element] of noteElements) element.classList.toggle('is-connected', connected.has(id));
}

function updateCorkTexture(view) {
  corkTexture.style.transform = world.style.transform;
  const paper = board.theme.startsWith('paper-');
  const resolution = paper ? paperResolution(view.zoom, window.devicePixelRatio) : 0;
  const variant = paper ? `paper-${resolution}` : 'cork';
  if (variant !== textureVariant) {
    for (const tile of corkTiles.values()) tile.remove();
    corkTiles.clear(); textureVariant = variant;
  }
  const {width, height} = paper ? {width:PAPER_TILE_SIZE, height:PAPER_TILE_SIZE} : corkTileSize;
  const margin = paper ? 0 : 1;
  const left = Math.floor(-view.x / view.zoom / width) - margin;
  const right = Math.floor((viewport.clientWidth - view.x) / view.zoom / width) + margin;
  const top = Math.floor(-view.y / view.zoom / height) - margin;
  const bottom = Math.floor((viewport.clientHeight - view.y) / view.zoom / height) + margin;
  const visible = new Set();
  for (let row = top; row <= bottom; row++) {
    for (let column = left; column <= right; column++) {
      const key = `${column},${row}`;
      visible.add(key);
      if (corkTiles.has(key)) continue;
      const tile = document.createElement(paper ? 'canvas' : 'div');
      tile.className = paper ? 'paper-tile' : 'cork-tile';
      tile.style.left = `${column * width}px`;
      tile.style.top = `${row * height}px`;
      if (paper) paintPaperTile(tile, column, row, resolution);
      // Mirrored cork neighbors share the same photograph edge.
      else tile.style.transform = `scale(${column % 2 ? -1 : 1}, ${row % 2 ? -1 : 1})`;
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

function setSelected(ids) {
  selected.clear(); selectedStrings.clear(); selectedTapes.clear(); selectedTape = null; selectedMainPinId = null;
  if (tapeLayer?.isConnected) setTapeMode(false);
  for (const id of typeof ids === 'string' ? [ids] : ids || []) selected.add(id);
  updateSelection();
}

function updateSelection() {
  for (const id of selected) if (!noteElements.has(id)) selected.delete(id);
  const links = new Set(board.connections.map(link => link.id));
  for (const id of selectedStrings) if (!links.has(id)) selectedStrings.delete(id);
  for (const [id, element] of noteElements) {
    element.classList.toggle('is-selected', selected.has(id));
    element.querySelector('.note-drag')?.setAttribute('aria-pressed', String(selected.has(id)));
    for (const input of element.querySelectorAll('textarea')) { input.readOnly = selectMode; input.tabIndex = selectMode ? -1 : 0; }
    for (const control of element.querySelectorAll('.note-actions button, .note-resize, .note-resize-height, .folder-open, .polaroid-photo')) control.tabIndex = selectMode ? -1 : 0;
  }
  for (const yarn of stringLayer?.querySelectorAll('.yarn') || []) {
    const active = selectedStrings.has(yarn.dataset.connectionId);
    yarn.classList.toggle('is-selected', active);
    yarn.querySelector('.connection-hit').setAttribute('aria-pressed', String(active));
  }
  const validTapes = new Set(board.tapes.map(t => t.id));
  for (const id of selectedTapes) if (!validTapes.has(id)) selectedTapes.delete(id);
  const count = selected.size + selectedStrings.size + selectedTapes.size;
  viewport.classList.toggle('has-multi-selection', count > 1);
  $('selection-tools').hidden = !count;
  const signature = [...selected].sort().join('|');
  if (signature !== textSelection) { textTarget = selected.size ? 'selected' : 'new'; textSelection = signature; }
  $('edit-text').hidden = !selected.size;
  renderTextControls();
  const label = `${count} selected`;
  if ($('selection-count').textContent !== label) $('selection-count').textContent = label;
  updateBoardTip(); refreshSupplyControls();
}

function refreshSupplyControls() {
  const panel = $('supply-controls');
  if (!panel) return;
  const notes = board.notes.filter(note => selected.has(note.id));
  const selectedPin = notes.length === 1 && (notes[0].pin || selectedMainPinId === notes[0].id) ? notes[0] : null;
  const pinConfig = selectedPin?.pin || (selectedPin ? {shape:'board-pin',size:48,rotation:0} : null);
  const cardSelection = notes.length > 0 && notes.every(note => note.type === 'card');
  const selectedLinks = board.connections.filter(link => selectedStrings.has(link.id));
  const context = tapeMode || selectedTape ? '' : pinChoosing ? 'pin-new' : placement?.type === 'card' ? 'card-new' : stringMode ? 'string-new' : placement ? '' : selectedPin ? 'pin-edit' : cardSelection ? 'card-edit' : selectedLinks.length ? 'string-edit' : '';
  panel.hidden = !context;
  $('pin-options').hidden = !context.startsWith('pin');
  $('pin-size-control').hidden = context !== 'pin-edit';
  if (context === 'pin-edit') $('pin-size').value = Math.round(pinConfig.size);
  $('card-color-control').hidden = !context.startsWith('card');
  $('string-color-control').hidden = !context.startsWith('string');
  $('add-pin').setAttribute('aria-pressed', String(pinChoosing));
  $('supply-controls-title').textContent = context.startsWith('pin') ? 'Push pins' : context.startsWith('card') ? 'Index card' : 'String';
  $('supply-controls-hint').textContent = context === 'pin-new' ? 'Choose a pin, then place it.' : context === 'pin-edit' ? 'Drag the handle to resize and rotate.' : context === 'card-new' ? 'Choose a color, then place the card.' : context === 'string-new' ? 'Choose a color, then select two items.' : '';
  if (context === 'card-edit') { const colors = new Set(notes.map(n => n.cardColor || 'white')); $('card-color').value = colors.size === 1 ? [...colors][0] : ''; }
  if (context === 'string-edit') { const colors = new Set(selectedLinks.map(n => n.color || 'red')); $('string-color').value = colors.size === 1 ? [...colors][0] : ''; }
  for (const button of $('pin-options').querySelectorAll('button')) button.setAttribute('aria-pressed', String(Boolean(selectedPin && context === 'pin-edit' && button.dataset.shape === pinConfig.shape)));
}

function updateBoardTip() {
  $('board-tip').hidden = !board.notes.length || !$('selection-tools').hidden;
  $('board-tip').textContent = stringMode ? (stringStart ? 'Select a different item.' : 'Select the first item.') : selectMode ? 'Click items or drag a box to select. Drag selected items to move them.' : 'Scroll to zoom. Drag the board to pan.';
}

function setSelectMode(active) {
  if (active) pinChoosing = false;
  selectMode = active;
  if (active) {
    document.activeElement?.blur();
    cancelPlacement(); setStringMode(false);
    handMode = false; spaceHeld = false; updateHandMode();
  }
  viewport.classList.toggle('selection-mode', active);
  $('select-mode').setAttribute('aria-pressed', String(active));
  updateSelection();
}

function selectedNotes() { return board.notes.filter(note => selected.has(note.id)); }

function arrowDirection(key) { return {ArrowLeft:[-1,0], ArrowRight:[1,0], ArrowUp:[0,-1], ArrowDown:[0,1]}[key]; }
function selectedTapePositions() { return board.tapes.filter(t => selectedTapes.has(t.id)).map(tape => ({tape, x1:tape.x1, y1:tape.y1, x2:tape.x2, y2:tape.y2})); }
function moveSelectedTapes(dx,dy) { for (const t of board.tapes) if (selectedTapes.has(t.id)) { t.x1+=dx; t.y1+=dy; t.x2+=dx; t.y2+=dy; } renderTapes(); }
function moveNotes(notes, dx, dy) {
  const ids = new Set(notes.map(n=>n.id));
  for (const note of notes) {
    note.x += dx; note.y += dy;
    if (note.parentId && !ids.has(note.parentId)) { note.offsetX += dx; note.offsetY += dy; }
    const element = noteElements.get(note.id);
    element.style.left = `${note.x}px`; element.style.top = `${note.y}px`;
  }
  syncAttachedPins(ids); queueStrings();
}

function syncAttachedPins(parentIds) {
  for (const pin of board.notes) if (pin.type === 'pin' && pin.parentId && parentIds.has(pin.parentId)) { const parent=board.notes.find(n=>n.id===pin.parentId); if (!parent) continue; pin.x=parent.x+pin.offsetX; pin.y=parent.y+pin.offsetY; const el=noteElements.get(pin.id); if (el) { el.style.left=`${pin.x}px`; el.style.top=`${pin.y}px`; } }
}
function bringForward(id) {
  const index = board.notes.findIndex(note => note.id === id);
  if (index < 0 || index === board.notes.length - 1) return;
  board.notes.push(board.notes.splice(index, 1)[0]);
  board.notes.forEach((note, i) => { if (noteElements.has(note.id)) noteElements.get(note.id).style.zIndex = String(note.type === 'pin' ? 100000+i : i + 1); });
  saveSoon();
}

function autosize(note, element) {
  if (note.type === 'folder' || note.type === 'pin') return;
  if (note.type === 'image') {
    const caption = element.querySelector('.polaroid-caption');
    let size = note.style?.body?.size || 16;
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
    if (!compactLayout.matches || selectMode) return;
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
  applyNoteStyle(element, note.style, note.type);
  if (note.type !== 'folder' && note.type !== 'pin') {
    const shadow = document.createElement('span'); shadow.className = 'paper-shadow';
    const surface = document.createElement('span'); surface.className = 'paper-surface';
    shadow.append(surface); element.append(shadow);
    if (note.type !== 'card') {
      // Stable variation: a paper's curl survives redraws, reloads and backups.
      let seed = 2166136261;
      for (const character of note.id) seed = Math.imul(seed ^ character.codePointAt(0), 16777619) >>> 0;
      const size = note.type === 'image' ? 8 + seed % 5 : 16 + seed % 9;
      element.dataset.curl = seed & 1 ? 'left' : 'right';
      element.style.setProperty('--curl-size', `${size}px`);
      const curl = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
      curl.classList.add('paper-curl'); curl.setAttribute('viewBox', '0 0 24 24'); curl.setAttribute('aria-hidden', 'true');
      const gradient = `curl-${seed}`;
      curl.innerHTML = `<defs><linearGradient id="${gradient}" x1="0" y1="0" x2="1" y2="1"><stop stop-color="#fffef8" stop-opacity=".95"/><stop offset=".48" stop-color="#fffef8" stop-opacity=".72"/><stop offset=".78" stop-color="#fffef8" stop-opacity=".28"/><stop offset="1" stop-color="#392718" stop-opacity=".2"/></linearGradient></defs><path d="M0 24 Q3 13 1 2 Q13 4 24 0 Z" fill="url(#${gradient})"/><path d="M1 2 Q13 4 24 0" fill="none" stroke="#fffef8" stroke-opacity=".65" stroke-width=".55"/>`;
      element.append(curl);
    }
  }
  handle.addEventListener('keydown', event => {
    if (selectMode && (event.key === 'Enter' || event.key === ' ')) {
      event.preventDefault(); event.stopPropagation();
      if (selected.has(note.id)) selected.delete(note.id); else selected.add(note.id);
      updateSelection(); return;
    }
    const direction = {ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1]}[event.key];
    if (!direction) return;
    event.preventDefault(); record();
    if (!selected.has(note.id)) setSelected(note.id);
    const step = event.shiftKey ? 1 : 10;
    moveNotes(selectedNotes(), direction[0] * step, direction[1] * step); moveSelectedTapes(direction[0] * step, direction[1] * step); event.stopPropagation(); saveSoon();
  });
  element.addEventListener('focusin', () => {
    if (!compactLayout.matches && !selectMode) { revealOnBoard(note, element); saveSoon(); }
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
  element.append(handle, photo, caption, actions); applyPushPin(note,element);
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
  folderPickSession = activeSession;
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
  const target = activeSession;
  try {
    const previous = await loadFolder(note.folderId);
    const handle = await window.showDirectoryPicker({id: 'cork-folder', mode: 'read', ...(previous ? {startIn: previous} : {})});
    if (target !== activeSession) return;
    if (previous && await handle.isSameEntry(previous)) return updateFolderLink(note, note.folderId, handle.name);
    const id = crypto.randomUUID();
    await putFolder(id, handle); folderHandles.set(id, Promise.resolve(handle));
    if (target !== activeSession) return;
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
  element.append(open, handle, actions); applyPushPin(note,element); noteElements.set(note.id, element); world.append(element);
  loadFolder(note.folderId);
  return element;
}

function applyPushPin(note, element) {
  element.querySelector('.pin-art')?.remove(); element.querySelector('.pin-adjust')?.remove(); element.querySelector('.remove-custom-pin')?.remove();
  element.classList.toggle('has-custom-pin', Boolean(note.pin));
  if (!note.pin) return;
  const art = document.createElement('span'); art.className='pin-art'; setPinGlyph(art,note.pin.shape); art.setAttribute('aria-hidden','true');
  if (note.pin.shape === 'board-pin') art.style.filter='none';
  art.style.setProperty('--pin-size', `${note.pin.size}px`); art.style.setProperty('--pin-angle', `${note.pin.rotation}deg`);
  const adjust=document.createElement('button'); adjust.className='pin-adjust'; adjust.type='button'; adjust.title='Drag to resize and rotate pin'; adjust.setAttribute('aria-label','Resize and rotate push pin');
  adjust.addEventListener('keydown', event => {
    const direction=arrowDirection(event.key); if (!direction) return;
    event.preventDefault(); event.stopPropagation(); record();
    note.pin.size=Math.max(20,Math.min(100,note.pin.size+direction[1]*-2));
    note.pin.rotation+=direction[0]*5;
    art.style.setProperty('--pin-size',`${note.pin.size}px`); art.style.setProperty('--pin-angle',`${note.pin.rotation}deg`); saveSoon();
  });
  element.append(art, adjust);
  if (note.type !== 'pin') {
    const remove = actionButton('Remove decorative pin', 'close', () => { record(); delete note.pin; applyPushPin(note,element); renderStrings(); saveSoon(); });
    remove.classList.add('remove-custom-pin'); element.querySelector('.note-actions')?.append(remove);
  }
}
function buildPushPin(note,index) {
  const element=document.createElement('article'); element.className='note pin-item'; element.dataset.noteId=note.id; element.style.left=`${note.x}px`; element.style.top=`${note.y}px`; element.style.zIndex=String(100000+index);
  element.setAttribute('aria-label', `${note.pin.shape} push pin`);
  const handle=document.createElement('div'); handle.className='note-drag'; handle.tabIndex=0; handle.setAttribute('role','button'); handle.setAttribute('aria-label','Move push pin');
  const actions=document.createElement('div'); actions.className='note-actions'; actions.append(actionButton('Duplicate pin','copy',()=>duplicateNote(note)),actionButton('Delete pin','trash',()=>removeNote(note.id)));
  element.append(handle,actions); wireNoteMovement(element,note,handle); applyPushPin(note,element); noteElements.set(note.id,element); world.append(element); return element;
}
function buildNote(note, index) {
  if (note.type === 'pin') return buildPushPin(note,index);
  if (note.type === 'folder') return buildFolder(note, index);
  if (note.type === 'image') return buildPolaroid(note, index);
  const element = document.createElement('article');
  element.className = `note${note.type === 'card' ? ' index-card' : ''}`;
  element.dataset.noteId = note.id;
  element.style.left = `${note.x}px`; element.style.top = `${note.y}px`;
  element.style.zIndex = String(index + 1);
  element.style.setProperty('--tilt', `${note.tilt}deg`);
  element.style.setProperty('--note-color', colorFor(note.category));
  if (note.type === 'card') element.style.setProperty('--card-color', CARD_COLORS[note.cardColor] || CARD_COLORS.white);
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
  const resizeCorners = ['left', 'right'].map(side => {
    const resize = document.createElement('button'); resize.className = `note-resize note-resize-${side}`;
    resize.dataset.side = side;
    resize.setAttribute('aria-label', `Resize note from bottom ${side} corner. Drag or use arrow keys.`);
    resize.title = 'Drag to resize; double-click for automatic sizing';
    resize.addEventListener('dblclick', () => { record(); delete note.width; delete note.height; autosize(note, element); saveSoon(); });
    resize.addEventListener('keydown', event => {
      const direction = {ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1]}[event.key];
      if (!direction) return;
      event.preventDefault(); record();
      const step = event.shiftKey ? 1 : 10;
      const angle = note.tilt * Math.PI / 180, dx = direction[0] * step, dy = direction[1] * step;
      Object.assign(note, resizePaper({...note, width: element.offsetWidth, height: element.offsetHeight}, dx * Math.cos(angle) - dy * Math.sin(angle), dx * Math.sin(angle) + dy * Math.cos(angle), side));
      element.style.left = `${note.x}px`; element.style.top = `${note.y}px`; syncAttachedPins(new Set([note.id])); queueStrings();
      autosize(note, element); saveSoon();
    });
    return resize;
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
  element.append(title, content, actions, ...resizeCorners, resizeHeight); applyPushPin(note,element);
  noteElements.set(note.id, element);
  world.append(element);
  autosize(note, element);
  return element;
}

function renderBoard() {
  pinChoosing = false; selectedTape = null; setTapeMode(false);
  world.replaceChildren(); noteElements.clear();
  $('board-name').value = board.name;
  board.notes.forEach(buildNote);
  renderStrings(); renderTapes();
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
    try { localStorage.setItem(`${appKey}:sidebar`, open ? 'open' : 'closed'); } catch { /* UI preference is optional. */ }
  }
  requestAnimationFrame(() => {
    board.notes.forEach(note => autosize(note, noteElements.get(note.id)));
    applyView();
  });
}

function startPlacement(type, category = '', assetId = null, folderName = '') {
  pinChoosing = false;
  cancelGesture();
  setTapeMode(false);
  setSelectMode(false);
  setStringMode(false);
  handMode = false; spaceHeld = false;
  updateHandMode(); setSelected(null);
  placement = {type, category, imageId: type === 'image' ? assetId : null, folderId: type === 'folder' ? assetId : null, folderName};
  viewport.classList.add('is-placing');
  viewport.classList.toggle('is-pin-placing', type === 'pin');
  const preview = $('placement-preview'); preview.hidden = false;
  preview.classList.toggle('pin-preview', type === 'pin');
  preview.querySelector('.pin-preview-art')?.remove();
  if (type === 'pin') {
    const art = document.createElement('span'); art.className='pin-art pin-preview-art';
    setPinGlyph(art, category); if (category === 'board-pin') art.style.filter='none';
    preview.append(art);
  }
  $('placement-preview').classList.toggle('index-preview', type === 'card');
  $('placement-preview').classList.toggle('photo-preview', type === 'image');
  $('placement-preview').classList.toggle('folder-preview', type === 'folder');
  $('preview-photo').hidden = type !== 'image';
  if (type === 'image') getImageResource(assetId).then(asset => { if (placement?.imageId === assetId) $('preview-photo').src = asset.previewUrl; });
  $('placement-preview').style.setProperty('--note-color', colorFor(category));
  applyNoteStyle($('placement-preview'), board.noteStyle, type);
  $('preview-title').textContent = type === 'card' ? 'Notes' : type === 'image' ? '' : type === 'folder' ? folderName : category;
  $('preview-hint').textContent = matchMedia('(pointer:coarse)').matches ? 'Tap to pin it here' : 'Click to pin it here';
  $('placement-label').textContent = type === 'pin' ? 'Click the board or an item to place the push pin' : type === 'card' ? 'Choose a position for the index card' : type === 'image' ? 'Choose a position for the photo' : type === 'folder' ? 'Choose a position for the folder' : `Choose a position for “${category}”`;
  $('placement-bar').hidden = type === 'card';
  refreshSupplyControls();
  if (compactLayout.matches) setSidebar(false);
  renderCategories();
  const width = type === 'card' ? 344 : type === 'image' ? 286 : type === 'folder' ? 300 : 248;
  pointer = {x: Math.max(16, (viewport.clientWidth - width * board.view.zoom) / 2), y: Math.max(60, viewport.clientHeight / 2 - 100)};
  movePreview(pointer);
}

function movePreview(point) {
  const preview = $('placement-preview');
  const pin = placement?.type === 'pin', offset = pin ? 24 * board.view.zoom : 0;
  preview.style.left = `${point.x-offset}px`; preview.style.top = `${point.y-offset}px`;
  preview.style.transform = `scale(${board.view.zoom}) rotate(${pin ? 0 : -2}deg)`;
}

function cancelPlacement() {
  placement = null; viewport.classList.remove('is-placing', 'is-pin-placing');
  $('placement-preview').hidden = true; $('placement-bar').hidden = true;
  renderCategories(); refreshSupplyControls();
}

function placeNote(point, targetId = null) {
  if (!placement) return;
  record();
  const target = placement.type === 'pin' && targetId ? board.notes.find(n=>n.id===targetId && n.type !== 'pin') : null;
  if (target) {
    const el=noteElements.get(target.id), main=el.querySelector('.pin-art, .pin');
    if (main) { const rect=main.getBoundingClientRect(), bounds=viewport.getBoundingClientRect(), x=rect.left+rect.width/2-bounds.left, y=rect.top+rect.height/2-bounds.top;
      if (Math.hypot(point.x-x,point.y-y) <= 24*board.view.zoom) { target.pin={shape:placement.category,size:32,rotation:0}; applyPushPin(target,el); cancelPlacement(); setSelected(target.id); selectedMainPinId=target.id; refreshSupplyControls(); renderStrings(); saveNow(); return; }
    }
  }
  const location = screenToWorld(point, board.view);
  const note = {id: crypto.randomUUID(), style: normalizeNoteStyle(board.noteStyle), type: placement.type, category: placement.category, title: placement.type === 'card' ? 'Notes' : placement.category, text: '', x: location.x, y: location.y, tilt: (Math.random() - .5) * 2.4};
  if (placement.type === 'pin') { note.pin={shape:placement.category,size:48,rotation:0}; note.tilt=0; note.x-=60; note.y-=60; if (target) { note.parentId=target.id; note.offsetX=note.x-target.x; note.offsetY=note.y-target.y; } }
  if (placement.type === 'card') note.cardColor = $('card-color').value;
  if (placement.type === 'image') { note.imageId = placement.imageId; note.title = placement.imageName || 'Photo'; }
  if (placement.type === 'folder') { note.folderId = placement.folderId; note.title = placement.folderName; }
  board.notes.push(note);
  const element = buildNote(note, board.notes.length - 1);
  cancelPlacement(); setSelected(note.id); updateCounts(); saveNow();
  revealOnBoard(note, element); saveSoon();
  const input = element.querySelector('.note-content, .folder-open');
  if (input) { if (compactLayout.matches) input.focus({preventScroll: true}); else requestAnimationFrame(() => input.focus({preventScroll: true})); }
}

function removeNote(id) {
  removeElements(new Set([id]), new Set());
}

function removeSelection() {
  if (selected.size || selectedStrings.size || selectedTapes.size) removeElements(new Set(selected), new Set(selectedStrings), new Set(selectedTapes));
}

function removeElements(items, strings, tapes = new Set()) {
  for (const pin of board.notes) if (pin.parentId && items.has(pin.parentId)) items.add(pin.id);
  record(); board.tapes = board.tapes.filter(t => !tapes.has(t.id)); board.notes = board.notes.filter(note => !items.has(note.id));
  board.connections = board.connections.filter(link => !items.has(link.from) && !items.has(link.to) && !strings.has(link.id));
  for (const id of items) { noteElements.get(id)?.remove(); noteElements.delete(id); }
  setSelected(null);
  renderStrings(); renderTapes(); renderCategories(); updateCounts(); saveNow();
  toast(items.size + strings.size + tapes.size === 1 ? 'Item removed.' : `${items.size + strings.size + tapes.size} items removed.`, true);
}

function duplicateNote(note) {
  record();
  const copy = {...note, ...(note.pin ? {pin:{...note.pin}} : {}), id: crypto.randomUUID(), x: note.x + 28, y: note.y + 28};
  if (copy.parentId) { copy.offsetX+=28; copy.offsetY+=28; }
  board.notes.push(copy); const element = buildNote(copy, board.notes.length - 1);
  if (note.type !== 'pin') for (const child of board.notes.filter(n => n.parentId===note.id)) { const pin={...child,id:crypto.randomUUID(),parentId:copy.id,pin:{...child.pin},x:child.x+28,y:child.y+28}; board.notes.push(pin); buildNote(pin,board.notes.length-1); }
  setSelected(copy.id); updateCounts(); renderCategories(); saveNow();
  revealOnBoard(copy, element); saveSoon();
  element.querySelector('.note-content, .folder-open, .note-drag')?.focus({preventScroll: true});
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
  if (!board.notes.length && !board.tapes.length) { board.view = {x: 0, y: 0, zoom: 1}; applyView(); saveSoon(); return; }
  const rects = [...board.notes.map(n => ({x: n.x, y: n.y, w: noteElements.get(n.id).offsetWidth, h: noteElements.get(n.id).offsetHeight})), ...board.tapes.map(t => ({x:Math.min(t.x1,t.x2)-16, y:Math.min(t.y1,t.y2)-16, w:Math.abs(t.x2-t.x1)+32, h:Math.abs(t.y2-t.y1)+32}))];
  const left = Math.min(...rects.map(r => r.x)); const top = Math.min(...rects.map(r => r.y));
  const right = Math.max(...rects.map(r => r.x + r.w)); const bottom = Math.max(...rects.map(r => r.y + r.h));
  const zoom = Math.max(.25, Math.min(1, (viewport.clientWidth - 70) / (right - left), (viewport.clientHeight - 150) / (bottom - top)));
  board.view = {zoom, x: (viewport.clientWidth - (right - left) * zoom) / 2 - left * zoom, y: 38 - top * zoom + Math.max(0, (viewport.clientHeight - 150 - (bottom - top) * zoom) / 2)};
  applyView(); saveSoon();
}

viewport.addEventListener('click', event => {
  const element = event.target.closest('.note');
  const handledByPointer = element && selectionPointerId === element.dataset.noteId;
  selectionPointerId = null;
  if (!element) return;
  if (stringMode) {
    event.preventDefault(); event.stopPropagation(); chooseStringItem(element.dataset.noteId);
  } else if (selectMode || event.shiftKey) {
    event.preventDefault(); event.stopPropagation();
    // Keyboard and accessibility activation can dispatch a click without any
    // pointer events. Pointer gestures already made the selection above.
    if (!handledByPointer) {
      document.activeElement?.blur(); viewport.focus({preventScroll: true});
      const id = element.dataset.noteId;
      if (selected.has(id)) selected.delete(id); else selected.add(id);
      updateSelection();
    }
  } else if (!handledByPointer && !event.target.closest('.note-actions') && !handMode && !spaceHeld) {
    const id = element.dataset.noteId;
    if (!selected.has(id) || event.target.closest('textarea')) setSelected(id);
  }
}, true);

function clearGestureVisuals() {
  for (const element of noteElements.values()) element.classList.remove('is-dragging', 'is-resizing');
  $('selection-box').hidden = true;
  viewport.classList.remove('is-panning', 'is-box-selecting');
}

function restoreBoxSelection() {
  if (gesture?.type !== 'marquee') return;
  selected.clear(); selectedStrings.clear();
  for (const id of gesture.originalItems) selected.add(id);
  for (const id of gesture.originalStrings) selectedStrings.add(id);
  selectedTapes.clear(); for (const id of gesture.originalTapes) selectedTapes.add(id); renderTapes();
  updateSelection();
}

function cancelGesture() {
  selectionPointerId = null;
  restoreBoxSelection(); clearGestureVisuals();
  if (gesture?.moved && ['notes', 'tape-end', 'pin-transform', 'resize', 'resize-height', 'pan', 'pinch'].includes(gesture.type)) saveSoon();
  for (const id of activePointers.keys()) if (viewport.hasPointerCapture(id)) viewport.releasePointerCapture(id);
  activePointers.clear(); gesture = null;
}

viewport.addEventListener('pointerdown', event => {
  selectionPointerId = null;
  if (event.target.closest('.board-footer, .placement-bar, .sidebar-toggle, .mobile-done')) return;
  if (event.button !== 0 && event.button !== 1) return;
  if (tapeMode && event.button === 0) {
    const point = localPoint(event);
    const start = screenToWorld(point, board.view);
    gesture = {type: 'tape', pointerId: event.pointerId, start: point, worldStart: start, moved: false};
    viewport.setPointerCapture(event.pointerId); event.preventDefault(); event.stopPropagation(); return;
  }

  const noteElement = event.target.closest('.note');
  if (stringMode && noteElement) { event.preventDefault(); event.stopPropagation(); return; }
  const pan = handMode || spaceHeld || event.button === 1;
  if (event.target.closest('.connection-hit') && !pan && !placement) {
    if (event.shiftKey || selectMode) event.preventDefault();
    return;
  }
  activePointers.set(event.pointerId, localPoint(event));
  if (activePointers.size >= 2) {
    if (gesture?.type === 'pinch') { viewport.setPointerCapture(event.pointerId); return; }
    restoreBoxSelection(); clearGestureVisuals();
    if (mobileEditing) mobileEditing.input.blur();
    const [a, b] = [...activePointers.values()];
    gesture = {type: 'pinch', distance: Math.hypot(b.x - a.x, b.y - a.y), center: {x: (a.x + b.x) / 2, y: (a.y + b.y) / 2}, view: {...board.view}, moved: true};
    for (const id of activePointers.keys()) viewport.setPointerCapture(id);
    event.preventDefault(); return;
  }
  const point = localPoint(event);
  const tapeElement = event.target.closest('.tape-piece');
  const tape = tapeElement && board.tapes.find(t => t.id === tapeElement.dataset.tapeId);
  if (tape && !pan && !placement && !stringMode) {
    const end = event.target.closest('.tape-handle')?.dataset.end;
    if (!end) {
      if (event.shiftKey) { if (selectedTapes.has(tape.id)) selectedTapes.delete(tape.id); else selectedTapes.add(tape.id); }
      else { if (!selectedTapes.has(tape.id) && !selectMode) setSelected(null); selectedTapes.add(tape.id); }
      selectedTape = selectedTapes.has(tape.id) ? tape.id : null;
      setTapeMode(false, Boolean(selectedTape)); updateSelection();
    }
    document.activeElement?.blur(); viewport.focus({preventScroll:true});
    gesture = end ? {type:'tape-end', pointerId:event.pointerId, start:point, tape, end, element:tapeElement, x:tape['x'+end], y:tape['y'+end], moved:false} :
      {type:'notes', pointerId:event.pointerId, start:point, items:selectedNotes().map(note => ({note,x:note.x,y:note.y})), tapes:selectedTapePositions(), moved:false};
    viewport.setPointerCapture(event.pointerId); event.preventDefault(); event.stopPropagation(); return;
  }
  if (!placement && !pan && !stringMode && noteElement && !noteElement.classList.contains('pin-item') && event.target.closest('.pin-art, .pin')) {
    const note=board.notes.find(n=>n.id===noteElement.dataset.noteId); if (note) { setSelected(note.id); selectedMainPinId=note.id; refreshSupplyControls(); event.preventDefault(); event.stopPropagation(); return; }
  }
  const pinControl=event.target.closest('.pin-adjust');
  if (pinControl && !pan && !placement) {
    const element=pinControl.closest('.note'), note=board.notes.find(n=>n.id===element.dataset.noteId);
    if (note?.pin) { const rect=element.querySelector('.pin-art').getBoundingClientRect(), cx=rect.left+rect.width/2, cy=rect.top+rect.height/2; setSelected(note.id); gesture={type:'pin-transform', pointerId:event.pointerId, start:point, note, element, cx, cy, angle:Math.atan2(event.clientY-cy,event.clientX-cx), distance:Math.max(1,Math.hypot(event.clientX-cx,event.clientY-cy)), size:note.pin.size, rotation:note.pin.rotation, moved:false}; viewport.setPointerCapture(event.pointerId); event.preventDefault(); return; }
  }
  const controls = event.target.closest('.note-actions, .note-content, .note-title-input');
  if (placement) {
    gesture = {type: 'place', pointerId: event.pointerId, start: point, targetId:noteElement?.dataset.noteId, moved: false}; viewport.setPointerCapture(event.pointerId); if (placement.type === 'pin') event.preventDefault(); return;
  }
  const note = noteElement && board.notes.find(n => n.id === noteElement.dataset.noteId);
  if (note && !pan) selectionPointerId = note.id;
  if (note && !pan && (selectMode || event.shiftKey)) {
    document.activeElement?.blur(); viewport.focus({preventScroll: true});
    event.preventDefault(); event.stopPropagation();
    const alreadySelected = selected.has(note.id);
    if (event.shiftKey) {
      if (alreadySelected) selected.delete(note.id); else selected.add(note.id);
      updateSelection();
      gesture = {type: 'selection-click', pointerId: event.pointerId, start: point, moved: false};
    } else {
      selected.add(note.id); updateSelection();
      gesture = {type: 'notes', pointerId: event.pointerId, start: point, items: selectedNotes().map(note => ({note, x: note.x, y: note.y})), tapes: selectedTapePositions(), deselectOnClick: alreadySelected ? note.id : null, moved: false};
    }
  } else if (note && !pan) {
    if (event.target.closest('.note-actions')) return;
    if (!selected.has(note.id) || controls) setSelected(note.id);
    if (controls) { bringForward(note.id); return; }
    const resize = event.target.closest('.note-resize');
    const resizeHeight = event.target.closest('.note-resize-height');
    if (resize || resizeHeight) {
      setSelected(note.id);
      gesture = {type: resize ? 'resize' : 'resize-height', pointerId: event.pointerId, start: point, note, element: noteElement, width: noteElement.offsetWidth, height: noteElement.offsetHeight, x: note.x, y: note.y, tilt: note.tilt, side: resize?.dataset.side, moved: false};
    } else {
      if (!event.target.closest('.note-drag') && selected.size < 2) return;
      document.activeElement?.blur(); viewport.focus({preventScroll: true});
      gesture = {type: 'notes', pointerId: event.pointerId, start: point, items: selectedNotes().map(note => ({note, x: note.x, y: note.y})), tapes: selectedTapePositions(), moved: false};
    }
    event.preventDefault();
  } else if (!pan && (selectMode || event.shiftKey)) {
    document.activeElement?.blur(); viewport.focus({preventScroll: true});
    const originalItems = new Set(selected), originalStrings = new Set(selectedStrings), originalTapes = new Set(selectedTapes);
    const baseTapes = new Set(event.shiftKey ? selectedTapes : []);
    const base = new Set(event.shiftKey ? selected : []);
    if (!event.shiftKey) setSelected(null);
    gesture = {type: 'marquee', pointerId: event.pointerId, start: point, base, baseTapes, originalItems, originalStrings, originalTapes, moved: false,
      bounds: board.notes.map(note => ({...note, width: noteElements.get(note.id).offsetWidth, height: noteElements.get(note.id).offsetHeight}))};
    viewport.classList.add('is-box-selecting');
    event.preventDefault();
  } else {
    document.activeElement?.blur();
    if (!pan) setSelected(null);
    gesture = {type: 'pan', pointerId: event.pointerId, start: point, view: {...board.view}, moved: false};
    event.preventDefault();
  }
  viewport.setPointerCapture(event.pointerId);
}, true);

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
    if (gesture.type === 'notes' || gesture.type === 'tape-end' || gesture.type === 'pin-transform' || gesture.type === 'resize' || gesture.type === 'resize-height') record();
    if (gesture.type === 'notes') {
      const moved = new Set(gesture.items.map(item => item.note.id));
      board.notes = [...board.notes.filter(note => !moved.has(note.id)), ...board.notes.filter(note => moved.has(note.id))];
      board.notes.forEach((note, i) => { noteElements.get(note.id).style.zIndex = String(note.type === 'pin' ? 100000+i : i + 1); });
    }
  }
  if (gesture.type === 'tape') {
    renderTapes({id:'preview', color:$('tape-color').value, text:'', x1:gesture.worldStart.x, y1:gesture.worldStart.y, x2:screenToWorld(point, board.view).x, y2:screenToWorld(point, board.view).y}); return;
  }
  if (gesture.type === 'place') { movePreview(point); return; }
  if (gesture.type === 'marquee') {
    const bounds = selectionBounds(gesture.start, point), box = $('selection-box');
    box.hidden = false; box.style.left = `${bounds.left}px`; box.style.top = `${bounds.top}px`;
    box.style.width = `${bounds.right - bounds.left}px`; box.style.height = `${bounds.bottom - bounds.top}px`;
    const hits = notesInSelection(gesture.bounds, selectionBounds(screenToWorld(gesture.start, board.view), screenToWorld(point, board.view)));
    selected.clear();
    for (const id of [...gesture.base, ...hits]) selected.add(id);
    selectedTapes.clear(); for (const id of [...gesture.baseTapes, ...tapesInSelection(board.tapes, selectionBounds(screenToWorld(gesture.start, board.view), screenToWorld(point, board.view)))]) selectedTapes.add(id); renderTapes();
    updateSelection();
  } else if (gesture.type === 'pan') {
    board.view.x = gesture.view.x + dx; board.view.y = gesture.view.y + dy;
    viewport.classList.add('is-panning'); applyView();
  } else if (gesture.type === 'notes') {
    const movingIds = new Set(gesture.items.map(item=>item.note.id));
    for (const item of gesture.items) {
      item.note.x = item.x + dx / board.view.zoom; item.note.y = item.y + dy / board.view.zoom;
      const element = noteElements.get(item.note.id);
      element.style.left = `${item.note.x}px`; element.style.top = `${item.note.y}px`; element.classList.add('is-dragging');
      if (item.note.parentId && !movingIds.has(item.note.parentId)) { const parent=board.notes.find(n=>n.id===item.note.parentId); if(parent) { item.note.offsetX=item.note.x-parent.x; item.note.offsetY=item.note.y-parent.y; } }
    }
    syncAttachedPins(movingIds);
    for (const item of gesture.tapes || []) { item.tape.x1=item.x1+dx/board.view.zoom; item.tape.y1=item.y1+dy/board.view.zoom; item.tape.x2=item.x2+dx/board.view.zoom; item.tape.y2=item.y2+dy/board.view.zoom; }
    if (gesture.tapes?.length) renderTapes();
    queueStrings();
  } else if (gesture.type === 'pin-transform') {
    const a=Math.atan2(event.clientY-gesture.cy,event.clientX-gesture.cx), d=Math.hypot(event.clientX-gesture.cx,event.clientY-gesture.cy);
    gesture.note.pin.size=Math.max(20,Math.min(100,gesture.size*d/gesture.distance)); gesture.note.pin.rotation=gesture.rotation+(a-gesture.angle)*180/Math.PI;
    $('pin-size').value=Math.round(gesture.note.pin.size);
    const art=gesture.element.querySelector('.pin-art'); art.style.setProperty('--pin-size',`${gesture.note.pin.size}px`); art.style.setProperty('--pin-angle',`${gesture.note.pin.rotation}deg`);
  } else if (gesture.type === 'tape-end') {
    gesture.tape['x'+gesture.end] = gesture.x + dx/board.view.zoom; gesture.tape['y'+gesture.end] = gesture.y + dy/board.view.zoom; updateTapeGeometry(gesture.element, gesture.tape);
  } else if (gesture.type === 'resize' || gesture.type === 'resize-height') {
    if (gesture.type === 'resize') {
      Object.assign(gesture.note, resizePaper(gesture, dx / board.view.zoom, dy / board.view.zoom, gesture.side));
      gesture.element.style.left = `${gesture.note.x}px`; gesture.element.style.top = `${gesture.note.y}px`; syncAttachedPins(new Set([gesture.note.id]));
    } else gesture.note.height = Math.max(120, Math.min(2000, gesture.height + dy / board.view.zoom));
    gesture.element.classList.add('is-resizing'); autosize(gesture.note, gesture.element);
  }
});

function endGesture(event) {
  setTimeout(() => { selectionPointerId = null; }, 0);
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
  if (gesture.type === 'marquee' && event.type === 'pointercancel') restoreBoxSelection();
  if (gesture.type === 'notes' && !gesture.moved && gesture.deselectOnClick && event.type === 'pointerup') {
    selected.delete(gesture.deselectOnClick); updateSelection();
  }
  const changed = gesture.moved && ['notes', 'tape-end', 'pin-transform', 'resize', 'resize-height', 'pan', 'pinch'].includes(gesture.type);
  if (gesture.type === 'tape') {
    const end = screenToWorld(localPoint(event), board.view), start = gesture.worldStart;
    if (event.type === 'pointerup' && Math.hypot(end.x-start.x, end.y-start.y) >= 20) {
      record(); const tape = {id:crypto.randomUUID(), color:$('tape-color').value, text:'', x1:start.x, y1:start.y, x2:end.x, y2:end.y};
      board.tapes.push(tape); setSelected(null); selectedTapes.add(tape.id); selectedTape = tape.id; setTapeMode(false, true); updateCounts(); saveNow();
    } else renderTapes();
  }
  if (gesture.type === 'place' && event.type === 'pointerup') placeNote(localPoint(event), gesture.targetId);
  clearGestureVisuals();
  gesture = null;
  if (viewport.hasPointerCapture(event.pointerId)) viewport.releasePointerCapture(event.pointerId);
  if (changed) saveSoon();
}
window.addEventListener('pointerup', endGesture);
window.addEventListener('pointercancel', endGesture);
viewport.addEventListener('pointerleave', () => { if (placement && !gesture) $('placement-preview').hidden = true; });
viewport.addEventListener('pointerenter', () => { if (placement) $('placement-preview').hidden = false; });
viewport.addEventListener('wheel', event => {
  // Leave note text and floating controls alone; the cork itself always zooms.
  if (event.target.closest('.note-content, .note-title-input, .board-footer, .placement-bar, .sidebar-toggle, .mobile-done')) return;
  event.preventDefault();
  if (gesture) return;
  const unit = event.deltaMode === 1 ? 18 : event.deltaMode === 2 ? viewport.clientHeight : 1;
  // Clamp unusually large wheel ticks without losing high-resolution trackpad input.
  const delta = Math.max(-200, Math.min(200, event.deltaY * unit));
  changeZoom(Math.exp(-delta * .0009), localPoint(event));
}, {passive: false});

$('category-search').addEventListener('input', renderCategories);
$('load-categories').addEventListener('click', chooseCategories);
$('edit-categories').addEventListener('click', editCategories);
$('connect-category-drive').addEventListener('click', openDriveDialog);
$('categories-text').addEventListener('input', () => { clearTimeout(categoryEditTimer); categoryEditTimer = setTimeout(flushCategoryEdits, 250); });
$('categories-text').addEventListener('keydown', event => { if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 's') { event.preventDefault(); event.stopPropagation(); flushCategoryEdits(); } });
for (const id of ['categories-close', 'categories-done']) $(id).addEventListener('click', () => { if (flushCategoryEdits()) $('categories-dialog').close(); });
$('categories-dialog').addEventListener('cancel', event => { if (!flushCategoryEdits()) event.preventDefault(); });
$('category-use-drive').addEventListener('click', () => { if (flushCategoryEdits()) syncAccountCategories('remote'); });
$('category-keep-mine').addEventListener('click', () => { if (flushCategoryEdits()) syncAccountCategories('local'); });
$('drive-category-edit').addEventListener('click', () => { $('drive-dialog').close(); editCategories(); });
$('refresh-categories').addEventListener('click', () => refreshCategories());
$('categories-file').addEventListener('change', async event => {
  const file = event.target.files[0]; event.target.value = '';
  const target = categoryPickSession; categoryPickSession = null;
  if (!file || target !== categoriesKey) return;
  const revision = ++categoryRevision;
  categoryBusy = true; renderCategorySource();
  try { await useCategoryFile(file, null, revision); }
  catch (error) { if (revision === categoryRevision) toast(error.message || 'Could not open the categories file.'); }
  finally {
    if (revision === categoryRevision) {
      categoryBusy = false; renderCategorySource(); queueCategorySync();
      if (!categoriesReady) loadCategories();
    }
  }
});
$('default-categories').addEventListener('click', () => {
  categoryHandle = null;
  putCategoryHandle(categoriesKey, null).catch(() => {});
  loadDefaultCategories(true);
});
$('download-categories').addEventListener('click', () => {
  const url = URL.createObjectURL(new Blob([categoryText], {type: 'text/plain;charset=utf-8'}));
  const link = document.createElement('a');
  link.href = url; link.download = categoryFile?.name || 'categories.txt';
  document.body.append(link); link.click(); link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10000);
});
$('random-note').addEventListener('click', randomCategory);
for (const [shape, glyph] of Object.entries(PIN_SHAPES)) {
  if (shape === 'classic') continue; // Keep older boards readable without offering the slanted pin.
  const button=document.createElement('button'); button.type='button'; button.dataset.shape=shape; setPinGlyph(button,shape); const label = shape === 'check' ? 'green check mark' : shape === 'cross' ? 'red X' : shape === 'film' ? 'film reel' : shape === 'chat' ? 'chat bubble' : shape === 'tv' ? 'TV' : shape === 'board-pin' ? 'board' : shape === 'arrow' ? 'red arrow' : shape.startsWith('arrow-') ? `${shape.slice(6)} arrow` : shape; button.title=`${label} push pin`; button.setAttribute('aria-label',`${label} push pin`);
  button.addEventListener('click',()=> {
    const selectedPin = board.notes.find(note => selected.has(note.id) && (note.pin || selectedMainPinId === note.id));
    if (!pinChoosing && selected.size === 1 && selectedPin) { record(); selectedPin.pin ||= {shape:'board-pin',size:48,rotation:0}; selectedPin.pin.shape=shape; applyPushPin(selectedPin,noteElements.get(selectedPin.id)); renderStrings(); refreshSupplyControls(); saveSoon(); }
    else { pinChoosing=false; startPlacement('pin',shape); }
  }); $('pin-options').append(button);
}
$('pin-size').addEventListener('focus', record);
$('pin-size').addEventListener('input', () => { const note=board.notes.find(n=>selected.has(n.id) && (n.pin || selectedMainPinId===n.id)); const size=Number($('pin-size').value); if (!note || !Number.isFinite(size) || size<20 || size>100) return; if (!note.pin) { note.pin={shape:'board-pin',size,rotation:0}; applyPushPin(note,noteElements.get(note.id)); renderStrings(); } else { note.pin.size=size; noteElements.get(note.id)?.querySelector('.pin-art')?.style.setProperty('--pin-size',`${size}px`); } saveSoon(); });
$('add-pin').addEventListener('click', () => { const open=!pinChoosing; cancelGesture(); cancelPlacement(); setStringMode(false); setTapeMode(false); setSelectMode(false); setSelected(null); pinChoosing=open; refreshSupplyControls(); if (compactLayout.matches) setSidebar(false); });
$('supply-controls-done').addEventListener('click', () => { pinChoosing=false; if (placement?.type === 'card') cancelPlacement(); if (stringMode) setStringMode(false); setSelected(null); refreshSupplyControls(); });
$('card-color').addEventListener('change', () => { const cards=selectedNotes().filter(n=>n.type==='card'); if (!cards.length) return; record(); for (const n of cards) {n.cardColor=$('card-color').value; noteElements.get(n.id).style.setProperty('--card-color', CARD_COLORS[n.cardColor]);} saveSoon(); });
$('string-color').addEventListener('change', () => { const links=board.connections.filter(c=>selectedStrings.has(c.id)); if (!links.length) return; record(); for (const c of links) c.color=$('string-color').value; renderStrings(); saveSoon(); });
$('add-card').addEventListener('click', () => startPlacement('card'));
$('add-image').addEventListener('click', () => { imagePickSession = activeSession; $('image-file').click(); });
if (typeof window.showDirectoryPicker !== 'function') $('add-folder').title = 'Choose a folder. This browser asks you to select it again when opening a folder tile.';
$('add-folder').addEventListener('click', async () => {
  if (typeof window.showDirectoryPicker !== 'function') return pickFolderFallback();
  const target = activeSession;
  try {
    const handle = await window.showDirectoryPicker({id: 'cork-folder', mode: 'read'});
    const id = crypto.randomUUID(); await putFolder(id, handle); folderHandles.set(id, Promise.resolve(handle));
    if (target === activeSession) startPlacement('folder', '', id, handle.name);
  } catch (error) { if (error.name !== 'AbortError') toast(error.message || 'Could not select this folder.'); }
});
$('folder-file').addEventListener('change', event => {
  const input = event.target;
  const name = directoryNameFromFiles(input.files);
  const target = folderPickTarget; folderPickTarget = null;
  // Use only the root folder's name; do not read or retain any selected files.
  input.value = '';
  if (folderPickSession !== activeSession) return;
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
  pinChoosing=false; setTapeMode(false);
  const active = !stringMode; cancelPlacement(); handMode = false; spaceHeld = false; updateHandMode(); setStringMode(active);
  if (compactLayout.matches) setSidebar(false);
});
$('image-file').addEventListener('change', async event => {
  const file = event.target.files[0]; event.target.value = '';
  const target = imagePickSession; imagePickSession = null;
  if (!file || target !== activeSession) return;
  $('add-image').disabled = true;
  try {
    const asset = await prepareImage(file);
    await putImage(asset);
    await getImageResource(asset.id);
    if (target !== activeSession) return;
    startPlacement('image', '', asset.id);
    placement.imageName = asset.name;
  } catch (error) { toast(error.message || 'Could not add this image.'); }
  finally { $('add-image').disabled = false; }
});
$('cancel-placement').addEventListener('click', cancelPlacement);
$('retry-categories').addEventListener('click', loadDefaultCategories);
$('shuffle-colors').addEventListener('click', () => {
  if (categories.length < 2) { toast('Add at least two categories to shuffle their colors.'); return; }
  const old = board.colorOrder?.length ? board.colorOrder : categories;
  const order = [...categories], numbers = new Uint32Array(order.length); crypto.getRandomValues(numbers);
  for (let i=order.length-1; i>0; i--) { const j=Math.floor(numbers[i]/4294967296*(i+1)); [order[i],order[j]]=[order[j],order[i]]; }
  if (order.every((value,i)=>value===old[i])) order.push(order.shift());
  record(); board.colorOrder=order; renderCategories(); renderPalette(); updateNoteColors(); saveNow();
});
$('reset-color-order').addEventListener('click', () => { record(); delete board.colorOrder; renderCategories(); renderPalette(); updateNoteColors(); saveNow(); });
$('palette').addEventListener('change', () => { record(); board.palette = $('palette').value; renderCategories(); renderPalette(); updateNoteColors(); saveNow(); });
$('theme').addEventListener('change', () => { record(); board.theme = $('theme').value; renderPalette(); applyView(); saveNow(); });
$('text-target').addEventListener('change', () => { textTarget = $('text-target').value; renderTextControls(); });
for (const control of document.querySelectorAll('[data-text-part]')) {
  let recorded = false;
  control.addEventListener('focus', () => { recorded = false; });
  const apply = () => {
    if (changeTextStyle(control.dataset.textPart, control.dataset.textField, control.value, !recorded)) recorded = true;
  };
  control.addEventListener('change', apply);
  if (control.type === 'number') {
    control.addEventListener('input', () => { if (control.value !== '') apply(); });
    control.addEventListener('blur', renderTextControls);
  }
}
$('reset-text-style').addEventListener('click', () => {
  record();
  if (textTarget === 'new') delete board.noteStyle;
  else for (const note of selectedNotes()) { delete note.style; applyNoteStyle(noteElements.get(note.id), null, note.type); autosize(note, noteElements.get(note.id)); }
  renderTextControls(); queueStrings(); saveNow();
});
$('edit-text').addEventListener('click', () => {
  textTarget = 'selected'; setSidebar(true); $('appearance-settings').open = false; $('text-settings').open = true; renderTextControls();
});
for (const id of ['text-settings', 'appearance-settings']) {
  $(`${id}-toggle`).addEventListener('click', () => toggleSidebarSettings(id));
  $(id).addEventListener('toggle', () => $(`${id}-toggle`).setAttribute('aria-expanded', String($(id).open)));
}
$('ui-theme').addEventListener('change', () => {
  uiThemePreference = $('ui-theme').value; applyInterfaceTheme();
  try { localStorage.setItem(`${appKey}:ui-theme`, uiThemePreference); } catch { /* The choice still applies for this visit. */ }
});
systemAppearance.addEventListener('change', () => { if (uiThemePreference === 'system') applyInterfaceTheme(); });

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
$('pan-mode').addEventListener('click', () => { pinChoosing=false; setTapeMode(false); cancelGesture(); cancelPlacement(); setStringMode(false); setSelectMode(false); handMode = !handMode; updateHandMode(); });
$('select-mode').addEventListener('click', () => { setTapeMode(false); cancelGesture(); setSelectMode(!selectMode); });
$('delete-selection').addEventListener('click', removeSelection);
$('clear-selection').addEventListener('click', () => setSelected(null));
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
  if (pdfExporting || openingBoard || (!board.notes.length && !board.tapes.length)) return;
  pdfExporting = true; updateBoardFiles();
  $('export-pdf').disabled = true;
  $('export-pdf').setAttribute('aria-busy', 'true');
  toast('Preparing PDF…');
  try {
    const {snapshotNotes, createBoardPdf} = await import('./export-pdf.js');
    await Promise.all(board.notes.filter(note => note.type === 'image').map(note => getImageResource(note.imageId)));
    await Promise.all([...world.querySelectorAll('.note-image')].map(image => image.decode()));
    const name = board.name;
    const notes = snapshotNotes(board.notes, noteElements);
    const bytes = await createBoardPdf(name, notes, structuredClone(board.connections), structuredClone(board.tapes), (done, total) => {
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
    pdfExporting = false; updateBoardFiles();
    $('export-pdf').removeAttribute('aria-busy');
    updateCounts();
  }
});
function downloadBlob(blob, name) {
  const url = URL.createObjectURL(blob), link = document.createElement('a');
  link.href = url; link.download = name;
  document.body.append(link); link.click(); link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10000);
}

async function boardBlob(snapshot) {
  const images = await exportImages(snapshot.notes);
  return new Blob([JSON.stringify({...snapshot, images, exportedAt: new Date().toISOString()}, null, 2)], {type: 'application/json'});
}

let emailFiles = null, emailPreparation = 0;
function updateEmailActions() {
  const files = emailFiles ? [emailFiles.board, ...($('email-categories').checked && emailFiles.categories ? [emailFiles.categories] : [])] : [];
  let canShare = false;
  try { canShare = Boolean(files.length && navigator.share && navigator.canShare?.({files})); } catch { /* Offer downloads when the browser cannot share these files. */ }
  $('email-share-option').hidden = !canShare; $('email-fallback').hidden = canShare;
  $('email-share').disabled = !files.length; $('email-download').disabled = !files.length; $('email-open').disabled = !files.length;
}
$('email-board').addEventListener('click', async () => {
  const revision = ++emailPreparation; emailFiles = null;
  $('email-categories').checked = false;
  $('email-categories').disabled = !categoriesReady || categoryLoadFailed || !flushCategoryEdits();
  $('email-status').textContent = 'Preparing your board…'; updateEmailActions(); $('email-dialog').showModal();
  try {
    const snapshot=validateBoard(JSON.parse(JSON.stringify(board)));
    const categorySnapshot=categoryText;
    const blob=await boardBlob(snapshot);
    if (revision !== emailPreparation || !$('email-dialog').open) return;
    const name=snapshot.name.replace(/[^a-z0-9 _-]/gi,'').trim() || 'cork-board';
    emailFiles={board:new File([blob],`${name}.json`,{type:'application/json'}), categories:new File([categorySnapshot],'categories.txt',{type:'text/plain'}), title:snapshot.name};
    $('email-status').textContent='Your board file is ready.'; updateEmailActions();
  } catch (error) { if (revision === emailPreparation) $('email-status').textContent=`Could not prepare the board: ${error.message}`; }
});
$('email-categories').addEventListener('change', updateEmailActions);
$('email-dialog').addEventListener('close', () => { emailPreparation++; emailFiles=null; });
$('email-cancel').addEventListener('click', () => $('email-dialog').close());
$('email-share').addEventListener('click', async () => {
  if (!emailFiles) return;
  const files=[emailFiles.board, ...($('email-categories').checked ? [emailFiles.categories] : [])];
  try { await navigator.share({files, title:emailFiles.title}); $('email-dialog').close(); }
  catch (error) { if (error.name !== 'AbortError') { $('email-status').textContent='Could not open the share sheet. You can download the files and attach them to an email.'; $('email-share-option').hidden=true; $('email-fallback').hidden=false; } }
});
$('email-download').addEventListener('click', () => {
  if (!emailFiles) return;
  downloadBlob(emailFiles.board,emailFiles.board.name);
  if ($('email-categories').checked) downloadBlob(emailFiles.categories,emailFiles.categories.name);
  $('email-status').textContent='Downloaded. Attach the file'+($('email-categories').checked ? 's' : '')+' to your email.';
});
$('email-open').addEventListener('click', () => {
  if (!emailFiles) return;
  const subject=encodeURIComponent(`Cork board: ${emailFiles.title}`);
  const names=[emailFiles.board.name, ...($('email-categories').checked ? [emailFiles.categories.name] : [])];
  const body=encodeURIComponent(`Please see the attached Cork board.\n\nAttach: ${names.join(', ')}`);
  window.location.href=`mailto:?subject=${subject}&body=${body}`;
});

async function matchingBoard(handle, exceptId = null) {
  for (const entry of workspace.boards) {
    if (entry.id === exceptId || !entry.file) continue;
    const session = getSession(entry.id);
    await restoreBoardHandle(session);
    try { if (session.handle && await handle.isSameEntry(session.handle)) return entry; }
    catch { /* A removed or inaccessible file does not match. */ }
  }
  return null;
}

async function openBoardFile(file, handle = null) {
  if (workspaceBlocked) return toast('Reload Cork before changing board tabs. The saved tabs have been left untouched.');
  if (handle) {
    const existing = await matchingBoard(handle);
    if (existing) { switchBoard(existing.id); return toast('Using the remembered board tab.'); }
  }
  const loaded = await readBoardFile(file);
  const assets = await importImages(loaded.data, loaded.board);
  for (const asset of assets) await putImage(asset);
  const id = crypto.randomUUID(), keys = boardKeys(appKey, id);
  const entry = {id, name: loaded.board.name, open: true, file: {
    name: file.name, token: crypto.randomUUID(), stamp: boardStamp(loaded.board), modified: file.lastModified, size: file.size,
  }};
  localStorage.setItem(keys.board, JSON.stringify(loaded.board));
  const session = {id, board: loaded.board, undo: [], redo: [], blocked: false, handle, handleReady: true};
  sessions.set(id, session); workspace.boards.push(entry);
  switchBoard(id); saveNow();
  if (handle) {
    try { await putCategoryHandle(keys.file, {token: entry.file.token, handle}); }
    catch { toast('Board opened. The file link could not be remembered; use Save as next time.'); }
  }
}

async function chooseBoardFiles() {
  closeMenu();
  if (openingBoard || workspaceBlocked || pdfExporting) return;
  if (typeof window.showOpenFilePicker !== 'function') return $('import-file').click();
  openingBoard = true; updateBoardFiles();
  try {
    const handles = await window.showOpenFilePicker({id: 'cork-boards', multiple: true, types: [{description: 'Cork board', accept: {'application/json': ['.json']}}]});
    for (const handle of handles) await openBoardFile(await handle.getFile(), handle);
  } catch (error) { if (error.name !== 'AbortError') toast(error.message || 'Could not open this board file.'); }
  finally { openingBoard = false; updateBoardFiles(); }
}

async function saveBoardFile(saveAs = false) {
  const session = activeSession, entry = entryFor(session);
  if (!saveAs && entry.file?.kind === 'drive') return saveDriveBoard();
  if (fileTasks.has(session.id) || !session.handleReady) return;
  session.board = board;
  const snapshot = validateBoard(JSON.parse(JSON.stringify(board)));
  const filename = entry.file?.name || `${snapshot.name.replace(/[^a-z0-9 _-]/gi, '').trim() || 'cork-board'}.json`;
  const previous = entry.file;
  let handle = saveAs ? null : session.handle;
  fileTasks.add(session.id); closeMenu(); updateBoardFiles();
  try {
    // Pick/request access before preparing images, while the click is still active.
    if (!handle && typeof window.showSaveFilePicker === 'function') {
      handle = await window.showSaveFilePicker({id: 'cork-boards', suggestedName: filename, types: [{description: 'Cork board', accept: {'application/json': ['.json']}}]});
    } else if (handle && await handle.requestPermission({mode: 'readwrite'}) !== 'granted') {
      throw new Error('File access was not granted. Your board is still saved in this browser.');
    }
    if (handle) {
      const other = await matchingBoard(handle, session.id);
      if (other) throw new Error('That file belongs to another board tab. Choose a different file with Save as.');
    }
    const blob = await boardBlob(snapshot);
    let saved;
    if (handle) {
      const same = session.handle && await handle.isSameEntry(session.handle);
      saved = await writeBoardFile(handle, blob, same ? previous : null);
    } else {
      downloadBlob(blob, filename);
      saved = {name: filename, modified: 0, size: blob.size};
    }
    entry.file = {...saved, token: crypto.randomUUID(), stamp: boardStamp(snapshot)};
    session.handle = handle;
    rememberWorkspace();
    try { await putCategoryHandle(boardKeys(appKey, session.id).file, handle ? {token: entry.file.token, handle} : null); }
    catch { if (handle) toast('File saved. The link could not be remembered; use Save as next time.'); }
    if (session === activeSession) { saveNow(); toast(handle ? `Saved ${saved.name}.` : 'Board downloaded. This browser saves changes as a new download.'); }
    return true;
  } catch (error) {
    if (error.name !== 'AbortError') toast(error.message || 'Could not save the board file.');
    return false;
  } finally { fileTasks.delete(session.id); updateBoardFiles(); }
}

function updateDriveControls() {
  const connected = drive.connected, linked = entryFor()?.file?.kind === 'drive';
  const blocked = driveBusy || openingBoard || workspaceBlocked || savingBlocked || pdfExporting || fileTasks.has(activeSession.id);
  $('drive-status').textContent = driveMessage || driveAutoErrors.get(activeSession.id)?.message || (!drive.configured
    ? 'Google Drive has not been enabled for this site yet. Your boards are still saved in this browser.'
    : connected ? `Connected as ${drive.user.displayName || drive.user.emailAddress || 'your Google account'}.`
    : drive.remembered ? `Reconnect${drive.loginHint ? ` as ${drive.loginHint}` : ' Google Drive'} to resume saving your boards and categories.`
    : 'Connect to open or save Cork boards in your Google Drive.');
  $('drive-connect').hidden = connected || !drive.configured;
  $('drive-connect').disabled = !driveReady || driveBusy;
  $('drive-connect').textContent = drive.remembered ? 'Reconnect Google Drive' : 'Connect Google Drive';
  $('drive-reconnect').hidden = connected || !drive.configured || !(drive.remembered || linked || categoryAccount);
  $('drive-reconnect').disabled = !driveReady || driveBusy;
  $('drive-reconnect').textContent = driveBusy ? 'Connecting…' : 'Reconnect Drive';
  $('drive-reconnect').title = 'Reconnect Google Drive and resume saving' + (drive.loginHint ? ` as ${drive.loginHint}` : '');
  $('drive-disconnect').hidden = !drive.remembered;
  $('drive-disconnect').disabled = driveBusy;
  $('drive-setup').hidden = drive.configured;
  $('drive-save').hidden = !drive.configured;
  $('drive-save').disabled = !connected || blocked;
  $('drive-save').textContent = linked ? 'Save now' : 'Save this board to Drive';
  $('drive-save-copy').hidden = !linked || !drive.configured;
  $('drive-save-copy').disabled = !connected || blocked;
  $('drive-files-section').hidden = !connected;
  $('drive-refresh').disabled = blocked;
  $('drive-pick').hidden = !drive.pickerConfigured;
  $('drive-pick').disabled = !connected || blocked;
  for (const button of $('drive-files').querySelectorAll('button')) button.disabled = blocked;
  if (!connected) { driveListRevision++; $('drive-files').replaceChildren(); }
}

async function openDriveDialog() {
  document.activeElement?.blur(); saveNow(); closeMenu(); closeAllBoards();
  driveMessage = ''; updateDriveControls();
  if (!$('drive-dialog').open) $('drive-dialog').showModal();
  if (!drive.configured) return;
  try {
    await drive.ready(); driveReady = true; updateDriveControls();
    if (drive.connected && !driveBusy) await refreshDriveBoards();
  } catch (error) { driveMessage = error.message; updateDriveControls(); }
}

async function restoreDriveConnection() {
  if (driveBusy || drive.connected) return;
  driveBusy = true;
  try {
    if (drive.remembered || categoryAccount || workspace.boards.some(entry => entry.file?.kind === 'drive')) {
      // Prepare only; Google authorization still starts directly from a click.
      await drive.ready(); driveReady = true;
    }
    const user = await drive.restore();
    if (user) { driveReady = true; await connectCategoryAccount(user); }
  } catch (error) { driveMessage = error.message; }
  finally { driveBusy = false; updateBoardFiles(); renderCategorySource(); showSavedStatus(); }
  if (drive.connected) resumeDriveAutosaves();
}

async function refreshDriveBoards(pageToken = '') {
  if (!drive.connected || driveBusy) return;
  const revision = ++driveListRevision;
  driveBusy = true; updateDriveControls();
  if (!pageToken) $('drive-files').replaceChildren();
  try {
    const result = await drive.listBoards(pageToken);
    if (revision !== driveListRevision || !drive.connected) return;
    $('drive-files').querySelector('.drive-more')?.remove();
    for (const file of result.files || []) {
      const button = document.createElement('button'); button.className = 'drive-file';
      const label = document.createElement('span'); label.textContent = file.name;
      const date = document.createElement('small'); date.textContent = new Date(file.modifiedTime).toLocaleDateString();
      button.append(icon('card'), label, date); button.addEventListener('click', () => openDriveBoard(file.id));
      $('drive-files').append(button);
    }
    if (!$('drive-files').childElementCount) {
      const empty = document.createElement('p'); empty.textContent = 'No Cork boards in this Drive yet. Save this board to add one.';
      $('drive-files').append(empty);
    }
    if (result.nextPageToken) {
      const more = document.createElement('button'); more.className = 'drive-more'; more.textContent = 'Load more boards';
      more.addEventListener('click', () => refreshDriveBoards(result.nextPageToken)); $('drive-files').append(more);
    }
  } catch (error) { driveMessage = error.message; }
  finally { driveBusy = false; updateDriveControls(); }
}

async function openDriveBoard(fileId) {
  if (driveBusy || openingBoard || workspaceBlocked || pdfExporting) return;
  const existing = workspace.boards.find(entry => entry.file?.kind === 'drive' && entry.file.id === fileId && entry.file.accountId === drive.user?.permissionId);
  const previousSession = existing ? getSession(existing.id) : null;
  if (previousSession && (previousSession.blocked || fileChanged(previousSession))) {
    $('drive-dialog').close(); switchBoard(existing.id);
    return toast('This board is already open with browser changes. Save a Drive copy to keep them before reopening the latest file.');
  }
  const previousStamp = previousSession && boardStamp(previousSession === activeSession ? board : previousSession.board);
  openingBoard = true; driveBusy = true; driveMessage = 'Opening board…'; updateBoardFiles();
  try {
    const remote = await drive.openBoard(fileId), loaded = await readBoardFile(remote.file);
    const assets = await importImages(loaded.data, loaded.board);
    for (const asset of assets) await putImage(asset);
    if (workspaceBlocked || (previousSession && (!entryFor(previousSession) || previousSession.blocked || previousStamp !== boardStamp(previousSession === activeSession ? board : previousSession.board)))) throw new Error('The browser board changed while opening. Its changes have been kept; try again.');
    const id = existing?.id || crypto.randomUUID(), keys = boardKeys(appKey, id);
    const file = {...remote.record, token: crypto.randomUUID(), stamp: boardStamp(loaded.board)};
    localStorage.setItem(keys.board, JSON.stringify(loaded.board));
    const session = previousSession || {id, handleReady: true};
    Object.assign(session, {board: loaded.board, undo: [], redo: [], blocked: false, handle: null, handleReady: true});
    sessions.set(id, session);
    if (existing) Object.assign(existing, {name: loaded.board.name, file});
    else workspace.boards.push({id, name: loaded.board.name, open: true, file});
    if (session === activeSession) {
      cancelGesture(); cancelPlacement(); setStringMode(false); setSelectMode(false);
      board = session.board; undoStack = session.undo; redoStack = session.redo;
      selected.clear(); selectedStrings.clear(); renderBoard(); updateHistory(); renderBoardTabs(); saveNow();
    } else { switchBoard(id); saveNow(); }
    $('drive-dialog').close(); driveMessage = ''; toast(`Opened ${file.name} from Drive.`);
  } catch (error) { driveMessage = error.message; toast(error.message); }
  finally { openingBoard = false; driveBusy = false; updateBoardFiles(); }
}

async function saveDriveBoard(saveCopy = false, {session = activeSession, automatic = false} = {}) {
  const entry = session && entryFor(session);
  if (!entry || driveBusy || fileTasks.has(session.id) || workspaceBlocked || session.blocked || (session === activeSession && savingBlocked) || pdfExporting) return false;
  if (!automatic) { if (session === activeSession) { document.activeElement?.blur(); saveNow(); } closeMenu(); }
  if (!drive.connected) {
    if (automatic) return false;
    await openDriveDialog();
    driveMessage = 'Connect Google Drive, then save the board. Your browser changes have been kept.';
    updateDriveControls(); return false;
  }
  const snapshot = validateBoard(JSON.parse(JSON.stringify(session === activeSession ? board : session.board)));
  const previous = !saveCopy && entry.file?.kind === 'drive' ? entry.file : null;
  if (automatic && (!previous || !fileChanged(session))) return true;
  const baseName = snapshot.name.replace(/[^a-z0-9 _-]/gi, '').trim() || 'cork-board';
  const name = `${baseName}${saveCopy ? ' copy' : ''}.json`;
  let saved = false;
  driveAutoErrors.delete(session.id); driveAutosave.remove(session.id);
  fileTasks.add(session.id); driveBusy = true; driveMessage = 'Saving board to Drive…'; updateBoardFiles();
  if (session === activeSession) showSavedStatus();
  try {
    const contents = await boardBlob(snapshot);
    const record = await drive.saveBoard(contents, name, previous);
    entry.file = {...record, token: crypto.randomUUID(), stamp: boardStamp(snapshot)};
    session.handle = null;
    rememberWorkspace();
    try { await putCategoryHandle(boardKeys(appKey, session.id).file, null); } catch { /* Workspace already identifies Drive as the destination. */ }
    if (session === activeSession) saveNow();
    saved = true; driveMessage = `Saved ${record.name} to Drive.`;
    if (!automatic) toast(driveMessage);
  } catch (error) {
    const problem = error instanceof DriveConflictError ? new DriveConflictError('This board changed in Drive. Save a Drive copy to keep both versions.') : error;
    driveAutoErrors.set(session.id, problem); driveMessage = problem.message;
    if (!automatic) toast(problem.message);
    if (!automatic && error instanceof DriveAuthError && !$('drive-dialog').open) {
      await openDriveDialog(); driveMessage = error.message;
    }
  } finally {
    fileTasks.delete(session.id); driveBusy = false; updateBoardFiles();
    if (session === activeSession) showSavedStatus();
    if (saved && !automatic && $('drive-dialog').open) await refreshDriveBoards();
  }
  return saved;
}

$('google-drive').addEventListener('click', openDriveDialog);
$('drive-close').addEventListener('click', () => $('drive-dialog').close());
async function connectDrive() {
  if (driveBusy) return;
  if (!driveReady) { await openDriveDialog(); return; }
  driveMessage = ''; driveBusy = true; updateDriveControls();
  try { await drive.authorize(); await connectCategoryAccount(drive.user); }
  catch (error) { driveMessage = error.message; }
  finally { driveBusy = false; updateDriveControls(); }
  if (drive.connected) { resumeDriveAutosaves(); if ($('drive-dialog').open) await refreshDriveBoards(); }
  else if (!$('drive-dialog').open) { updateDriveControls(); $('drive-dialog').showModal(); }
}
$('drive-connect').addEventListener('click', connectDrive);
$('drive-reconnect').addEventListener('click', connectDrive);
$('drive-disconnect').addEventListener('click', () => {
  if (driveBusy) return;
  drive.disconnect(); driveMessage = 'Google Drive disconnected. Local board copies have been kept.'; updateDriveControls();
});
$('drive-refresh').addEventListener('click', () => refreshDriveBoards());
$('drive-save').addEventListener('click', () => saveDriveBoard());
$('drive-save-copy').addEventListener('click', () => saveDriveBoard(true));
$('drive-pick').addEventListener('click', async () => {
  if (driveBusy) return;
  driveBusy = true; updateDriveControls(); $('drive-dialog').close();
  let fileId;
  try { fileId = await drive.pickBoard(); }
  catch (error) { driveMessage = error.message; }
  finally { driveBusy = false; updateDriveControls(); }
  if (fileId) await openDriveBoard(fileId);
  else if (!$('drive-dialog').open) $('drive-dialog').showModal();
});

$('new-board').addEventListener('click', newBoard);
$('duplicate-board').addEventListener('click', () => duplicateBoard());
$('cancel-close-board').addEventListener('click', () => { pendingCloseId = null; $('close-board-dialog').close(); });
$('close-board-dialog').addEventListener('cancel', () => { pendingCloseId = null; });
$('discard-close-board').addEventListener('click', () => {
  const id = pendingCloseId; pendingCloseId = null; $('close-board-dialog').close();
  if (id) finishCloseBoard(id);
});
$('save-close-board').addEventListener('click', async () => {
  const id = pendingCloseId; pendingCloseId = null; $('close-board-dialog').close();
  if (!id) return;
  switchBoard(id);
  if (await saveBoardFile()) {
    const session = sessions.get(id);
    if (session && fileChanged(session)) toast('File saved. Newer changes are still open.');
    else finishCloseBoard(id);
  }
});
$('all-boards-button').addEventListener('click', () => {
  const open = $('all-boards-menu').hidden;
  $('all-boards-menu').hidden = !open; $('all-boards-button').setAttribute('aria-expanded', String(open));
  if (open) { closeMenu(); $('board-search').value = ''; renderAllBoards(); $('board-search').focus(); }
});
$('board-search').addEventListener('input', renderAllBoards);
document.addEventListener('click', event => { if (!event.target.closest('#boards-section')) closeAllBoards(); });
$('open-board').addEventListener('click', chooseBoardFiles);
$('save-board').addEventListener('click', () => saveBoardFile());
$('save-board-as').addEventListener('click', () => saveBoardFile(true));
$('board-tabs').addEventListener('keydown', event => {
  const tabs = [...$('board-tabs').querySelectorAll('[role=tab]')];
  const index = tabs.indexOf(event.target);
  if (index < 0 || !['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
  event.preventDefault();
  const next = event.key === 'Home' ? 0 : event.key === 'End' ? tabs.length - 1 : (index + (['ArrowDown', 'ArrowRight'].includes(event.key) ? 1 : -1) + tabs.length) % tabs.length;
  const id = tabs[next].dataset.boardId; switchBoard(id); $(`tab-${id}`).focus();
});
$('import-file').addEventListener('change', async event => {
  const files = [...event.target.files]; event.target.value = '';
  if (!files.length || openingBoard) return;
  openingBoard = true; updateBoardFiles();
  try { for (const file of files) await openBoardFile(file); }
  catch (error) { toast(error.message || 'Could not open this board file.'); }
  finally { openingBoard = false; updateBoardFiles(); }
});

document.addEventListener('keydown', event => {
  if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 's' && !document.querySelector('dialog[open]')) { event.preventDefault(); saveBoardFile(event.shiftKey); return; }
  const editing = event.target.matches('textarea, input, select, [contenteditable=true]');
  if (event.key === 'Escape') { pinChoosing=false; setTapeMode(false); cancelGesture(); setStringMode(false); setSelectMode(false); setSelected(null); cancelPlacement(); closeMenu(); closeAllBoards(); $('text-settings').open = false; $('appearance-settings').open = false; if (compactLayout.matches) setSidebar(false); return; }
  if (stringMode && event.key === 'Enter' && event.target.closest('.note')) { event.preventDefault(); chooseStringItem(event.target.closest('.note').dataset.noteId); return; }
  if (editing || document.querySelector('dialog[open]')) return;
  if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'a') { event.preventDefault(); setSelected(board.notes.map(note => note.id)); for (const tape of board.tapes) selectedTapes.add(tape.id); renderTapes(); updateSelection(); return; }
  if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'z') { event.preventDefault(); historyStep(event.shiftKey ? redoStack : undoStack, event.shiftKey ? undoStack : redoStack); return; }
  if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'y') { event.preventDefault(); historyStep(redoStack, undoStack); return; }
  if (event.ctrlKey || event.metaKey || event.altKey) return;
  const direction = arrowDirection(event.key);
  if (direction && selectedTapes.size) { event.preventDefault(); record(); const step=event.shiftKey?1:10; moveNotes(selectedNotes(),direction[0]*step,direction[1]*step); moveSelectedTapes(direction[0]*step,direction[1]*step); saveSoon(); return; }
  if (event.key.toLowerCase() === 'r') { event.preventDefault(); randomCategory(); }
  else if (event.key.toLowerCase() === 'v') { event.preventDefault(); cancelGesture(); setSelectMode(!selectMode); }
  else if (event.key.toLowerCase() === 'i') { event.preventDefault(); startPlacement('card'); }
  else if (event.key === '/') { event.preventDefault(); setSidebar(true); $('category-search').focus(); }
  else if (event.key === ' ') { event.preventDefault(); spaceHeld = true; updateHandMode(); }
  else if ((event.key === 'Delete' || event.key === 'Backspace') && (selected.size || selectedStrings.size || selectedTapes.size)) { event.preventDefault(); removeSelection(); }
  else if (event.key === 'Enter' && placement) { event.preventDefault(); placeNote(pointer || {x: viewport.clientWidth / 2, y: viewport.clientHeight / 2}); }
});
document.addEventListener('keyup', event => { if (event.key === ' ') { spaceHeld = false; updateHandMode(); } });
window.addEventListener('blur', () => {
  spaceHeld = false; updateHandMode();
  cancelGesture();
});
window.addEventListener('pagehide', () => { flushCategoryEdits(); saveNow(); });
document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'hidden') { flushCategoryEdits(); saveNow(); } else checkCategoryFile(); });
window.addEventListener('focus', checkCategoryFile);
window.addEventListener('online', () => {
  if (!drive.connected) { restoreDriveConnection(); return; }
  resumeDriveAutosaves();
  if (categoryDriveConnected() && !categoryConflict) { categorySyncError = ''; syncAccountCategories(); }
});
window.addEventListener('storage', event => {
  if (event.key === `${appKey}:ui-theme`) { uiThemePreference = ['light', 'dark'].includes(event.newValue) ? event.newValue : 'system'; applyInterfaceTheme(); return; }
  if (event.key === categoriesKey) { loadCategories(); return; }
  if (event.key === `${appKey}:workspace`) {
    workspaceBlocked = true; updateBoardFiles();
    toast('Board tabs changed in another browser tab. Reload to use the updated tab list.');
    return;
  }
  if (!event.newValue) return;
  for (const session of sessions.values()) if (event.key === boardKeys(appKey, session.id).board) session.blocked = true;
  if (event.key !== storageKey) return;
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

applyInterfaceTheme();
renderBoard();
entryFor().name = board.name;
renderBoardTabs(); updateHistory(); rememberWorkspace(); restoreBoardHandle(activeSession);
setSidebar(!compactLayout.matches && desktopSidebarOpen);
updateVisibleHeight();
loadCategories().then(restoreDriveConnection);
if (startupProblem || activeSession.problem) { setSaveStatus('Saved board unavailable — saving paused', true); toast(startupProblem || activeSession.problem); }
