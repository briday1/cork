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
