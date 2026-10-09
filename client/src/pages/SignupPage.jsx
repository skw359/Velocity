import { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import AuthVisual from '../components/AuthVisual';
import { apiAuthBootstrap, apiSignup } from '../api/fetch';
import '../styles/login.css';

// Open signup; the first account on an install becomes the owner.
export default function SignupPage({ onSignup }) {
  const navigate = useNavigate();

  const [checking, setChecking] = useState(true);
  const [isFirstAccount, setIsFirstAccount] = useState(false);
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const [statusText, setStatusText] = useState('');

  useEffect(() => {
    let alive = true;
    apiAuthBootstrap()
      .then((b) => { if (alive) { setIsFirstAccount(!b.hasUsers); setChecking(false); } })
      .catch(() => { if (alive) { setError('Could not reach the server.'); setChecking(false); } });
    return () => { alive = false; };
  }, []);

  const handleSubmit = async (e) => {
    e.preventDefault();
    if (loading) return;

    if (username.trim().length < 3) { setError('Username must be at least 3 characters.'); return; }
    if (password.length < 8) { setError('Password must be at least 8 characters.'); return; }
    if (password !== confirm) { setError('Passwords do not match.'); return; }

    setLoading(true);
    setError('');

    try {
      setStatusText('Creating your account…');
      const { user } = await apiSignup({ username: username.trim(), password });
      // Signup opens the session, so there is nothing to log into afterwards.
      setStatusText('');
      if (onSignup) onSignup(user);
      else window.location.href = '/app';
    } catch (err) {
      setError(err?.message || 'Could not create the account.');
      setLoading(false);
      setStatusText('');
    }
  };

  return (
    <div className="login-page">
      <div className="login-wrapper">
        <AuthVisual />

        <div className="form-side">
          <div className="form-header">
            <h2>{isFirstAccount ? 'Set up this server' : 'Welcome to the first-class storage platform.'}</h2>
            <p>{statusText}</p>
          </div>

          {error && <div className="error-message show">{error}</div>}

          {isFirstAccount && !checking && (
            <p className="form-note">
              This is the first account on this server, so it becomes the owner.
              It has full access to every drive and is the only account that can manage the
              others.
            </p>
          )}

          <form onSubmit={handleSubmit}>
            <div className="input-group">
              <label htmlFor="new-username">Username</label>
              <input
                type="text" id="new-username" className="input-field" placeholder="Username"
                value={username} onChange={(e) => setUsername(e.target.value)}
                autoComplete="username" spellCheck="false" required
              />
            </div>

            <div className="input-group">
              <label htmlFor="new-password">Password</label>
              <input
                type="password" id="new-password" className="input-field" placeholder="At least 8 characters"
                value={password} onChange={(e) => setPassword(e.target.value)}
                autoComplete="new-password" required
              />
            </div>

            <div className="input-group">
              <label htmlFor="confirm-password">Confirm password</label>
              <input
                type="password" id="confirm-password" className="input-field" placeholder="Confirm password"
                value={confirm} onChange={(e) => setConfirm(e.target.value)}
                autoComplete="new-password" required
              />
            </div>

            <button type="submit" className="login-button" disabled={loading || checking}>
              {loading
                ? <span className="login-loader" style={{ display: 'block' }}></span>
                : <span>{isFirstAccount ? 'Create the owner account' : 'Create account'}</span>}
            </button>

            <div className="form-alt">
              Already have an account?{' '}
              <button type="button" className="link-button" onClick={() => navigate('/')}>
                Log in
              </button>
            </div>
          </form>

          <div className="form-footer"></div>
        </div>
      </div>
    </div>
  );
}
