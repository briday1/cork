import {toCanvas} from './assets/html-to-image.min.js';
import {PDFDocument, degrees, rgb} from './assets/pdf-lib.min.js';
import {boardExportLayout, pdfImagePlacement, connectionGeometry} from './export-core.js';

// Freeze the notes before any asynchronous rendering, including unsaved input.
export function snapshotNotes(notes, elements) {
  return [...notes.filter(note => note.type !== 'pin'), ...notes.filter(note => note.type === 'pin')].map(note => {
    const element = elements.get(note.id);
    const style = getComputedStyle(element);
    const width = parseFloat(style.width), height = parseFloat(style.height);
    const [originX, originY] = style.transformOrigin.split(' ').map(parseFloat);
    const clone = element.cloneNode(true);
    clone.classList.remove('is-selected', 'is-dragging', 'is-resizing');
    clone.querySelectorAll('.note-actions, .note-resize, .note-resize-height, .note-drag svg, .pin-adjust').forEach(control => control.remove());
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
    return {id: note.id, type: note.type, pin:note.pin, x: note.x, y: note.y, tilt: note.tilt, width, height, originX, originY, element: clone};
  });
}

export async function createBoardPdf(name, notes, connections = [], tapes = [], onProgress = () => {}) {
  const tapeBounds = tapes.map(t => ({x:Math.min(t.x1,t.x2)-16, y:Math.min(t.y1,t.y2)-16, width:Math.abs(t.x2-t.x1)+32, height:Math.abs(t.y2-t.y1)+32, tilt:0}));
  const layout = boardExportLayout([...notes, ...tapeBounds]);
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
    const colors = {red:'#b5252e', blue:'#2454a3', yellow:'#f1d43b', white:'#f0eee7', black:'#232527'};
    for (const tape of tapes) {
      const length = Math.hypot(tape.x2-tape.x1, tape.y2-tape.y1);
      if (length < 1) continue;
      const ratio = Math.min(3, 8192 / length);
      const canvas = document.createElement('canvas'); canvas.width = Math.max(1, Math.ceil(length * ratio)); canvas.height = Math.max(1, Math.ceil(32 * ratio));
      const ctx = canvas.getContext('2d'); ctx.scale(ratio,ratio);
      const seed = [...tape.id].reduce((n,c) => (n*31+c.charCodeAt(0))>>>0, 7), a=2+seed%5, b=2+(seed>>>4)%5;
      ctx.beginPath(); ctx.moveTo(a,0); for (const [x,y] of [[length-b,0],[length-2,6],[length-b,11],[length-1,16],[length-b,22],[length-3,27],[length-b,32],[a,32],[2,27],[a,22],[1,16],[a,11],[2,5]]) ctx.lineTo(x,y); ctx.closePath(); ctx.fillStyle=colors[tape.color]; ctx.fill();
      ctx.fillStyle=tape.color === 'white' ? '#000' : '#fff'; ctx.font='600 15px sans-serif'; ctx.textAlign='center'; ctx.textBaseline='middle'; if (tape.text) ctx.fillText(tape.text,length/2,16,Math.max(1,length-20));
      const png = await new Promise((resolve,reject) => canvas.toBlob(blob => blob ? resolve(blob) : reject(new Error('Could not render tape.')), 'image/png'));
      const image = await pdf.embedPng(await png.arrayBuffer());
      const angle = Math.atan2(tape.y2-tape.y1,tape.x2-tape.x1), scale=layout.scale;
      page.drawImage(image, {x:(tape.x1-layout.left-16*Math.sin(angle))*scale, y:(layout.bottom-tape.y1-16*Math.cos(angle))*scale, width:length*scale, height:32*scale, rotate:degrees(-angle*180/Math.PI)});
      canvas.width=canvas.height=1;
    }
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
      const palette = {red:[[.62,.18,.15],[.88,.43,.34]], blue:[[.14,.35,.65],[.62,.76,.94]], yellow:[[.71,.54,.03],[1,.88,.48]], green:[[.20,.46,.29],[.61,.86,.61]], black:[[.16,.17,.19],[.64,.64,.65]], white:[[.78,.78,.75],[1,1,1]]};
      const [base, highlight] = palette[connection.color] || palette.red;
      page.drawSvgPath(path, {x: 0, y: layout.pageHeight, scale: layout.scale, borderColor: rgb(...base), borderWidth: connection.width || 2.4});
      page.drawSvgPath(path, {x: 0, y: layout.pageHeight, scale: layout.scale, borderColor: rgb(...highlight), borderWidth: (connection.width || 2.4) * .65 / 2.4, borderDashArray: [1, 2]});
      if (!from.pin) pins.set(from.id, curve.from); if (!to.pin) pins.set(to.id, curve.to);
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
