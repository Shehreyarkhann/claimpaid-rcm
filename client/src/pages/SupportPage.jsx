import { useState } from 'react';
import { api } from '../api';

export default function SupportPage() {
  const [form, setForm] = useState({ name: '', email: '', subject: '', message: '', website: '' });
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(false);
  const set = (k) => (e) => setForm({ ...form, [k]: e.target.value });

  const submit = async (e) => {
    e.preventDefault();
    setError(null); setBusy(true);
    try {
      await api.submitSupport(form);
      setDone(true);
    } catch (err) { setError(err.message); }
    finally { setBusy(false); }
  };

  return (
    <div className="min-h-screen bg-[#0b1220] flex items-center justify-center px-6 py-12">
      <div className="w-full max-w-lg">
        <div className="text-center mb-8">
          <div className="w-12 h-12 mx-auto rounded-2xl bg-emerald-500 flex items-center justify-center font-extrabold text-[#0b1220] text-xl mb-4">C</div>
          <h1 className="text-2xl font-bold text-white tracking-tight">Contact support</h1>
          <p className="text-slate-400 text-sm mt-2">We reply within one business day.</p>
        </div>

        {done ? (
          <div className="bg-slate-900 border border-slate-800 rounded-2xl p-8 text-center">
            <div className="w-12 h-12 mx-auto rounded-full bg-emerald-500/15 border border-emerald-500/30 flex items-center justify-center text-emerald-400 text-xl mb-4">✓</div>
            <h2 className="text-lg font-bold text-white mb-2">Ticket received</h2>
            <p className="text-slate-400 text-sm mb-6">Thanks for reaching out — we'll get back to you shortly.</p>
            <a href="/app/" className="btn btn-primary w-full !py-3">Back to the app</a>
          </div>
        ) : (
          <form onSubmit={submit} className="bg-slate-900 border border-slate-800 rounded-2xl p-7">
            {error && <div className="mb-4 text-sm text-rose-300 bg-rose-950/60 border border-rose-800 rounded-xl px-4 py-3">{error}</div>}
            <div className="grid sm:grid-cols-2 gap-4 mb-4">
              <div><label className="label !text-slate-400">Name</label>
                <input value={form.name} onChange={set('name')} required placeholder="Jane Doe"
                  className="input !bg-slate-800 !border-slate-700 !text-white" /></div>
              <div><label className="label !text-slate-400">Email</label>
                <input type="email" value={form.email} onChange={set('email')} required placeholder="you@company.com"
                  className="input !bg-slate-800 !border-slate-700 !text-white" /></div>
            </div>
            <div className="mb-4"><label className="label !text-slate-400">Subject</label>
              <input value={form.subject} onChange={set('subject')} required placeholder="What do you need help with?"
                className="input !bg-slate-800 !border-slate-700 !text-white" /></div>
            <div className="mb-5"><label className="label !text-slate-400">Message</label>
              <textarea value={form.message} onChange={set('message')} required rows={5}
                placeholder="Describe the issue…" className="input !bg-slate-800 !border-slate-700 !text-white" /></div>
            {/* Honeypot — invisible to humans */}
            <input type="text" value={form.website} onChange={set('website')} tabIndex={-1} autoComplete="off"
              style={{ position: 'absolute', left: '-9999px', opacity: 0, height: 0 }} aria-hidden="true" />
            <button type="submit" disabled={busy} className="btn btn-primary w-full !py-3">
              {busy ? 'Sending…' : 'Submit ticket'}
            </button>
            <div className="text-center mt-4">
              <a href="/app/" className="text-xs text-slate-500 hover:text-slate-300">← Back to the app</a>
            </div>
          </form>
        )}
      </div>
    </div>
  );
}
