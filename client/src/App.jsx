import { useState, useEffect, useCallback } from 'react';
import { Routes, Route, Navigate, useNavigate } from 'react-router-dom';
import LoginPage from './pages/LoginPage';
import SignupPage from './pages/SignupPage';
import DashboardPage from './pages/DashboardPage';
import SharePage from './pages/SharePage';

export default function App() {
  const [authChecked, setAuthChecked] = useState(false);
  const [isLoggedIn, setIsLoggedIn] = useState(false);
  const [account, setAccount] = useState(null);
  const navigate = useNavigate();

  useEffect(() => {
    fetch('/api/auth-status')
      .then(res => {
        if (res.ok) return res.json();
        return { loggedIn: false };
      })
      .then(data => {
        setIsLoggedIn(data.loggedIn);
        setAccount(data.user || null);
        setAuthChecked(true);
      })
      .catch(() => {
        setIsLoggedIn(false);
        setAuthChecked(true);
      });
  }, []);

  // Navigate in-app so the dashboard mounts without a full page reload.
  const handleLogin = useCallback((user) => {
    setIsLoggedIn(true);
    if (user) setAccount(user);
    navigate('/app');
  }, [navigate]);

  if (!authChecked) return null;

  return (
    <Routes>
      <Route path="/" element={isLoggedIn ? <Navigate to="/app" /> : <LoginPage onLogin={handleLogin} />} />
      <Route path="/signup" element={isLoggedIn ? <Navigate to="/app" /> : <SignupPage onSignup={handleLogin} />} />
      {/* Keep the dashboard shell and its background work mounted across app pages. */}
      <Route path="/app" element={isLoggedIn ? <DashboardPage account={account} /> : <Navigate to="/" />}>
        <Route path="settings" element={null} />
      </Route>
      {/* No auth gate: public share links work without an account. */}
      <Route path="/share/:token" element={<SharePage />} />
      <Route path="*" element={<Navigate to="/" />} />
    </Routes>
  );
}
