import { useEffect, useRef, useState } from 'react';
import { api } from '../api';
import { useAuth } from '../auth';

// Workspace switcher: one login, many orgs. Dropdown in the sidebar header.
export default function WorkspaceSwitcher({ collapsed }) {
  const { user } = useAuth();
  const [orgs, setOrgs] = useState(null);
  const [open, setOpen] = useState(false);
  const [creating, setCreating] = useState(false);
  const [newName, setNewName] = useState('');
  const [busy, setBusy] = useState(false);
  const ref = useRef(null);

  useEffect(() => {
    api.myOrgs().then(setOrgs).catch(() => setOrgs([]));
  }, []);

  useEffect(() => {
    const close = (e) => { if (ref.current && !ref.current.contains(e.target)) setOpen(false); };
    document.addEventListener('mousedown', close);
    return () => document.removeEventListener('mousedown', close);
  }, []);

  const doSwitch = async (orgId) => {
    if (orgId === user?.org_id) { setOpen(false); return; }
    if (busy) return;
    setBusy(true);
    try {
      const r = await api.switchOrg(orgId);
      localStorage.setItem('pulse_token', r.token);
      window.location.reload();
    } catch (e) {
      alert(e.message);
      setBusy(false);
    }
  };

  const doCreate = async () => {
    if (!newName.trim() || busy) return;
    setBusy(true);
    try {
      const org = await api.createOrg(newName.trim());
      const r = await api.switchOrg(org.id);
      localStorage.setItem('pulse_token', r.token);
      window.location.reload();
    } catch (e) {
      alert(e.message);
      setBusy(false);
    }
  };

  if (collapsed) return null;

  return (
    <div ref={ref} className="relative">
      <button
        onClick={() => setOpen((o) => !o)}
        className="w-full flex items-center gap-2 rounded-lg hover:bg-white/10 px-1.5 py-1 -mx-1.5 transition text-left"
        title="Switch workspace"
      >
        <div className="min-w-0 flex-1">
          <div className="font-bold leading-tight tracking-tight truncate">ClaimPaid RCM</div>
          <div className="text-[11px] text-slate-400 truncate max-w-[150px] flex items-center gap-1">
            {user?.orgName}
            <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" className="shrink-0 opacity-70">
              <path d="M6 9l6 6 6-6" />
            </svg>
          </div>
        </div>
      </button>

      {open && (
        <div className="absolute left-0 right-0 top-full mt-2 min-w-[220px] rounded-xl bg-[#111a2e] border border-white/10 shadow-2xl py-1.5 z-50">
          <div className="px-3.5 py-1.5 text-[10px] font-semibold uppercase tracking-widest text-slate-500">Workspaces</div>
          {(orgs || []).map((o) => (
            <button
              key={o.id}
              onClick={() => doSwitch(o.id)}
              disabled={busy}
              className="w-full flex items-center gap-2.5 px-3.5 py-2 hover:bg-white/5 transition text-left disabled:opacity-50"
            >
              <span className={`w-2 h-2 rounded-full shrink-0 ${o.id === user?.org_id ? 'bg-emerald-400' : 'bg-slate-600'}`} />
              <span className="flex-1 min-w-0">
                <span className="block text-sm font-medium text-white truncate">{o.name}</span>
                <span className="block text-[11px] text-slate-400 capitalize">{o.role}</span>
              </span>
              {o.id === user?.org_id && (
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#34d399" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M20 6L9 17l-5-5" />
                </svg>
              )}
            </button>
          ))}
          <div className="mx-3 my-1.5 border-t border-white/10" />
          {creating ? (
            <div className="px-3.5 py-1.5">
              <input
                autoFocus
                className="input !bg-white/5 !border-white/10 !text-white !text-sm w-full"
                placeholder="Workspace name…"
                value={newName}
                onChange={(e) => setNewName(e.target.value)}
                onKeyDown={(e) => { if (e.key === 'Enter') doCreate(); if (e.key === 'Escape') setCreating(false); }}
              />
              <div className="flex gap-2 mt-2">
                <button className="btn btn-primary !text-xs !py-1.5 flex-1" onClick={doCreate} disabled={busy || !newName.trim()}>
                  {busy ? 'Creating…' : 'Create & switch'}
                </button>
                <button className="btn btn-ghost !text-xs !py-1.5" onClick={() => setCreating(false)}>Cancel</button>
              </div>
            </div>
          ) : (
            <button
              onClick={() => setCreating(true)}
              className="w-full flex items-center gap-2.5 px-3.5 py-2 hover:bg-white/5 transition text-left text-sm text-slate-300"
            >
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
                <path d="M12 5v14M5 12h14" />
              </svg>
              New workspace
            </button>
          )}
        </div>
      )}
    </div>
  );
}
