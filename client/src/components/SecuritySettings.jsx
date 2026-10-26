import { useState, useEffect, useRef } from 'react';
import { authFetch } from '../auth';
import { useToast } from './ui';

export default function SecuritySettings() {
  const toast = useToast();
  const [enabled, setEnabled] = useState(null);
  const [step, setStep] = useState('idle'); // idle | verifying | disabling
  const [mfaToken, setMfaToken] = useState(null);
  const [digits, setDigits] = useState(['', '', '', '', '', '']);
  const [password, setPassword] = useState('');
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);
  const inputs = useRef([]);

  const load = async () => {
    try {
      const res = await authFetch('/api/auth/mfa/status');
      setEnabled((await res.json()).enabled);
    } catch { setEnabled(false); }
  };
  useEffect(() => { load(); }, []);
  useEffect(() => { if (step === 'verifying') inputs.current[0]?.focus(); }, [step]);

  const startEnable = async () => {
    setError(null); setBusy(true);
    try {
      const res = await authFetch('/api/auth/mfa/enable', { method: 'POST' });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error);
      setMfaToken(data.mfaToken);
      setStep('verifying');
      toast.success('Verification code sent to your email');
    } catch (e) { setError(e.message); }
    finally { setBusy(false); }
  };

  const setDigit = (i, v) => {
    const d = v.replace(/\D/g, '').slice(-1);
    const next = [...digits]; next[i] = d; setDigits(next);
    if (d && i < 5) inputs.current[i + 1]?.focus();
  };

  const confirmEnable = async () => {
    const code = digits.join('');
    if (code.length !== 6) return;
    setError(null); setBusy(true);
    try {
      const res = await fetch('/api/auth/mfa/verify', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ mfaToken, code, purpose: 'enroll' }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error);
      toast.success('Two-factor authentication is now on');
      setStep('idle'); setEnabled(true); setDigits(['', '', '', '', '', '']);
    } catch (e) {
      setError(e.message);
      setDigits(['', '', '', '', '', '']);
      inputs.current[0]?.focus();
    }
    finally { setBusy(false); }
  };

  const confirmDisable = async () => {
    if (!password) { setError('Enter your password to confirm'); return; }
    setError(null); setBusy(true);
    try {
      const res = await authFetch('/api/auth/mfa/disable', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ password }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error);
      toast.success('Two-factor authentication is now off');
      setStep('idle'); setEnabled(false); setPassword('');
    } catch (e) { setError(e.message); }
    finally { setBusy(false); }
  };

  if (enabled === null) return null;

  return (
    <div className="card p-6 mb-5">
      <div className="flex items-start justify-between gap-4">
        <div>
          <div className="flex items-center gap-2.5">
            <div className="text-xl">🔐</div>
            <div className="font-semibold text-stone-900">Two-factor authentication</div>
            <span className={`badge ${enabled ? 'badge-green' : 'badge-slate'}`}>{enabled ? 'On' : 'Off'}</span>
          </div>
          <p className="text-sm text-stone-500 mt-2 max-w-xl leading-relaxed">
            {enabled
              ? 'Your account is protected. Every sign-in requires a 6-digit code sent to your email, in addition to your password.'
              : 'Add a second layer of security: every sign-in will require a 6-digit code sent to your email, in addition to your password.'}
          </p>
        </div>
        {step === 'idle' && (
          enabled
            ? <button className="btn btn-outline shrink-0" onClick={() => { setStep('disabling'); setError(null); }}>Turn off</button>
            : <button className="btn btn-dark shrink-0" disabled={busy} onClick={startEnable}>{busy ? 'Sending…' : 'Turn on'}</button>
        )}
      </div>

      {error && <div className="mt-4 text-sm text-rose-700 bg-rose-50 border border-rose-200 rounded-xl px-4 py-3">{error}</div>}

      {step === 'verifying' && (
        <div className="mt-5 pt-5 border-t border-stone-100">
          <p className="text-sm text-stone-600 mb-3">Enter the 6-digit code from your email to finish setup:</p>
          <div className="flex gap-2 mb-4">
            {digits.map((d, i) => (
              <input key={i} ref={(el) => (inputs.current[i] = el)} value={d}
                onChange={(e) => setDigit(i, e.target.value)}
                onKeyDown={(e) => { if (e.key === 'Backspace' && !digits[i] && i > 0) inputs.current[i - 1]?.focus(); }}
                inputMode="numeric" maxLength={1} disabled={busy}
                className="w-11 h-12 text-center text-xl font-bold border-2 border-stone-200 rounded-xl focus:border-emerald-500 outline-none" />
            ))}
          </div>
          <div className="flex gap-2">
            <button className="btn btn-primary" disabled={busy || digits.some((d) => !d)} onClick={confirmEnable}>
              {busy ? 'Verifying…' : 'Confirm & enable'}
            </button>
            <button className="btn btn-ghost" onClick={() => { setStep('idle'); setDigits(['', '', '', '', '', '']); }}>Cancel</button>
          </div>
        </div>
      )}

      {step === 'disabling' && (
        <div className="mt-5 pt-5 border-t border-stone-100">
          <p className="text-sm text-stone-600 mb-3">Enter your password to turn off two-factor authentication:</p>
          <div className="flex gap-2 max-w-sm">
            <input type="password" value={password} onChange={(e) => setPassword(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && confirmDisable()}
              placeholder="Your password" className="input" disabled={busy} />
            <button className="btn btn-outline !border-rose-200 !text-rose-600 hover:!bg-rose-50 shrink-0" disabled={busy} onClick={confirmDisable}>
              {busy ? 'Working…' : 'Turn off'}
            </button>
            <button className="btn btn-ghost shrink-0" onClick={() => { setStep('idle'); setPassword(''); }}>Cancel</button>
          </div>
        </div>
      )}
    </div>
  );
}
