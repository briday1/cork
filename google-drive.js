import {MAX_CATEGORY_FILE_SIZE, validateCategoryText} from './category-file.js';

export const DRIVE_SCOPE = 'https://www.googleapis.com/auth/drive.file';
const API = 'https://www.googleapis.com/drive/v3';
const UPLOAD = 'https://www.googleapis.com/upload/drive/v3/files';
const FIELDS = 'id,name,size,modifiedTime,version,trashed,capabilities(canEdit)';
const MAX_SIZE = 100 * 1024 * 1024;

export class DriveAuthError extends Error {}
export class DriveConflictError extends Error {}

function fileId(id) {
  if (typeof id !== 'string' || !/^[\w-]{1,200}$/.test(id)) throw new Error('That Drive file could not be opened.');
  return encodeURIComponent(id);
}

function loadScript(src) {
  return new Promise((resolve, reject) => {
    const script = document.createElement('script');
    script.src = src; script.async = true;
    const timeout = setTimeout(fail, 20000);
    function fail() { clearTimeout(timeout); script.remove(); reject(new Error('Google could not be loaded. Check your connection and try again.')); }
    script.onload = () => { clearTimeout(timeout); resolve(); };
    script.onerror = fail; document.head.append(script);
  });
}

export function driveFileRecord(metadata, accountId, etag = '') {
  const modified = Date.parse(metadata.modifiedTime), size = Number(metadata.size);
  fileId(metadata.id);
  if (typeof metadata.name !== 'string' || !metadata.name || !/^\d+$/.test(String(metadata.version)) || !Number.isFinite(modified) || !Number.isFinite(size) || size < 0) throw new Error('Drive returned incomplete file details. Your browser copy is unchanged.');
  return {kind: 'drive', id: metadata.id, accountId, name: metadata.name, version: String(metadata.version), modified, size, etag};
}

// A short-lived token may survive reloads in this tab's sessionStorage only.
// It is never written to board files, localStorage, or IndexedDB.
export class GoogleDrive {
  constructor(config, {fetch = globalThis.fetch.bind(globalThis), now = Date.now, identity = () => globalThis.google?.accounts?.oauth2, onChange = () => {}, storage = () => globalThis.sessionStorage, sessionKey = 'cork:google-drive-session', accountStorage = () => globalThis.localStorage} = {}) {
    this.config = config; this.fetch = fetch; this.now = now; this.identity = identity; this.onChange = onChange;
    this.storage = storage; this.sessionKey = sessionKey; this.accountStorage = accountStorage;
    this.token = ''; this.expiresAt = 0; this.user = null; this.generation = 0;
    this.loginHint = '';
    try {
      const saved = JSON.parse(this.accountStorage()?.getItem(`${this.sessionKey}:account`) || 'null');
      if (saved?.version === 1 && saved.clientId === this.config.clientId && typeof saved.emailAddress === 'string' && /^[^\s@]+@[^\s@]+$/.test(saved.emailAddress) && saved.emailAddress.length <= 255) this.loginHint = saved.emailAddress;
    } catch { /* A remembered account is optional and never authorizes Drive access. */ }
  }

  get configured() { return /^\d+-[\w-]+\.apps\.googleusercontent\.com$/.test(this.config.clientId || ''); }
  get pickerConfigured() { return Boolean(this.config.apiKey && /^\d+$/.test(this.config.appId || '')); }
  get connected() { return Boolean(this.token && this.expiresAt > this.now() && this.user); }
  get remembered() { return Boolean(this.user || this.loginHint); }

  forgetAccount() {
    this.loginHint = '';
    try { this.accountStorage()?.removeItem(`${this.sessionKey}:account`); } catch { /* Disconnect also works when browser storage is blocked. */ }
  }

  rememberAccount() {
    this.forgetAccount();
    const email = this.user?.emailAddress;
    if (typeof email !== 'string' || !/^[^\s@]+@[^\s@]+$/.test(email) || email.length > 255) return;
    this.loginHint = email;
    try {
      // Only an account hint persists between visits, never a token or grant.
      this.accountStorage()?.setItem(`${this.sessionKey}:account`, JSON.stringify({version: 1, clientId: this.config.clientId, emailAddress: email}));
    } catch { /* The hint can still be reused while this page remains open. */ }
  }

  forgetSession() {
    try { this.storage()?.removeItem(this.sessionKey); } catch { /* Memory-only authorization still works when browser storage is blocked. */ }
  }

  rememberSession() {
    try {
      this.storage()?.setItem(this.sessionKey, JSON.stringify({version: 1, clientId: this.config.clientId, token: this.token, expiresAt: this.expiresAt, accountId: this.user.permissionId}));
    } catch { this.forgetSession(); }
  }

  clearAuthorization() {
    this.token = ''; this.expiresAt = 0;
    clearTimeout(this.expiryTimer); this.forgetSession();
  }

  scheduleExpiry() {
    clearTimeout(this.expiryTimer);
    this.expiryTimer = setTimeout(() => { this.clearAuthorization(); this.onChange(); }, Math.max(0, this.expiresAt - this.now()));
    this.expiryTimer.unref?.();
  }

  async restore() {
    if (!this.configured) return null;
    if (this.connected) return this.user;
    if (this.pending) return this.pending.promise;
    if (this.restoring) return this.restoring;
    let saved;
    try {
      const value = this.storage()?.getItem(this.sessionKey);
      if (!value) return null;
      saved = JSON.parse(value);
      if (saved?.version !== 1 || saved.clientId !== this.config.clientId || typeof saved.token !== 'string' || !saved.token || typeof saved.accountId !== 'string' || !saved.accountId || !Number.isFinite(saved.expiresAt) || saved.expiresAt <= this.now()) throw new Error('Invalid or expired session');
    } catch { this.forgetSession(); return null; }
    const generation = ++this.generation;
    this.token = saved.token; this.expiresAt = saved.expiresAt; this.user = null;
    const restoring = (async () => {
      try {
        await this.ready();
        if (generation !== this.generation) return null;
        const response = await this.request(`${API}/about?fields=user(permissionId,displayName,emailAddress)`);
        const {user} = await response.json();
        if (generation !== this.generation) return null;
        if (user?.permissionId !== saved.accountId) throw new DriveAuthError('The remembered Google account could not be verified. Reconnect Google Drive to continue.');
        this.user = user; this.rememberAccount(); this.scheduleExpiry(); this.onChange();
        return user;
      } catch (error) {
        if (generation !== this.generation) return null;
        // Offline failures keep the unexpired tab session available for retry.
        this.token = ''; this.expiresAt = 0;
        if (error instanceof DriveAuthError) this.forgetSession();
        this.onChange(); throw error;
      }
    })();
    this.restoring = restoring;
    try { return await restoring; }
    finally { if (this.restoring === restoring) this.restoring = null; }
  }

  async ready() {
    if (!this.configured) throw new Error('Google Drive has not been enabled for this site yet. Your boards are still saved in this browser.');
    if (this.client) return;
    if (this.loading) return this.loading;
    this.loading = (async () => {
      if (!this.identity()) await loadScript('https://accounts.google.com/gsi/client');
      this.client = this.identity().initTokenClient({
        client_id: this.config.clientId, scope: DRIVE_SCOPE, include_granted_scopes: false,
        callback: response => this.receiveToken(response),
        error_callback: error => this.authorizationFailed(new DriveAuthError(error.type === 'popup_closed' ? 'Google sign-in was canceled. Your browser copy is unchanged.' : 'Google sign-in could not open. Allow the sign-in popup and try again.')),
      });
    })();
    try { await this.loading; } finally { this.loading = null; }
  }

  // Call directly from a click after ready(), before awaiting other work.
  authorize() {
    if (!this.client) return Promise.reject(new DriveAuthError('Open Google Drive and wait for the Connect button to become available.'));
    if (this.pending) return this.pending.promise;
    this.generation++;
    const promise = new Promise((resolve, reject) => { this.pending = {resolve, reject}; });
    this.pending.promise = promise;
    const loginHint = this.user?.emailAddress || this.loginHint;
    try { this.client.requestAccessToken({prompt: this.remembered ? '' : 'select_account', ...(loginHint ? {login_hint: loginHint} : {})}); }
    catch { this.authorizationFailed(new DriveAuthError('Google sign-in could not open. Try Connect again.')); }
    return promise;
  }

  async receiveToken(response) {
    const pending = this.pending;
    if (!pending) return;
    if (response.error || !response.access_token || !Number.isFinite(Number(response.expires_in)) || !(Number(response.expires_in) > 30) || !String(response.scope || '').split(' ').includes(DRIVE_SCOPE)) {
      return this.authorizationFailed(new DriveAuthError('Google Drive access was not granted. Your browser copy is unchanged.'));
    }
    this.generation++; this.token = response.access_token;
    this.expiresAt = this.now() + (Number(response.expires_in) - 30) * 1000;
    try {
      const response = await this.request(`${API}/about?fields=user(permissionId,displayName,emailAddress)`);
      const {user} = await response.json();
      if (this.pending !== pending) return;
      if (!user?.permissionId) throw new DriveAuthError('Google could not identify the connected account. Try Connect again.');
      this.user = user;
      this.rememberAccount(); this.rememberSession(); this.scheduleExpiry();
      this.pending = null; this.onChange(); pending.resolve(user);
    } catch (error) { if (this.pending === pending) this.authorizationFailed(error); }
  }

  authorizationFailed(error) {
    this.clearAuthorization();
    const pending = this.pending; this.pending = null; this.onChange(); pending?.reject(error);
  }

  disconnect() {
    const token = this.token; this.generation++; this.token = ''; this.expiresAt = 0; this.user = null;
    this.forgetAccount();
    clearTimeout(this.expiryTimer);
    this.authorizationFailed(new DriveAuthError('Google Drive was disconnected. Your browser copy is unchanged.'));
    try { if (token) this.identity()?.revoke(token, () => {}); } catch { /* The browser session is disconnected even if Google is unreachable. */ }
  }

  async request(url, options = {}) {
    if (!this.token || this.expiresAt <= this.now()) {
      this.clearAuthorization(); this.onChange();
      throw new DriveAuthError('Reconnect Google Drive to continue. Your changes are still saved in this browser.');
    }
    const generation = this.generation, headers = new Headers(options.headers);
    headers.set('Authorization', `Bearer ${this.token}`);
    let response;
    try { response = await this.fetch(url, {...options, headers, ...(typeof AbortSignal.timeout === 'function' ? {signal: AbortSignal.timeout(90000)} : {})}); }
    catch { throw new Error('Google Drive could not be reached. Your browser copy is unchanged; try again when you are online.'); }
    if (generation !== this.generation) throw new DriveAuthError('The Drive connection changed. Reconnect before continuing.');
    if (response.status === 401) {
      this.clearAuthorization(); this.onChange();
      throw new DriveAuthError('Reconnect Google Drive to continue. Your changes are still saved in this browser.');
    }
    if (response.status === 409 || response.status === 412) throw new DriveConflictError('This file changed in Drive. Your browser changes have been kept.');
    if (response.status === 404) throw new Error('This Drive file is no longer available to this account. Your browser changes have been kept.');
    if (response.status === 403) throw new Error('Google Drive did not allow this request. Check file access and available storage, or save a local copy.');
    if (!response.ok) throw new Error('Google Drive could not finish that request. Your browser copy is unchanged. Please try again.');
    return response;
  }

  async metadata(id) {
    const response = await this.request(`${API}/files/${fileId(id)}?fields=${encodeURIComponent(FIELDS)}`);
    const data = await response.json();
    if (data.trashed) throw new Error('This file is in Drive Trash. Restore it in Drive or save a new copy.');
    return {data, record: driveFileRecord(data, this.user?.permissionId, response.headers.get('etag') || '')};
  }

  async listBoards(pageToken = '') {
    const query = new URLSearchParams({q: "trashed = false and (mimeType = 'application/json' or appProperties has { key='cork' and value='board' })", fields: `nextPageToken,files(${FIELDS})`, pageSize: '100', orderBy: 'modifiedTime desc'});
    if (pageToken) query.set('pageToken', pageToken);
    const response = await this.request(`${API}/files?${query}`);
    return response.json();
  }

  async findCategories() {
    const query = new URLSearchParams({q: "trashed = false and 'me' in owners and appProperties has { key='cork' and value='categories' }", fields: `nextPageToken,files(${FIELDS})`, pageSize: '1', orderBy: 'createdTime asc,name'});
    let page;
    do {
      const response = await this.request(`${API}/files?${query}`);
      page = await response.json();
      if (page.files?.length) return driveFileRecord(page.files[0], this.user.permissionId);
      if (page.nextPageToken) query.set('pageToken', page.nextPageToken);
    } while (page.nextPageToken);
    return null;
  }

  openBoard(id) { return this.openFile(id); }

  openCategories(id) { return this.openFile(id, {limit: MAX_CATEGORY_FILE_SIZE, mimeType: 'text/plain', label: 'categories', sizeLabel: '1 MB'}); }

  async openFile(id, {limit = MAX_SIZE, mimeType = 'application/json', label = 'board', sizeLabel = '100 MB'} = {}) {
    const before = await this.metadata(id);
    if (before.record.size > limit) throw new Error(`Choose a ${label} file smaller than ${sizeLabel}.`);
    const response = await this.request(`${API}/files/${fileId(id)}?alt=media`);
    const blob = await response.blob();
    if (blob.size > limit) throw new Error(`Choose a ${label} file smaller than ${sizeLabel}.`);
    const after = await this.metadata(id);
    if (before.record.version !== after.record.version) throw new DriveConflictError(`These ${label} contents changed while opening. Try opening them again.`);
    return {file: new File([blob], after.record.name, {type: mimeType, lastModified: after.record.modified}), record: after.record};
  }

  saveBoard(blob, name, previous = null) { return this.saveFile(blob, name, previous); }

  saveCategories(text, name, previous = null) {
    validateCategoryText(text);
    return this.saveFile(new Blob([text], {type: 'text/plain'}), name, previous, {mimeType: 'text/plain', type: 'categories', limit: MAX_CATEGORY_FILE_SIZE});
  }

  async saveFile(blob, name, previous = null, {mimeType = 'application/json', type = 'board', limit = MAX_SIZE} = {}) {
    if (!this.connected) throw new DriveAuthError('Reconnect Google Drive to save. Your changes are still saved in this browser.');
    if (blob.size > limit) throw new Error('This file is too large to save to Drive. Save a local copy instead.');
    if (previous && previous.accountId !== this.user.permissionId) throw new DriveAuthError('This file is linked to another Google account. Connect that account or save a Drive copy.');
    let remote;
    if (previous) {
      remote = await this.metadata(previous.id);
      if (remote.record.version !== previous.version) throw new DriveConflictError(`This ${type} file changed in Drive. Your browser changes have been kept.`);
      if (remote.data.capabilities?.canEdit === false) throw new Error('This Drive file is read-only. Save a Drive copy to keep your changes.');
    }
    const headers = {'Content-Type': 'application/json; charset=UTF-8', 'X-Upload-Content-Type': mimeType, 'X-Upload-Content-Length': String(blob.size)};
    if (remote?.record.etag) headers['If-Match'] = remote.record.etag;
    const url = `${UPLOAD}${previous ? `/${fileId(previous.id)}` : ''}?uploadType=resumable&fields=${encodeURIComponent(FIELDS)}`;
    const session = await this.request(url, {
      method: previous ? 'PATCH' : 'POST', headers,
      body: JSON.stringify({name, mimeType, appProperties: {cork: type}}),
    });
    const location = session.headers.get('location');
    let target;
    try { target = new URL(location); } catch { /* Validated below before sending a token. */ }
    if (!target || target.protocol !== 'https:' || !['www.googleapis.com', 'content.googleapis.com'].includes(target.hostname) || !target.pathname.startsWith('/upload/drive/v3/files') || target.username || target.password || target.port) throw new Error('Drive did not return a valid upload destination. Your browser copy is unchanged.');
    const response = await this.request(target.href, {method: 'PUT', headers: {'Content-Type': mimeType}, body: blob});
    return driveFileRecord(await response.json(), this.user.permissionId, response.headers.get('etag') || '');
  }

  async pickBoard() {
    if (!this.connected) throw new DriveAuthError('Connect Google Drive before choosing a board.');
    if (!this.pickerConfigured) throw new Error('The Google file picker has not been enabled for this site.');
    if (!globalThis.google?.picker) {
      if (!globalThis.gapi) await loadScript('https://apis.google.com/js/api.js');
      await new Promise((resolve, reject) => globalThis.gapi.load('picker', {callback: resolve, onerror: () => reject(new Error('Google’s file picker could not load. Try again.')), timeout: 20000, ontimeout: () => reject(new Error('Google’s file picker timed out. Try again.'))}));
    }
    // Loading Google's scripts can outlast an existing access token.
    if (!this.connected) throw new DriveAuthError('Reconnect Google Drive before choosing a board.');
    return new Promise(resolve => {
      const pickerApi = globalThis.google.picker;
      const view = new pickerApi.DocsView().setMimeTypes('application/json,text/plain,application/octet-stream').setIncludeFolders(true).setSelectFolderEnabled(false);
      const picker = new pickerApi.PickerBuilder().setTitle('Open a Cork board').setDeveloperKey(this.config.apiKey)
        .setAppId(this.config.appId).setOrigin(location.origin).setOAuthToken(this.token).addView(view)
        .setCallback(data => {
          if (data.action === pickerApi.Action.PICKED) { picker.dispose(); resolve(data.docs?.[0]?.id || null); }
          if (data.action === pickerApi.Action.CANCEL) { picker.dispose(); resolve(null); }
        }).build();
      picker.setVisible(true);
    });
  }
}
