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
      return { mfaRequired: true, mfaToken: data.mfaToken };
    }
    localStorage.setItem('pulse_token', data.token);
    setUser(data.user);
    return data.user;
  };

  const verifyMfa = async (mfaToken, code) => {
    const res = await fetch('/api/auth/mfa/verify', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ mfaToken, code }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Verification failed');
    localStorage.setItem('pulse_token', data.token);
    setUser(data.user);
    return data.user;
  };

  const resendMfa = async (mfaToken) => {
    const res = await fetch('/api/auth/mfa/resend', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ mfaToken }),
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
      return { mfaRequired: true, mfaToken: data.mfaToken };
    }
    localStorage.setItem('pulse_token', data.token);
    setUser(data.user);
    return data.user;
  };

  const logout = () => {
    localStorage.removeItem('pulse_token');
    setUser(null);
  };

  return (
    <AuthContext.Provider value={{ user, loading, login, signup, googleLogin, logout, verifyMfa, resendMfa }}>
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
