import { useState, useEffect, useRef, useCallback } from 'react';
import { bandwidthWidgetEnabled, setBandwidthWidgetEnabled } from '../utils/uiPrefs';
import {
  apiChangePassword, apiListAccounts, apiCreateAccount, apiResetAccountPassword,
  apiSetAccountStatus, apiSetAccountDrives, apiDeleteAccount,
} from '../api/fetch';

const DRIVE_LABEL = { none: 'No access', ro: 'Read only', rw: 'Read & write' };

export default function SettingsPage({ active, account }) {
  const headingRef = useRef(null);
  const [lightMode, setLightMode] = useState(() => {
    return localStorage.getItem('velocity-theme') === 'light';
  });
  // Display-only: the server keeps counting bytes either way.
  const [showBandwidth, setShowBandwidth] = useState(bandwidthWidgetEnabled);

  const [pwOpen, setPwOpen] = useState(false);
  const [pwCurrent, setPwCurrent] = useState('');
  const [pwNew, setPwNew] = useState('');
  const [pwConfirm, setPwConfirm] = useState('');
  const [pwBusy, setPwBusy] = useState(false);
  const [pwMsg, setPwMsg] = useState(null); // { ok, text }

  const isOwner = !!(account && account.role === 'owner');
  const [accOpen, setAccOpen] = useState(false);
  const [accounts, setAccounts] = useState([]);
  const [accMsg, setAccMsg] = useState(null); // { ok, text }
  const [resetFor, setResetFor] = useState(null); // account id
  const [resetPw, setResetPw] = useState('');
  const [resetBusy, setResetBusy] = useState(false);
  const [signupOpen, setSignupOpen] = useState(null); // unknown until the accounts load
  const [newName, setNewName] = useState('');
  const [newPw, setNewPw] = useState('');
  const [newDrives, setNewDrives] = useState('ro');
  const [createBusy, setCreateBusy] = useState(false);

  useEffect(() => {
    if (active) {
      headingRef.current?.focus({ preventScroll: true });
      window.scrollTo({ top: 0 });
    }
  }, [active]);

  useEffect(() => {
    if (lightMode) {
      document.body.setAttribute('data-theme', 'light');
      localStorage.setItem('velocity-theme', 'light');
    } else {
      document.body.removeAttribute('data-theme');
      localStorage.setItem('velocity-theme', 'dark');
    }
  }, [lightMode]);

  const refreshAccounts = useCallback(async () => {
    try {
      const data = await apiListAccounts();
      setAccounts(data.accounts || []);
      setSignupOpen(!!data.signupOpen);
    } catch (e) { setAccMsg({ ok: false, text: e.message || 'Could not load accounts.' }); }
  }, []);

  const handleCreateAccount = async () => {
    if (newPw.length < 8) { setAccMsg({ ok: false, text: 'Password must be at least 8 characters.' }); return; }
    setCreateBusy(true);
    setAccMsg(null);
    try {
      const { account: created } = await apiCreateAccount(newName.trim(), newPw, newDrives);
      setAccMsg({ ok: true, text: `Created '${created.username}'. Pass the password on however you normally would.` });
      setNewName(''); setNewPw(''); setNewDrives('ro');
      await refreshAccounts();
    } catch (e) {
      setAccMsg({ ok: false, text: e.message || 'Could not create the account.' });
    } finally {
      setCreateBusy(false);
    }
  };

  const handleChangePassword = async () => {
    setPwMsg(null);
    if (pwNew.length < 8) { setPwMsg({ ok: false, text: 'New password must be at least 8 characters.' }); return; }
    if (pwNew !== pwConfirm) { setPwMsg({ ok: false, text: 'New passwords do not match.' }); return; }
    setPwBusy(true);
    try {
      await apiChangePassword(pwCurrent, pwNew);
      setPwMsg({ ok: true, text: 'Password changed.' });
      setPwCurrent(''); setPwNew(''); setPwConfirm('');
      setPwOpen(false);
    } catch (e) {
      setPwMsg({ ok: false, text: e.message || 'Password change failed.' });
    } finally {
      setPwBusy(false);
    }
  };

  const handleResetPassword = async (id) => {
    if (resetPw.length < 8) { setAccMsg({ ok: false, text: 'Password must be at least 8 characters.' }); return; }
    setResetBusy(true);
    setAccMsg(null);
    try {
      await apiResetAccountPassword(id, resetPw);
      setAccMsg({ ok: true, text: 'Password reset. Pass the new one on however you normally would.' });
      setResetPw('');
      setResetFor(null);
    } catch (e) {
      setAccMsg({ ok: false, text: e.message || 'Could not reset that password.' });
    } finally {
      setResetBusy(false);
    }
  };

  const handleStatus = async (acc) => {
    const next = acc.status === 'active' ? 'suspended' : 'active';
    setAccMsg(null);
    try {
      await apiSetAccountStatus(acc.id, next);
      await refreshAccounts();
    } catch (e) {
      setAccMsg({ ok: false, text: e.message || 'Could not change that account.' });
    }
  };

  const handleDrives = async (acc) => {
    const next = acc.externalDrives === 'none' ? 'ro' : acc.externalDrives === 'ro' ? 'rw' : 'none';
    setAccMsg(null);
    try {
      await apiSetAccountDrives(acc.id, next);
      await refreshAccounts();
    } catch (e) {
      setAccMsg({ ok: false, text: e.message || 'Could not change drive access.' });
    }
  };

  const handleDelete = async (acc) => {
    // Asked separately: an account can be re-created, deleted files cannot.
    if (!window.confirm(`Delete the account '${acc.username}'? They will be signed out and cannot sign back in.`)) return;
    const deleteFiles = window.confirm(
      `Also permanently delete every file in ${acc.username}'s storage?\n\n`
      + 'OK = delete the files too (cannot be undone).\n'
      + 'Cancel = keep the files on disk.',
    );
    setAccMsg(null);
    try {
      await apiDeleteAccount(acc.id, deleteFiles);
      setAccMsg({ ok: true, text: `Deleted '${acc.username}'${deleteFiles ? ' and their files.' : '. Their files are still on disk.'}` });
      await refreshAccounts();
    } catch (e) {
      setAccMsg({ ok: false, text: e.message || 'Could not delete that account.' });
    }
  };

  const settingsRow = (label, description, control) => (
    <div className="settings-row">
      <div className="settings-row-info">
        <span className="settings-label">{label}</span>
        <span className="settings-description">{description}</span>
      </div>
      {control}
    </div>
  );

  return (
    <div className="settings-page">
      <div className="settings-header">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="settings-header-icon" aria-hidden="true">
          <circle cx="12" cy="12" r="3"></circle>
          <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"></path>
        </svg>
        <div>
          <h1 ref={headingRef} tabIndex={-1} className="settings-title">Settings</h1>
          <p className="settings-subtitle">Manage your preferences, storage, and account.</p>
        </div>
      </div>

      <section className="settings-section" aria-labelledby="settings-appearance-heading">
        <h2 className="settings-section-title" id="settings-appearance-heading">Appearance</h2>

        <div className="settings-row settings-toggle-row">
          <div className="settings-row-info">
            <span className="settings-label" id="settings-light-mode-label">Light Mode</span>
            <span className="settings-description" id="settings-light-mode-description">Use a light color scheme</span>
          </div>
          <label className="toggle-switch">
            <input
              type="checkbox"
              aria-labelledby="settings-light-mode-label"
              aria-describedby="settings-light-mode-description"
              checked={lightMode}
              onChange={(e) => setLightMode(e.target.checked)}
            />
            <span className="toggle-slider"></span>
          </label>
        </div>

        <div className="settings-row settings-toggle-row">
          <div className="settings-row-info">
            <span className="settings-label" id="settings-bandwidth-label">Show Data Usage</span>
            <span className="settings-description" id="settings-bandwidth-description">Show lifetime data usage in the nav bar</span>
          </div>
          <label className="toggle-switch">
            <input
              type="checkbox"
              aria-labelledby="settings-bandwidth-label"
              aria-describedby="settings-bandwidth-description"
              checked={showBandwidth}
              onChange={(e) => { setShowBandwidth(e.target.checked); setBandwidthWidgetEnabled(e.target.checked); }}
            />
            <span className="toggle-slider"></span>
          </label>
        </div>
      </section>

      <section className="settings-section" aria-labelledby="settings-account-heading">
        <h2 className="settings-section-title" id="settings-account-heading">Account</h2>

        {account && settingsRow(
          'Signed in as',
          `${account.username}${account.role === 'owner' ? ' (owner of this server)' : ''}. External drives: ${DRIVE_LABEL[account.externalDrives] || account.externalDrives}.`,
          null,
        )}

        {settingsRow(
          'Change password',
          'You need your current password. Your other sessions are signed out.',
          <button className="modal-button modal-button-cancel" aria-expanded={pwOpen} aria-controls="settings-password-form" onClick={() => { setPwOpen(!pwOpen); setPwMsg(null); }}>
            {pwOpen ? 'Close' : 'Change'}
          </button>,
        )}
        {pwOpen && (
          <div className="settings-form" id="settings-password-form">
            <input type="password" className="file-input-field" aria-label="Current password" placeholder="Current password" value={pwCurrent} onChange={(e) => setPwCurrent(e.target.value)} autoComplete="current-password" />
            <input type="password" className="file-input-field" aria-label="New password" placeholder="New password" value={pwNew} onChange={(e) => setPwNew(e.target.value)} autoComplete="new-password" />
            <input type="password" className="file-input-field" aria-label="Confirm new password" placeholder="Confirm new password" value={pwConfirm} onChange={(e) => setPwConfirm(e.target.value)} autoComplete="new-password" />
            <button className="modal-button modal-button-delete" disabled={pwBusy || !pwCurrent || !pwNew} onClick={handleChangePassword}>
              {pwBusy ? 'Saving…' : 'Change password'}
            </button>
          </div>
        )}

        {pwMsg && (
          <p className={`settings-message settings-message-${pwMsg.ok ? 'success' : 'error'}`} role="status">{pwMsg.text}</p>
        )}
      </section>

      {isOwner && (
        <section className="settings-section" aria-labelledby="settings-people-heading">
          <h2 className="settings-section-title" id="settings-people-heading">People</h2>

          {settingsRow(
            'Accounts on this server',
            'Add people, reset passwords, and choose who can use external drives. Each account gets storage of its own.',
            <button className="modal-button modal-button-cancel" aria-expanded={accOpen} aria-controls="settings-accounts" onClick={() => { const n = !accOpen; setAccOpen(n); setAccMsg(null); if (n) refreshAccounts(); }}>
              {accOpen ? 'Close' : 'Manage'}
            </button>,
          )}

          {accOpen && (
            <div className="settings-form" id="settings-accounts">
              {signupOpen !== null && (
                <p className="settings-note">
                  {signupOpen
                    ? 'Sign-up is open: anyone who can reach this server can create an account. Suspend or delete the ones that should not be here.'
                    : 'Sign-up is closed, so accounts are added here. (Setting VELOCITY_SIGNUP=open on the server lets people sign themselves up.)'}
                </p>
              )}

              <div className="settings-panel">
                <p>Add an account. Share the password with its owner, who can change it in Settings.</p>
                <input
                  type="text" className="file-input-field" aria-label="New account username" placeholder="Username"
                  value={newName} onChange={(e) => setNewName(e.target.value)} autoComplete="off" spellCheck="false"
                />
                <input
                  type="password" className="file-input-field" aria-label="New account password"
                  placeholder="Password (at least 8 characters)"
                  value={newPw} onChange={(e) => setNewPw(e.target.value)} autoComplete="new-password"
                />
                <select className="file-input-field" aria-label="External drive access" value={newDrives} onChange={(e) => setNewDrives(e.target.value)}>
                  <option value="none">External drives: {DRIVE_LABEL.none}</option>
                  <option value="ro">External drives: {DRIVE_LABEL.ro}</option>
                  <option value="rw">External drives: {DRIVE_LABEL.rw}</option>
                </select>
                <button className="modal-button modal-button-delete" disabled={createBusy || !newName.trim() || newPw.length < 8} onClick={handleCreateAccount}>
                  {createBusy ? 'Creating…' : 'Add account'}
                </button>
              </div>

              {accounts.length === 0 && <p className="settings-note">No accounts loaded.</p>}

              {accounts.map((acc) => (
                <div key={acc.id} className="settings-account">
                  <div className="settings-account-head">
                    <span className="settings-account-name">
                      {acc.username}
                      {acc.role === 'owner' && <span className="settings-account-tag">owner</span>}
                      {acc.status !== 'active' && <span className="settings-account-tag settings-account-tag-off">suspended</span>}
                    </span>
                    <span className="settings-account-meta">
                      Drives: {DRIVE_LABEL[acc.externalDrives] || acc.externalDrives}
                      {acc.lastLoginAt ? ` · last seen ${new Date(acc.lastLoginAt).toLocaleDateString()}` : ' · never signed in'}
                    </span>
                  </div>

                  <div className="settings-actions">
                    <button className="modal-button modal-button-cancel" onClick={() => { setResetFor(resetFor === acc.id ? null : acc.id); setResetPw(''); setAccMsg(null); }}>
                      {resetFor === acc.id ? 'Close' : 'Reset password'}
                    </button>
                    <button className="modal-button modal-button-cancel" onClick={() => handleDrives(acc)}>
                      Drives: {DRIVE_LABEL[acc.externalDrives] || acc.externalDrives}
                    </button>
                    {acc.role !== 'owner' && (
                      <button className="modal-button modal-button-cancel" onClick={() => handleStatus(acc)}>
                        {acc.status === 'active' ? 'Suspend' : 'Reinstate'}
                      </button>
                    )}
                    {acc.role !== 'owner' && (
                      <button className="modal-button modal-button-delete" onClick={() => handleDelete(acc)}>Delete</button>
                    )}
                  </div>

                  {resetFor === acc.id && (
                    <div className="settings-panel">
                      <p>
                        Set a new password for <strong>{acc.username}</strong>. You do not need their
                        current one. That is what makes this a reset.
                      </p>
                      <input
                        type="password" className="file-input-field" aria-label={`New password for ${acc.username}`}
                        placeholder="New password (at least 8 characters)"
                        value={resetPw} onChange={(e) => setResetPw(e.target.value)} autoComplete="new-password"
                      />
                      <button className="modal-button modal-button-delete" disabled={resetBusy || resetPw.length < 8} onClick={() => handleResetPassword(acc.id)}>
                        {resetBusy ? 'Saving…' : 'Set password'}
                      </button>
                    </div>
                  )}
                </div>
              ))}

              {accMsg && (
                <p className={`settings-message settings-message-${accMsg.ok ? 'success' : 'error'}`} role="status">{accMsg.text}</p>
              )}
            </div>
          )}
        </section>
      )}
    </div>
  );
}
