import test from 'node:test';
import assert from 'node:assert/strict';
import {boardExportLayout, pdfImagePlacement, rotatedNoteCorners} from '../export-core.js';

test('PDF crops to the paper with a small margin, independently of the camera', () => {
  const note = {x: -100, y: 50, width: 248, height: 184, tilt: 0};
  const layout = boardExportLayout([note]);
  assert.equal(layout.left, -116);
  assert.equal(layout.top, 34);
  assert.equal(layout.pageWidth, 210);
  assert.equal(layout.pageHeight, 162);
  assert.deepEqual(pdfImagePlacement(note, layout), {x: 12, y: 12, width: 186, height: 138, rotation: -0});
  assert.equal(boardExportLayout([]), null);
});

test('PDF contains every rotated corner, including tall resized notes and negative positions', () => {
  const notes = [
    {x: -850, y: -450, width: 800, height: 2000, tilt: -3, originX: 400, originY: 20},
    {x: 450, y: 700, width: 344, height: 207, tilt: 3, originX: 172, originY: 20},
  ];
  const layout = boardExportLayout(notes);
  for (const note of notes) {
    const placement = pdfImagePlacement(note, layout);
    const radians = placement.rotation * Math.PI / 180;
    const imageCorners = [[0, note.height], [note.width, note.height], [note.width, 0], [0, 0]];
    rotatedNoteCorners(note).forEach((corner, index) => {
      const [x, y] = imageCorners[index].map(value => value * layout.scale);
      const px = placement.x + x * Math.cos(radians) - y * Math.sin(radians);
      const py = placement.y + x * Math.sin(radians) + y * Math.cos(radians);
      assert.ok(Math.abs(px - (corner.x - layout.left) * layout.scale) < 1e-8);
      assert.ok(Math.abs(py - (layout.bottom - corner.y) * layout.scale) < 1e-8);
      assert.ok(px >= 12 - 1e-8 && px <= layout.pageWidth - 12 + 1e-8);
      assert.ok(py >= 12 - 1e-8 && py <= layout.pageHeight - 12 + 1e-8);
    });
  }
  const huge = boardExportLayout([...notes, {...notes[0], x: 1000000}]);
  assert.equal(Math.max(huge.pageWidth, huge.pageHeight), 14400);
});
