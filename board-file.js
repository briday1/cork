import {validateBoard} from './board-core.js';

export async function readBoardFile(file) {
  if (file.size > 100 * 1024 * 1024) throw new Error('Choose a board file smaller than 100 MB.');
  let data;
  try { data = JSON.parse(await file.text()); }
  catch (error) {
    if (error instanceof SyntaxError) throw new Error('That file is not a valid Cork JSON board.');
    throw error;
  }
  return {data, board: validateBoard(data)};
}

export async function writeBoardFile(handle, contents, previous = null) {
  if (previous) {
    const current = await handle.getFile();
    if (current.lastModified !== previous.modified || current.size !== previous.size) throw new Error('This file changed outside Cork. Use Save as to keep both copies.');
  }
  const writable = await handle.createWritable();
  try {
    await writable.write(contents);
    await writable.close();
  } catch (error) {
    try { await writable.abort(); } catch { /* The original write error is more useful. */ }
    throw error;
  }
  const saved = await handle.getFile();
  return {name: saved.name, modified: saved.lastModified, size: saved.size};
}
