import test from 'node:test';
import assert from 'node:assert/strict';
import {readCategoryFile, readCategoryCache, writeCategoryCache, readLinkedCategories} from '../category-file.js';

const file = (text, name = 'My categories.txt') => new File([text], name, {type: 'text/plain'});
const memoryStorage = () => {
  const values = new Map();
  return {getItem: key => values.get(key) ?? null, setItem: (key, value) => values.set(key, value), removeItem: key => values.delete(key)};
};

test('remembered categories survive a new visit without needing the original file', async () => {
  const storage = memoryStorage(), key = 'cork.board.v1:/cork/:categories';
  const loaded = {version: 1, ...await readCategoryFile(file('\uFEFF* Ideas\r\nWork\r\n')), token: 'selected-file'};
  writeCategoryCache(storage, key, loaded);
  assert.deepEqual(readCategoryCache(storage, key), loaded);
  assert.equal(readCategoryCache(storage, 'another-app'), null, 'category choices are scoped to the app path');
  writeCategoryCache(storage, key, null);
  assert.equal(readCategoryCache(storage, key), null, 'Use default removes the local override');
});

test('an empty local list stays an intentional override of the default', async () => {
  const storage = memoryStorage();
  const loaded = {version: 1, ...await readCategoryFile(file('')), token: 'empty-file'};
  writeCategoryCache(storage, 'categories', loaded);
  assert.equal(readCategoryCache(storage, 'categories').text, '');
});

test('binary, oversized, and broken saved lists fail without overwriting the previous copy', async () => {
  const storage = memoryStorage(), loaded = {version: 1, name: 'Good.txt', text: 'Ideas', token: 'good'};
  writeCategoryCache(storage, 'categories', loaded);
  await assert.rejects(readCategoryFile(file('binary\u0000data')), /plain text/);
  await assert.rejects(readCategoryFile(file('x'.repeat(1024 * 1024 + 1))), /smaller than 1 MB/);
  assert.deepEqual(readCategoryCache(storage, 'categories'), loaded);
  storage.setItem('categories', '{broken JSON');
  assert.throws(() => readCategoryCache(storage, 'categories'));
  storage.setItem('categories', JSON.stringify({...loaded, version: 99}));
  assert.throws(() => readCategoryCache(storage, 'categories'));
});

test('automatic file checks read current disk contents but never request permission', async () => {
  let contents = 'Ideas', reads = 0, requests = 0;
  const handle = {
    queryPermission: async options => { assert.deepEqual(options, {mode: 'read'}); return 'granted'; },
    requestPermission: async () => { requests++; return 'granted'; },
    getFile: async () => { reads++; return file(contents); },
  };
  assert.equal((await readLinkedCategories(handle)).text, 'Ideas');
  contents = '* Work\nNew category';
  assert.equal((await readLinkedCategories(handle)).text, contents);
  assert.equal(reads, 2);
  assert.equal(requests, 0);
  handle.queryPermission = async () => 'prompt';
  assert.equal(await readLinkedCategories(handle), null);
  assert.equal(reads, 2, 'expired permission does not try reading the file');
  assert.equal(requests, 0, 'no permission prompt on a return visit');
});

test('explicit Refresh can request read permission; denial does not access the file', async () => {
  let permission = 'denied', requests = 0, reads = 0;
  const handle = {
    requestPermission: async options => { assert.deepEqual(options, {mode: 'read'}); requests++; return permission; },
    getFile: async () => { reads++; return file('Current categories'); },
  };
  assert.equal(await readLinkedCategories(handle, true), null);
  assert.equal(reads, 0);
  permission = 'granted';
  assert.equal((await readLinkedCategories(handle, true)).text, 'Current categories');
  assert.equal(requests, 2);
  assert.equal(reads, 1);
});
