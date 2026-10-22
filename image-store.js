let database;
const rasterTypes = new Set(['image/jpeg', 'image/png', 'image/webp', 'image/gif', 'image/avif']);

function openDatabase() {
  if (!database) database = new Promise((resolve, reject) => {
    if (!globalThis.indexedDB) return reject(new Error('Image storage is unavailable in this browser.'));
    const request = indexedDB.open('cork.images.v1', 2);
    request.onupgradeneeded = () => {
      for (const name of ['images', 'folders']) if (!request.result.objectStoreNames.contains(name)) request.result.createObjectStore(name, {keyPath: 'id'});
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(new Error('Could not open image storage.'));
    request.onblocked = () => reject(new Error('Close other Cork tabs and try again.'));
  }).catch(error => { database = null; throw error; });
  return database;
}

export async function putImage(asset) {
  const db = await openDatabase();
  return new Promise((resolve, reject) => {
    const transaction = db.transaction('images', 'readwrite');
    transaction.objectStore('images').put(asset);
    transaction.oncomplete = () => resolve();
    transaction.onerror = transaction.onabort = () => reject(new Error('Could not save the image. Browser storage may be full.'));
  });
}

export async function getImage(id) {
  const db = await openDatabase();
  return new Promise((resolve, reject) => {
    const request = db.transaction('images', 'readonly').objectStore('images').get(id);
    request.onsuccess = () => request.result ? resolve(request.result) : reject(new Error('The original image is unavailable.'));
    request.onerror = () => reject(new Error('Could not read the saved image.'));
  });
}

function canvasBlob(canvas, type, quality) {
  return new Promise((resolve, reject) => canvas.toBlob(blob => blob ? resolve(blob) : reject(new Error('Could not process this image.')), type, quality));
}

export async function prepareImage(file, name = file.name || 'Image') {
  if (file.size > 50 * 1024 * 1024) throw new Error('Choose an image smaller than 50 MB.');
  if (file.type && !file.type.startsWith('image/')) throw new Error('Choose an image file.');
  const source = URL.createObjectURL(file);
  const image = new Image();
  image.src = source;
  try {
    await image.decode();
    const width = image.naturalWidth, height = image.naturalHeight;
    if (!width || !height) throw new Error('This image could not be opened.');
    let original = file;
    // Flatten SVG and other browser-decodable formats so the full-image tab is
    // always an inert raster image. Standard photo files keep their originals.
    if (!rasterTypes.has(file.type)) {
      if (width * height > 32000000 || Math.max(width, height) > 16384) throw new Error('Choose a smaller image in PNG, JPEG, WebP, GIF, or AVIF format.');
      const canvas = document.createElement('canvas'); canvas.width = width; canvas.height = height;
      canvas.getContext('2d').drawImage(image, 0, 0);
      original = await canvasBlob(canvas, 'image/png');
      canvas.width = canvas.height = 1;
    }
    const ratio = Math.min(1, 1024 / Math.max(width, height));
    const preview = document.createElement('canvas');
    preview.width = Math.max(1, Math.round(width * ratio)); preview.height = Math.max(1, Math.round(height * ratio));
    preview.getContext('2d').drawImage(image, 0, 0, preview.width, preview.height);
    const thumbnail = await canvasBlob(preview, 'image/webp', .94);
    preview.width = preview.height = 1;
    return {id: crypto.randomUUID(), original, thumbnail, name, width, height};
  } catch (error) {
    if (error.name === 'EncodingError') throw new Error('This image format could not be opened. Try PNG, JPEG, WebP, GIF, or AVIF.');
    throw error;
  } finally {
    URL.revokeObjectURL(source);
  }
}

function dataUrl(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader(); reader.onload = () => resolve(reader.result); reader.onerror = reject; reader.readAsDataURL(blob);
  });
}

export async function putFolder(id, handle) {
  const db = await openDatabase();
  return new Promise((resolve, reject) => {
    const transaction = db.transaction('folders', 'readwrite');
    transaction.objectStore('folders').put({id, handle});
    transaction.oncomplete = () => resolve();
    transaction.onerror = transaction.onabort = () => reject(new Error('Could not save this folder link.'));
  });
}

export async function getFolder(id) {
  const db = await openDatabase();
  return new Promise((resolve, reject) => {
    const request = db.transaction('folders', 'readonly').objectStore('folders').get(id);
    request.onsuccess = () => resolve(request.result?.handle || null);
    request.onerror = () => reject(new Error('Could not read this folder link.'));
  });
}

export async function exportImages(notes) {
  const images = Object.create(null);
  for (const id of new Set(notes.filter(note => note.type === 'image').map(note => note.imageId))) {
    const asset = await getImage(id);
    images[id] = {name: asset.name, data: await dataUrl(asset.original)};
  }
  return images;
}

export async function importImages(data, board) {
  const images = [];
  const replacements = new Map();
  for (const id of new Set(board.notes.filter(note => note.type === 'image').map(note => note.imageId))) {
    const entry = data.images && Object.hasOwn(data.images, id) && data.images[id];
    if (!entry || typeof entry.data !== 'string' || !/^data:image\/(?:jpeg|png|webp|gif|avif);base64,[A-Za-z0-9+/]+=*$/.test(entry.data)) throw new Error('This backup is missing a valid image. Nothing was changed.');
    const comma = entry.data.indexOf(',');
    const type = entry.data.slice(5, entry.data.indexOf(';'));
    const binary = atob(entry.data.slice(comma + 1));
    const bytes = Uint8Array.from(binary, character => character.charCodeAt(0));
    const asset = await prepareImage(new Blob([bytes], {type}), typeof entry.name === 'string' ? entry.name.slice(0, 255) : 'Image');
    replacements.set(id, asset.id);
    images.push(asset);
  }
  // Fresh IDs keep importing a backup from overwriting images needed by Undo.
  for (const note of board.notes) if (note.type === 'image') note.imageId = replacements.get(note.imageId);
  return images;
}
