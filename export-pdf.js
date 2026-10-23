import {toCanvas} from './assets/html-to-image.min.js';
import {PDFDocument, degrees, rgb} from './assets/pdf-lib.min.js';
import {boardExportLayout, pdfImagePlacement, connectionGeometry} from './export-core.js';

// Freeze the notes before any asynchronous rendering, including unsaved input.
export function snapshotNotes(notes, elements) {
  return notes.map(note => {
    const element = elements.get(note.id);
    const style = getComputedStyle(element);
    const width = parseFloat(style.width), height = parseFloat(style.height);
    const [originX, originY] = style.transformOrigin.split(' ').map(parseFloat);
    const clone = element.cloneNode(true);
    clone.classList.remove('is-selected', 'is-dragging', 'is-resizing');
    clone.querySelectorAll('.note-actions, .note-resize, .note-resize-height, .note-drag svg').forEach(control => control.remove());
    const sourceInputs = [...element.querySelectorAll('textarea')];
    clone.querySelectorAll('textarea').forEach((input, index) => {
      const text = document.createElement('div');
      text.className = input.className;
      text.style.cssText = input.style.cssText;
      text.textContent = sourceInputs[index].value;
      input.replaceWith(text);
    });
    Object.assign(clone.style, {
      position: 'relative', left: '0', top: '0', transform: 'none',
      width: `${width}px`, height: `${height}px`, maxWidth: 'none',
      boxShadow: 'none', outline: 'none', transition: 'none', margin: '0',
    });
    clone.querySelectorAll('.paper-shadow').forEach(part => { part.style.filter = 'none'; });
    clone.querySelectorAll('.folder-face, .folder-tab').forEach(part => { part.style.boxShadow = 'none'; });
    const pin = clone.querySelector('.pin');
    if (pin) pin.style.opacity = '1';
    return {id: note.id, type: note.type, x: note.x, y: note.y, tilt: note.tilt, width, height, originX, originY, element: clone};
  });
}

export async function createBoardPdf(name, notes, connections = [], onProgress = () => {}) {
  const layout = boardExportLayout(notes);
  if (!layout) throw new Error('Add a note before exporting a PDF.');
  const pdf = await PDFDocument.create();
  pdf.setTitle(name);
  pdf.setCreator('Cork');
  pdf.setSubject('Cork board notes');
  const page = pdf.addPage([layout.pageWidth, layout.pageHeight]);
  const stage = document.createElement('div');
  stage.setAttribute('aria-hidden', 'true');
  stage.inert = true;
  stage.style.cssText = 'position:fixed;left:-100000px;top:0;pointer-events:none;';
  document.body.append(stage);
  try {
    for (let index = 0; index < notes.length; index++) {
      const note = notes[index];
      stage.replaceChildren(note.element);
      // Lossless 4x capture = 384 dpi at the original paper size. Render notes
      // separately to avoid one enormous canvas for a widely spread board.
      const pixelRatio = Math.min(4, 8192 / note.width, 8192 / note.height, Math.sqrt(16000000 / (note.width * note.height)));
      const canvas = await toCanvas(note.element, {width: note.width, height: note.height, pixelRatio, skipFonts: true, skipAutoScale: true});
      const png = await new Promise((resolve, reject) => canvas.toBlob(blob => blob ? resolve(blob) : reject(new Error('Could not render a note.')), 'image/png'));
      const image = await pdf.embedPng(await png.arrayBuffer());
      const {rotation, ...placement} = pdfImagePlacement(note, layout);
      page.drawImage(image, {...placement, rotate: degrees(rotation)});
      // Release the large raster before rendering the next note.
      canvas.width = canvas.height = 1;
      onProgress(index + 1, notes.length);
    }
    const pins = new Map();
    for (const connection of connections) {
      const from = notes.find(note => note.id === connection.from), to = notes.find(note => note.id === connection.to);
      if (!from || !to) continue;
      const curve = connectionGeometry(from, to);
      const point = p => `${p.x - layout.left} ${p.y - layout.top}`;
      const path = `M ${point(curve.from)} Q ${point(curve.control)} ${point(curve.to)}`;
      page.drawSvgPath(path, {x: 0, y: layout.pageHeight, scale: layout.scale, borderColor: rgb(.62, .18, .15), borderWidth: 2.4});
      page.drawSvgPath(path, {x: 0, y: layout.pageHeight, scale: layout.scale, borderColor: rgb(.88, .43, .34), borderWidth: .65, borderDashArray: [1, 2]});
      pins.set(from.id, curve.from); pins.set(to.id, curve.to);
    }
    for (const pin of pins.values()) {
      const x = (pin.x - layout.left) * layout.scale, y = (layout.bottom - pin.y) * layout.scale;
      page.drawCircle({x, y, size: 4 * layout.scale, color: rgb(.64, .23, .18), borderColor: rgb(.45, .17, .13), borderWidth: .5 * layout.scale});
      page.drawCircle({x: x - layout.scale, y: y + layout.scale, size: 1.2 * layout.scale, color: rgb(.95, .69, .59)});
    }
    // No page fill: the spaces between the paper remain transparent.
    return await pdf.save();
  } finally {
    stage.remove();
  }
}
