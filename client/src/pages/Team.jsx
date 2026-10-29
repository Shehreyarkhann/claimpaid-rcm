import { useEffect, useState } from 'react';
import Avatar from '../components/Avatar';
import { useAuth, authFetch } from '../auth';
import { api } from '../api';
import { Modal, EmptyState, PageHeader, Skeleton, confirmDialog } from '../components/ui';
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
      if (!res.ok) throw new Error(data.message || data.error);
      toast.success(data.addedToWorkspace ? `${data.name} added to this workspace (they keep their existing login)` : `${form.name} added to your team`);
      onAdded();
    } catch (e) { setError(e.message); }
    finally { setBusy(false); }
  };

  return (
    <Modal onClose={onClose}>
      <div className="p-7">
        <h3 className="text-xl font-bold tracking-tight mb-1">Invite team member</h3>
        <p className="text-sm text-stone-500 mb-5">New users sign in with this email and password. If they already have a ClaimPaid login, they're added to this workspace with their existing password.</p>
        {error && <div className="mb-4 text-sm text-rose-700 bg-rose-50 border border-rose-200 rounded-xl px-4 py-3">{error}</div>}
        <div className="space-y-4">
          <div><label className="label">Full name <span className="text-stone-400 font-normal">(skip if they already have a login)</span></label><input className="input" value={form.name} onChange={set('name')} placeholder="Alex Rivera" /></div>
          <div><label className="label">Email</label><input type="email" className="input" value={form.email} onChange={set('email')} placeholder="alex@company.com" /></div>
          <div><label className="label">Temporary password <span className="text-stone-400 font-normal">(new users only)</span></label><input type="text" className="input" value={form.password} onChange={set('password')} placeholder="Min. 8 characters" /></div>
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

// Account team (deploy #100) — the roster across ALL of the account's
// workspaces. Rendered only for the account holder (the API 403s anyone
// else and the section stays hidden). Seats count people, not memberships.
function AccountTeamSection({ onMembershipChanged }) {
  const toast = useToast();
  const [account, setAccount] = useState(null);
  const [busyKey, setBusyKey] = useState(null);

  const loadAccount = () => {
    api.accountTeam().then(setAccount).catch(() => setAccount(null));
  };
  useEffect(() => { loadAccount(); }, []);

  if (!account) return null;

  const fmtLimit = (v) => (v === null || v === undefined ? '∞' : v);

  const grant = async (member, org) => {
    setBusyKey(`g-${member.id}-${org.id}`);
    try {
      await api.accountGrantAccess({ user_id: member.id, org_id: org.id });
      toast.success(`${member.name} added to ${org.name}`);
      loadAccount();
      onMembershipChanged && onMembershipChanged();
    } catch (e) { toast.error(e.message); }
    finally { setBusyKey(null); }
  };

  const revoke = async (member, org) => {
    if (!(await confirmDialog({
      title: `Remove ${member.name} from ${org.name}?`,
      body: 'They keep access to their other workspaces. If this is their last workspace they keep their login and can create their own workspace.',
      confirmLabel: 'Revoke access',
    }))) return;
    setBusyKey(`r-${member.id}-${org.id}`);
    try {
      await api.accountRevokeAccess({ user_id: member.id, org_id: org.id });
      toast.success(`${member.name} removed from ${org.name}`);
      loadAccount();
      onMembershipChanged && onMembershipChanged();
    } catch (e) { toast.error(e.message); }
    finally { setBusyKey(null); }
  };

  const toggleShare = async (enabled) => {
    setBusyKey('share');
    try {
      const updated = await api.accountShareTeam(enabled);
      setAccount(updated);
      toast.success(enabled
        ? 'Team sharing on — everyone on your roster now has access to every workspace.'
        : 'Team sharing off — existing access stays as-is; new invites join one workspace at a time.');
      onMembershipChanged && onMembershipChanged();
    } catch (e) { toast.error(e.message); }
    finally { setBusyKey(null); }
  };

  return (
    <div className="card p-5 mb-5">
      <div className="flex items-start justify-between gap-4 mb-1">
        <div>
          <div className="text-sm font-semibold text-stone-800">Account team</div>
          <p className="text-xs text-stone-500 mt-0.5">
            Everyone across your workspaces. Seats count people, not memberships — a person in 3 workspaces is 1 seat.
          </p>
        </div>
        <div className="text-sm tabular-nums text-stone-600 whitespace-nowrap">
          <span className="font-bold text-stone-900">{account.seats.used}</span>
          {' of '}
          <span className="font-bold text-stone-900">{fmtLimit(account.seats.limit)}</span>
          {' seats · '}
          <span className="font-bold text-stone-900">{account.workspaces.used}</span>
          {' of '}
          <span className="font-bold text-stone-900">{fmtLimit(account.workspaces.limit)}</span>
          {' workspaces'}
        </div>
      </div>

      <label className="flex items-center gap-3 mt-3 mb-4 cursor-pointer select-none">
        <button
          type="button"
          role="switch"
          aria-checked={account.share_team}
          disabled={busyKey === 'share'}
          onClick={() => toggleShare(!account.share_team)}
          className={`relative w-11 h-6 rounded-full transition shrink-0 ${account.share_team ? 'bg-emerald-500' : 'bg-stone-300'}`}
        >
          <span className={`absolute top-0.5 w-5 h-5 rounded-full bg-white shadow transition-all ${account.share_team ? 'left-[22px]' : 'left-0.5'}`} />
        </button>
        <span className="text-sm text-stone-700">
          <span className="font-medium">Share team across all my workspaces</span>
          <span className="text-stone-400"> — everyone on the roster joins every workspace, including new ones.</span>
        </span>
      </label>

      <div className="overflow-x-auto">
        <table className="w-full tbl">
          <thead><tr><th>Person</th><th>Workspace access</th></tr></thead>
          <tbody>
            {account.members.map((m) => {
              const byOrg = new Map(m.workspaces.map((w) => [w.org_id, w]));
              return (
                <tr key={m.id}>
                  <td>
                    <div className="flex items-center gap-3">
                      <Avatar userId={m.id} name={m.name} className="w-9 h-9 text-xs" />
                      <span>
                        <span className="font-medium block">{m.name}{m.is_account_owner && <span className="text-xs text-stone-400 ml-2">(account owner)</span>}</span>
                        <span className="text-xs text-stone-400">{m.email}</span>
                      </span>
                    </div>
                  </td>
                  <td>
                    <div className="flex flex-wrap gap-1.5">
                      {account.orgs.map((o) => {
                        const w = byOrg.get(o.id);
                        if (w) {
                          return (
                            <span key={o.id} className="inline-flex items-center gap-1.5 rounded-full bg-emerald-50 border border-emerald-200 text-emerald-900 text-xs pl-2.5 pr-1.5 py-1">
                              {o.name} · {ROLE_META[w.role]?.label || w.role}
                              {!m.is_account_owner && (
                                <button
                                  title={`Revoke ${m.name} from ${o.name}`}
                                  disabled={busyKey === `r-${m.id}-${o.id}`}
                                  onClick={() => revoke(m, o)}
                                  className="w-4 h-4 rounded-full hover:bg-emerald-200 text-emerald-700 leading-none"
                                >×</button>
                              )}
                            </span>
                          );
                        }
                        return (
                          <button
                            key={o.id}
                            disabled={busyKey === `g-${m.id}-${o.id}`}
                            onClick={() => grant(m, o)}
                            className="inline-flex items-center gap-1 rounded-full border border-dashed border-stone-300 text-stone-500 hover:border-emerald-400 hover:text-emerald-700 text-xs px-2.5 py-1 transition"
                          >
                            {o.name} · Grant
                          </button>
                        );
                      })}
                    </div>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
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
    if (!(await confirmDialog({ title: `Remove ${name} from this workspace?`, body: 'They lose access to this workspace and their appeals here become unassigned. Their login stays — they keep any other workspaces they belong to.', confirmLabel: 'Remove member' }))) return;
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
      {user?.role === 'owner' && <AccountTeamSection onMembershipChanged={load} />}

      {seats && (
        <div className="card p-5 mb-5">
          <div className="flex items-center justify-between mb-2">
            <div className="text-sm font-semibold text-stone-800">Seat usage</div>
            <div className="text-sm tabular-nums text-stone-600">
              <span className="font-bold text-stone-900">{seats.used}</span>
              {' of '}
              <span className="font-bold text-stone-900">{seats.limit === null ? '∞' : seats.limit}</span>
              {' seats used'}
              <span className="text-stone-400 capitalize"> · {seats.plan} plan</span>
            </div>
          </div>
          {seats.limit !== null && (
            <div className="h-2 rounded-full bg-stone-100 overflow-hidden">
              <div
                className={`h-full rounded-full transition-all ${seats.atCap ? 'bg-rose-500' : 'bg-emerald-500'}`}
                style={{ width: `${Math.min(100, (seats.used / seats.limit) * 100)}%` }}
              />
            </div>
          )}
          <p className="text-[11px] text-stone-400 mt-2">Seats count unique people across all of your account's workspaces.</p>
          {seats.atCap && (
            <p className="text-xs text-rose-700 mt-2">Seat limit reached — remove a member or upgrade your plan to invite more people.</p>
          )}
          {seats.limit === null && (
            <p className="text-xs text-stone-400 mt-2">Unlimited seats on the Enterprise plan.</p>
          )}
        </div>
      )}

      <div className="card p-5 mb-5 bg-gradient-to-r from-amber-50 to-emerald-50 !border-amber-100">
        <div className="text-sm font-semibold text-stone-800 mb-3">Roles & permissions</div>
        <div className="overflow-x-auto">
          <table className="w-full text-xs">
            <thead>
              <tr className="text-left text-stone-500">
                <th className="pb-2 pr-3 font-medium">Capability</th>
                <th className="pb-2 pr-3 font-medium text-center"><span className="badge badge-violet">Owner</span></th>
                <th className="pb-2 pr-3 font-medium text-center"><span className="badge badge-blue">Biller</span></th>
                <th className="pb-2 font-medium text-center"><span className="badge badge-slate">Viewer</span></th>
              </tr>
            </thead>
            <tbody className="text-stone-600">
              {[
                ['View dashboards, claims, reports', true, true, true],
                ['Create & edit claims, appeals, auths', true, true, false],
                ['Upload 835 ERA files', true, true, false],
                ['Manage filing rules & letter templates', true, true, false],
                ['Invite team & change roles', true, false, false],
                ['Billing, plan & audit log', true, false, false],
                ['Rename workspace', true, false, false],
              ].map(([label, o, b, v]) => (
                <tr key={label} className="border-t border-amber-100/60">
                  <td className="py-2 pr-3">{label}</td>
                  {[o, b, v].map((has, i) => (
                    <td key={i} className="py-2 text-center">
                      {has
                        ? <span className="text-emerald-600 font-bold">✓</span>
                        : <span className="text-stone-300">—</span>}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <p className="text-[11px] text-stone-400 mt-3">Roles are per-workspace — the same person can be an owner in one workspace and a viewer in another.</p>
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
                      <Avatar userId={m.id} name={m.name} hasAvatar={m.has_avatar} className="w-9 h-9 text-xs" />
                      <span className="font-medium">{m.name}{m.id === user.id && <span className="text-xs text-stone-400 ml-2">(you)</span>}</span>
                    </div>
                  </td>
                  <td className="text-stone-500">{m.email}</td>
                  <td>
                    {m.id === user.id ? (
                      <span className={`badge ${ROLE_META[m.role].badge}`}>{ROLE_META[m.role].label}</span>
                    ) : (
                      <select value={m.role} onChange={(e) => changeRole(m.id, e.target.value)} className="input !w-auto !py-1.5 !text-xs">
                        {Object.entries(ROLE_META).map(([v, meta]) => <option key={v} value={v}>{meta.label}</option>)}
                      </select>
                    )}
                  </td>
                  <td className="text-stone-500 text-xs">{new Date(m.created_at).toLocaleDateString()}</td>
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
