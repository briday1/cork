import test from 'node:test';
import assert from 'node:assert/strict';
import {GoogleDrive, DRIVE_SCOPE, DriveAuthError, DriveConflictError} from '../google-drive.js';

const config = {clientId: '12345-cork.apps.googleusercontent.com', apiKey: '', appId: ''};
const info = (version = '1', overrides = {}) => ({id: 'board-id', name: 'Board.json', size: '20', modifiedTime: '2026-10-25T16:00:00.000Z', version, capabilities: {canEdit: true}, ...overrides});
const json = (data, headers = {}) => new Response(JSON.stringify(data), {headers: {'Content-Type': 'application/json', ...headers}});

async function connected(responses = [], {clock = () => 1000} = {}) {
  const requests = []; let tokenOptions, authOptions, revoked;
  const identity = {
    initTokenClient(options) { tokenOptions = options; return {requestAccessToken(options) { authOptions = options; queueMicrotask(() => tokenOptions.callback({access_token: 'test-token', expires_in: 3600, scope: DRIVE_SCOPE})); }}; },
    revoke(token) { revoked = token; },
  };
  const client = new GoogleDrive(config, {
    now: clock, identity: () => identity,
    fetch: async (url, options) => {
      requests.push({url, ...options});
      if (url.includes('/about?')) return json({user: {permissionId: 'account-a', displayName: 'Test writer'}});
      assert.ok(responses.length, `Unexpected request: ${url}`);
      const response = responses.shift();
      if (response instanceof Error) throw response;
      return typeof response === 'function' ? response(url, options) : response;
    },
  });
  await client.ready(); await client.authorize(); requests.length = 0;
  return {client, requests, get tokenOptions() { return tokenOptions; }, get authOptions() { return authOptions; }, get revoked() { return revoked; }};
}

test('Drive stays inactive without a site OAuth client and requests only per-file access', async () => {
  const inactive = new GoogleDrive({clientId: ''}, {fetch: () => assert.fail('Unconfigured Drive must not contact Google')});
  assert.equal(inactive.configured, false);
  await assert.rejects(inactive.ready(), /not been enabled/);
  const auth = await connected();
  assert.equal(auth.client.connected, true);
  assert.equal(auth.tokenOptions.scope, DRIVE_SCOPE);
  assert.equal(auth.tokenOptions.include_granted_scopes, false);
  assert.equal(auth.authOptions.prompt, 'select_account');
  assert.equal(auth.client.pickerConfigured, false);
});

test('new boards upload as complete JSON files using a resumable browser upload', async () => {
  const auth = await connected([
    new Response(null, {headers: {Location: 'https://www.googleapis.com/upload/drive/v3/files?upload_id=test'}}),
    json(info('1'), {etag: 'first-revision'}),
  ]);
  const blob = new Blob(['{"name":"Test board"}'], {type: 'application/json'});
  const record = await auth.client.saveBoard(blob, 'Board.json');
  assert.equal(record.kind, 'drive'); assert.equal(record.accountId, 'account-a'); assert.equal(record.version, '1');
  assert.equal(auth.requests[0].method, 'POST');
  assert.equal(new Headers(auth.requests[0].headers).get('X-Upload-Content-Length'), String(blob.size));
  assert.deepEqual(JSON.parse(auth.requests[0].body), {name: 'Board.json', mimeType: 'application/json', appProperties: {cork: 'board'}});
  assert.equal(auth.requests[1].method, 'PUT'); assert.equal(auth.requests[1].body, blob);
  assert.ok(auth.requests.every(request => request.headers.get('Authorization') === 'Bearer test-token'));
});

test('declined consent and closed sign-in popups never authorize Drive calls', async () => {
  for (const outcome of ['denied', 'closed']) {
    const client = new GoogleDrive(config, {identity: () => ({initTokenClient: options => ({requestAccessToken() {
      queueMicrotask(() => outcome === 'closed' ? options.error_callback({type: 'popup_closed'}) : options.callback({error: 'access_denied'}));
    }})}), fetch: () => assert.fail('Declined consent must not access Drive')});
    await client.ready();
    await assert.rejects(client.authorize(), outcome === 'closed' ? /canceled/ : /not granted/);
    assert.equal(client.connected, false);
    await assert.rejects(client.listBoards(), DriveAuthError);
  }
});

test('saving an existing board checks its version and carries the server precondition', async () => {
  const auth = await connected([
    json(info('4'), {etag: 'current-revision'}),
    new Response(null, {headers: {Location: 'https://www.googleapis.com/upload/drive/v3/files/board-id?upload_id=test'}}),
    json(info('5')),
  ]);
  const record = await auth.client.saveBoard(new Blob(['board']), 'Updated.json', {id: 'board-id', version: '4', accountId: 'account-a'});
  assert.equal(record.version, '5');
  assert.equal(auth.requests[1].method, 'PATCH');
  assert.equal(auth.requests[1].headers.get('If-Match'), 'current-revision');
});

test('stale files and other Google accounts cannot overwrite the linked Drive board', async () => {
  const auth = await connected([json(info('9'))]);
  const previous = {id: 'board-id', version: '8', accountId: 'account-a'};
  await assert.rejects(auth.client.saveBoard(new Blob(['board']), 'Board.json', previous), DriveConflictError);
  assert.equal(auth.requests.length, 1, 'no upload follows a version conflict');
  auth.requests.length = 0;
  await assert.rejects(auth.client.saveBoard(new Blob(['board']), 'Board.json', {...previous, accountId: 'account-b'}), DriveAuthError);
  assert.equal(auth.requests.length, 0, 'no file access occurs under the wrong account');
});

test('Drive rejects mid-save precondition failures without updating a file link', async () => {
  const auth = await connected([json(info('2')), new Response(null, {status: 412})]);
  await assert.rejects(auth.client.saveBoard(new Blob(['board']), 'Board.json', {id: 'board-id', version: '2', accountId: 'account-a'}), DriveConflictError);
  assert.equal(auth.requests.length, 2);
});

test('expired or rejected authorization stops requests and asks for reconnection', async () => {
  let time = 1000;
  const auth = await connected([], {clock: () => time});
  time += 3600 * 1000;
  assert.equal(auth.client.connected, false);
  await assert.rejects(auth.client.listBoards(), DriveAuthError);
  assert.equal(auth.requests.length, 0);
  const rejected = await connected([new Response(null, {status: 401})]);
  await assert.rejects(rejected.client.listBoards(), DriveAuthError);
  assert.equal(rejected.client.connected, false);
});

test('offline failures do not become successful saves, and disconnect clears the browser grant', async () => {
  const auth = await connected([new TypeError('network unavailable')]);
  await assert.rejects(auth.client.saveBoard(new Blob(['board']), 'Board.json'), /browser copy is unchanged/);
  assert.equal(auth.requests.length, 1);
  auth.client.disconnect();
  assert.equal(auth.client.connected, false); assert.equal(auth.client.user, null); assert.equal(auth.revoked, 'test-token');
  await assert.rejects(auth.client.listBoards(), DriveAuthError);
});

test('Drive upload locations cannot redirect a bearer token to another host', async () => {
  for (const location of ['https://example.com/upload/drive/v3/files', 'https://www.googleapis.com.evil.test/upload/drive/v3/files', 'http://www.googleapis.com/upload/drive/v3/files', 'https://www.googleapis.com/another-api']) {
    const auth = await connected([new Response(null, {headers: {Location: location}})]);
    await assert.rejects(auth.client.saveBoard(new Blob(['board']), 'Board.json'), /valid upload destination/);
    assert.equal(auth.requests.length, 1);
  }
});

test('opening validates a stable remote revision and returns a portable board file', async () => {
  const auth = await connected([json(info('3')), new Response('{"name":"Portable"}'), json(info('3'))]);
  const remote = await auth.client.openBoard('board-id');
  assert.equal(remote.file.name, 'Board.json'); assert.equal(await remote.file.text(), '{"name":"Portable"}');
  assert.equal(remote.record.version, '3');
  const changing = await connected([json(info('3')), new Response('board'), json(info('4'))]);
  await assert.rejects(changing.client.openBoard('board-id'), DriveConflictError);
});

test('oversize and read-only boards are rejected before any upload', async () => {
  const tooBig = await connected([json(info('1', {size: String(101 * 1024 * 1024)}))]);
  await assert.rejects(tooBig.client.openBoard('board-id'), /100 MB/);
  assert.equal(tooBig.requests.length, 1);
  const readOnly = await connected([json(info('1', {capabilities: {canEdit: false}}))]);
  await assert.rejects(readOnly.client.saveBoard(new Blob(['board']), 'Board.json', {id: 'board-id', version: '1', accountId: 'account-a'}), /read-only/);
  assert.equal(readOnly.requests.length, 1);
});

test('board listings paginate and never ask to search the full Drive account', async () => {
  const auth = await connected([json({files: [info()], nextPageToken: 'next page'})]);
  const result = await auth.client.listBoards('previous page');
  assert.equal(result.nextPageToken, 'next page');
  const query = new URL(auth.requests[0].url).searchParams;
  assert.equal(query.get('pageToken'), 'previous page'); assert.match(query.get('q'), /trashed = false/);
});

test('account categories discovery only selects owned Cork category files', async () => {
  const auth = await connected([json({files: [info('4', {name: 'Cork categories.txt'})]})]);
  const result = await auth.client.findCategories();
  assert.equal(result.name, 'Cork categories.txt'); assert.equal(result.accountId, 'account-a');
  const query = new URL(auth.requests[0].url).searchParams;
  assert.match(query.get('q'), /'me' in owners/);
  assert.match(query.get('q'), /value='categories'/);
  assert.equal(query.get('orderBy'), 'createdTime asc,name');
});

test('categories upload as their own text file with the same narrow authorization', async () => {
  const auth = await connected([
    new Response(null, {headers: {Location: 'https://www.googleapis.com/upload/drive/v3/files?upload_id=categories'}}),
    json(info('1', {name: 'Cork categories.txt'})),
  ]);
  await auth.client.saveCategories('* Ideas\nWork', 'Cork categories.txt');
  assert.deepEqual(JSON.parse(auth.requests[0].body), {name: 'Cork categories.txt', mimeType: 'text/plain', appProperties: {cork: 'categories'}});
  assert.equal(auth.requests[0].headers.get('X-Upload-Content-Type'), 'text/plain');
  assert.equal(await auth.requests[1].body.text(), '* Ideas\nWork');
  assert.equal(auth.tokenOptions.scope, DRIVE_SCOPE);
});

test('categories reject oversized or non-text content before sending it to Google', async () => {
  const auth = await connected();
  assert.throws(() => auth.client.saveCategories('\u0000', 'Cork categories.txt'), /plain text/);
  assert.throws(() => auth.client.saveCategories('é'.repeat(600000), 'Cork categories.txt'), /1 MB/);
  assert.equal(auth.requests.length, 0);
  const remote = await connected([json(info('1', {size: String(2 * 1024 * 1024)}))]);
  await assert.rejects(remote.client.openCategories('board-id'), /1 MB/);
  assert.equal(remote.requests.length, 1);
});
