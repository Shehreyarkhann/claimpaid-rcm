import { useState } from 'react';
import { api } from '../api';

// Shown when an authenticated account has NO workspace (its workspace was
// deleted, or the database was reset). Creating one here is the recovery
// path — the alternative used to be a login loop that could never succeed.
export default function CreateWorkspaceGate({ user }) {
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const create = async () => {
    if (!name.trim() || busy) return;
    setBusy(true);
    setError('');
    try {
      const org = await api.createOrg(name.trim());
      const r = await api.switchOrg(org.id);
      localStorage.setItem('pulse_token', r.token);
      window.location.reload();
    } catch (e) {
      setError(e.message || 'Could not create the workspace. Please try again.');
      setBusy(false);
    }
  };

  return (
    <div className="min-h-screen flex items-center justify-center bg-[#17251F] px-4">
      <div className="w-full max-w-md bg-white rounded-3xl shadow-2xl p-8">
        <div className="w-12 h-12 rounded-2xl bg-emerald-500 flex items-center justify-center font-extrabold text-[#17251F] text-xl mb-5">C</div>
        <h1 className="text-2xl font-extrabold text-stone-900">Create your workspace</h1>
        <p className="text-stone-500 text-sm mt-2 leading-relaxed">
          {user?.name ? `Hi ${user.name.split(' ')[0]} — ` : ''}your account doesn't have a workspace right now.
          Name your practice or billing company to continue — if your account already has a plan, the new workspace joins it automatically.
        </p>
        <label className="block text-xs font-bold tracking-wide text-stone-500 mt-6 mb-2">WORKSPACE NAME</label>
        <input
          value={name}
          onChange={(e) => setName(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter') create(); }}
          placeholder="e.g. Harborview Medical Group"
          className="w-full border border-stone-300 rounded-xl px-4 py-3 text-stone-900 outline-none focus:border-emerald-500 focus:ring-2 focus:ring-emerald-100"
          autoFocus
        />
        {error && <p className="text-red-600 text-sm mt-3">{error}</p>}
        <button
          onClick={create}
          disabled={busy || !name.trim()}
          className="w-full mt-6 bg-emerald-500 hover:bg-emerald-600 disabled:opacity-50 text-white font-bold py-3.5 rounded-xl transition"
        >
          {busy ? 'Creating…' : 'Create workspace'}
        </button>
        <button
          onClick={() => { localStorage.removeItem('pulse_token'); window.location.reload(); }}
          className="w-full mt-3 text-stone-400 hover:text-stone-600 text-sm py-1"
        >
          Sign out
        </button>
      </div>
    </div>
  );
}
