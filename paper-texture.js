// Each patch comes from its world coordinates, so paper stays consistent while
// panning, zooming, and reopening a board without repeating an image.
export const PAPER_TILE_SIZE = 512;
const CELL = 64;

function hash(x, y) {
  let value = Math.imul(x, 374761393) ^ Math.imul(y, 668265263);
  value = Math.imul(value ^ value >>> 13, 1274126177);
  return (value ^ value >>> 16) >>> 0;
}

function random(seed) {
  return () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let value = Math.imul(seed ^ seed >>> 15, 1 | seed);
    value ^= value + Math.imul(value ^ value >>> 7, 61 | value);
    return ((value ^ value >>> 14) >>> 0) / 4294967296;
  };
}

export function paperResolution(zoom, pixelRatio = 1) {
  return Math.max(.25, Math.min(4, 2 ** Math.ceil(Math.log2(zoom * Math.min(2, Math.max(1, pixelRatio))))));
}

export function paperFibers(column, row) {
  const fibers = [];
  const left = column * PAPER_TILE_SIZE, top = row * PAPER_TILE_SIZE;
  // Include neighboring cells so a fiber crossing a patch edge is painted on
  // both sides with exactly the same position, curve, and shade.
  for (let cy = top / CELL - 1; cy <= (top + PAPER_TILE_SIZE) / CELL; cy++) {
    for (let cx = left / CELL - 1; cx <= (left + PAPER_TILE_SIZE) / CELL; cx++) {
      const next = random(hash(cx, cy));
      for (let i = 0; i < 28; i++) {
        const x = cx * CELL + next() * CELL, y = cy * CELL + next() * CELL;
        const angle = next() * Math.PI * 2, length = .8 + next() * 3.4;
        const dx = Math.cos(angle) * length, dy = Math.sin(angle) * length;
        const bend = (next() - .5) * .8, shade = Math.floor(next() * 4);
        if (x < left - 5 || x > left + PAPER_TILE_SIZE + 5 || y < top - 5 || y > top + PAPER_TILE_SIZE + 5) continue;
        fibers.push({x, y, endX:x + dx, endY:y + dy, bendX:x + dx / 2 - Math.sin(angle) * bend, bendY:y + dy / 2 + Math.cos(angle) * bend, shade});
      }
    }
  }
  return fibers;
}

export function paintPaperTile(canvas, column, row, resolution) {
  const size = Math.round(PAPER_TILE_SIZE * resolution);
  canvas.width = size; canvas.height = size;
  const context = canvas.getContext('2d');
  if (!context) return;
  const grain = context.createImageData(size, size);
  const strength = Math.min(1, resolution / 2);
  for (let y = 0; y < size; y++) {
    const worldY = Math.floor((row * size + y) / resolution * 4);
    for (let x = 0; x < size; x++) {
      const value = hash(Math.floor((column * size + x) / resolution * 4), worldY);
      const at = (y * size + x) * 4, shade = value & 1 ? 255 : 0;
      grain.data[at] = shade; grain.data[at + 1] = shade; grain.data[at + 2] = shade;
      grain.data[at + 3] = (3 + (value >>> 24 & 7)) * strength;
    }
  }
  context.putImageData(grain, 0, 0);
  context.setTransform(resolution, 0, 0, resolution, -column * PAPER_TILE_SIZE * resolution, -row * PAPER_TILE_SIZE * resolution);
  context.lineCap = 'round';
  const fibers = paperFibers(column, row);
  const shades = ['#30271912', '#3027191c', '#ffffff36', '#ffffff50'];
  for (let shade = 0; shade < shades.length; shade++) {
    context.beginPath(); context.strokeStyle = shades[shade]; context.lineWidth = shade % 2 ? .45 : .3;
    for (const fiber of fibers) {
      if (fiber.shade !== shade) continue;
      context.moveTo(fiber.x, fiber.y);
      context.quadraticCurveTo(fiber.bendX, fiber.bendY, fiber.endX, fiber.endY);
    }
    context.stroke();
  }
}
