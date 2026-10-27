import { useEffect, useRef, useState } from 'react';
import { api } from '../api';
import { PageHeader, Skeleton, useToast, confirmDialog } from '../components/ui';
import { useAuth } from '../auth';
import { useOrgSettings } from '../orgSettings';
import EligibilityVendorSettings from '../components/EligibilityVendorSettings';
import TransmitSettings from '../components/TransmitSettings';

const TIMEZONES = [
  'America/New_York', 'America/Chicago', 'America/Denver', 'America/Los_Angeles',
  'America/Anchorage', 'Pacific/Honolulu', 'America/Puerto_Rico', 'America/Toronto',
  'America/Chicago', 'UTC', 'Europe/London', 'Europe/Berlin', 'Asia/Karachi',
  'Asia/Dubai', 'Asia/Kolkata', 'Asia/Singapore', 'Australia/Sydney',
];
const DATE_FORMATS = ['MM/DD/YYYY', 'DD/MM/YYYY', 'YYYY-MM-DD'];
const ROWS_OPTIONS = [10, 25, 50, 100];

function Toggle({ checked, onChange, disabled, label, hint }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={!!checked}
      disabled={disabled}
      onClick={() => onChange(!checked)}
      className="flex items-start justify-between gap-4 w-full text-left py-3"
    >
      <span>
        <span className="block text-sm font-medium text-stone-800">{label}</span>
        {hint && <span className="block text-xs text-stone-500 mt-0.5">{hint}</span>}
      </span>
      <span className={`mt-0.5 shrink-0 w-11 h-6 rounded-full relative transition-colors ${checked ? 'bg-emerald-500' : 'bg-stone-300'} ${disabled ? 'opacity-40' : ''}`}>
        <span className={`absolute top-0.5 w-5 h-5 rounded-full bg-white shadow transition-all ${checked ? 'left-[22px]' : 'left-0.5'}`} />
      </span>
    </button>
  );
}

// ---------------- General ----------------
function GeneralTab({ settings, refresh, isOwner }) {
  const toast = useToast();
  const [name, setName] = useState('');
  const [timezone, setTimezone] = useState('America/New_York');
  const [dateFormat, setDateFormat] = useState('MM/DD/YYYY');
  const [rows, setRows] = useState(25);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (settings) {
      setName(settings.name || '');
      setTimezone(settings.timezone || 'America/New_York');
      setDateFormat(settings.date_format || 'MM/DD/YYYY');
      setRows(settings.rows_per_page || 25);
    }
  }, [settings]);

  const dirty =
    settings &&
    (name.trim() !== settings.name ||
      timezone !== settings.timezone ||
      dateFormat !== settings.date_format ||
      rows !== settings.rows_per_page);

  const save = async () => {
    if (!dirty || saving) return;
    setSaving(true);
    try {
      await api.settings.saveGeneral({ name: name.trim(), timezone, date_format: dateFormat, rows_per_page: rows });
      toast.success('Settings saved');
      await refresh();
      window.location.reload(); // refresh sidebar label + date-format default
    } catch (e) {
      toast.error(e.message);
      setSaving(false);
    }
  };

  if (!settings) return <div className="card p-6 space-y-3"><Skeleton className="h-10" /><Skeleton className="h-24" /></div>;
  return (
    <div className="grid lg:grid-cols-2 gap-6">
      <div className="card p-6">
        <h3 className="font-bold text-stone-900 mb-1">Workspace profile</h3>
        <p className="text-sm text-stone-500 mb-4">This name appears in the sidebar and on reports.</p>
        <label className="label">Workspace name</label>
        <input className="input w-full" value={name} onChange={(e) => setName(e.target.value)} disabled={!isOwner} maxLength={80} />
        {!isOwner && <p className="text-xs text-stone-400 mt-2">Only owners can change workspace settings.</p>}
        <div className="mt-4 text-xs text-stone-400">
          Created {settings.created_at ? new Date(settings.created_at.replace(' ', 'T') + 'Z').toLocaleDateString() : '—'}
          {' · '}Plan: <span className="font-medium text-stone-500 capitalize">{settings.plan}</span>
        </div>
      </div>

      <div className="card p-6">
        <h3 className="font-bold text-stone-900 mb-1">Localization & display</h3>
        <p className="text-sm text-stone-500 mb-4">Timezone drives report timestamps; display prefs apply app-wide.</p>
        <div className="space-y-4">
          <div>
            <label className="label">Timezone</label>
            <select className="input w-full" value={timezone} onChange={(e) => setTimezone(e.target.value)} disabled={!isOwner}>
              {[...new Set(TIMEZONES)].map((tz) => <option key={tz} value={tz}>{tz.replace(/_/g, ' ')}</option>)}
            </select>
          </div>
          <div className="grid grid-cols-2 gap-4">
            <div>
              <label className="label">Date format</label>
              <select className="input w-full" value={dateFormat} onChange={(e) => setDateFormat(e.target.value)} disabled={!isOwner}>
                {DATE_FORMATS.map((f) => <option key={f} value={f}>{f}</option>)}
              </select>
            </div>
            <div>
              <label className="label">Rows per page</label>
              <select className="input w-full" value={rows} onChange={(e) => setRows(Number(e.target.value))} disabled={!isOwner}>
                {ROWS_OPTIONS.map((r) => <option key={r} value={r}>{r}</option>)}
              </select>
            </div>
          </div>
        </div>
      </div>

      <div className="card p-6">
        <h3 className="font-bold text-stone-900 mb-4">Usage</h3>
        <div className="grid grid-cols-3 gap-3">
          {[
            { label: 'Team members', value: settings.users },
            { label: 'Claims', value: settings.claims },
            { label: 'Appeals', value: settings.appeals },
          ].map((s) => (
            <div key={s.label} className="rounded-xl bg-stone-50 border border-stone-100 p-4 text-center">
              <div className="text-2xl font-extrabold text-stone-900 tabular-nums">{s.value ?? '—'}</div>
              <div className="text-[11px] text-stone-500 mt-1">{s.label}</div>
            </div>
          ))}
        </div>
        <p className="text-xs text-stone-400 mt-4">
          All data is isolated to this workspace. Team members only see workspaces they've been added to.
        </p>
      </div>

      {isOwner && (
        <div className="lg:col-span-2 flex justify-end">
          <button className="btn btn-primary" onClick={save} disabled={!dirty || saving}>
            {saving ? 'Saving…' : 'Save changes'}
          </button>
        </div>
      )}
    </div>
  );
}

// ---------------- API keys (owner only) ----------------
function ApiTab() {
  const toast = useToast();
  const [keys, setKeys] = useState(null);
  const [name, setName] = useState('');
  const [creating, setCreating] = useState(false);
  const [newKey, setNewKey] = useState(null); // { key, name } — shown ONCE
  const [revoking, setRevoking] = useState(null);

  const load = async () => {
    try { setKeys(await api.settings.apiKeys()); }
    catch (e) { toast.error(e.message); setKeys([]); }
  };
  useEffect(() => { load(); }, []);

  const create = async () => {
    if (!name.trim() || creating) return;
    setCreating(true);
    try {
      const k = await api.settings.createApiKey(name.trim());
      setNewKey({ key: k.key, name: k.name });
      setName('');
      load();
    } catch (e) { toast.error(e.message); }
    finally { setCreating(false); }
  };

  const revoke = async (id, keyName) => {
    if (!(await confirmDialog({ title: `Revoke the API key "${keyName}"?`, body: 'Integrations using it will stop working immediately.', confirmLabel: 'Revoke key' }))) return;
    setRevoking(id);
    try {
      await api.settings.revokeApiKey(id);
      toast.success('API key revoked');
      load();
    } catch (e) { toast.error(e.message); }
    finally { setRevoking(null); }
  };

  const copy = async (text) => {
    try { await navigator.clipboard.writeText(text); toast.success('Copied to clipboard'); }
    catch { toast.error('Copy failed — select the key manually'); }
  };

  return (
    <div className="space-y-6 max-w-4xl">
      <div className="card p-6">
        <h3 className="font-bold text-stone-900 mb-1">Developer API keys</h3>
        <p className="text-sm text-stone-500 mb-4">
          Keys authenticate machine integrations via <code className="text-xs bg-stone-100 px-1.5 py-0.5 rounded">Authorization: Bearer cp_sk_live_…</code> on <code className="text-xs bg-stone-100 px-1.5 py-0.5 rounded">/api/v1/*</code>.
          Only the key hash is stored — the full key is shown <strong>once</strong> at creation.
        </p>
        <div className="rounded-xl bg-amber-50 border border-amber-200 px-4 py-3 text-xs text-amber-900 mb-5">
          API keys are <strong>not affected by MFA enforcement</strong> — they keep working even when two-factor is required for logins.
          They are revocable below at any time.
        </div>
        <div className="flex gap-2 max-w-md">
          <input
            className="input flex-1"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="Key name — e.g. Billing sync"
            maxLength={60}
          />
          <button className="btn btn-primary whitespace-nowrap" onClick={create} disabled={!name.trim() || creating}>
            {creating ? 'Generating…' : 'Generate key'}
          </button>
        </div>

        {newKey && (
          <div className="mt-5 rounded-xl border-2 border-emerald-300 bg-emerald-50 p-4">
            <div className="text-sm font-bold text-emerald-900 mb-1">Key created — copy it now. You won't see it again.</div>
            <div className="flex items-center gap-2">
              <code className="flex-1 text-xs bg-white border border-emerald-200 rounded-lg px-3 py-2.5 break-all select-all">{newKey.key}</code>
              <button className="btn btn-ghost !text-sm shrink-0" onClick={() => copy(newKey.key)}>Copy</button>
            </div>
            <button className="btn btn-ghost !text-xs mt-2" onClick={() => setNewKey(null)}>I've stored it securely — dismiss</button>
          </div>
        )}
      </div>

      <div className="card p-6">
        <h3 className="font-bold text-stone-900 mb-4">Keys</h3>
        {!keys ? (
          <div className="space-y-2"><Skeleton className="h-12" /><Skeleton className="h-12" /></div>
        ) : keys.length === 0 ? (
          <p className="text-sm text-stone-500">No API keys yet. Generate one above to connect an integration.</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="text-left text-xs text-stone-500 border-b">
                  <th className="pb-2 pr-3 font-medium">Name</th>
                  <th className="pb-2 pr-3 font-medium">Prefix</th>
                  <th className="pb-2 pr-3 font-medium">Created by</th>
                  <th className="pb-2 pr-3 font-medium">Created</th>
                  <th className="pb-2 pr-3 font-medium">Last used</th>
                  <th className="pb-2 pr-3 font-medium">Status</th>
                  <th className="pb-2 font-medium text-right">Actions</th>
                </tr>
              </thead>
              <tbody>
                {keys.map((k) => (
                  <tr key={k.id} className="border-b last:border-0 border-stone-100">
                    <td className="py-2.5 pr-3 font-medium text-stone-800">{k.name}</td>
                    <td className="py-2.5 pr-3"><code className="text-xs bg-stone-100 px-1.5 py-0.5 rounded">{k.key_prefix}…</code></td>
                    <td className="py-2.5 pr-3 text-stone-500 text-xs">{k.created_by || '—'}</td>
                    <td className="py-2.5 pr-3 text-stone-500 text-xs">{k.created_at ? new Date(k.created_at.replace(' ', 'T') + 'Z').toLocaleDateString() : '—'}</td>
                    <td className="py-2.5 pr-3 text-stone-500 text-xs">{k.last_used_at ? new Date(k.last_used_at.replace(' ', 'T') + 'Z').toLocaleString() : 'Never'}</td>
                    <td className="py-2.5 pr-3">
                      <span className={`badge ${k.revoked ? 'badge-slate' : 'badge-green'}`}>{k.revoked ? 'Revoked' : 'Active'}</span>
                    </td>
                    <td className="py-2.5 text-right">
                      {!k.revoked && (
                        <button className="btn btn-ghost !text-xs !text-rose-600" disabled={revoking === k.id} onClick={() => revoke(k.id, k.name)}>
                          {revoking === k.id ? 'Revoking…' : 'Revoke'}
                        </button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}

// ---------------- Notifications ----------------
const NOTIF_DEFS = [
  { key: 'demo_requests', label: 'Demo request alerts', hint: 'Email staff when someone submits a demo request.', wired: true },
  { key: 'support_replies', label: 'Support reply alerts', hint: 'Email staff when a new ticket arrives or a customer replies.', wired: true },
  { key: 'trial_reminders', label: 'Trial ending reminders', hint: 'Email the workspace before its trial expires. Sender not connected yet — preference is saved.', wired: false },
  { key: 'weekly_digest', label: 'Weekly digest', hint: 'A weekly summary email for the workspace. Sender not connected yet — preference is saved.', wired: false },
];

function NotificationsTab({ isOwner }) {
  const toast = useToast();
  const [prefs, setPrefs] = useState(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    api.settings.notifications().then(setPrefs).catch((e) => toast.error(e.message));
  }, []);

  const flip = async (key, value) => {
    if (!isOwner || saving) return;
    setSaving(true);
    try {
      const updated = await api.settings.saveNotifications({ [key]: value });
      setPrefs(updated);
    } catch (e) { toast.error(e.message); }
    finally { setSaving(false); }
  };

  if (!prefs) return <div className="card p-6 max-w-2xl"><Skeleton className="h-40" /></div>;
  return (
    <div className="card p-6 max-w-2xl">
      <h3 className="font-bold text-stone-900 mb-1">Email notifications</h3>
      <p className="text-sm text-stone-500 mb-2">Per-workspace email preferences. Emails queue until a mail provider is configured — preferences save and apply regardless.</p>
      {!isOwner && <p className="text-xs text-stone-400 mb-2">Only owners can change these.</p>}
      <div className="divide-y divide-stone-100">
        {NOTIF_DEFS.map((d) => (
          <div key={d.key} className="flex items-center justify-between gap-4">
            <div className="flex-1">
              <Toggle
                label={d.label}
                hint={d.hint}
                checked={!!prefs[d.key]}
                disabled={!isOwner || saving}
                onChange={(v) => flip(d.key, v)}
              />
            </div>
            {!d.wired && <span className="badge badge-slate shrink-0">No sender yet</span>}
          </div>
        ))}
      </div>
    </div>
  );
}

// ---------------- Security (owner only) ----------------
function SecurityTab() {
  const toast = useToast();
  const { settings, refresh } = useOrgSettings();
  const [mfaRequired, setMfaRequired] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (settings) { setMfaRequired(!!settings.mfa_required); setLoaded(true); }
  }, [settings]);

  const flip = async (value) => {
    if (saving) return;
    setSaving(true);
    try {
      // Exact endpoint contract with the MFA-enforcement workstream:
      // PUT /api/settings/security  { mfa_required: boolean }
      const r = await api.settings.saveSecurity(value);
      setMfaRequired(!!r.mfa_required);
      await refresh();
      toast.success(value ? 'MFA enforcement is on for this workspace' : 'MFA enforcement is off');
    } catch (e) { toast.error(e.message); }
    finally { setSaving(false); }
  };

  return (
    <div className="card p-6 max-w-2xl">
      <h3 className="font-bold text-stone-900 mb-1">Security</h3>
      <p className="text-sm text-stone-500 mb-2">Workspace-level login policy. Owner-only.</p>
      {!loaded ? (
        <Skeleton className="h-16" />
      ) : (
        <div className="divide-y divide-stone-100">
          <Toggle
            label="Require two-factor for everyone"
            hint="Requires every member of this workspace to complete two-factor authentication at login. Members without 2FA set up will be prompted to enroll on their next sign-in."
            checked={mfaRequired}
            disabled={saving}
            onChange={flip}
          />
        </div>
      )}
      <div className="mt-4 rounded-xl bg-stone-50 border border-stone-200 px-4 py-3 text-xs text-stone-500">
        Sessions are stateless signed tokens (7-day expiry) — there is no server-side session list to review or revoke.
        Signing out clears the token on that device; changing a password does not invalidate other devices' tokens until they expire.
      </div>
    </div>
  );
}

// ---------------- Customization (owner only) ----------------
function CustomizationTab() {
  const toast = useToast();
  const { settings, refresh } = useOrgSettings();
  const [brand, setBrand] = useState('#10b981');
  const [savingBrand, setSavingBrand] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [logoUrl, setLogoUrl] = useState(null);
  const fileRef = useRef(null);

  useEffect(() => {
    if (settings) {
      if (settings.brand_color) setBrand(settings.brand_color);
      setLogoUrl(settings.logo_url || null);
    }
  }, [settings]);

  const saveBrand = async (value) => {
    if (!/^#[0-9a-fA-F]{6}$/.test(value)) { toast.error('Enter a hex color like #10b981'); return; }
    setSavingBrand(true);
    try {
      await api.settings.saveBrand(value);
      toast.success('Brand color updated');
      await refresh();
    } catch (e) { toast.error(e.message); }
    finally { setSavingBrand(false); }
  };

  const onFile = async (e) => {
    const f = e.target.files?.[0];
    e.target.value = '';
    if (!f) return;
    if (!f.type.startsWith('image/')) { toast.error('Please choose an image file (PNG, JPG, GIF, WebP).'); return; }
    if (f.size > 2 * 1024 * 1024) { toast.error('Logo must be 2 MB or smaller.'); return; }
    setUploading(true);
    try {
      const r = await api.settings.uploadLogo(f);
      setLogoUrl(r.logo_url);
      toast.success('Logo uploaded');
      await refresh();
    } catch (err) { toast.error(err.message); }
    finally { setUploading(false); }
  };

  const removeLogo = async () => {
    if (!(await confirmDialog({ title: 'Remove the workspace logo?', confirmLabel: 'Remove logo' }))) return;
    try {
      await api.settings.deleteLogo();
      setLogoUrl(null);
      toast.success('Logo removed');
      await refresh();
    } catch (e) { toast.error(e.message); }
  };

  return (
    <div className="grid lg:grid-cols-2 gap-6 max-w-4xl">
      <div className="card p-6">
        <h3 className="font-bold text-stone-900 mb-1">Workspace logo</h3>
        <p className="text-sm text-stone-500 mb-4">Shown in the app header. PNG, JPG, GIF or WebP, max 2 MB.</p>
        <div className="flex items-center gap-4">
          <div className="w-16 h-16 rounded-xl bg-stone-100 border border-stone-200 flex items-center justify-center overflow-hidden shrink-0">
            {logoUrl ? <img src={logoUrl} alt="Workspace logo" className="w-full h-full object-contain" /> : (
              <span className="text-stone-400 text-xs">No logo</span>
            )}
          </div>
          <div className="flex gap-2">
            <input ref={fileRef} type="file" accept="image/png,image/jpeg,image/gif,image/webp" className="hidden" onChange={onFile} />
            <button className="btn btn-primary !text-sm" disabled={uploading} onClick={() => fileRef.current?.click()}>
              {uploading ? 'Uploading…' : logoUrl ? 'Replace logo' : 'Upload logo'}
            </button>
            {logoUrl && (
              <button className="btn btn-ghost !text-sm !text-rose-600" onClick={removeLogo}>Remove</button>
            )}
          </div>
        </div>
      </div>

      <div className="card p-6">
        <h3 className="font-bold text-stone-900 mb-1">Brand accent color</h3>
        <p className="text-sm text-stone-500 mb-4">Applied to primary buttons and accents across the app.</p>
        <div className="flex items-center gap-3">
          <input
            type="color"
            value={brand}
            onChange={(e) => setBrand(e.target.value)}
            className="w-12 h-12 rounded-lg border border-stone-200 cursor-pointer bg-white p-1"
            aria-label="Brand color picker"
          />
          <input
            className="input w-32 font-mono"
            value={brand}
            onChange={(e) => setBrand(e.target.value)}
            maxLength={7}
            spellCheck={false}
          />
          <button className="btn btn-primary !text-sm" disabled={savingBrand} onClick={() => saveBrand(brand)}>
            {savingBrand ? 'Saving…' : 'Apply'}
          </button>
          <button
            className="btn btn-ghost !text-sm"
            onClick={async () => {
              try { await api.settings.saveBrand(null); setBrand('#10b981'); await refresh(); toast.success('Brand color reset'); }
              catch (e) { toast.error(e.message); }
            }}
          >
            Reset
          </button>
        </div>
        <div className="mt-4 flex gap-2">
          <span className="btn btn-primary !text-xs pointer-events-none">Primary button preview</span>
        </div>
      </div>
    </div>
  );
}

// ---------------- Advanced: vendor settings + danger zone (owner only) ----------------
function AdvancedTab({ org, isOwner, onDelete }) {
  const [showDelete, setShowDelete] = useState(false);
  const [deleteConfirm, setDeleteConfirm] = useState('');
  const [deleting, setDeleting] = useState(false);
  return (
    <div className="max-w-4xl space-y-6">
      <EligibilityVendorSettings />
      <TransmitSettings />
      {isOwner && org && (
        <div className="card p-6 !border-rose-200 bg-rose-50/50">
          <h3 className="font-bold text-rose-900 mb-1">Danger zone</h3>
          <p className="text-sm text-rose-700/80 mb-4">
            Deleting this workspace permanently removes all of its claims, appeals, authorizations,
            payers, team memberships and settings. This cannot be undone.
          </p>
          {!showDelete ? (
            <button className="btn !bg-rose-600 !text-white hover:!bg-rose-700 !text-sm" onClick={() => setShowDelete(true)}>
              Delete this workspace…
            </button>
          ) : (
            <div className="space-y-3">
              <p className="text-sm text-rose-900 font-medium">
                Type <span className="font-bold">"{org.name}"</span> to confirm permanent deletion:
              </p>
              <input
                className="input !border-rose-300 max-w-sm"
                value={deleteConfirm}
                onChange={(e) => setDeleteConfirm(e.target.value)}
                placeholder={org.name}
                autoFocus
              />
              <div className="flex gap-2">
                <button
                  className="btn !bg-rose-600 !text-white hover:!bg-rose-700 !text-sm disabled:opacity-40"
                  disabled={deleteConfirm !== org.name || deleting}
                  onClick={() => onDelete(setDeleting)}
                >
                  {deleting ? 'Deleting…' : 'Delete permanently'}
                </button>
                <button className="btn btn-ghost !text-sm" onClick={() => { setShowDelete(false); setDeleteConfirm(''); }}>
                  Cancel
                </button>
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// ---------------- Page ----------------
export default function Organization() {
  const { user } = useAuth();
  const toast = useToast();
  const { settings, refresh } = useOrgSettings();
  const [tab, setTab] = useState('general');
  const isOwner = user?.role === 'owner';

  const tabs = [
    { id: 'general', label: 'General' },
    ...(isOwner ? [{ id: 'api', label: 'API' }] : []),
    { id: 'notifications', label: 'Notifications' },
    ...(isOwner ? [{ id: 'security', label: 'Security' }] : []),
    ...(isOwner ? [{ id: 'custom', label: 'Customization' }] : []),
    ...(isOwner ? [{ id: 'advanced', label: 'Advanced' }] : []),
  ];

  const doDelete = async (setDeleting) => {
    setDeleting(true);
    try {
      const r = await api.deleteOrg(settings.id);
      if (r.logout) {
        localStorage.removeItem('pulse_token');
        window.location.href = '/app/';
      } else {
        localStorage.setItem('pulse_token', r.token);
        window.location.reload();
      }
    } catch (e) {
      toast.error(e.message);
      setDeleting(false);
    }
  };

  return (
    <div>
      <PageHeader title="Organization" subtitle="Workspace settings, integrations, and policy." />

      <div className="flex gap-1 mb-6 border-b border-stone-200 overflow-x-auto">
        {tabs.map((t) => (
          <button
            key={t.id}
            onClick={() => setTab(t.id)}
            className={`px-4 py-2.5 text-sm font-medium whitespace-nowrap -mb-px border-b-2 transition-colors ${
              tab === t.id
                ? 'border-emerald-500 text-stone-900'
                : 'border-transparent text-stone-500 hover:text-stone-800'
            }`}
          >
            {t.label}
          </button>
        ))}
      </div>

      {tab === 'general' && <GeneralTab settings={settings} refresh={refresh} isOwner={isOwner} />}
      {tab === 'api' && isOwner && <ApiTab />}
      {tab === 'notifications' && <NotificationsTab isOwner={isOwner} />}
      {tab === 'security' && isOwner && <SecurityTab />}
      {tab === 'custom' && isOwner && <CustomizationTab />}
      {tab === 'advanced' && isOwner && <AdvancedTab org={settings} isOwner={isOwner} onDelete={doDelete} />}
    </div>
  );
}
