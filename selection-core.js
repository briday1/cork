import {rotatedNoteCorners} from './export-core.js';

export function selectionBounds(start, end) {
  return {left: Math.min(start.x, end.x), top: Math.min(start.y, end.y), right: Math.max(start.x, end.x), bottom: Math.max(start.y, end.y)};
}

// Test the paper itself, including its tilt, rather than its larger bounding box.
export function notesInSelection(notes, bounds) {
  const rectangle = [
    {x: bounds.left, y: bounds.top}, {x: bounds.right, y: bounds.top},
    {x: bounds.right, y: bounds.bottom}, {x: bounds.left, y: bounds.bottom},
  ];
  return notes.filter(note => {
    const paper = rotatedNoteCorners(note);
    const edge = (a, b) => ({x: -(b.y - a.y), y: b.x - a.x});
    const axes = [{x: 1, y: 0}, {x: 0, y: 1}, edge(paper[0], paper[1]), edge(paper[1], paper[2])];
    return axes.every(axis => {
      const a = paper.map(p => p.x * axis.x + p.y * axis.y);
      const b = rectangle.map(p => p.x * axis.x + p.y * axis.y);
      return Math.max(...a) >= Math.min(...b) && Math.max(...b) >= Math.min(...a);
    });
  }).map(note => note.id);
}

// Treat tape as a rotated strip, not its axis-aligned bounding box.
export function tapesInSelection(tapes, bounds) {
  return notesInSelection(tapes.map(t => {
    const angle = Math.atan2(t.y2-t.y1, t.x2-t.x1), length = Math.hypot(t.x2-t.x1, t.y2-t.y1);
    return {id:t.id, x:t.x1+16*Math.sin(angle), y:t.y1-16*Math.cos(angle), width:length, height:32, tilt:angle*180/Math.PI, originX:0, originY:0};
  }), bounds);
}
