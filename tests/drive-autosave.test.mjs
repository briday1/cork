import test from 'node:test';
import assert from 'node:assert/strict';
import {DriveAutoSaveQueue} from '../drive-autosave.js';

function clock() {
  let time = 0, counter = 0;
  const timers = new Map();
  return {
    timers, now: () => time,
    setTimer: (fn, delay) => { const id = ++counter; timers.set(id, {fn, due: time + delay}); return id; },
    clearTimer: id => timers.delete(id),
    async advance(amount) { time += amount; for (const [id, timer] of [...timers]) if (timer.due <= time && timers.delete(id)) await timer.fn(); },
  };
}

test('default browser timers do not receive the queue as their window receiver', () => {
  const originalSet = globalThis.setTimeout, originalClear = globalThis.clearTimeout;
  let calls = 0;
  function hostTimer() {
    if (this != null && this !== globalThis) throw new TypeError('Illegal invocation');
    calls++; return calls;
  }
  try {
    globalThis.setTimeout = hostTimer; globalThis.clearTimeout = hostTimer;
    const queue = new DriveAutoSaveQueue({ready: () => true, save: () => {}});
    queue.schedule('board-a'); queue.remove('board-a');
  } finally { globalThis.setTimeout = originalSet; globalThis.clearTimeout = originalClear; }
  assert.ok(calls >= 3);
});

test('typing coalesces into one idle save of the newest board content', async () => {
  const time = clock(), writes = [];
  let content = '';
  const queue = new DriveAutoSaveQueue({...time, ready: () => true, save: id => writes.push([id, content])});
  for (const letter of 'a long edit') { content += letter; queue.schedule('board-a'); await time.advance(100); }
  assert.deepEqual(writes, []);
  await time.advance(2000);
  assert.deepEqual(writes, [['board-a', 'a long edit']]); assert.equal(time.timers.size, 0);
});

test('offline saves wait for reconnect without issuing recurring network requests', async () => {
  const time = clock(), writes = []; let online = false;
  const queue = new DriveAutoSaveQueue({...time, ready: () => online, save: id => writes.push(id)});
  queue.schedule('board-a'); await time.advance(60000);
  assert.deepEqual(writes, []); assert.equal(time.timers.size, 0);
  online = true; queue.resume(); await time.advance(0);
  assert.deepEqual(writes, ['board-a']);
});

test('edits during an upload save afterward and uploads never overlap', async () => {
  const time = clock(), writes = []; let finish, content = 'first';
  const queue = new DriveAutoSaveQueue({...time, ready: () => true, save: async id => {
    writes.push([id, content]); if (writes.length === 1) await new Promise(resolve => { finish = resolve; });
  }});
  queue.schedule('board-a');
  const first = time.advance(2000);
  content = 'newer'; queue.schedule('board-a'); queue.schedule('board-b');
  assert.equal(writes.length, 1); finish(); await first;
  await time.advance(2000); await time.advance(0);
  assert.deepEqual(writes, [['board-a', 'first'], ['board-a', 'newer'], ['board-b', 'newer']]);
});

test('account eligibility is rechecked before background boards upload', async () => {
  const time = clock(), writes = []; let account = 'a';
  const queue = new DriveAutoSaveQueue({...time, ready: id => id.startsWith(account), save: id => writes.push(id)});
  queue.schedule('a-board'); queue.schedule('b-board'); await time.advance(2000);
  assert.deepEqual(writes, ['a-board']); assert.equal(time.timers.size, 0);
  account = 'b'; queue.resume(); await time.advance(0);
  assert.deepEqual(writes, ['a-board', 'b-board']);
});

test('closing or unlinking a board cancels its pending upload', async () => {
  const time = clock();
  const queue = new DriveAutoSaveQueue({...time, ready: () => true, save: () => assert.fail('Closed board uploaded')});
  queue.schedule('board-a'); queue.remove('board-a'); await time.advance(3000);
  assert.equal(time.timers.size, 0);
});
