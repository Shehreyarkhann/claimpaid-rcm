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
      const data = await res.json();
      if (!res.ok) throw new Error(data.error);
      toast.success(data.addedToWorkspace ? `${data.name} added to this workspace (they keep their existing login)` : `${form.name} added to your team`);
      onAdded();
    } catch (e) { setError(e.message); }
    finally { setBusy(false); }
  };

  return (
    <Modal onClose={onClose}>
      <div className="p-7">
        <h3 className="text-xl font-bold tracking-tight mb-1">Invite team member</h3>
        <p className="text-sm text-slate-500 mb-5">New users sign in with this email and password. If they already have a ClaimPaid login, they're added to this workspace with their existing password.</p>
        {error && <div className="mb-4 text-sm text-rose-700 bg-rose-50 border border-rose-200 rounded-xl px-4 py-3">{error}</div>}
        <div className="space-y-4">
          <div><label className="label">Full name <span className="text-slate-400 font-normal">(skip if they already have a login)</span></label><input className="input" value={form.name} onChange={set('name')} placeholder="Alex Rivera" /></div>
          <div><label className="label">Email</label><input type="email" className="input" value={form.email} onChange={set('email')} placeholder="alex@company.com" /></div>
          <div><label className="label">Temporary password <span className="text-slate-400 font-normal">(new users only)</span></label><input type="text" className="input" value={form.password} onChange={set('password')} placeholder="Min. 8 characters" /></div>
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
  const [seats, setSeats] = useState(null);
  const [showInvite, setShowInvite] = useState(false);

  const load = () => {
    api.team().then(setTeam).catch((e) => toast.error(e.message));
    api.settings.seats().then(setSeats).catch(() => {});
  };
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

      {seats && (
        <div className="card p-5 mb-5">
          <div className="flex items-center justify-between mb-2">
            <div className="text-sm font-semibold text-slate-800">Seat usage</div>
            <div className="text-sm tabular-nums text-slate-600">
              <span className="font-bold text-slate-900">{seats.used}</span>
              {' of '}
              <span className="font-bold text-slate-900">{seats.limit === null ? '∞' : seats.limit}</span>
              {' seats used'}
              <span className="text-slate-400 capitalize"> · {seats.plan} plan</span>
            </div>
          </div>
          {seats.limit !== null && (
            <div className="h-2 rounded-full bg-slate-100 overflow-hidden">
              <div
                className={`h-full rounded-full transition-all ${seats.atCap ? 'bg-rose-500' : 'bg-emerald-500'}`}
                style={{ width: `${Math.min(100, (seats.used / seats.limit) * 100)}%` }}
              />
            </div>
          )}
          {seats.atCap && (
            <p className="text-xs text-rose-700 mt-2">Seat limit reached — remove a member or upgrade your plan to invite more people.</p>
          )}
          {seats.limit === null && (
            <p className="text-xs text-slate-400 mt-2">Unlimited seats on the Enterprise plan.</p>
          )}
        </div>
      )}

      <div className="card p-5 mb-5 bg-gradient-to-r from-violet-50 to-sky-50 !border-violet-100">
        <div className="text-sm font-semibold text-slate-800 mb-3">Roles & permissions</div>
        <div className="overflow-x-auto">
          <table className="w-full text-xs">
            <thead>
              <tr className="text-left text-slate-500">
                <th className="pb-2 pr-3 font-medium">Capability</th>
                <th className="pb-2 pr-3 font-medium text-center"><span className="badge badge-violet">Owner</span></th>
                <th className="pb-2 pr-3 font-medium text-center"><span className="badge badge-blue">Biller</span></th>
                <th className="pb-2 font-medium text-center"><span className="badge badge-slate">Viewer</span></th>
              </tr>
            </thead>
            <tbody className="text-slate-600">
              {[
                ['View dashboards, claims, reports', true, true, true],
                ['Create & edit claims, appeals, auths', true, true, false],
                ['Upload 835 ERA files', true, true, false],
                ['Manage filing rules & letter templates', true, true, false],
                ['Invite team & change roles', true, false, false],
                ['Billing, plan & audit log', true, false, false],
                ['Rename workspace', true, false, false],
              ].map(([label, o, b, v]) => (
                <tr key={label} className="border-t border-violet-100/60">
                  <td className="py-2 pr-3">{label}</td>
                  {[o, b, v].map((has, i) => (
                    <td key={i} className="py-2 text-center">
                      {has
                        ? <span className="text-emerald-600 font-bold">✓</span>
                        : <span className="text-slate-300">—</span>}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <p className="text-[11px] text-slate-400 mt-3">Roles are per-workspace — the same person can be an owner in one workspace and a viewer in another.</p>
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
