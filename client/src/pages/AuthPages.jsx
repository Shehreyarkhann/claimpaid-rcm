import { useState, useRef, useEffect } from 'react';
import { useAuth } from '../auth';

function BrandPanel() {
  return (
    <div className="hidden lg:flex flex-col justify-between bg-[#0b1220] text-white p-12 relative overflow-hidden w-[46%]">
      <div className="absolute inset-0 opacity-40"
        style={{ background: 'radial-gradient(600px 400px at 20% 20%, rgba(16,185,129,0.25), transparent), radial-gradient(500px 400px at 80% 90%, rgba(14,165,233,0.18), transparent)' }} />
      <div className="relative flex items-center gap-3">
        <div className="w-10 h-10 rounded-xl bg-emerald-500 flex items-center justify-center font-extrabold text-[#0b1220] text-lg">P</div>
        <div>
          <div className="font-bold text-lg leading-tight">ClaimPaid RCM</div>
          <div className="text-xs text-slate-400">Revenue Cycle Analytics</div>
        </div>
      </div>
      <div className="relative">
        <div className="text-3xl font-bold leading-snug tracking-tight">
          Turn denied claims<br />into recovered revenue.
        </div>
        <p className="text-slate-400 mt-4 max-w-sm text-[15px] leading-relaxed">
          Track every claim, work every denial, and watch your A/R shrink — purpose-built for billing teams.
        </p>
        <div className="grid grid-cols-3 gap-4 mt-10">
          {[
            ['98%', 'Faster denial triage'],
            ['$2.4M', 'Recovered by customers'],
            ['4.9★', 'Billing team rating'],
          ].map(([v, l]) => (
            <div key={l}>
              <div className="text-2xl font-bold text-emerald-400">{v}</div>
              <div className="text-xs text-slate-400 mt-1">{l}</div>
            </div>
          ))}
        </div>
      </div>
      <div className="relative text-xs text-slate-500">HIPAA-aware · SOC 2 controls · Your data stays yours</div>
    </div>
  );
}

function Field({ label, ...props }) {
  return (
    <div>
      <label className="label">{label}</label>
      <input className="input" {...props} />
    </div>
  );
}

// "Continue with Google" via Google Identity Services. Fetches the public
// client ID from /api/config; if it's not configured (or GIS fails to load)
// the button area renders nothing — no broken UI, no errors.
function GoogleButton({ onCredential, text }) {
  const btnRef = useRef(null);
  const [clientId, setClientId] = useState(null);
  const cbRef = useRef(onCredential);
  cbRef.current = onCredential;

  // 1. Fetch the public client ID. Nothing renders until we have one.
  useEffect(() => {
    let cancelled = false;
    fetch('/api/config')
      .then((r) => (r.ok ? r.json() : null))
      .then((cfg) => {
        if (!cancelled && cfg && cfg.googleClientId) setClientId(cfg.googleClientId);
      })
      .catch(() => { /* hide gracefully */ });
    return () => { cancelled = true; };
  }, []);

  // 2. Once the container div is mounted, init GIS and render the button.
  useEffect(() => {
    if (!clientId || !btnRef.current) return;
    let cancelled = false;
    const loadGis = () =>
      new Promise((resolve, reject) => {
        if (window.google && window.google.accounts && window.google.accounts.id) return resolve();
        const s = document.createElement('script');
        s.src = 'https://accounts.google.com/gsi/client';
        s.async = true;
        s.defer = true;
        s.onload = resolve;
        s.onerror = () => reject(new Error('gis-load-failed'));
        document.head.appendChild(s);
      });
    loadGis()
      .then(() => {
        if (cancelled || !btnRef.current) return;
        window.google.accounts.id.initialize({
          client_id: clientId,
          callback: (resp) => {
            if (resp && resp.credential) cbRef.current(resp.credential);
          },
        });
        window.google.accounts.id.renderButton(btnRef.current, {
          theme: 'outline',
          size: 'large',
          text: text || 'continue_with',
          width: 320,
        });
      })
      .catch(() => { /* hide gracefully */ });
    return () => { cancelled = true; };
  }, [clientId, text]);

  if (!clientId) return null;
  return (
    <div>
      <div className="flex items-center gap-3 my-1">
        <div className="flex-1 h-px bg-slate-200" />
        <span className="text-xs text-slate-400 font-medium">or</span>
        <div className="flex-1 h-px bg-slate-200" />
      </div>
      <div ref={btnRef} className="flex justify-center" />
    </div>
  );
}

function MfaChallenge({ mfaToken, email, onBack }) {
  const { verifyMfa, resendMfa } = useAuth();
  const [digits, setDigits] = useState(['', '', '', '', '', '']);
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);
  const [cooldown, setCooldown] = useState(0);
  const [resent, setResent] = useState(false);
  const inputs = useRef([]);

  useEffect(() => { inputs.current[0]?.focus(); }, []);
  useEffect(() => {
    if (cooldown <= 0) return;
    const t = setTimeout(() => setCooldown(cooldown - 1), 1000);
    return () => clearTimeout(t);
  }, [cooldown]);

  const setDigit = (i, v) => {
    const d = v.replace(/\D/g, '').slice(-1);
    const next = [...digits];
    next[i] = d;
    setDigits(next);
    if (d && i < 5) inputs.current[i + 1]?.focus();
  };

  const handleKey = (i, e) => {
    if (e.key === 'Backspace' && !digits[i] && i > 0) {
      inputs.current[i - 1]?.focus();
    }
  };

  const handlePaste = (e) => {
    const text = e.clipboardData.getData('text').replace(/\D/g, '').slice(0, 6);
    if (!text) return;
    e.preventDefault();
    const next = [...digits];
    for (let i = 0; i < text.length; i++) next[i] = text[i];
    setDigits(next);
    inputs.current[Math.min(text.length, 5)]?.focus();
  };

  const submit = async (e) => {
    e?.preventDefault();
    const code = digits.join('');
    if (code.length !== 6) return;
    setError(null); setBusy(true);
    try { await verifyMfa(mfaToken, code); }
    catch (err) {
      setError(err.message);
      setDigits(['', '', '', '', '', '']);
      inputs.current[0]?.focus();
    }
    finally { setBusy(false); }
  };

  // Auto-submit when all 6 digits are entered
  useEffect(() => {
    if (digits.every((d) => d) && !busy) submit();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [digits]);

  const resend = async () => {
    setError(null); setResent(false);
    try {
      await resendMfa(mfaToken);
      setResent(true);
      setCooldown(60);
      setDigits(['', '', '', '', '', '']);
      inputs.current[0]?.focus();
    } catch (err) { setError(err.message); }
  };

  return (
    <div className="min-h-screen flex bg-white">
      <BrandPanel />
      <div className="flex-1 flex items-center justify-center p-8">
        <div className="w-full max-w-sm space-y-5">
          <div className="text-center">
            <div className="w-14 h-14 rounded-2xl bg-emerald-100 flex items-center justify-center text-2xl mx-auto mb-4">🔐</div>
            <h2 className="text-2xl font-bold tracking-tight text-slate-900">Check your email</h2>
            <p className="text-sm text-slate-500 mt-2">
              We sent a 6-digit verification code to<br />
              <strong className="text-slate-700">{email}</strong>
            </p>
          </div>
          {error && <div className="text-sm text-rose-700 bg-rose-50 border border-rose-200 rounded-xl px-4 py-3 text-center">{error}</div>}
          {resent && <div className="text-sm text-emerald-700 bg-emerald-50 border border-emerald-200 rounded-xl px-4 py-3 text-center">New code sent — check your inbox.</div>}
          <form onSubmit={submit} onPaste={handlePaste}>
            <div className="flex gap-2.5 justify-center">
              {digits.map((d, i) => (
                <input
                  key={i}
                  ref={(el) => (inputs.current[i] = el)}
                  value={d}
                  onChange={(e) => setDigit(i, e.target.value)}
                  onKeyDown={(e) => handleKey(i, e)}
                  inputMode="numeric"
                  maxLength={1}
                  disabled={busy}
                  className="w-12 h-14 text-center text-2xl font-bold border-2 border-slate-200 rounded-xl focus:border-emerald-500 focus:ring-2 focus:ring-emerald-200 outline-none transition disabled:opacity-50"
                />
              ))}
            </div>
            <button type="submit" className="btn btn-primary w-full !py-3 mt-6" disabled={busy || digits.some((d) => !d)}>
              {busy ? 'Verifying…' : 'Verify & sign in'}
            </button>
          </form>
          <div className="text-center text-sm">
            {cooldown > 0 ? (
              <span className="text-slate-400">Resend code in {cooldown}s</span>
            ) : (
              <button onClick={resend} className="text-emerald-600 font-semibold hover:underline">Didn't get it? Resend code</button>
            )}
          </div>
          <div className="text-center">
            <button onClick={onBack} className="text-sm text-slate-400 hover:text-slate-600">← Back to sign in</button>
          </div>
        </div>
      </div>
    </div>
  );
}

export function Login({ goSignup, goForgot }) {
  const { login, googleLogin } = useAuth();
  const [email, setEmail] = useState('demo@pulsercm.com');
  const [password, setPassword] = useState('demo1234');
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);
  const [mfaToken, setMfaToken] = useState(null);

  const submit = async (e) => {
    e.preventDefault();
    setError(null); setBusy(true);
    try {
      const result = await login(email, password);
      if (result?.mfaRequired) setMfaToken(result.mfaToken);
    }
    catch (err) { setError(err.message); }
    finally { setBusy(false); }
  };

  const handleGoogle = async (idToken) => {
    setError(null); setBusy(true);
    try {
      const result = await googleLogin(idToken);
      if (result?.mfaRequired) setMfaToken(result.mfaToken);
    }
    catch (err) { setError(err.message); }
    finally { setBusy(false); }
  };

  if (mfaToken) {
    return <MfaChallenge mfaToken={mfaToken} email={email} onBack={() => setMfaToken(null)} />;
  }

  return (
    <div className="min-h-screen flex bg-white">
      <BrandPanel />
      <div className="flex-1 flex items-center justify-center p-8">
        <form onSubmit={submit} className="w-full max-w-sm space-y-5">
          <div>
            <h2 className="text-2xl font-bold tracking-tight text-slate-900">Welcome back</h2>
            <p className="text-sm text-slate-500 mt-1">Sign in to your billing workspace</p>
          </div>
          {error && <div className="text-sm text-rose-700 bg-rose-50 border border-rose-200 rounded-xl px-4 py-3">{error}</div>}
          <Field label="Email" type="email" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="you@company.com" required />
          <div>
            <Field label="Password" type="password" value={password} onChange={(e) => setPassword(e.target.value)} placeholder="••••••••" required />
            <div className="text-right mt-1.5">
              <button type="button" onClick={goForgot} className="text-xs text-slate-500 hover:text-emerald-600 font-medium">Forgot password?</button>
            </div>
          </div>
          <button className="btn btn-primary w-full !py-3" disabled={busy}>{busy ? 'Signing in…' : 'Sign in'}</button>
          <GoogleButton onCredential={handleGoogle} text="continue_with" />
          <p className="text-sm text-slate-500 text-center">
            New to ClaimPaid? <button type="button" onClick={goSignup} className="text-emerald-600 font-semibold hover:underline">Create an account</button>
          </p>
          <p className="text-xs text-slate-400 text-center bg-slate-50 rounded-xl px-4 py-3">
            Demo login is pre-filled — just hit <strong>Sign in</strong> to explore.
          </p>
        </form>
      </div>
    </div>
  );
}

export function Signup({ goLogin }) {
  const { signup, googleLogin } = useAuth();
  const [form, setForm] = useState({ orgName: '', name: '', email: '', password: '' });
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);
  const set = (k) => (e) => setForm({ ...form, [k]: e.target.value });

  const submit = async (e) => {
    e.preventDefault();
    setError(null); setBusy(true);
    try { await signup(form.orgName, form.name, form.email, form.password); }
    catch (err) { setError(err.message); }
    finally { setBusy(false); }
  };

  const handleGoogle = async (idToken) => {
    setError(null); setBusy(true);
    try { await googleLogin(idToken); }
    catch (err) { setError(err.message); }
    finally { setBusy(false); }
  };

  return (
    <div className="min-h-screen flex bg-white">
      <BrandPanel />
      <div className="flex-1 flex items-center justify-center p-8">
        <form onSubmit={submit} className="w-full max-w-sm space-y-5">
          <div>
            <h2 className="text-2xl font-bold tracking-tight text-slate-900">Create your workspace</h2>
            <p className="text-sm text-slate-500 mt-1">Your billing team's data stays isolated and private</p>
          </div>
          {error && <div className="text-sm text-rose-700 bg-rose-50 border border-rose-200 rounded-xl px-4 py-3">{error}</div>}
          <Field label="Company name" value={form.orgName} onChange={set('orgName')} placeholder="Acme Billing Services" required />
          <Field label="Your name" value={form.name} onChange={set('name')} placeholder="Jane Smith" required />
          <Field label="Work email" type="email" value={form.email} onChange={set('email')} placeholder="you@company.com" required />
          <div>
            <Field label="Password" type="password" value={form.password} onChange={set('password')} placeholder="8+ chars, upper, lower, number, symbol" required />
            <p className="text-xs text-slate-400 mt-1.5">At least 8 characters with an uppercase letter, a lowercase letter, a number, and a symbol.</p>
          </div>
          <button className="btn btn-primary w-full !py-3" disabled={busy}>{busy ? 'Creating…' : 'Create workspace'}</button>
          <GoogleButton onCredential={handleGoogle} text="signup_with" />
          <p className="text-sm text-slate-500 text-center">
            Already have an account? <button type="button" onClick={goLogin} className="text-emerald-600 font-semibold hover:underline">Sign in</button>
          </p>
        </form>
      </div>
    </div>
  );
}

export function ForgotPassword({ goLogin }) {
  const [email, setEmail] = useState('');
  const [sent, setSent] = useState(false);
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);

  const submit = async (e) => {
    e.preventDefault();
    setError(null); setBusy(true);
    try {
      const res = await fetch('/api/auth/password/forgot', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email }),
      });
      if (!res.ok) throw new Error('Something went wrong');
      setSent(true);
    } catch (err) { setError(err.message); }
    finally { setBusy(false); }
  };

  return (
    <div className="min-h-screen flex bg-white">
      <BrandPanel />
      <div className="flex-1 flex items-center justify-center p-8">
        <div className="w-full max-w-sm space-y-5">
          <div>
            <h2 className="text-2xl font-bold tracking-tight text-slate-900">Reset password</h2>
            <p className="text-sm text-slate-500 mt-1">We'll email you a link to set a new password</p>
          </div>
          {sent ? (
            <div className="text-sm text-emerald-700 bg-emerald-50 border border-emerald-200 rounded-xl px-4 py-4">
              If an account exists for <strong>{email}</strong>, a reset link is on its way. Check your inbox (and spam folder).
            </div>
          ) : (
            <form onSubmit={submit} className="space-y-5">
              {error && <div className="text-sm text-rose-700 bg-rose-50 border border-rose-200 rounded-xl px-4 py-3">{error}</div>}
              <Field label="Work email" type="email" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="you@company.com" required />
              <button className="btn btn-primary w-full !py-3" disabled={busy}>{busy ? 'Sending…' : 'Send reset link'}</button>
            </form>
          )}
          <p className="text-sm text-slate-500 text-center">
            <button onClick={goLogin} className="text-emerald-600 font-semibold hover:underline">← Back to sign in</button>
          </p>
        </div>
      </div>
    </div>
  );
}

export function ResetPassword({ goLogin }) {
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [done, setDone] = useState(false);
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);
  const token = new URLSearchParams(window.location.search).get('token');

  const submit = async (e) => {
    e.preventDefault();
    if (password !== confirm) { setError('Passwords do not match'); return; }
    setError(null); setBusy(true);
    try {
      const res = await fetch('/api/auth/password/reset', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token, password }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error);
      setDone(true);
    } catch (err) { setError(err.message); }
    finally { setBusy(false); }
  };

  return (
    <div className="min-h-screen flex bg-white">
      <BrandPanel />
      <div className="flex-1 flex items-center justify-center p-8">
        <div className="w-full max-w-sm space-y-5">
          <div>
            <h2 className="text-2xl font-bold tracking-tight text-slate-900">Set a new password</h2>
            <p className="text-sm text-slate-500 mt-1">At least 8 characters with an uppercase letter, a lowercase letter, a number, and a symbol</p>
          </div>
          {!token ? (
            <div className="text-sm text-rose-700 bg-rose-50 border border-rose-200 rounded-xl px-4 py-3">
              This reset link is invalid. Please request a new one.
            </div>
          ) : done ? (
            <div className="text-sm text-emerald-700 bg-emerald-50 border border-emerald-200 rounded-xl px-4 py-4">
              Password updated. You can now sign in with your new password.
            </div>
          ) : (
            <form onSubmit={submit} className="space-y-5">
              {error && <div className="text-sm text-rose-700 bg-rose-50 border border-rose-200 rounded-xl px-4 py-3">{error}</div>}
              <Field label="New password" type="password" value={password} onChange={(e) => setPassword(e.target.value)} placeholder="8+ chars, upper, lower, number, symbol" required />
              <Field label="Confirm password" type="password" value={confirm} onChange={(e) => setConfirm(e.target.value)} placeholder="Repeat it" required />
              <button className="btn btn-primary w-full !py-3" disabled={busy}>{busy ? 'Updating…' : 'Set new password'}</button>
            </form>
          )}
          <p className="text-sm text-slate-500 text-center">
            <button onClick={goLogin} className="text-emerald-600 font-semibold hover:underline">← Back to sign in</button>
          </p>
        </div>
      </div>
    </div>
  );
}
