import { useEffect, useState } from 'react';
import { useAuth } from '../auth';
import { api, fmtMoney2 } from '../api';
import { Modal, EmptyState, PageHeader, Skeleton, useToast } from '../components/ui';

const PLAN_LABEL = { starter: 'Starter', pro: 'Pro + AI', ai: 'AI Only', enterprise: 'Enterprise', trial: 'Trial' };
const PLAN_BADGE = { starter: 'badge-blue', pro: 'badge-violet', ai: 'badge-amber', enterprise: 'badge-green', trial: 'badge-blue' };
const STATUS_BADGE = {
  trialing: 'badge-blue', active: 'badge-green', past_due: 'badge-rose',
  canceled: 'badge-slate', unpaid: 'badge-rose', incomplete: 'badge-amber', incomplete_expired: 'badge-slate',
};
const VALID_PLANS = ['trial', 'starter', 'pro', 'ai', 'enterprise'];
const VALID_STATUSES = ['trialing', 'active', 'past_due', 'canceled', 'unpaid'];
const VALID_ROLES = ['owner', 'biller', 'viewer'];

const money = (cents) => fmtMoney2((cents || 0) / 100);
const trunc = (s, n = 14) => (s && s.length > n ? s.slice(0, n) + '…' : (s || '—'));

function StatCard({ label, value, accent }) {
  return (
    <div className="bg-slate-800/60 border border-slate-700/60 rounded-2xl p-5">
      <div className="text-xs font-medium text-slate-400 uppercase tracking-wide mb-1.5">{label}</div>
      <div className={`text-3xl font-bold tracking-tight ${accent || 'text-white'}`}>{value}</div>
    </div>
  );
}

function SectionTitle({ children }) {
  return <h3 className="text-sm font-semibold text-slate-300 uppercase tracking-wide mb-4">{children}</h3>;
}

/* ---------------- OVERVIEW ---------------- */
function OverviewTab() {
  const [data, setData] = useState(null);
  const [demos, setDemos] = useState([]);
  const [tickets, setTickets] = useState([]);
  const [subs, setSubs] = useState([]);

  useEffect(() => {
    api.super.overview().then(setData).catch(() => {});
    api.super.demos().then(setDemos).catch(() => {});
    api.super.tickets().then(setTickets).catch(() => {});
    api.super.subscriptions().then((s) => setSubs(s.subscriptions || [])).catch(() => {});
  }, []);

  if (!data) return <div className="space-y-3">{[1, 2, 3].map((i) => <Skeleton key={i} className="h-24 !bg-slate-800" />)}</div>;

  const attention = [];
  subs.filter((s) => s.plan_status === 'past_due').forEach((s) =>
    attention.push({ kind: 'Past-due subscription', detail: `${s.name} (${PLAN_LABEL[s.plan] || s.plan})`, sev: 'rose' }));
  subs.filter((s) => s.plan_status === 'trialing' && s.current_period_end &&
    (new Date(s.current_period_end) - Date.now()) / 86400000 <= 3).forEach((s) =>
    attention.push({ kind: 'Trial ending soon', detail: `${s.name} — ends ${s.current_period_end.slice(0, 10)}`, sev: 'amber' }));
  demos.filter((d) => !d.contacted).slice(0, 5).forEach((d) =>
    attention.push({ kind: 'Uncontacted demo', detail: `${d.company} — ${d.name}`, sev: 'blue' }));
  tickets.filter((t) => t.status !== 'closed' && t.sla_due_at && new Date(t.sla_due_at.replace(' ', 'T') + 'Z') < new Date()).slice(0, 5).forEach((t) =>
    attention.push({ kind: 'Overdue ticket', detail: `#${t.id} ${t.subject}`, sev: 'rose' }));
  tickets.filter((t) => t.status === 'open').slice(0, 5).forEach((t) =>
    attention.push({ kind: 'Open ticket', detail: `#${t.id} ${t.subject}`, sev: 'amber' }));

  return (
    <div>
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4 mb-8">
        <StatCard label="RCM orgs" value={data.rcm_orgs} />
        <StatCard label="AI orgs" value={data.ai_orgs} />
        <StatCard label="Total users" value={data.total_users} />
        <StatCard label="MRR" value={money(data.mrr_cents)} accent="text-emerald-400" />
        <StatCard label="Trialing" value={data.trialing} accent="text-sky-400" />
        <StatCard label="Past due" value={data.past_due} accent={data.past_due ? 'text-rose-400' : 'text-white'} />
        <StatCard label="Open demos" value={data.open_demos} />
        <StatCard label="Open tickets" value={data.open_tickets} accent={data.open_tickets ? 'text-amber-400' : 'text-white'} />
      </div>

      <div className="grid lg:grid-cols-2 gap-6">
        <div className="bg-slate-800/60 border border-slate-700/60 rounded-2xl p-6">
          <SectionTitle>Needs attention</SectionTitle>
          {attention.length === 0 ? (
            <p className="text-sm text-slate-500">Nothing needs attention right now.</p>
          ) : (
            <div className="space-y-2.5">
              {attention.map((a, i) => (
                <div key={i} className="flex items-center gap-3 text-sm">
                  <span className={`badge ${a.sev === 'rose' ? 'badge-rose' : a.sev === 'amber' ? 'badge-amber' : 'badge-blue'} shrink-0`}>{a.kind}</span>
                  <span className="text-slate-300 truncate">{a.detail}</span>
                </div>
              ))}
            </div>
          )}
        </div>
        <div className="bg-slate-800/60 border border-slate-700/60 rounded-2xl p-6">
          <SectionTitle>Newest workspaces</SectionTitle>
          <div className="space-y-2.5">
            {data.recent_orgs.map((o) => (
              <div key={o.id} className="flex items-center justify-between text-sm">
                <span className="text-slate-200 font-medium truncate">{o.name}</span>
                <span className="flex items-center gap-2 shrink-0 ml-3">
                  <span className={`badge ${PLAN_BADGE[o.plan] || 'badge-slate'}`}>{PLAN_LABEL[o.plan] || o.plan}</span>
                  <span className={`badge ${STATUS_BADGE[o.plan_status] || 'badge-slate'}`}>{o.plan_status}</span>
                </span>
              </div>
            ))}
            {data.recent_orgs.length === 0 && <p className="text-sm text-slate-500">No workspaces yet.</p>}
          </div>
        </div>
      </div>
    </div>
  );
}

/* ---------------- CLIENTS ---------------- */
function OrgDrawer({ orgId, onClose, onChanged }) {
  const toast = useToast();
  const [detail, setDetail] = useState(null);
  const [plan, setPlan] = useState('');
  const [status, setStatus] = useState('');
  const [confirmName, setConfirmName] = useState('');
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    api.super.orgDetail(orgId).then((d) => {
      setDetail(d);
      setPlan(d.org.plan || 'trial');
      setStatus(d.org.plan_status || 'trialing');
    }).catch((e) => toast.error(e.message));
  }, [orgId]);

  const savePlan = async () => {
    setSaving(true);
    try {
      await api.super.setPlan(orgId, plan, status);
      toast.success('Plan updated');
      const d = await api.super.orgDetail(orgId);
      setDetail(d); onChanged();
    } catch (e) { toast.error(e.message); }
    finally { setSaving(false); }
  };

  const del = async () => {
    try {
      await api.super.deleteOrg(orgId);
      toast.success('Workspace deleted');
      onChanged(); onClose();
    } catch (e) { toast.error(e.message); }
  };

  if (!detail) return <Modal onClose={onClose}><div className="p-8"><Skeleton className="h-40 !bg-slate-700" /></div></Modal>;
  const { org, users, claimsByStatus, openAppeals, baa, eligibility, transmission, ehr, coding } = detail;

  return (
    <Modal onClose={onClose} wide>
      <div className="p-7 bg-slate-900 text-slate-200 rounded-2xl">
        <h3 className="text-xl font-bold text-white mb-1">{org.name}</h3>
        <p className="text-xs text-slate-500 mb-6">Workspace #{org.id} · created {org.created_at?.slice(0, 10)}</p>

        <div className="grid sm:grid-cols-3 gap-4 mb-6">
          <div className="bg-slate-800 rounded-xl p-4">
            <div className="text-xs text-slate-500 mb-1">Plan</div>
            <div className="flex gap-2">
              <select value={plan} onChange={(e) => setPlan(e.target.value)} className="input !bg-slate-700 !border-slate-600 !text-white text-sm">
                {VALID_PLANS.map((p) => <option key={p} value={p}>{PLAN_LABEL[p]}</option>)}
              </select>
            </div>
            <div className="text-xs text-slate-500 mt-3 mb-1">Status</div>
            <select value={status} onChange={(e) => setStatus(e.target.value)} className="input !bg-slate-700 !border-slate-600 !text-white text-sm">
              {VALID_STATUSES.map((s) => <option key={s} value={s}>{s}</option>)}
            </select>
            <button onClick={savePlan} disabled={saving} className="btn btn-primary !py-1.5 !text-xs mt-3 w-full">
              {saving ? 'Saving…' : 'Save plan'}
            </button>
          </div>
          <div className="bg-slate-800 rounded-xl p-4">
            <div className="text-xs text-slate-500 mb-2">Subscription</div>
            <div className="text-xs space-y-1.5 font-mono">
              <div><span className="text-slate-500">customer </span><span className="text-slate-300">{trunc(org.stripe_customer_id, 22)}</span></div>
              <div><span className="text-slate-500">sub </span><span className="text-slate-300">{trunc(org.stripe_subscription_id, 22)}</span></div>
              <div><span className="text-slate-500">period end </span><span className="text-slate-300">{org.current_period_end?.slice(0, 10) || '—'}</span></div>
            </div>
          </div>
          <div className="bg-slate-800 rounded-xl p-4">
            <div className="text-xs text-slate-500 mb-2">Activity</div>
            <div className="text-xs space-y-1.5 text-slate-300">
              <div>Users: <strong className="text-white">{users.length}</strong></div>
              <div>Open appeals: <strong className="text-white">{openAppeals}</strong></div>
              {claimsByStatus.map((c) => <div key={c.status}>{c.status}: <strong className="text-white">{c.n}</strong></div>)}
            </div>
          </div>
        </div>

        <SectionTitle>BAA (HIPAA)</SectionTitle>
        <div className="bg-slate-800 rounded-xl p-4 mb-6">
          {baa ? (
            <div className="grid sm:grid-cols-2 gap-x-6 gap-y-2 text-xs">
              <div><span className="text-slate-500">Status </span><span className="badge badge-green ml-1">Signed {baa.baa_version}</span></div>
              <div><span className="text-slate-500">Legal name </span><span className="text-slate-200">{baa.org_legal_name}</span></div>
              <div><span className="text-slate-500">Signer </span><span className="text-slate-200">{baa.signed_by_name}{baa.signed_by_title ? `, ${baa.signed_by_title}` : ''}</span></div>
              <div><span className="text-slate-500">Email </span><span className="text-slate-200">{baa.signed_by_email}</span></div>
              <div><span className="text-slate-500">Signed </span><span className="text-slate-200">{baa.signed_at?.slice(0, 19).replace('T', ' ')}</span></div>
              <div><span className="text-slate-500">IP </span><span className="text-slate-200 font-mono">{baa.ip_address || '—'}</span></div>
              <div className="sm:col-span-2"><span className="text-slate-500">Text hash </span><span className="text-slate-200 font-mono break-all">{baa.text_hash?.slice(0, 32)}…</span></div>
            </div>
          ) : (
            <p className="text-sm text-amber-300/90">Not signed — this workspace cannot activate a paid subscription until the BAA is signed.</p>
          )}
        </div>

        <SectionTitle>Eligibility</SectionTitle>
        <div className="bg-slate-800 rounded-xl p-4 mb-6">
          {eligibility ? (
            <div className="grid sm:grid-cols-3 gap-x-6 gap-y-2 text-xs">
              <div><span className="text-slate-500">Vendor </span>
                <span className={`badge ml-1 ${eligibility.vendor === 'demo' ? 'badge-amber' : 'badge-green'}`}>
                  {eligibility.vendor === 'demo' ? 'Demo (synthetic)' : 'Live REST'}
                </span></div>
              <div><span className="text-slate-500">Endpoint </span>
                <span className="text-slate-200">{eligibility.configured ? 'Configured' : '—'}</span></div>
              <div><span className="text-slate-500">Checks (30d) </span>
                <span className="text-white font-bold">{eligibility.checks_30d}</span></div>
            </div>
          ) : (
            <p className="text-sm text-slate-500">No eligibility data.</p>
          )}
        </div>

        <SectionTitle>Transmission</SectionTitle>
        <div className="bg-slate-800 rounded-xl p-4 mb-6">
          {transmission ? (
            <div className="grid sm:grid-cols-3 gap-x-6 gap-y-2 text-xs">
              <div><span className="text-slate-500">Vendor </span>
                <span className={`badge ml-1 ${transmission.vendor === 'manual' ? 'badge-slate' : 'badge-green'}`}>
                  {transmission.vendor}
                </span></div>
              <div><span className="text-slate-500">Batches (30d) </span>
                <span className="text-white font-bold">{transmission.batches_30d}</span></div>
              <div><span className="text-slate-500">Claims transmitted (30d) </span>
                <span className="text-white font-bold">{transmission.claims_transmitted_30d}</span></div>
              <div><span className="text-slate-500">Acceptance rate </span>
                <span className="text-white font-bold">{transmission.acceptance_rate == null ? '—' : `${transmission.acceptance_rate}%`}</span></div>
            </div>
          ) : (
            <p className="text-sm text-slate-500">No transmission data.</p>
          )}
        </div>

        <SectionTitle>EHR</SectionTitle>
        <div className="bg-slate-800 rounded-xl p-4 mb-6">
          {ehr ? (
            <div className="grid sm:grid-cols-3 gap-x-6 gap-y-2 text-xs">
              <div><span className="text-slate-500">Connections </span>
                {(ehr.connections || []).length ? ehr.connections.map((c) => (
                  <span key={c.provider} className={`badge ml-1 ${c.status === 'connected' ? 'badge-green' : c.status === 'error' ? 'badge-red' : 'badge-slate'}`}>
                    {c.provider}: {c.status}
                  </span>
                )) : <span className="text-slate-400">none</span>}</div>
              <div><span className="text-slate-500">Encounters synced (30d) </span>
                <span className="text-white font-bold">{ehr.encounters_30d}</span></div>
              <div><span className="text-slate-500">Last sync </span>
                <span className="text-slate-200">{ehr.connections?.[0]?.last_sync_at?.slice(0, 16).replace('T', ' ') || '—'}</span></div>
            </div>
          ) : (
            <p className="text-sm text-slate-500">No EHR data.</p>
          )}
        </div>

        <SectionTitle>AI code assist</SectionTitle>
        <div className="bg-slate-800 rounded-xl p-4 mb-6">
          {coding ? (
            <div className="grid sm:grid-cols-3 gap-x-6 gap-y-2 text-xs">
              <div><span className="text-slate-500">Coding jobs (30d) </span>
                <span className="text-white font-bold">{coding.jobs_30d}</span></div>
              <div><span className="text-slate-500">Human acceptance rate </span>
                <span className="text-white font-bold">{coding.acceptance_rate == null ? '—' : `${coding.acceptance_rate}%`}</span></div>
              <div className="text-slate-500">Codes are never auto-applied — every accepted code was reviewed by a human.</div>
            </div>
          ) : (
            <p className="text-sm text-slate-500">No coding data.</p>
          )}
        </div>

        <SectionTitle>Users</SectionTitle>
        <div className="space-y-2 mb-6 max-h-48 overflow-y-auto">
          {users.map((u) => (
            <div key={u.id} className="flex items-center justify-between text-sm bg-slate-800/60 rounded-lg px-4 py-2.5">
              <span className="text-slate-200">{u.name} <span className="text-slate-500 text-xs ml-1">{u.email}</span></span>
              <span className="badge badge-slate">{u.role}</span>
            </div>
          ))}
          {users.length === 0 && <p className="text-sm text-slate-500">No users.</p>}
        </div>

        <div className="border-t border-rose-900/50 pt-5">
          <div className="text-sm font-semibold text-rose-400 mb-2">Danger zone</div>
          <p className="text-xs text-slate-500 mb-3">Type <strong className="text-slate-300">{org.name}</strong> to permanently delete this workspace and all its data.</p>
          <div className="flex gap-2">
            <input value={confirmName} onChange={(e) => setConfirmName(e.target.value)} placeholder={org.name}
              className="input !bg-slate-800 !border-slate-700 !text-white text-sm flex-1" />
            <button onClick={del} disabled={confirmName !== org.name} className="btn !bg-rose-600 hover:!bg-rose-700 !text-white disabled:!opacity-40 text-sm">
              Delete workspace
            </button>
          </div>
        </div>

        <div className="flex justify-end mt-6">
          <button onClick={onClose} className="btn btn-ghost !text-slate-300">Close</button>
        </div>
      </div>
    </Modal>
  );
}

function ClientsTab() {
  const toast = useToast();
  const [orgs, setOrgs] = useState(null);
  const [drawer, setDrawer] = useState(null);
  const load = () => api.super.orgs().then(setOrgs).catch((e) => toast.error(e.message));
  useEffect(() => { load(); }, []);

  if (!orgs) return <Skeleton className="h-64 !bg-slate-800" />;
  return (
    <div>
      {drawer && <OrgDrawer orgId={drawer} onClose={() => setDrawer(null)} onChanged={load} />}
      <div className="bg-slate-800/60 border border-slate-700/60 rounded-2xl overflow-hidden">
        <table className="w-full tbl !text-slate-300">
          <thead><tr className="!text-slate-500">
            <th>Workspace</th><th>Plan</th><th>Status</th><th>BAA</th><th className="!text-right">Users</th>
            <th className="!text-right">Claims</th><th>Created</th>
          </tr></thead>
          <tbody>
            {orgs.map((o) => (
              <tr key={o.id} onClick={() => setDrawer(o.id)} className="cursor-pointer hover:!bg-slate-700/40">
                <td className="font-medium text-white">{o.name} <span className="text-slate-500 text-xs">#{o.id}</span></td>
                <td><span className={`badge ${PLAN_BADGE[o.plan] || 'badge-slate'}`}>{PLAN_LABEL[o.plan] || o.plan}</span></td>
                <td><span className={`badge ${STATUS_BADGE[o.plan_status] || 'badge-slate'}`}>{o.plan_status}</span></td>
                <td>
                  {o.baa_version
                    ? <span className="badge badge-green" title={`Signed ${o.baa_signed_at?.slice(0, 10)}`}>Signed {o.baa_version}</span>
                    : <span className="badge badge-amber">Not signed</span>}
                </td>
                <td className="!text-right">{o.user_count}</td>
                <td className="!text-right">{o.claim_count}</td>
                <td className="text-slate-500 text-xs">{o.created_at?.slice(0, 10)}</td>
              </tr>
            ))}
          </tbody>
        </table>
        {orgs.length === 0 && <div className="p-8"><EmptyState icon="🏢" title="No workspaces" hint="No RCM orgs exist yet." /></div>}
      </div>
    </div>
  );
}

/* ---------------- AI CLIENTS ---------------- */
function AiClientsTab() {
  const [rows, setRows] = useState(null);
  useEffect(() => { api.super.aiOrgs().then(setRows).catch(() => setRows([])); }, []);
  if (!rows) return <Skeleton className="h-64 !bg-slate-800" />;
  return (
    <div className="bg-slate-800/60 border border-slate-700/60 rounded-2xl overflow-hidden">
      <table className="w-full tbl !text-slate-300">
        <thead><tr className="!text-slate-500">
          <th>AI workspace</th><th>Linked RCM org</th><th className="!text-right">Users</th>
          <th className="!text-right">KBs</th><th className="!text-right">Chunks</th>
        </tr></thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.id}>
              <td className="font-medium text-white">{r.name} <span className="text-slate-500 text-xs">#{r.id}</span></td>
              <td className="text-slate-400">{r.rcm_org_name ? `${r.rcm_org_name} (#${r.rcm_org_id})` : '—'}</td>
              <td className="!text-right">{r.user_count}</td>
              <td className="!text-right">{r.kb_count}</td>
              <td className="!text-right">{r.chunk_count}</td>
            </tr>
          ))}
        </tbody>
      </table>
      {rows.length === 0 && <div className="p-8 text-sm text-slate-500 text-center">AI database not reachable or no AI workspaces yet.</div>}
    </div>
  );
}

/* ---------------- USERS ---------------- */
function UserDrawer({ userId, onClose, onChanged, meId }) {
  const toast = useToast();
  const [form, setForm] = useState({ name: '', role: 'biller', is_active: true });
  const [loaded, setLoaded] = useState(false);
  const [tempPw, setTempPw] = useState(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    api.super.users('').then((rows) => {
      const u = rows.find((r) => r.id === userId);
      if (u) {
        setForm({ name: u.name || '', role: (u.roles || 'biller').split(',')[0].trim() || 'biller', is_active: true });
        setLoaded(true);
      }
    }).catch((e) => toast.error(e.message));
  }, [userId]);

  const save = async () => {
    setBusy(true);
    try {
      await api.super.updateUser(userId, { name: form.name, role: form.role, is_active: form.is_active });
      toast.success('User updated'); onChanged();
    } catch (e) { toast.error(e.message); }
    finally { setBusy(false); }
  };
  const resetPw = async () => {
    try {
      const r = await api.super.resetPassword(userId);
      setTempPw(r.temp_password);
      toast.success('Temporary password generated');
    } catch (e) { toast.error(e.message); }
  };
  const del = async () => {
    if (!window.confirm('Delete this user permanently?')) return;
    try {
      await api.super.deleteUser(userId);
      toast.success('User deleted'); onChanged(); onClose();
    } catch (e) { toast.error(e.message); }
  };

  return (
    <Modal onClose={onClose}>
      <div className="p-7 bg-slate-900 text-slate-200 rounded-2xl">
        <h3 className="text-lg font-bold text-white mb-5">Edit user #{userId}</h3>
        {!loaded ? <Skeleton className="h-32 !bg-slate-700" /> : (
          <div className="space-y-4">
            <div><label className="label !text-slate-400">Name</label>
              <input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })}
                className="input !bg-slate-800 !border-slate-700 !text-white" /></div>
            <div><label className="label !text-slate-400">Role (all workspaces)</label>
              <select value={form.role} onChange={(e) => setForm({ ...form, role: e.target.value })}
                className="input !bg-slate-800 !border-slate-700 !text-white">
                {VALID_ROLES.map((r) => <option key={r} value={r}>{r}</option>)}
              </select></div>
            <label className="flex items-center gap-2 text-sm text-slate-300">
              <input type="checkbox" checked={form.is_active} onChange={(e) => setForm({ ...form, is_active: e.target.checked })} className="rounded" />
              Active (can sign in)
            </label>
            <div className="flex gap-2 pt-1">
              <button onClick={save} disabled={busy} className="btn btn-primary !text-sm">Save</button>
              <button onClick={resetPw} className="btn !bg-amber-600 hover:!bg-amber-700 !text-white !text-sm">Reset password</button>
            </div>
            {tempPw && (
              <div className="bg-amber-950/60 border border-amber-800 rounded-xl p-4">
                <div className="text-xs text-amber-400 mb-1">Temporary password — shown once. Copy it now:</div>
                <div className="flex items-center gap-2">
                  <code className="font-mono text-lg text-white">{tempPw}</code>
                  <button onClick={() => { navigator.clipboard.writeText(tempPw); toast.success('Copied'); }}
                    className="btn !bg-slate-700 !text-white !py-1 !text-xs">Copy</button>
                </div>
              </div>
            )}
            {userId !== meId && (
              <div className="border-t border-slate-800 pt-4">
                <button onClick={del} className="btn !bg-rose-600 hover:!bg-rose-700 !text-white !text-sm">Delete user</button>
              </div>
            )}
          </div>
        )}
        <div className="flex justify-end mt-6">
          <button onClick={onClose} className="btn btn-ghost !text-slate-300">Close</button>
        </div>
      </div>
    </Modal>
  );
}

function UsersTab() {
  const toast = useToast();
  const { user } = useAuth();
  const [rows, setRows] = useState(null);
  const [search, setSearch] = useState('');
  const [drawer, setDrawer] = useState(null);
  const load = () => api.super.users(search).then(setRows).catch((e) => toast.error(e.message));
  useEffect(() => { load(); }, []);

  if (!rows) return <Skeleton className="h-64 !bg-slate-800" />;
  return (
    <div>
      {drawer && <UserDrawer userId={drawer} meId={user?.id} onClose={() => setDrawer(null)} onChanged={load} />}
      <div className="mb-4 flex gap-2">
        <input value={search} onChange={(e) => setSearch(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && load()}
          placeholder="Search name or email…" className="input !bg-slate-800 !border-slate-700 !text-white max-w-xs" />
        <button onClick={load} className="btn btn-dark !text-sm">Search</button>
      </div>
      <div className="bg-slate-800/60 border border-slate-700/60 rounded-2xl overflow-hidden">
        <table className="w-full tbl !text-slate-300">
          <thead><tr className="!text-slate-500"><th>Name</th><th>Email</th><th>Workspaces</th><th>Roles</th><th></th></tr></thead>
          <tbody>
            {rows.map((u) => (
              <tr key={u.id} onClick={() => setDrawer(u.id)} className="cursor-pointer hover:!bg-slate-700/40">
                <td className="font-medium text-white">
                  {u.name}
                  {u.is_superadmin === 1 && <span className="badge badge-amber ml-2">super</span>}
                </td>
                <td className="text-slate-400 text-xs">{u.email}</td>
                <td className="text-slate-400 text-xs">{u.orgs || '—'}</td>
                <td className="text-slate-400 text-xs">{u.roles || '—'}</td>
                <td className="text-slate-500 text-xs">{u.created_at?.slice(0, 10)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

/* ---------------- SUBSCRIPTIONS ---------------- */
function SubscriptionsTab() {
  const [data, setData] = useState(null);
  useEffect(() => { api.super.subscriptions().then(setData).catch(() => {}); }, []);
  if (!data) return <Skeleton className="h-64 !bg-slate-800" />;
  const t = data.totals;
  return (
    <div>
      <div className="grid grid-cols-2 lg:grid-cols-5 gap-4 mb-6">
        <StatCard label="MRR" value={money(t.mrr_cents)} accent="text-emerald-400" />
        <StatCard label="Active" value={t.active} accent="text-emerald-400" />
        <StatCard label="Trialing" value={t.trialing} accent="text-sky-400" />
        <StatCard label="Past due" value={t.past_due} accent={t.past_due ? 'text-rose-400' : 'text-white'} />
        <StatCard label="Canceled" value={t.canceled} />
      </div>
      <div className="bg-slate-800/60 border border-slate-700/60 rounded-2xl overflow-hidden">
        <table className="w-full tbl !text-slate-300">
          <thead><tr className="!text-slate-500">
            <th>Workspace</th><th>Plan</th><th>Status</th><th>Stripe customer</th><th>Stripe sub</th><th>Trial ends</th><th className="!text-right">MRR</th>
          </tr></thead>
          <tbody>
            {data.subscriptions.map((s) => (
              <tr key={s.id}>
                <td className="font-medium text-white">{s.name}</td>
                <td><span className={`badge ${PLAN_BADGE[s.plan] || 'badge-slate'}`}>{PLAN_LABEL[s.plan] || s.plan}</span></td>
                <td><span className={`badge ${STATUS_BADGE[s.plan_status] || 'badge-slate'}`}>{s.plan_status}</span></td>
                <td className="font-mono text-xs text-slate-500">{trunc(s.stripe_customer_id, 18)}</td>
                <td className="font-mono text-xs text-slate-500">{trunc(s.stripe_subscription_id, 18)}</td>
                <td className="text-xs text-slate-500">{s.current_period_end?.slice(0, 10) || '—'}</td>
                <td className="!text-right text-slate-200">{money(s.mrr_cents)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

/* ---------------- DEMO REQUESTS ---------------- */
function DemosTab() {
  const toast = useToast();
  const [rows, setRows] = useState(null);
  const [notes, setNotes] = useState({});
  const load = () => api.super.demos().then((r) => {
    setRows(r);
    setNotes(Object.fromEntries(r.map((x) => [x.id, x.notes || ''])));
  }).catch((e) => toast.error(e.message));
  useEffect(() => { load(); }, []);

  const toggle = async (d) => {
    try {
      await api.super.updateDemo(d.id, { contacted: !d.contacted });
      load();
    } catch (e) { toast.error(e.message); }
  };
  const saveNote = async (d) => {
    try {
      await api.super.updateDemo(d.id, { notes: notes[d.id] || '' });
      toast.success('Note saved');
    } catch (e) { toast.error(e.message); }
  };

  if (!rows) return <Skeleton className="h-64 !bg-slate-800" />;
  return (
    <div className="space-y-3">
      {rows.map((d) => (
        <div key={d.id} className="bg-slate-800/60 border border-slate-700/60 rounded-2xl p-5">
          <div className="flex items-start justify-between gap-4 flex-wrap">
            <div>
              <div className="font-semibold text-white">{d.company} <span className="text-slate-500 font-normal text-sm">· {d.name}</span></div>
              <div className="text-xs text-slate-500 mt-1">{d.email}{d.phone ? ` · ${d.phone}` : ''}{d.team_size ? ` · ${d.team_size}` : ''}</div>
              {d.message && <p className="text-sm text-slate-400 mt-2 max-w-2xl">{d.message}</p>}
            </div>
            <div className="flex items-center gap-2 shrink-0">
              <span className={`badge ${d.contacted ? 'badge-green' : 'badge-amber'}`}>{d.contacted ? 'Contacted' : 'New'}</span>
              <button onClick={() => toggle(d)} className="btn !bg-slate-700 !text-white !py-1.5 !text-xs">
                {d.contacted ? 'Mark new' : 'Mark contacted'}
              </button>
            </div>
          </div>
          <div className="flex gap-2 mt-3">
            <input value={notes[d.id] || ''} onChange={(e) => setNotes({ ...notes, [d.id]: e.target.value })}
              placeholder="Internal note…" className="input !bg-slate-900 !border-slate-700 !text-white !text-xs flex-1" />
            <button onClick={() => saveNote(d)} className="btn btn-dark !py-1.5 !text-xs">Save</button>
          </div>
          <div className="text-[11px] text-slate-600 mt-2">{d.created_at?.slice(0, 16).replace('T', ' ')}</div>
        </div>
      ))}
      {rows.length === 0 && <div className="bg-slate-800/60 border border-slate-700/60 rounded-2xl p-8 text-center text-sm text-slate-500">No demo requests yet.</div>}
    </div>
  );
}

/* ---------------- SUPPORT TICKETS ---------------- */
const TICKET_STATUS_BADGE = { open: 'badge-amber', pending: 'badge !bg-sky-500/15 !text-sky-300 !border-sky-500/30', closed: 'badge-green' };
const PRIORITY_BADGE = {
  low: 'badge-slate', normal: 'badge-blue', high: 'badge !bg-amber-500/15 !text-amber-300 !border-amber-500/30',
  urgent: 'badge !bg-rose-500/15 !text-rose-300 !border-rose-500/30',
};

function slaStatus(t) {
  if (!t || t.status === 'closed' || !t.sla_due_at) return 'ok';
  const due = new Date(t.sla_due_at.replace(' ', 'T') + 'Z');
  const hrs = (due - new Date()) / 3600000;
  if (hrs < 0) return 'overdue';
  if (hrs < 4) return 'due-soon';
  return 'ok';
}

function TicketDrawer({ ticketId, onClose, onChanged }) {
  const toast = useToast();
  const [data, setData] = useState(null);
  const [reply, setReply] = useState('');
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);

  const load = async () => {
    try {
      const d = await api.super.ticketDetail(ticketId);
      setData(d);
      setNote(d.ticket.internal_note || '');
    } catch (e) { toast.error(e.message); }
  };
  useEffect(() => { load(); }, [ticketId]);

  const sendReply = async () => {
    if (!reply.trim() || busy) return;
    setBusy(true);
    try {
      await api.super.replyTicket(ticketId, reply.trim());
      setReply('');
      toast.success('Reply sent');
      await load(); onChanged();
    } catch (e) { toast.error(e.message); }
    finally { setBusy(false); }
  };
  const saveMeta = async (patch, msg) => {
    try {
      await api.super.updateTicket(ticketId, patch);
      toast.success(msg || 'Saved');
      await load(); onChanged();
    } catch (e) { toast.error(e.message); }
  };

  return (
    <Modal onClose={onClose} wide>
      <div className="p-7 bg-slate-900 text-slate-200 rounded-2xl max-h-[85vh] overflow-y-auto">
        {!data ? <Skeleton className="h-64 !bg-slate-800" /> : (() => {
          const t = data.ticket;
          const sla = slaStatus(t);
          const firstRespHrs = t.first_response_at
            ? ((new Date(t.first_response_at.replace(' ', 'T') + 'Z') - new Date(t.created_at.replace(' ', 'T') + 'Z')) / 3600000)
            : null;
          return (
            <div>
              <div className="flex items-center gap-2 flex-wrap mb-1">
                <span className={`badge ${TICKET_STATUS_BADGE[t.status] || 'badge-amber'}`}>{t.status}</span>
                <span className={`badge ${PRIORITY_BADGE[t.priority] || 'badge-blue'}`}>{t.priority}</span>
                {sla === 'overdue' && <span className="badge !bg-rose-500/15 !text-rose-300 !border-rose-500/30 font-bold">OVERDUE</span>}
                {sla === 'due-soon' && <span className="badge !bg-amber-500/15 !text-amber-300 !border-amber-500/30">Due soon</span>}
                <span className="text-xs text-slate-500 ml-auto">#{t.id} · {t.created_at?.slice(0, 16).replace('T', ' ')}</span>
              </div>
              <h3 className="text-xl font-bold text-white mb-1">{t.subject}</h3>
              <div className="text-sm text-slate-400 mb-4">{t.name} · {t.email}{t.org_name && <span> · {t.org_name}</span>}</div>
              <div className="text-xs text-slate-500 mb-5">
                SLA due {t.sla_due_at?.slice(0, 16).replace('T', ' ')}
                {firstRespHrs !== null && <span> · first response {firstRespHrs < 1 ? `${Math.round(firstRespHrs * 60)}m` : `${firstRespHrs.toFixed(1)}h`}</span>}
              </div>

              <div className="space-y-3 mb-6">
                <div className="bg-slate-800 rounded-xl p-4">
                  <div className="text-[11px] text-slate-500 mb-1">{t.name} · original message</div>
                  <div className="text-sm text-slate-200 whitespace-pre-wrap">{t.message}</div>
                </div>
                {data.replies.map((r) => (
                  <div key={r.id} className={`rounded-xl p-4 ${r.author_type === 'staff' ? 'bg-sky-950/40 border border-sky-800/50' : 'bg-slate-800'}`}>
                    <div className="text-[11px] text-slate-500 mb-1">
                      {r.author_type === 'staff' ? `Staff${r.author_name ? ` · ${r.author_name}` : ''}` : t.name} · {r.created_at?.slice(0, 16).replace('T', ' ')}
                    </div>
                    <div className="text-sm text-slate-200 whitespace-pre-wrap">{r.body}</div>
                  </div>
                ))}
              </div>

              <label className="label !text-slate-400">Reply to customer</label>
              <textarea value={reply} onChange={(e) => setReply(e.target.value)} rows={3}
                className="input !bg-slate-800 !border-slate-700 !text-white mb-3" placeholder="Write a reply… (sending moves the ticket to pending)" />
              <button onClick={sendReply} disabled={busy || !reply.trim()} className="btn btn-primary !text-sm mb-6">
                {busy ? 'Sending…' : 'Send reply'}
              </button>

              <div className="grid sm:grid-cols-2 gap-4 mb-4">
                <div>
                  <label className="label !text-slate-400">Status</label>
                  <select value={t.status} onChange={(e) => saveMeta({ status: e.target.value }, `Status → ${e.target.value}`)}
                    className="input !bg-slate-800 !border-slate-700 !text-white">
                    <option value="open">open</option>
                    <option value="pending">pending (waiting on customer)</option>
                    <option value="closed">closed</option>
                  </select>
                </div>
                <div>
                  <label className="label !text-slate-400">Priority</label>
                  <select value={t.priority} onChange={(e) => saveMeta({ priority: e.target.value }, `Priority → ${e.target.value}`)}
                    className="input !bg-slate-800 !border-slate-700 !text-white">
                    <option value="low">low</option>
                    <option value="normal">normal</option>
                    <option value="high">high</option>
                    <option value="urgent">urgent</option>
                  </select>
                </div>
              </div>
              <label className="label !text-slate-400">Internal note <span className="text-rose-400/80">(never shown to the customer)</span></label>
              <textarea value={note} onChange={(e) => setNote(e.target.value)} rows={3}
                className="input !bg-slate-800 !border-slate-700 !text-white mb-3" placeholder="Private note…" />
              <div className="flex gap-2 flex-wrap">
                <button onClick={() => saveMeta({ internal_note: note }, 'Note saved')} className="btn btn-dark !text-sm">Save note</button>
                <button onClick={onClose} className="btn btn-ghost !text-slate-300 ml-auto">Close</button>
              </div>
            </div>
          );
        })()}
      </div>
    </Modal>
  );
}

function SupportTab() {
  const toast = useToast();
  const [rows, setRows] = useState(null);
  const [openId, setOpenId] = useState(null);
  const load = () => api.super.tickets().then(setRows).catch((e) => toast.error(e.message));
  useEffect(() => { load(); }, []);

  if (!rows) return <Skeleton className="h-64 !bg-slate-800" />;
  return (
    <div>
      {openId && <TicketDrawer ticketId={openId} onClose={() => setOpenId(null)} onChanged={load} />}
      <div className="bg-slate-800/60 border border-slate-700/60 rounded-2xl overflow-hidden">
        <table className="w-full tbl !text-slate-300">
          <thead><tr className="!text-slate-500"><th></th><th>Subject</th><th>From</th><th>Workspace</th><th>SLA</th><th>Replies</th><th>Received</th></tr></thead>
          <tbody>
            {rows.map((t) => {
              const sla = slaStatus(t);
              return (
                <tr key={t.id} onClick={() => setOpenId(t.id)} className="cursor-pointer hover:!bg-slate-700/40">
                  <td>
                    <div className="flex gap-1 flex-wrap">
                      <span className={`badge ${TICKET_STATUS_BADGE[t.status] || 'badge-amber'}`}>{t.status}</span>
                      <span className={`badge ${PRIORITY_BADGE[t.priority] || 'badge-blue'}`}>{t.priority}</span>
                    </div>
                  </td>
                  <td className="font-medium text-white">
                    #{t.id} {t.subject}
                    {t.latest_reply_author === 'customer' && t.status !== 'closed' && (
                      <span className="ml-2 badge !bg-emerald-500/15 !text-emerald-300 !border-emerald-500/30">needs reply</span>
                    )}
                  </td>
                  <td className="text-slate-400 text-xs">{t.name} · {t.email}</td>
                  <td className="text-slate-400 text-xs">{t.org_name || '—'}</td>
                  <td>
                    {sla === 'overdue' && <span className="badge !bg-rose-500/15 !text-rose-300 !border-rose-500/30 font-bold">OVERDUE</span>}
                    {sla === 'due-soon' && <span className="badge !bg-amber-500/15 !text-amber-300 !border-amber-500/30">Due soon</span>}
                    {sla === 'ok' && <span className="text-slate-500 text-xs">{t.sla_due_at?.slice(5, 16).replace('T', ' ') || '—'}</span>}
                  </td>
                  <td className="text-slate-400 text-xs">{t.reply_count || 0}</td>
                  <td className="text-slate-500 text-xs">{t.created_at?.slice(0, 16).replace('T', ' ')}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
        {rows.length === 0 && <div className="p-8 text-center text-sm text-slate-500">No support tickets yet.</div>}
      </div>
    </div>
  );
}

/* ---------------- DATABASE MANAGER ---------------- */
function DbTab() {
  const toast = useToast();
  const [tables, setTables] = useState(null);
  const [table, setTable] = useState(null);
  const [data, setData] = useState(null);
  const [search, setSearch] = useState('');
  const [page, setPage] = useState(1);
  const [editing, setEditing] = useState(null); // null | 'add' | row
  const [form, setForm] = useState({});

  useEffect(() => { api.super.tables().then(setTables).catch((e) => toast.error(e.message)); }, []);

  const loadRows = (t = table, p = page, s = search) => {
    if (!t) return;
    api.super.tableRows(t, { page: p, limit: 25, search: s })
      .then(setData).catch((e) => toast.error(e.message));
  };
  const pick = (t) => { setTable(t); setPage(1); setSearch(''); setEditing(null); loadRows(t, 1, ''); };

  const editable = (forAdd) => data.columns.filter((c) =>
    forAdd ? !(c.name === 'id' && c.pk) : c.name !== data.idCol
  );
  const openEdit = (row) => {
    const f = {};
    editable(false).forEach((c) => { f[c.name] = row[c.name] ?? ''; });
    setForm(f); setEditing(row);
  };
  const openAdd = () => {
    const f = {};
    editable(true).forEach((c) => { f[c.name] = ''; });
    setForm(f); setEditing('add');
  };
  const save = async () => {
    try {
      const payload = {};
      Object.entries(form).forEach(([k, v]) => { payload[k] = v === '' ? null : v; });
      if (editing === 'add') await api.super.insertRow(table, payload);
      else await api.super.updateRow(table, editing.id, payload);
      toast.success(editing === 'add' ? 'Row added' : 'Row updated');
      setEditing(null); loadRows();
      api.super.tables().then(setTables).catch(() => {});
    } catch (e) { toast.error(e.message); }
  };
  const del = async (id) => {
    if (!window.confirm(`Delete row #${id} from ${table}?`)) return;
    try {
      await api.super.deleteRow(table, id);
      toast.success('Row deleted'); loadRows();
      api.super.tables().then(setTables).catch(() => {});
    } catch (e) { toast.error(e.message); }
  };

  const totalPages = data ? Math.ceil(data.total / data.limit) : 0;

  return (
    <div className="grid lg:grid-cols-[240px_1fr] gap-5">
      <div className="bg-slate-800/60 border border-slate-700/60 rounded-2xl p-3 h-fit max-h-[70vh] overflow-y-auto">
        <div className="text-xs font-semibold text-slate-500 uppercase tracking-wide px-2 py-2">Tables</div>
        {(tables || []).map((t) => (
          <button key={t.name} onClick={() => pick(t.name)}
            className={`w-full text-left px-3 py-2 rounded-lg text-sm flex justify-between items-center ${table === t.name ? 'bg-emerald-600/20 text-emerald-300' : 'text-slate-300 hover:bg-slate-700/50'}`}>
            <span className="font-mono text-xs">{t.name}</span>
            <span className="text-[11px] text-slate-500">{t.rows}</span>
          </button>
        ))}
      </div>

      <div>
        {!table && <div className="bg-slate-800/60 border border-slate-700/60 rounded-2xl p-10 text-center text-sm text-slate-500">Select a table to browse its rows.</div>}
        {table && !data && <Skeleton className="h-64 !bg-slate-800" />}
        {table && data && (
          <div>
            <div className="flex gap-2 mb-4 flex-wrap">
              <input value={search} onChange={(e) => setSearch(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && (setPage(1), loadRows(table, 1, search))}
                placeholder={`Search ${table}…`} className="input !bg-slate-800 !border-slate-700 !text-white max-w-xs !text-sm" />
              <button onClick={() => { setPage(1); loadRows(table, 1, search); }} className="btn btn-dark !text-sm">Search</button>
              <button onClick={openAdd} className="btn btn-primary !text-sm ml-auto">+ Add row</button>
            </div>
            <div className="bg-slate-800/60 border border-slate-700/60 rounded-2xl overflow-hidden">
              <div className="overflow-x-auto">
                <table className="w-full tbl !text-slate-300">
                  <thead><tr className="!text-slate-500">
                    {data.columns.map((c) => <th key={c.name} className="!text-xs font-mono">{c.name}</th>)}
                    <th className="!text-right">Actions</th>
                  </tr></thead>
                  <tbody>
                    {data.rows.map((r) => (
                      <tr key={r.id ?? JSON.stringify(r).slice(0, 20)}>
                        {data.columns.map((c) => (
                          <td key={c.name} className="text-xs font-mono text-slate-400 max-w-[220px] truncate" title={String(r[c.name] ?? '')}>
                            {String(r[c.name] ?? '—').slice(0, 60)}
                          </td>
                        ))}
                        <td className="!text-right whitespace-nowrap">
                          <button onClick={() => openEdit(r)} className="text-sky-400 hover:text-sky-300 text-xs font-semibold mr-3">Edit</button>
                          <button onClick={() => del(r.id)} className="text-rose-400 hover:text-rose-300 text-xs font-semibold">Delete</button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              {data.rows.length === 0 && <div className="p-8 text-center text-sm text-slate-500">No rows.</div>}
            </div>
            {totalPages > 1 && (
              <div className="flex items-center justify-between mt-3 text-sm text-slate-500">
                <span className="text-xs">{data.total} rows · page {page} of {totalPages}</span>
                <div className="flex gap-2">
                  <button disabled={page <= 1} onClick={() => { setPage(page - 1); loadRows(table, page - 1); }} className="btn !bg-slate-700 !text-white !px-3 !py-1.5 !text-xs disabled:!opacity-40">← Prev</button>
                  <button disabled={page >= totalPages} onClick={() => { setPage(page + 1); loadRows(table, page + 1); }} className="btn !bg-slate-700 !text-white !px-3 !py-1.5 !text-xs disabled:!opacity-40">Next →</button>
                </div>
              </div>
            )}
          </div>
        )}
      </div>

      {editing && (
        <Modal onClose={() => setEditing(null)} wide>
          <div className="p-7 bg-slate-900 text-slate-200 rounded-2xl max-h-[85vh] overflow-y-auto">
            <h3 className="text-lg font-bold text-white mb-5">{editing === 'add' ? `Add row — ${table}` : `Edit row #${editing.id} — ${table}`}</h3>
            <div className="grid sm:grid-cols-2 gap-4">
              {editable(editing === 'add').map((c) => (
                <div key={c.name} className={String(form[c.name] ?? '').length > 80 ? 'sm:col-span-2' : ''}>
                  <label className="label !text-slate-400 font-mono !text-xs">{c.name} <span className="text-slate-600">({c.type})</span></label>
                  {String(form[c.name] ?? '').length > 80 ? (
                    <textarea value={form[c.name] ?? ''} onChange={(e) => setForm({ ...form, [c.name]: e.target.value })} rows={3}
                      className="input !bg-slate-800 !border-slate-700 !text-white font-mono !text-xs" />
                  ) : (
                    <input value={form[c.name] ?? ''} onChange={(e) => setForm({ ...form, [c.name]: e.target.value })}
                      className="input !bg-slate-800 !border-slate-700 !text-white font-mono !text-xs" />
                  )}
                </div>
              ))}
            </div>
            <div className="flex justify-end gap-2 mt-6">
              <button onClick={() => setEditing(null)} className="btn btn-ghost !text-slate-300">Cancel</button>
              <button onClick={save} className="btn btn-primary">{editing === 'add' ? 'Add row' : 'Save changes'}</button>
            </div>
          </div>
        </Modal>
      )}
    </div>
  );
}

/* ---------------- SHELL ---------------- */
const TABS = [
  ['overview', 'Overview'], ['clients', 'Clients'], ['ai', 'AI Clients'], ['users', 'Users'],
  ['subscriptions', 'Subscriptions'], ['demos', 'Demo Requests'], ['support', 'Support'], ['db', 'Database'],
];

export default function SuperAdmin() {
  const { user, logout } = useAuth();
  const [tab, setTab] = useState('overview');

  return (
    <div className="min-h-screen bg-slate-950 text-slate-200 flex">
      <aside className="w-60 shrink-0 bg-slate-900 border-r border-slate-800 flex flex-col">
        <div className="px-5 py-6 border-b border-slate-800">
          <div className="flex items-center gap-2.5">
            <div className="w-9 h-9 rounded-xl bg-emerald-500 flex items-center justify-center font-extrabold text-slate-950">C</div>
            <div>
              <div className="font-bold text-white leading-tight">ClaimPaid</div>
              <div className="text-[10px] font-bold text-amber-400 tracking-[0.2em]">SUPER ADMIN</div>
            </div>
          </div>
        </div>
        <nav className="p-3 space-y-1 flex-1">
          {TABS.map(([id, label]) => (
            <button key={id} onClick={() => setTab(id)}
              className={`w-full text-left px-4 py-2.5 rounded-xl text-sm font-medium ${tab === id ? 'bg-emerald-600/20 text-emerald-300' : 'text-slate-400 hover:bg-slate-800 hover:text-slate-200'}`}>
              {label}
            </button>
          ))}
        </nav>
        <div className="p-4 border-t border-slate-800">
          <div className="text-xs text-slate-500 mb-2 truncate">{user?.email}</div>
          <div className="flex gap-2">
            <a href="/app/" className="btn !bg-slate-800 !text-slate-300 !text-xs flex-1 !py-2 text-center">← App</a>
            <button onClick={logout} className="btn !bg-slate-800 !text-slate-300 !text-xs flex-1 !py-2">Sign out</button>
          </div>
        </div>
      </aside>

      <main className="flex-1 p-8 max-w-[1400px] w-full mx-auto overflow-x-hidden">
        <PageHeader
          title={TABS.find((t) => t[0] === tab)[1]}
          subtitle={tab === 'overview' ? 'Everything across ClaimPaid, in one place' : ''}
        />
        <div className="[&_h2]:!text-white">
          {tab === 'overview' && <OverviewTab />}
          {tab === 'clients' && <ClientsTab />}
          {tab === 'ai' && <AiClientsTab />}
          {tab === 'users' && <UsersTab />}
          {tab === 'subscriptions' && <SubscriptionsTab />}
          {tab === 'demos' && <DemosTab />}
          {tab === 'support' && <SupportTab />}
          {tab === 'db' && <DbTab />}
        </div>
      </main>
    </div>
  );
}
