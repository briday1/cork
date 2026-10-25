export const MAX_CATEGORY_FILE_SIZE = 1024 * 1024;
const MAX_FILE_SIZE = MAX_CATEGORY_FILE_SIZE;
let database;

export function validateCategoryText(text) {
  if (typeof text !== 'string' || text.length > MAX_FILE_SIZE || new TextEncoder().encode(text).length > MAX_FILE_SIZE || /[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(text)) throw new Error('Choose a plain text categories file smaller than 1 MB, with one category per line.');
  return text;
}

export function categoryStamp(text) {
  let first = 2166136261, second = 5381;
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    first = Math.imul(first ^ code, 16777619) >>> 0;
    second = (Math.imul(second, 33) ^ code) >>> 0;
  }
  return `${text.length}:${first.toString(36)}:${second.toString(36)}`;
}

export function categoriesChanged(file) {
  return Boolean(file && (file.pending || (file.drive && file.drive.stamp !== categoryStamp(file.text))));
}

export async function readCategoryFile(file) {
  if (file.size > MAX_FILE_SIZE) throw new Error('Choose a categories text file smaller than 1 MB.');
  const text = await file.text();
  validateCategoryText(text);
  return {name: (file.name || 'categories.txt').slice(0, 255), text};
}

// A cached copy works even in browsers that cannot retain access to local files.
// File handles stay in IndexedDB; neither the file nor its path is uploaded.
export function readCategoryCache(storage, key) {
  const value = storage.getItem(key);
  if (value === null) return null;
  const data = JSON.parse(value);
  if (data?.version !== 1 || typeof data.name !== 'string' || !data.name || data.name.length > 255 || typeof data.text !== 'string' || data.text.length > MAX_FILE_SIZE || typeof data.token !== 'string' || !data.token) throw new Error('The saved categories could not be read.');
  validateCategoryText(data.text);
  const drive = data.drive;
  if (drive && (drive.kind !== 'drive' || typeof drive.id !== 'string' || !/^[\w-]{1,200}$/.test(drive.id) || typeof drive.accountId !== 'string' || !/^[\w-]{1,200}$/.test(drive.accountId) || typeof drive.version !== 'string' || !/^\d+$/.test(drive.version) || typeof drive.stamp !== 'string' || !Number.isFinite(drive.modified) || !Number.isFinite(drive.size) || typeof drive.name !== 'string' || (drive.etag !== undefined && typeof drive.etag !== 'string'))) throw new Error('The saved categories file link could not be read.');
  return {version: 1, name: data.name, text: data.text, token: data.token, ...(drive ? {drive: {...drive}} : {}), ...(data.pending ? {pending: true} : {})};
}

export function writeCategoryCache(storage, key, file) {
  if (!file) return storage.removeItem(key);
  const value = JSON.stringify(file);
  if (storage.getItem(key) !== value) storage.setItem(key, value);
}

export async function readLinkedCategories(handle, askPermission = false) {
  // Permission requests only happen on Refresh, in a user gesture. Startup and
  // returning to the tab can check an existing grant without showing a prompt.
  const permission = askPermission ? await handle.requestPermission({mode: 'read'}) : await handle.queryPermission({mode: 'read'});
  if (permission !== 'granted') return null;
  return readCategoryFile(await handle.getFile());
}

function openDatabase() {
  if (!database) database = new Promise((resolve, reject) => {
    if (!globalThis.indexedDB) return reject(new Error('File linking is unavailable.'));
    const request = indexedDB.open('cork.categories.v1', 1);
    request.onupgradeneeded = () => request.result.createObjectStore('files', {keyPath: 'id'});
    request.onsuccess = () => {
      const db = request.result;
      db.onversionchange = () => { db.close(); database = null; };
      resolve(db);
    };
    request.onerror = request.onblocked = () => reject(new Error('Could not remember the linked file.'));
  }).catch(error => { database = null; throw error; });
  return database;
}

export async function getCategoryHandle(id) {
  const db = await openDatabase();
  return new Promise((resolve, reject) => {
    const request = db.transaction('files', 'readonly').objectStore('files').get(id);
    request.onsuccess = () => resolve(request.result || null);
    request.onerror = () => reject(new Error('Could not restore the linked file.'));
  });
}

export async function putCategoryHandle(id, file) {
  const db = await openDatabase();
  return new Promise((resolve, reject) => {
    const transaction = db.transaction('files', 'readwrite');
    const store = transaction.objectStore('files');
    if (file) store.put({id, ...file});
    else store.delete(id);
    transaction.oncomplete = () => resolve();
    transaction.onerror = transaction.onabort = () => reject(new Error('Could not remember the linked file.'));
  });
}
