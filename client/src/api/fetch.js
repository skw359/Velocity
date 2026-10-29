// A bare 403 means the session is gone, so go to login. A JSON 403 is a refused
// action (read-only drive, owner-only page) for the caller to report.
export async function fetchWithAuthCheck(url, options) {
  const response = await fetch(url, options);
  if (response.status === 403 && !(response.headers.get('content-type') || '').includes('application/json')) {
    window.location.href = '/';
    return new Promise(() => {});
  }
  return response;
}

export async function apiGetDrives() {
  const res = await fetchWithAuthCheck('/api/drives');
  if (!res.ok) throw new Error('Failed to load drives');
  return res.json();
}

export async function apiGetStorage(drive) {
  const res = await fetchWithAuthCheck(`/api/storage?drive=${encodeURIComponent(drive)}`);
  if (!res.ok) throw new Error('Failed');
  return res.json();
}

export async function apiGetNetworkStats() {
  const res = await fetchWithAuthCheck('/api/network-stats');
  if (!res.ok) throw new Error('Failed');
  return res.json();
}

export async function apiGetCpuUtilization() {
  const res = await fetchWithAuthCheck('/api/cpu-utilization');
  if (!res.ok) throw new Error('Failed');
  return res.json();
}

export async function apiGetBandwidth() {
  const res = await fetchWithAuthCheck('/api/bandwidth');
  if (!res.ok) throw new Error('Failed');
  return res.json();
}

export async function apiListFiles(path, drive, signal) {
  const res = await fetchWithAuthCheck(`/api/list?path=${encodeURIComponent(path)}&drive=${encodeURIComponent(drive)}`, { signal });
  if (!res.ok) throw new Error(`Server responded with ${res.status}`);
  return res.json();
}

export async function apiGetSize(name, path, drive, signal) {
  const res = await fetchWithAuthCheck(`/api/get-size?name=${encodeURIComponent(name)}&path=${encodeURIComponent(path)}&drive=${encodeURIComponent(drive)}`, { signal });
  if (!res.ok) throw new Error('Response not OK');
  return res.json();
}

export async function apiGetInfo(name, path, drive) {
  const res = await fetchWithAuthCheck(`/api/info?name=${encodeURIComponent(name)}&path=${encodeURIComponent(path)}&drive=${encodeURIComponent(drive)}`);
  if (!res.ok) throw new Error('Failed to fetch info');
  return res.json();
}

// items: [{ name, path, drive }]. Combined totals for a multi-selection.
export async function apiGetSelectionInfo(items) {
  const res = await fetchWithAuthCheck('/api/info-multiple', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ items }),
  });
  if (!res.ok) throw new Error('Failed to fetch info');
  return res.json();
}

export async function apiDeleteItem(name, path, drive) {
  const formData = new FormData();
  formData.append('name', name);
  formData.append('path', path);
  formData.append('drive', drive);
  return fetchWithAuthCheck('/api/delete', { method: 'POST', body: formData });
}

export async function apiRenameItem(oldName, newName, path, drive) {
  const formData = new FormData();
  formData.append('oldName', oldName);
  formData.append('newName', newName);
  formData.append('path', path);
  formData.append('drive', drive);
  return fetchWithAuthCheck('/api/rename', { method: 'POST', body: formData });
}

// Returns { conflicts: [{ name, type }], existingNames: [...] } for the given top-level names.
export async function apiCheckConflicts(path, drive, names) {
  const formData = new FormData();
  formData.append('path', path);
  formData.append('drive', drive);
  formData.append('names', JSON.stringify(names));
  const res = await fetchWithAuthCheck('/api/check-conflicts', { method: 'POST', body: formData });
  if (!res.ok) throw new Error('Failed to check for conflicts');
  return res.json();
}

export async function apiCreateFolder(folder, path, drive) {
  const formData = new FormData();
  formData.append('folder', folder);
  formData.append('path', path);
  formData.append('drive', drive);
  return fetchWithAuthCheck('/api/create-folder', { method: 'POST', body: formData });
}

export async function apiCreateFile(filename, path, drive) {
  const formData = new FormData();
  formData.append('filename', filename);
  formData.append('path', path);
  formData.append('drive', drive);
  return fetchWithAuthCheck('/api/create-file', { method: 'POST', body: formData });
}

export async function apiSaveFile(name, path, drive, content) {
  return fetchWithAuthCheck('/api/save-file', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name, path, drive, content }),
  });
}

export async function apiExtract(name, path, drive) {
  const formData = new FormData();
  formData.append('name', name);
  formData.append('path', path);
  formData.append('drive', drive);
  return fetchWithAuthCheck('/api/extract', { method: 'POST', body: formData });
}

export async function apiCompress(name, type, path, drive) {
  const formData = new FormData();
  formData.append('name', name);
  formData.append('path', path);
  formData.append('type', type);
  formData.append('drive', drive);
  return fetchWithAuthCheck('/api/compress', { method: 'POST', body: formData });
}

export async function apiCopy(name, path, drive) {
  const formData = new FormData();
  formData.append('name', name);
  formData.append('path', path);
  formData.append('drive', drive);
  return fetchWithAuthCheck('/api/copy', { method: 'POST', body: formData });
}

export async function apiTransfer({ name, sourcePath, sourceDrive, destPath, destDrive, mode, conflict }) {
  const formData = new FormData();
  formData.append('name', name);
  formData.append('sourcePath', sourcePath);
  formData.append('sourceDrive', sourceDrive);
  formData.append('destPath', destPath);
  formData.append('destDrive', destDrive);
  formData.append('mode', mode);
  // 'replace' | 'rename': only sent when resolving a name clash.
  if (conflict) formData.append('conflict', conflict);
  return fetchWithAuthCheck('/api/transfer', { method: 'POST', body: formData });
}

// Refusals before an operation starts: 507 = not enough space, JSON 403 = drive access denied.
// The error's message is the banner title and `detail` the server's explanation.
const INSUFFICIENT_STORAGE = 'insufficient_storage';
const REFUSAL_TITLES = {
  [INSUFFICIENT_STORAGE]: 'Insufficient storage space',
  read_only_drive: 'Read-only drive',
  drive_unavailable: 'Drive not available',
};

function isRefusalResponse(res) {
  return res.status === 507 || res.status === 403;
}

async function refusalError(res) {
  let body = {};
  try { body = await res.json(); } catch { /* keep the defaults */ }
  const code = res.status === 507 ? INSUFFICIENT_STORAGE : body.error;
  const err = new Error(REFUSAL_TITLES[code] || body.message || 'Operation not allowed');
  err.code = code;
  err.detail = (code === INSUFFICIENT_STORAGE ? body.detail : body.message) || '';
  err.refused = true;
  return err;
}

export function isRefusal(err) {
  return !!err?.refused;
}

export function isStorageError(err) {
  return err?.code === INSUFFICIENT_STORAGE;
}

export async function apiEnqueueOperation(payload) {
  const res = await fetchWithAuthCheck('/api/operations', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  if (isRefusalResponse(res)) throw await refusalError(res);
  if (!res.ok) throw new Error((await res.text()) || 'Failed to start operation');
  return res.json();
}

// Dry run of the enqueue checks (drive access, free space). Throws only for a refusal;
// any other failure lets the work go ahead.
export async function apiCheckSpace(payload) {
  let res;
  try {
    res = await fetchWithAuthCheck('/api/check-space', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
  } catch {
    return;
  }
  if (isRefusalResponse(res)) throw await refusalError(res);
}

// items: [{ name, path, drive }], zipped together by the server. Resolves to the zip's Blob.
export async function apiDownloadMultiple(items) {
  const res = await fetchWithAuthCheck('/api/download-multiple', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ items }),
  });
  if (isRefusalResponse(res)) throw await refusalError(res);
  if (!res.ok) throw new Error((await res.text()) || 'Download failed');
  return res.blob();
}

// Active (pending|running) operations for the current user.
export async function apiListOperations() {
  const res = await fetchWithAuthCheck('/api/operations');
  if (!res.ok) throw new Error('Failed to load operations');
  return res.json();
}

export async function apiGetOperation(id) {
  const res = await fetchWithAuthCheck(`/api/operations/${encodeURIComponent(id)}`);
  if (!res.ok) throw new Error('Failed to load operation');
  return res.json();
}

export async function apiCancelOperation(id) {
  return fetchWithAuthCheck(`/api/operations/${encodeURIComponent(id)}`, { method: 'DELETE' });
}

export async function apiHeartbeatOperation(id) {
  return fetchWithAuthCheck(`/api/operations/${encodeURIComponent(id)}/heartbeat`, { method: 'POST' });
}

// Bytes already written for an upload file, for resuming.
export async function apiGetUploadOffset(opId, file) {
  const res = await fetchWithAuthCheck(`/api/upload-offset?opId=${encodeURIComponent(opId)}&file=${encodeURIComponent(file)}`);
  if (!res.ok) return { offset: 0 };
  return res.json();
}

export async function apiGetRawPreview(path, drive) {
  const res = await fetchWithAuthCheck(`/api/preview/raw?path=${encodeURIComponent(path)}&drive=${encodeURIComponent(drive)}`);
  if (!res.ok) {
    const errorData = await res.json();
    throw new Error(errorData.message || 'Preview not available');
  }
  return res.json();
}

export async function apiGetVideoPreview(path, drive) {
  const res = await fetchWithAuthCheck(`/api/preview/video?path=${encodeURIComponent(path)}&drive=${encodeURIComponent(drive)}`);
  if (!res.ok) {
    const errorData = await res.json();
    throw new Error(errorData.message || 'Preview not available');
  }
  return res.json();
}

export async function apiCheckAuth() {
  const res = await fetch('/api/auth-status');
  if (!res.ok) return { loggedIn: false };
  return res.json();
}

// Resolves to { success, user }; `user` decides what Settings may show.
export async function apiLogin(username, password) {
  const formData = new URLSearchParams();
  formData.append('username', username);
  formData.append('password', password);
  const res = await fetch('/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: formData,
  });
  if (!res.ok) {
    const err = new Error(res.status === 429
      ? 'Too many attempts. Try again in a few minutes.'
      : 'The provided credentials are invalid.');
    err.status = res.status;
    throw err;
  }
  return res.json();
}

// Returns { share: {...} | null }.
export async function apiGetShare(name, path, drive) {
  const res = await fetchWithAuthCheck(`/api/share?name=${encodeURIComponent(name)}&path=${encodeURIComponent(path)}&drive=${encodeURIComponent(drive)}`);
  if (!res.ok) throw new Error('Failed to load share');
  return res.json();
}

// Creates the share link, or returns the existing one: { share }.
export async function apiCreateShare(name, path, drive) {
  const formData = new FormData();
  formData.append('name', name);
  formData.append('path', path);
  formData.append('drive', drive);
  const res = await fetchWithAuthCheck('/api/share', { method: 'POST', body: formData });
  if (!res.ok) throw new Error('Failed to create share link');
  return res.json();
}

// items: [{ name, path, drive }]. One link for all of them; returns the existing one if this
// exact selection is already shared.
export async function apiCreateSelectionShare(items) {
  const res = await fetchWithAuthCheck('/api/share-multiple', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ items }),
  });
  if (!res.ok) throw new Error((await res.text()) || 'Failed to create share link');
  return res.json();
}

// access: 'public' (anyone with the link) or 'restricted' (owner only).
export async function apiSetShareAccess(token, access) {
  const res = await fetchWithAuthCheck(`/api/share/${encodeURIComponent(token)}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ access }),
  });
  if (!res.ok) throw new Error('Failed to update share link');
  return res.json();
}

export async function apiRevokeShare(token) {
  const res = await fetchWithAuthCheck(`/api/share/${encodeURIComponent(token)}`, { method: 'DELETE' });
  if (!res.ok) throw new Error('Failed to revoke share link');
  return res.json();
}

// Public share endpoints use plain fetch: a 403 on a restricted link must not redirect to login.
export async function apiShareMeta(token) {
  const res = await fetch(`/api/public/share/${encodeURIComponent(token)}`);
  const data = await res.json().catch(() => ({}));
  return { ok: res.ok, status: res.status, data };
}

export async function apiShareList(token, subpath = '') {
  const res = await fetch(`/api/public/share/${encodeURIComponent(token)}/list?subpath=${encodeURIComponent(subpath)}`);
  if (!res.ok) throw new Error('Failed to load folder contents');
  return res.json();
}

export function shareRawUrl(token, subpath = '') {
  return `/api/public/share/${encodeURIComponent(token)}/raw?subpath=${encodeURIComponent(subpath)}`;
}

export function shareDownloadUrl(token, subpath = '') {
  return `/api/public/share/${encodeURIComponent(token)}/download?subpath=${encodeURIComponent(subpath)}`;
}

// Bootstrap and signup run before a session exists, so they use plain fetch:
// fetchWithAuthCheck's 403 redirect would bounce them to the page they're on.
export async function apiAuthBootstrap() {
  const res = await fetch('/api/auth/bootstrap');
  if (!res.ok) throw new Error('Failed to contact the server');
  return res.json(); // { hasUsers }
}

export async function apiSignup({ username, password }) {
  const res = await fetch('/api/signup', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username, password }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(data.message || signupErrorText(data.error, res.status));
    err.status = res.status;
    err.code = data.error;
    throw err;
  }
  return data; // { ok, user }
}

function signupErrorText(code, status) {
  switch (code) {
    case 'username_taken': return 'That username is already taken.';
    case 'weak_password': return 'Password must be at least 8 characters.';
    case 'too_many_attempts': return 'Too many attempts. Try again in a few minutes.';
    default: return `Could not create the account (${status}).`;
  }
}

export async function apiChangePassword(currentPassword, newPassword) {
  const res = await fetchWithAuthCheck('/api/account/password', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ currentPassword, newPassword }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.message || 'Could not change the password.');
  return data;
}

export async function apiListAccounts() {
  const res = await fetchWithAuthCheck('/api/admin/users');
  if (!res.ok) throw new Error('Could not load accounts.');
  return res.json(); // { accounts: [...], signupOpen }
}

// Owner only. externalDrives: 'none' | 'ro' | 'rw'.
export async function apiCreateAccount(username, password, externalDrives) {
  const res = await fetchWithAuthCheck('/api/admin/users', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username, password, externalDrives }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.message || 'Could not create the account.');
  return data; // { account }
}

export async function apiResetAccountPassword(id, newPassword) {
  const res = await fetchWithAuthCheck(`/api/admin/users/${encodeURIComponent(id)}/password`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ newPassword }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.message || 'Could not reset that password.');
  return data;
}

export async function apiSetAccountStatus(id, status) {
  const res = await fetchWithAuthCheck(`/api/admin/users/${encodeURIComponent(id)}/status`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ status }),
  });
  if (!res.ok) throw new Error('Could not change that account.');
  return res.json();
}

export async function apiSetAccountDrives(id, externalDrives) {
  const res = await fetchWithAuthCheck(`/api/admin/users/${encodeURIComponent(id)}/drives`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ externalDrives }),
  });
  if (!res.ok) throw new Error('Could not change drive access.');
  return res.json();
}

// Without deleteFiles, the account's files stay on disk.
export async function apiDeleteAccount(id, deleteFiles) {
  const res = await fetchWithAuthCheck(
    `/api/admin/users/${encodeURIComponent(id)}${deleteFiles ? '?deleteFiles=1' : ''}`,
    { method: 'DELETE' },
  );
  if (!res.ok) throw new Error('Could not delete that account.');
  return res.json();
}
