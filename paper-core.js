// Pointer movement is in board coordinates. Keep the opposite upper corner
// fixed even when changing the width moves the paper's rotation origin.
export function resizePaper(start, dx, dy, side = 'right') {
  const angle = (start.tilt || 0) * Math.PI / 180;
  const cosine = Math.cos(angle), sine = Math.sin(angle);
  const localX = dx * cosine + dy * sine;
  const localY = -dx * sine + dy * cosine;
  const width = Math.max(190, Math.min(800, start.width + (side === 'left' ? -localX : localX)));
  const height = Math.max(120, Math.min(2000, start.height + localY));
  const half = (width - start.width) / 2;
  return {
    width, height,
    x: start.x + (side === 'left' ? -(1 + cosine) * half : (cosine - 1) * half),
    y: start.y + (side === 'left' ? -sine * half : sine * half),
  };
}
