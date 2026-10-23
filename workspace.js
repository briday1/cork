import {blankBoard, validateBoard} from './board-core.js';

// The first board keeps its original keys, including its linked categories.
export function boardKeys(base, id) {
  const board = id === 'original' ? base : `${base}:board:${id}`;
  return {board, categories: `${board}:categories`, file: `${board}:file`};
}

export function readWorkspace(storage, base) {
  const saved = storage.getItem(`${base}:workspace`);
  if (!saved) return {version: 1, activeId: 'original', boards: [{id: 'original', name: 'My board', open: true, file: null}]};
  const value = JSON.parse(saved);
  const ids = new Set();
  if (value?.version !== 1 || !Array.isArray(value.boards) || !value.boards.length) throw new Error('Saved board tabs could not be read.');
  const boards = value.boards.map(entry => {
    if (!entry || !/^[a-zA-Z0-9_-]{1,100}$/.test(entry.id) || ids.has(entry.id) || typeof entry.name !== 'string' || typeof entry.open !== 'boolean') throw new Error('Saved board tabs could not be read.');
    ids.add(entry.id);
    const file = entry.file;
    if (file && (typeof file.name !== 'string' || !file.name || typeof file.token !== 'string' || typeof file.stamp !== 'string' || !Number.isFinite(file.modified) || !Number.isFinite(file.size))) throw new Error('A saved board file link could not be read.');
    return {id: entry.id, name: entry.name.slice(0, 80), open: entry.open, file: file ? {...file} : null};
  });
  if (!boards.some(entry => entry.id === value.activeId && entry.open)) throw new Error('The active board tab could not be read.');
  return {version: 1, activeId: value.activeId, boards};
}

export function writeWorkspace(storage, base, workspace) {
  const key = `${base}:workspace`, value = JSON.stringify(workspace);
  if (storage.getItem(key) !== value) storage.setItem(key, value);
}

export function readWorkspaceBoard(storage, base, id) {
  const saved = storage.getItem(boardKeys(base, id).board);
  return saved ? validateBoard(JSON.parse(saved)) : blankBoard();
}

export function duplicateBoardSnapshot(board, names) {
  const snapshot = validateBoard(JSON.parse(JSON.stringify(board)));
  const existing = new Set(names), baseName = `${snapshot.name.slice(0, 70)} copy`;
  let name = baseName, number = 2;
  while (existing.has(name)) name = `${baseName} ${number++}`;
  snapshot.name = name;
  return snapshot;
}

// Compact comparison against the last file save, including undo and camera changes.
export function boardStamp(board) {
  // Canonical property order and omitted defaults must match exported boards.
  const value = JSON.stringify(validateBoard(board));
  let first = 2166136261, second = 5381;
  for (let i = 0; i < value.length; i++) {
    const code = value.charCodeAt(i);
    first = Math.imul(first ^ code, 16777619) >>> 0;
    second = (Math.imul(second, 33) ^ code) >>> 0;
  }
  return `${value.length}:${first.toString(36)}:${second.toString(36)}`;
}
