export const STORAGE_KEY = 'cork.board.v1';
export const PALETTES = {
  hsv: [],
  spectrum: [[48, 79, 79], [22, 76, 81], [347, 59, 84], [279, 46, 85], [210, 54, 83], [158, 37, 78], [80, 44, 77]],
  warm: [[48, 83, 78], [33, 81, 78], [16, 70, 81], [352, 60, 83], [332, 44, 83]],
  cool: [[165, 37, 77], [190, 48, 79], [216, 58, 83], [244, 42, 85], [279, 44, 85]],
  earth: [[48, 47, 76], [29, 42, 76], [14, 38, 79], [78, 28, 74], [135, 21, 77]],
  viridis: [],
  cividis: [],
};

export function parseCategories(text) {
  const seen = new Set();
  return text.replace(/^\uFEFF/, '').split(/\r?\n/).map(s => s.trim()).filter(s => {
    const key = s.toLocaleLowerCase();
    if (!s || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
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
  const position = t * (stops.length - 1);
  const a = stops[Math.floor(position)];
  const b = stops[Math.min(Math.ceil(position), stops.length - 1)];
  const f = position % 1;
  const dh = ((b[0] - a[0] + 540) % 360) - 180;
  return `hsl(${(a[0] + dh * f + 360) % 360} ${(a[1] + (b[1] - a[1]) * f).toFixed(1)}% ${(a[2] + (b[2] - a[2]) * f).toFixed(1)}%)`;
}

export function blankBoard() {
  return {version: 1, name: 'My board', palette: 'hsv', theme: 'natural', notes: [], view: {x: 0, y: 0, zoom: 1}};
}

export function screenToWorld(point, view) {
  return {x: (point.x - view.x) / view.zoom, y: (point.y - view.y) / view.zoom};
}

export function zoomAt(view, zoom, point) {
  const next = Math.max(.25, Math.min(2, zoom));
  const world = screenToWorld(point, view);
  return {x: point.x - world.x * next, y: point.y - world.y * next, zoom: next};
}

export function validateBoard(data) {
  if (!data || data.version !== 1 || !Array.isArray(data.notes) || data.notes.length > 5000) throw new Error('Choose a Cork board export (version 1, up to 5,000 notes).');
  const ids = new Set();
  const finite = n => typeof n === 'number' && Number.isFinite(n) && Math.abs(n) < 1e7;
  const notes = data.notes.map(n => {
    if (!n || typeof n.id !== 'string' || !n.id || n.id.length > 100 || ids.has(n.id) || !['note', 'card'].includes(n.type) || !finite(n.x) || !finite(n.y) || typeof n.text !== 'string' || n.text.length > 100000 || typeof n.category !== 'string' || n.category.length > 10000 || typeof n.title !== 'string' || n.title.length > 10000) throw new Error('This board contains an invalid note. Nothing was changed.');
    ids.add(n.id);
    return {id: n.id, type: n.type, category: n.category, title: n.title, text: n.text, x: n.x, y: n.y, tilt: finite(n.tilt) ? Math.max(-3, Math.min(3, n.tilt)) : 0, ...(finite(n.width) ? {width: Math.max(190, Math.min(800, n.width))} : {})};
  });
  const view = data.view;
  return {
    version: 1,
    name: typeof data.name === 'string' ? data.name.slice(0, 80) || 'My board' : 'My board',
    palette: Object.hasOwn(PALETTES, data.palette) ? data.palette : 'hsv',
    theme: ['natural', 'pale', 'dark'].includes(data.theme) ? data.theme : 'natural',
    notes,
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
