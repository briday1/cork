export const STORAGE_KEY = 'cork.board.v1';
export const PALETTES = {
  hsv: [],
  spectrum: [[48, 79, 79], [22, 76, 81], [347, 59, 84], [279, 46, 85], [210, 54, 83], [158, 37, 78], [80, 44, 77]],
  warm: [[48, 83, 78], [33, 81, 78], [16, 70, 81], [352, 60, 83], [332, 44, 83]],
  cool: [[165, 37, 77], [190, 48, 79], [216, 58, 83], [244, 42, 85], [279, 44, 85]],
  earth: [[48, 47, 76], [29, 42, 76], [14, 38, 79], [78, 28, 74], [135, 21, 77]],
  viridis: [],
  cividis: [],
  sunset: [[42,84,81],[16,76,83],[345,59,85],[295,45,86],[245,42,84]],
  ocean: [[182,43,81],[195,58,83],[213,59,85],[236,48,87],[260,38,87]],
  garden: [[75,48,82],[107,39,80],[145,38,81],[173,40,82],[196,45,84]],
  berry: [[345,55,84],[322,46,84],[295,42,85],[270,42,85],[240,40,85]],
  'mix-bright': [[48,80,79],[212,65,82],[350,64,83],[142,45,78],[278,50,84],[24,80,80],[184,50,79],[325,53,83],[82,48,78],[240,45,85],[12,67,82],[162,40,79]],
  'mix-pastel': [[42,68,88],[215,55,88],[340,55,89],[150,37,87],[275,40,89],[20,64,88],[185,41,87],[315,45,89],[78,41,86],[245,38,89]],
  'mix-earth': [[40,50,78],[196,34,77],[8,43,79],[110,28,76],[275,25,81],[27,48,77],[160,27,75],[332,33,80],[73,32,75],[225,25,80]],
  'mix-vivid': [[52,89,76],[218,70,79],[355,70,80],[133,51,76],[280,55,82],[28,88,77],[185,58,76],[320,60,80],[78,56,76],[247,50,82]],
};

export function parseCategories(text) {
  return parseCategoryFile(text).categories;
}

export function parseCategoryFile(text) {
  const names = new Map(), frequent = new Set();
  for (const line of text.replace(/^\uFEFF/, '').split(/\r?\n/)) {
    const value = line.trim();
    const starred = value.startsWith('*');
    const name = (starred ? value.slice(1) : value).trim();
    if (!name) continue;
    const key = name.toLocaleLowerCase();
    if (!names.has(key)) names.set(key, name);
    if (starred) frequent.add(key);
  }
  const categories = [...names.values()];
  return {categories, frequentCategories: categories.filter(name => frequent.has(name.toLocaleLowerCase()))};
}

export function missingBoardCategories(notes, categories) {
  const defined = new Set(categories.map(name => name.trim().toLocaleLowerCase()));
  const missing = new Map();
  for (const note of notes) {
    if (note.type !== 'note') continue;
    const name = note.category.trim(), key = name.toLocaleLowerCase();
    if (name && !defined.has(key) && !missing.has(key)) missing.set(key, name);
  }
  return [...missing.values()];
}

export function directoryNameFromFiles(files) {
  let name = null;
  for (const file of files || []) {
    const parts = (file.webkitRelativePath || '').split('/');
    if (parts.length < 2 || !parts[0] || parts[0] === '.' || parts[0] === '..') return null;
    if (name !== null && parts[0] !== name) return null;
    name = parts[0];
  }
  return name;
}

export function categoryColor(name, categories, palette = 'hsv') {
  if (!Object.hasOwn(PALETTES, palette)) palette = 'hsv';
  const index = categories.indexOf(name);
  const hash = Array.from(name).reduce((n, c) => (Math.imul(n, 31) + c.codePointAt(0)) >>> 0, 0);
  const t = index < 0 ? (hash % 1000) / 1000 : index / Math.max(1, categories.length - 1);
  if (palette === 'hsv') {
    // Exclude the duplicate endpoint; soften saturation for readable paper.
    const fraction = index < 0 ? t : index / Math.max(1, categories.length);
    const hue = (45 + fraction * 360) % 360;
    const saturation = .36, value = .97;
    const c = value * saturation, x = c * (1 - Math.abs((hue / 60) % 2 - 1)), m = value - c;
    const rgb = [[c, x, 0], [x, c, 0], [0, c, x], [0, x, c], [x, 0, c], [c, 0, x]][Math.floor(hue / 60)];
    return `rgb(${rgb.map(v => Math.round((v + m) * 255)).join(' ')})`;
  }
  if (palette === 'viridis' || palette === 'cividis') {
    const colors = palette === 'viridis' ? [[68, 1, 84], [59, 82, 139], [33, 145, 140], [94, 201, 98], [253, 231, 37]] : [[0, 34, 78], [66, 78, 108], [124, 123, 120], [188, 173, 108], [255, 233, 69]];
    const p = t * (colors.length - 1), a = colors[Math.floor(p)], b = colors[Math.min(Math.ceil(p), colors.length - 1)];
    // Mix the map with ivory to make all notes legible with dark ink.
    return `rgb(${a.map((v, i) => Math.round((v + (b[i] - v) * (p % 1)) * .42 + [255, 253, 243][i] * .58)).join(' ')})`;
  }
  const stops = PALETTES[palette];
  if (palette.startsWith('mix-')) {
    // Keep neighboring categories distinct and colors stable across redraws.
    const i = index < 0 ? hash : index;
    const [h, saturation, lightness] = stops[i % stops.length];
    const round = Math.floor(i / stops.length);
    const shift = round === 0 ? 0 : ((round % 5) - 2) * 2;
    return `hsl(${h} ${saturation}% ${Math.max(69, Math.min(92, lightness + shift))}%)`;
  }
  const position = t * (stops.length - 1);
  const a = stops[Math.floor(position)];
  const b = stops[Math.min(Math.ceil(position), stops.length - 1)];
  const f = position % 1;
  const dh = ((b[0] - a[0] + 540) % 360) - 180;
  return `hsl(${(a[0] + dh * f + 360) % 360} ${(a[1] + (b[1] - a[1]) * f).toFixed(1)}% ${(a[2] + (b[2] - a[2]) * f).toFixed(1)}%)`;
}

export function blankBoard() {
  return {version: 1, name: 'My board', palette: 'hsv', theme: 'natural', notes: [], connections: [], tapes: [], view: {x: 0, y: 0, zoom: 1}};
}

export const NOTE_FONTS = {
  sans: '-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif',
  serif: 'Georgia,"Times New Roman",serif',
  mono: 'ui-monospace,SFMono-Regular,Consolas,"Liberation Mono",monospace',
};

export function normalizeNoteStyle(value) {
  const style = {};
  for (const part of ['header', 'body']) {
    const source = value?.[part], result = {};
    if (!source || typeof source !== 'object') continue;
    if (Object.hasOwn(NOTE_FONTS, source.font)) result.font = source.font;
    if (Number.isFinite(source.size)) result.size = Math.max(9, Math.min(72, source.size));
    if ([400, 500, 550, 600, 650, 700].includes(source.weight)) result.weight = source.weight;
    if (Object.keys(result).length) style[part] = result;
  }
  return style;
}

export function screenToWorld(point, view) {
  return {x: (point.x - view.x) / view.zoom, y: (point.y - view.y) / view.zoom};
}

export function zoomAt(view, zoom, point) {
  const next = Math.max(.25, Math.min(2, zoom));
  const world = screenToWorld(point, view);
  return {x: point.x - world.x * next, y: point.y - world.y * next, zoom: next};
}

// Bring a note into reach without changing its position on the board.
export function revealNote(view, rect, size, fitWidth = false, bottom = 88) {
  const margin = 16, top = 24;
  const zoom = fitWidth ? Math.max(.25, Math.min(view.zoom, (size.width - margin * 2) / rect.width)) : view.zoom;
  let {x, y} = view;
  const width = rect.width * zoom, height = rect.height * zoom;
  const left = rect.x * zoom + x, upper = rect.y * zoom + y;
  const availableHeight = Math.max(0, size.height - top - bottom);
  if (left < margin || width > size.width - margin * 2) x += margin - left;
  else if (left + width > size.width - margin) x -= left + width - size.width + margin;
  if (upper < top || height > availableHeight) y += top - upper;
  else if (upper + height > size.height - bottom) y -= upper + height - size.height + bottom;
  return {x, y, zoom};
}

export function focusNoteView(rect, size) {
  const zoom = Math.max(.25, Math.min(1.6, (size.width - 32) / rect.width));
  return {zoom, x: (size.width - rect.width * zoom) / 2 - rect.x * zoom, y: 16 - rect.y * zoom};
}

export function validateBoard(data) {
  if (!data || data.version !== 1 || !Array.isArray(data.notes) || data.notes.length > 5000) throw new Error('Choose a Cork board export (version 1, up to 5,000 notes).');
  const ids = new Set();
  const finite = n => typeof n === 'number' && Number.isFinite(n) && Math.abs(n) < 1e7;
  const notes = data.notes.map(n => {
    if (!n || typeof n.id !== 'string' || !n.id || n.id.length > 100 || ids.has(n.id) || !['note', 'card', 'image', 'folder', 'pin'].includes(n.type) || !finite(n.x) || !finite(n.y) || typeof n.text !== 'string' || n.text.length > 100000 || typeof n.category !== 'string' || n.category.length > 10000 || typeof n.title !== 'string' || n.title.length > 10000) throw new Error('This board contains an invalid note. Nothing was changed.');
    if (n.type === 'image' && (typeof n.imageId !== 'string' || !/^[a-zA-Z0-9_-]{1,100}$/.test(n.imageId) || n.text.length > 120)) throw new Error('This board contains an invalid Polaroid. Captions can contain up to 120 characters. Nothing was changed.');
    if (n.type === 'folder' && (typeof n.folderId !== 'string' || !/^[a-zA-Z0-9_-]{1,100}$/.test(n.folderId) || !n.title || n.title.length > 255)) throw new Error('This board contains an invalid folder link. Nothing was changed.');
    const pinShapes = ['classic','board-pin','arrow','arrow-blue','arrow-yellow','arrow-green','crown','flower','heart','bug','dog','cat','egg','duck','music','check','cross','envelope','camera','film','fire','exclamation','chat','tv'];
    if (n.pin !== undefined && (!n.pin || !pinShapes.includes(n.pin.shape) || !finite(n.pin.size) || n.pin.size < 20 || n.pin.size > 100 || !finite(n.pin.rotation))) throw new Error('This board contains an invalid push pin. Nothing was changed.');
    if (n.parentId !== undefined && (n.type !== 'pin' || typeof n.parentId !== 'string' || !n.parentId || !finite(n.offsetX) || !finite(n.offsetY))) throw new Error('This board contains an invalid attached pin. Nothing was changed.');
    if (n.type === 'pin' && !n.pin) throw new Error('This board contains an invalid push pin. Nothing was changed.');
    ids.add(n.id);
    const style = normalizeNoteStyle(n.style);
    return {id: n.id, type: n.type, category: n.category, title: n.title, text: n.text, x: n.x, y: n.y, tilt: finite(n.tilt) ? Math.max(-3, Math.min(3, n.tilt)) : 0, ...(Object.keys(style).length ? {style} : {}), ...(n.pin ? {pin:{shape:n.pin.shape,size:n.pin.size,rotation:n.pin.rotation}} : {}), ...(n.parentId ? {parentId:n.parentId, offsetX:n.offsetX, offsetY:n.offsetY} : {}), ...(n.type === 'card' && ['white','yellow','pink','blue'].includes(n.cardColor) ? {cardColor:n.cardColor} : {}), ...(n.type === 'image' ? {imageId: n.imageId} : n.type === 'folder' ? {folderId: n.folderId} : {
      ...(finite(n.width) ? {width: Math.max(190, Math.min(800, n.width))} : {}),
      ...(finite(n.height) ? {height: Math.max(120, Math.min(2000, n.height))} : {}),
    })};
  });
  for (const note of notes) if (note.parentId && !notes.some(parent => parent.id === note.parentId && parent.type !== 'pin')) throw new Error('This board contains a pin with a missing item. Nothing was changed.');
  const view = data.view;
  if (data.connections !== undefined && (!Array.isArray(data.connections) || data.connections.length > 10000)) throw new Error('This board contains invalid connections. Nothing was changed.');
  const connectionIds = new Set(), pairs = new Set();
  const connections = (data.connections || []).map(connection => {
    if (!connection || typeof connection.id !== 'string' || !connection.id || connection.id.length > 100 || connectionIds.has(connection.id) || !ids.has(connection.from) || !ids.has(connection.to) || connection.from === connection.to) throw new Error('This board contains an invalid connection. Nothing was changed.');
    const pair = JSON.stringify([connection.from, connection.to].sort());
    if (pairs.has(pair)) throw new Error('This board contains a duplicate connection. Nothing was changed.');
    pairs.add(pair); connectionIds.add(connection.id);
    return {id: connection.id, from: connection.from, to: connection.to, ...(['red','blue','yellow','green','black','white'].includes(connection.color) && connection.color !== 'red' ? {color:connection.color} : {})};
  });
  if (data.tapes !== undefined && (!Array.isArray(data.tapes) || data.tapes.length > 5000)) throw new Error('This board contains invalid tape. Nothing was changed.');
  const tapeIds = new Set();
  const tapes = (data.tapes || []).map(t => {
    if (!t || typeof t.id !== 'string' || !t.id || t.id.length > 100 || tapeIds.has(t.id) || !['red', 'blue', 'yellow', 'white', 'black'].includes(t.color) || typeof t.text !== 'string' || t.text.length > 200 || ![t.x1, t.y1, t.x2, t.y2].every(finite)) throw new Error('This board contains invalid tape. Nothing was changed.');
    tapeIds.add(t.id);
    return {id: t.id, color: t.color, text: t.text, x1: t.x1, y1: t.y1, x2: t.x2, y2: t.y2};
  });
  return {
    version: 1,
    name: typeof data.name === 'string' ? data.name.slice(0, 80) || 'My board' : 'My board',
    palette: Object.hasOwn(PALETTES, data.palette) ? data.palette : 'hsv',
    theme: ['natural', 'pale', 'dark', 'paper-cream', 'paper-sage', 'paper-blue', 'paper-rose', 'paper-lavender', 'paper-mint', 'paper-peach', 'paper-yellow', 'paper-gray', 'paper-sky', 'paper-terracotta'].includes(data.theme) ? data.theme : 'natural',
    ...(Array.isArray(data.colorOrder) && data.colorOrder.length <= 5000 && data.colorOrder.every(name => typeof name === 'string' && name.length <= 10000) ? {colorOrder:[...new Set(data.colorOrder)]} : {}),
    ...(Object.keys(normalizeNoteStyle(data.noteStyle)).length ? {noteStyle: normalizeNoteStyle(data.noteStyle)} : {}),
    notes,
    connections,
    tapes,
    view: view && finite(view.x) && finite(view.y) && finite(view.zoom) && view.zoom >= .25 && view.zoom <= 2 ? {x: view.x, y: view.y, zoom: view.zoom} : {x: 0, y: 0, zoom: 1},
  };
}

export function continueList(text, start, end = start) {
  if (start !== end) return null;
  const lineStart = text.lastIndexOf('\n', start - 1) + 1;
  const line = text.slice(lineStart, start);
  const match = /^(\s*)([-*•]|\d+\.)\s(.*)$/.exec(line);
  if (!match) return null;
  if (!match[3].trim()) {
    return {text: text.slice(0, lineStart) + text.slice(start), cursor: lineStart};
  }
  const bullet = /^\d/.test(match[2]) ? `${parseInt(match[2], 10) + 1}.` : match[2];
  const insert = `\n${match[1]}${bullet} `;
  return {text: text.slice(0, start) + insert + text.slice(start), cursor: start + insert.length};
}
