import test from 'node:test';
import assert from 'node:assert/strict';
import {ACCOUNT_CATEGORY_NAME, categoryProfileKey, readCategoryAccount, syncCategoryProfile} from '../category-profile.js';
import {categoryStamp, categoriesChanged, readCategoryCache, writeCategoryCache} from '../category-file.js';
import {DriveAuthError, DriveConflictError} from '../google-drive.js';

const local = (text, extra = {}) => ({version: 1, name: 'Local.txt', text, token: 'cached-text', ...extra});
const record = (version = '1', accountId = 'account-a') => ({kind: 'drive', id: 'categories-id', accountId, name: ACCOUNT_CATEGORY_NAME, version, modified: 1000, size: 12, etag: 'revision-' + version});
const cached = (text = 'Ideas', extra = {}) => local(text, {drive: {...record(), stamp: categoryStamp(text)}, ...extra});

function accountDrive(text = 'Ideas', version = '1') {
  const calls = [], remote = {text, version};
  return {
    connected: true, user: {permissionId: 'account-a'}, calls, remote,
    async findCategories() { calls.push('find'); return remote.text === null ? null : record(remote.version); },
    async openCategories(id) { assert.equal(id, 'categories-id'); calls.push('read'); return {file: new File([remote.text], ACCOUNT_CATEGORY_NAME), record: record(remote.version)}; },
    async saveCategories(text, name, previous) {
      calls.push('write'); assert.equal(name, ACCOUNT_CATEGORY_NAME);
      if (previous) assert.equal(previous.version, remote.version);
      remote.text = text; remote.version = String(Number(remote.version) + 1);
      return record(remote.version);
    },
  };
}

test('the shared categories cache is keyed only by account and keeps accounts isolated', () => {
  const values = new Map(), storage = {getItem: k => values.get(k) ?? null, setItem: (k, v) => values.set(k, v)};
  const base = 'cork:/cork/';
  writeCategoryCache(storage, categoryProfileKey(base, 'account-a'), cached('Private A'));
  writeCategoryCache(storage, categoryProfileKey(base, 'account-b'), local('Private B'));
  assert.equal(readCategoryCache(storage, categoryProfileKey(base, 'account-a')).text, 'Private A');
  assert.equal(readCategoryCache(storage, categoryProfileKey(base, 'account-b')).text, 'Private B');
  assert.equal(readCategoryCache(storage, categoryProfileKey(base)), null);
  storage.setItem(base + ':category-account', JSON.stringify({id: 'account-a', label: 'Writer A'}));
  assert.deepEqual(readCategoryAccount(storage, base), {id: 'account-a', label: 'Writer A'});
  assert.throws(() => categoryProfileKey(base, '../another-profile'));
});

test('first connection creates one account text file, then reconnecting only checks it', async () => {
  const drive = accountDrive(null);
  const first = await syncCategoryProfile(drive, local('* Ideas\nWork'));
  assert.equal(first.action, 'created'); assert.equal(drive.remote.text, '* Ideas\nWork');
  assert.equal(categoriesChanged(first.file), false);
  drive.calls.length = 0;
  const again = await syncCategoryProfile(drive, first.file);
  assert.equal(again.action, 'unchanged'); assert.deepEqual(drive.calls, ['find']);
});

test('an existing account list loads on a new device instead of uploading browser defaults', async () => {
  const drive = accountDrive('Account list', '9');
  const result = await syncCategoryProfile(drive, local('Browser defaults'));
  assert.equal(result.file.text, 'Account list'); assert.equal(result.file.drive.version, '9');
  assert.deepEqual(drive.calls, ['find', 'read']);
});

test('category edits update the same file and carry its latest known revision', async () => {
  const drive = accountDrive();
  const result = await syncCategoryProfile(drive, {...cached(), text: 'Ideas\nNew', pending: true});
  assert.equal(result.file.drive.id, 'categories-id'); assert.equal(result.file.drive.version, '2');
  assert.equal(categoriesChanged(result.file), false); assert.equal(drive.remote.text, 'Ideas\nNew');
  assert.deepEqual(drive.calls, ['find', 'write']);
});

test('external edits reload clean caches and never get overwritten by them', async () => {
  const drive = accountDrive('Updated elsewhere', '2');
  const result = await syncCategoryProfile(drive, cached());
  assert.equal(result.file.text, 'Updated elsewhere'); assert.deepEqual(drive.calls, ['find', 'read']);
});

test('conflicting offline edits keep both lists until the user chooses a resolution', async () => {
  const drive = accountDrive('Other device', '2'), mine = {...cached(), text: 'My offline edit', pending: true};
  await assert.rejects(syncCategoryProfile(drive, mine), DriveConflictError);
  assert.equal(mine.text, 'My offline edit'); assert.equal(drive.remote.text, 'Other device');
  assert.equal(drive.calls.includes('write'), false);
  const theirs = await syncCategoryProfile(drive, mine, {prefer: 'remote'});
  assert.equal(theirs.file.text, 'Other device');
  const ours = await syncCategoryProfile(drive, mine, {prefer: 'local'});
  assert.equal(ours.file.text, 'My offline edit'); assert.equal(drive.remote.text, 'My offline edit');
});

test('an upload completed on another device is recognized without writing a duplicate', async () => {
  const drive = accountDrive('Already saved', '2');
  const result = await syncCategoryProfile(drive, {...cached(), text: 'Already saved', pending: true});
  assert.equal(categoriesChanged(result.file), false); assert.deepEqual(drive.calls, ['find', 'read']);
});

test('wrong accounts and expired connections cannot read or save a cached account list', async () => {
  const drive = accountDrive();
  await assert.rejects(syncCategoryProfile(drive, {...cached(), drive: {...record('1', 'account-b'), stamp: categoryStamp('Ideas')}}), DriveAuthError);
  assert.deepEqual(drive.calls, []);
  drive.connected = false;
  await assert.rejects(syncCategoryProfile(drive, cached()), DriveAuthError);
  assert.deepEqual(drive.calls, []);
});

test('invalid remote text and failed uploads leave the recoverable browser cache intact', async () => {
  const drive = accountDrive('binary\u0000data', '2'), mine = cached();
  await assert.rejects(syncCategoryProfile(drive, mine), /plain text/);
  assert.equal(mine.text, 'Ideas');
  drive.remote.version = '1';
  drive.saveCategories = async () => { throw new Error('Offline'); };
  await assert.rejects(syncCategoryProfile(drive, {...mine, text: 'Pending', pending: true}), /Offline/);
  assert.equal(mine.drive.version, '1');
});
