import { createContext, useContext, useState, useEffect } from 'react';

const AuthContext = createContext(null);

export function AuthProvider({ children }) {
  const [user, setUser] = useState(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const token = localStorage.getItem('pulse_token');
    if (!token) { setLoading(false); return; }
    fetch('/api/auth/me', { headers: { Authorization: `Bearer ${token}` } })
      .then((r) => {
        if (!r.ok) throw new Error('expired');
        return r.json();
      })
      .then(setUser)
      .catch(() => localStorage.removeItem('pulse_token'))
      .finally(() => setLoading(false));
  }, []);

  const login = async (email, password) => {
    const res = await fetch('/api/auth/login', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Login failed');
    if (data.mfaRequired) {
      // Password was correct — second factor needed. Do NOT store a session yet.
      // orgEnforced: the workspace requires it (not just the user's own opt-in).
      return { mfaRequired: true, mfaToken: data.mfaToken, orgEnforced: !!data.orgEnforced, message: data.message };
    }
    localStorage.setItem('pulse_token', data.token);
    setUser(data.user);
    return data.user;
  };

  // purpose: undefined | 'enroll' | 'org-enforce' (org-wide MFA enforcement —
  // verifying enrolls the user and issues a session for the enforced org).
  const verifyMfa = async (mfaToken, code, purpose) => {
    const res = await fetch('/api/auth/mfa/verify', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ mfaToken, code, purpose }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Verification failed');
    localStorage.setItem('pulse_token', data.token);
    setUser(data.user);
    return data.user;
  };

  const resendMfa = async (mfaToken, purpose) => {
    const res = await fetch('/api/auth/mfa/resend', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ mfaToken, purpose }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Could not resend code');
    return data;
  };

  const signup = async (orgName, name, email, password) => {
    const res = await fetch('/api/auth/signup', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ orgName, name, email, password }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Signup failed');
    localStorage.setItem('pulse_token', data.token);
    setUser(data.user);
    return data.user;
  };

  const googleLogin = async (idToken) => {
    const res = await fetch('/api/auth/google', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ idToken }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Google sign-in failed');
    if (data.mfaRequired) {
      // Google verified the email, but the account requires a second factor
      return { mfaRequired: true, mfaToken: data.mfaToken, orgEnforced: !!data.orgEnforced, message: data.message };
    }
    localStorage.setItem('pulse_token', data.token);
    setUser(data.user);
    return data.user;
  };

  const refreshMe = async () => {
    const token = localStorage.getItem('pulse_token');
    if (!token) return null;
    const r = await fetch('/api/auth/me', { headers: { Authorization: `Bearer ${token}` } });
    if (!r.ok) return null;
    const me = await r.json();
    setUser(me);
    return me;
  };

  // After password change / log-out-everywhere the server mints a fresh
  // token (the old one is dead) — adopt it for this session.
  const adoptToken = (token) => { if (token) localStorage.setItem('pulse_token', token); };

  const logout = () => {
    localStorage.removeItem('pulse_token');
    setUser(null);
  };

  return (
    <AuthContext.Provider value={{ user, loading, login, signup, googleLogin, logout, verifyMfa, resendMfa, refreshMe, adoptToken }}>
      {children}
    </AuthContext.Provider>
  );
}

export const useAuth = () => useContext(AuthContext);

export function authFetch(path, options = {}) {
  const token = localStorage.getItem('pulse_token');
  return fetch(path, {
    ...options,
    headers: {
      ...(options.headers || {}),
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
  });
}
