import test from 'node:test';
import assert from 'node:assert/strict';
import {PAPER_TILE_SIZE, paperFibers, paperResolution} from '../paper-texture.js';

test('paper fibers stay at the same board positions when a region is rendered again', () => {
  assert.deepEqual(paperFibers(-3, 4), paperFibers(-3, 4));
});

test('neighboring paper patches contain different fiber arrangements', () => {
  const relative = (column, row) => paperFibers(column, row).map(fiber => ({
    x:fiber.x - column * PAPER_TILE_SIZE, y:fiber.y - row * PAPER_TILE_SIZE,
    endX:fiber.endX - column * PAPER_TILE_SIZE, endY:fiber.endY - row * PAPER_TILE_SIZE,
  }));
  assert.notDeepEqual(relative(0, 0), relative(1, 0));
  assert.notDeepEqual(relative(0, 0), relative(0, 1));
});

test('fibers crossing patch boundaries match on both sides, including negative coordinates', () => {
  for (const column of [-2, 0, 3]) {
    const edge = (column + 1) * PAPER_TILE_SIZE;
    const atEdge = fibers => fibers.filter(fiber => Math.abs(fiber.x - edge) <= 5 && fiber.y >= 0 && fiber.y < PAPER_TILE_SIZE);
    const left = atEdge(paperFibers(column, 0)), right = atEdge(paperFibers(column + 1, 0));
    assert.ok(left.length);
    assert.deepEqual(left, right);
  }
});

test('paper rendering matches zoom and screen density with bounded canvas resolution', () => {
  assert.equal(paperResolution(.25, 1), .25);
  assert.equal(paperResolution(1, 1), 1);
  assert.equal(paperResolution(1, 2), 2);
  assert.equal(paperResolution(2, 2), 4);
  assert.equal(paperResolution(2, 4), 4);
  for (const zoom of [.25, .7, 1.05, 1.5, 2]) {
    const resolution = paperResolution(zoom, 2);
    assert.ok(resolution >= zoom * 2);
    assert.ok(PAPER_TILE_SIZE * resolution <= 2048);
  }
});
