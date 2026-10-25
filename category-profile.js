import {categoriesChanged, categoryStamp, readCategoryFile} from './category-file.js';
import {DriveAuthError, DriveConflictError} from './google-drive.js';

export const ACCOUNT_CATEGORY_NAME = 'Cork categories.txt';

export function categoryProfileKey(base, accountId = '') {
  if (accountId && !/^[\w-]{1,200}$/.test(accountId)) throw new Error('The categories account could not be read.');
  return `${base}:categories:${accountId ? `account:${accountId}` : 'local'}`;
}

export function readCategoryAccount(storage, base) {
  const value = storage.getItem(`${base}:category-account`);
  if (!value) return null;
  const account = JSON.parse(value);
  categoryProfileKey(base, account.id);
  if (!account.id || typeof account.label !== 'string') throw new Error('The categories account could not be read.');
  return {id: account.id, label: account.label.slice(0, 255)};
}

// One owned Drive file is the account's list. Boards never store this link.
// A cached pending edit is compared with its saved revision before any write.
export async function syncCategoryProfile(drive, cached, {prefer = 'merge'} = {}) {
  if (!drive.connected) throw new DriveAuthError('Reconnect Google Drive to save your categories.');
  if (cached?.drive && cached.drive.accountId !== drive.user.permissionId) throw new DriveAuthError('These categories belong to another Google account. Reconnect that account to save them.');
  const remote = await drive.findCategories();
  const dirty = categoriesChanged(cached);
  const sameRevision = remote && cached?.drive?.id === remote.id && cached.drive.version === remote.version;
  const remembered = (data, record) => ({version: 1, name: data.name, text: data.text, token: cached?.token || crypto.randomUUID(), drive: {...record, stamp: categoryStamp(data.text)}});
  if (remote && sameRevision && !dirty && prefer !== 'remote') return {file: {...cached, drive: {...remote, stamp: cached.drive.stamp}}, action: 'unchanged'};
  if (remote && (prefer === 'remote' || !sameRevision || !cached)) {
    const opened = await drive.openCategories(remote.id);
    const data = await readCategoryFile(opened.file);
    if (dirty && prefer === 'merge' && cached.text !== data.text) throw new DriveConflictError('Categories changed on another device. Choose which list to keep in Edit categories.');
    if (prefer !== 'local' || !cached || cached.text === data.text) return {file: remembered(data, opened.record), action: 'loaded'};
    // Explicitly replacing the account list still checks this latest revision.
    const record = await drive.saveCategories(cached.text, opened.record.name, opened.record);
    return {file: remembered({name: record.name, text: cached.text}, record), action: 'saved'};
  }
  if (!cached) throw new Error('Load or enter a categories list before saving to Drive.');
  const name = remote?.name || ACCOUNT_CATEGORY_NAME;
  const record = await drive.saveCategories(cached.text, name, remote);
  return {file: remembered({name, text: cached.text}, record), action: remote ? 'saved' : 'created'};
}
