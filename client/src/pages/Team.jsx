import { useEffect, useState } from 'react';
import { useAuth, authFetch } from '../auth';
import { api } from '../api';
import { Modal, EmptyState, PageHeader, Skeleton } from '../components/ui';
import SecuritySettings from '../components/SecuritySettings';
import EdiSettings from '../components/EdiSettings';
import { useToast } from '../components/ui';

const ROLE_META = {
  owner: { label: 'Owner', badge: 'badge-violet' },
  biller: { label: 'Biller', badge: 'badge-blue' },
  viewer: { label: 'Viewer', badge: 'badge-slate' },
};

function InviteModal({ onClose, onAdded }) {
  const toast = useToast();
  const [form, setForm] = useState({ name: '', email: '', password: '', role: 'biller' });
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);
  const set = (k) => (e) => setForm({ ...form, [k]: e.target.value });

  const submit = async () => {
    setError(null); setBusy(true);
    try {
      const res = await authFetch('/api/auth/team', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(form),
      });
      if (!res.ok) throw new Error((await res.json()).error);
      toast.success(`${form.name} added to your team`);
      onAdded();
    } catch (e) { setError(e.message); }
    finally { setBusy(false); }
  };

  return (
    <Modal onClose={onClose}>
      <div className="p-7">
        <h3 className="text-xl font-bold tracking-tight mb-1">Invite team member</h3>
        <p className="text-sm text-slate-500 mb-5">They'll sign in with this email and password.</p>
        {error && <div className="mb-4 text-sm text-rose-700 bg-rose-50 border border-rose-200 rounded-xl px-4 py-3">{error}</div>}
        <div className="space-y-4">
          <div><label className="label">Full name</label><input className="input" value={form.name} onChange={set('name')} placeholder="Alex Rivera" /></div>
          <div><label className="label">Email</label><input type="email" className="input" value={form.email} onChange={set('email')} placeholder="alex@company.com" /></div>
          <div><label className="label">Temporary password</label><input type="text" className="input" value={form.password} onChange={set('password')} placeholder="Min. 8 characters" /></div>
          <div><label className="label">Role</label>
            <select className="input" value={form.role} onChange={set('role')}>
              <option value="biller">Biller — can manage claims and appeals</option>
              <option value="viewer">Viewer — read-only access</option>
              <option value="owner">Owner — full access including team</option>
            </select></div>
        </div>
        <div className="mt-6 flex justify-end gap-2">
          <button className="btn btn-ghost" onClick={onClose}>Cancel</button>
          <button className="btn btn-primary" disabled={busy} onClick={submit}>{busy ? 'Adding…' : 'Add to team'}</button>
        </div>
      </div>
    </Modal>
  );
}

export default function Team() {
  const { user } = useAuth();
  const toast = useToast();
  const [team, setTeam] = useState(null);
  const [showInvite, setShowInvite] = useState(false);

  const load = () => api.team().then(setTeam).catch((e) => toast.error(e.message));
  useEffect(() => { load(); }, []);

  const changeRole = async (id, role) => {
    try {
      const res = await authFetch(`/api/auth/team/${id}`, {
        method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ role }),
      });
      if (!res.ok) throw new Error((await res.json()).error);
      toast.success('Role updated');
      load();
    } catch (e) { toast.error(e.message); }
  };

  const remove = async (id, name) => {
    if (!window.confirm(`Remove ${name} from your team? Their appeals will become unassigned.`)) return;
    try {
      const res = await authFetch(`/api/auth/team/${id}`, { method: 'DELETE' });
      if (!res.ok) throw new Error((await res.json()).error);
      toast.success('Team member removed');
      load();
    } catch (e) { toast.error(e.message); }
  };

  return (
    <div>
      {showInvite && <InviteModal onClose={() => setShowInvite(false)} onAdded={() => { setShowInvite(false); load(); }} />}
      <PageHeader
        title="Team"
        subtitle="Who can access your billing workspace"
        actions={[<button key="i" className="btn btn-primary" onClick={() => setShowInvite(true)}>+ Invite member</button>]}
      />

      <SecuritySettings />
      {user?.role === 'owner' && <EdiSettings />}

      <div className="card p-5 mb-5 bg-gradient-to-r from-violet-50 to-sky-50 !border-violet-100">
        <div className="text-sm font-semibold text-slate-800 mb-2">How roles work</div>
        <div className="grid sm:grid-cols-3 gap-3 text-xs text-slate-600">
          <div><span className="badge badge-violet mb-1">Owner</span><p>Full access — team, settings, all data.</p></div>
          <div><span className="badge badge-blue mb-1">Biller</span><p>Manage claims, appeals, uploads. No team changes.</p></div>
          <div><span className="badge badge-slate mb-1">Viewer</span><p>Read-only dashboards and reports.</p></div>
        </div>
      </div>

      {!team ? (
        <div className="card p-6 space-y-3">{Array.from({ length: 3 }).map((_, i) => <Skeleton key={i} className="h-16" />)}</div>
      ) : (
        <div className="card overflow-hidden">
          <table className="w-full tbl">
            <thead><tr><th>Member</th><th>Email</th><th>Role</th><th>Joined</th><th className="!text-right">Actions</th></tr></thead>
            <tbody>
              {team.map((m) => (
                <tr key={m.id}>
                  <td>
                    <div className="flex items-center gap-3">
                      <div className="w-9 h-9 rounded-full bg-gradient-to-br from-emerald-400 to-sky-500 flex items-center justify-center text-xs font-bold text-white">
                        {m.name.split(' ').map((w) => w[0]).join('').slice(0, 2).toUpperCase()}
                      </div>
                      <span className="font-medium">{m.name}{m.id === user.id && <span className="text-xs text-slate-400 ml-2">(you)</span>}</span>
                    </div>
                  </td>
                  <td className="text-slate-500">{m.email}</td>
                  <td>
                    {m.id === user.id ? (
                      <span className={`badge ${ROLE_META[m.role].badge}`}>{ROLE_META[m.role].label}</span>
                    ) : (
                      <select value={m.role} onChange={(e) => changeRole(m.id, e.target.value)} className="input !w-auto !py-1.5 !text-xs">
                        {Object.entries(ROLE_META).map(([v, meta]) => <option key={v} value={v}>{meta.label}</option>)}
                      </select>
                    )}
                  </td>
                  <td className="text-slate-500 text-xs">{new Date(m.created_at).toLocaleDateString()}</td>
                  <td className="!text-right">
                    {m.id !== user.id && (
                      <button onClick={() => remove(m.id, m.name)} className="btn btn-danger-ghost !px-3 !py-1.5 text-xs">Remove</button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
