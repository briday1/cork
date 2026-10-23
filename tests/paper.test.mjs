import test from 'node:test';
import assert from 'node:assert/strict';
import {resizePaper} from '../paper-core.js';

const close = (a,b) => assert.ok(Math.abs(a-b)<1e-8, `${a} should equal ${b}`);
const corner = (paper, right) => {
  const a = paper.tilt * Math.PI / 180, x = right ? paper.width / 2 : -paper.width / 2;
  return {x: paper.x + paper.width/2 + x*Math.cos(a) + 20*Math.sin(a), y: paper.y + 20 + x*Math.sin(a) - 20*Math.cos(a)};
};
test('either lower corner grows and shrinks, anchoring the opposite side', () => {
  const start = {x: 100, y: 80, width: 250, height: 190, tilt: 0};
  assert.deepEqual(resizePaper(start, 50, 40, 'right'), {x:100,y:80,width:300,height:230});
  assert.deepEqual(resizePaper(start, -50, 40, 'left'), {x:50,y:80,width:300,height:230});
  assert.deepEqual(resizePaper(start, 500, -500, 'left'), {x:160,y:80,width:190,height:120});
});
test('rotated resizing keeps the opposite upper corner fixed in both directions', () => {
  for (const tilt of [-18, 0, 12]) for (const side of ['left','right']) {
    const start = {x:-40,y:120,width:344,height:207,tilt};
    const next = {...start,...resizePaper(start, side==='left'?-110:110, 75, side)};
    const oldCorner=corner(start,side==='left'), newCorner=corner(next,side==='left');
    close(oldCorner.x,newCorner.x); close(oldCorner.y,newCorner.y);
    assert.ok(next.width>start.width); assert.ok(next.height>start.height);
  }
});
