// Work in board coordinates so the export never depends on the current camera.
export function rotatedNoteCorners(note) {
  const radians = (note.tilt || 0) * Math.PI / 180;
  const cosine = Math.cos(radians), sine = Math.sin(radians);
  const ox = note.originX ?? note.width / 2, oy = note.originY ?? 20;
  return [[0, 0], [note.width, 0], [note.width, note.height], [0, note.height]].map(([x, y]) => ({
    x: note.x + ox + (x - ox) * cosine - (y - oy) * sine,
    y: note.y + oy + (x - ox) * sine + (y - oy) * cosine,
  }));
}

export function boardExportLayout(notes, padding = 16) {
  if (!notes.length) return null;
  const corners = notes.flatMap(rotatedNoteCorners);
  const left = Math.min(...corners.map(p => p.x)) - padding;
  const top = Math.min(...corners.map(p => p.y)) - padding;
  const right = Math.max(...corners.map(p => p.x)) + padding;
  const bottom = Math.max(...corners.map(p => p.y)) + padding;
  const width = right - left, height = bottom - top;
  // One CSS pixel is 3/4 of a PDF point. Stay within the PDF page-size limit.
  const scale = Math.min(.75, 14400 / Math.max(width, height));
  return {left, top, right, bottom, width, height, scale, pageWidth: width * scale, pageHeight: height * scale};
}

export function pdfImagePlacement(note, layout) {
  const rotation = -(note.tilt || 0);
  const radians = rotation * Math.PI / 180;
  const cosine = Math.cos(radians), sine = Math.sin(radians);
  const ox = (note.originX ?? note.width / 2) * layout.scale;
  const oy = (note.originY ?? 20) * layout.scale;
  const width = note.width * layout.scale, height = note.height * layout.scale;
  const anchorX = (note.x - layout.left) * layout.scale + ox;
  const anchorY = (layout.bottom - note.y) * layout.scale - oy;
  return {
    x: anchorX - ox * cosine + (height - oy) * sine,
    y: anchorY - ox * sine - (height - oy) * cosine,
    width, height, rotation,
  };
}

export function connectionGeometry(from, to) {
  const pin = note => {
    if (note.type === 'pin') return {x:note.x + note.width/2, y:note.y + note.height/2};
    const radians = (note.tilt || 0) * Math.PI / 180;
    const pinY = note.type === 'image' ? 7 : note.type === 'folder' ? 45 : 15;
    const delta = pinY - 20;
    return {x: note.x + note.width / 2 - delta * Math.sin(radians), y: note.y + 20 + delta * Math.cos(radians)};
  };
  const a = pin(from), b = pin(to);
  const sag = Math.min(50, Math.hypot(b.x - a.x, b.y - a.y) * .09);
  return {from: a, to: b, control: {x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 + sag}};
}
