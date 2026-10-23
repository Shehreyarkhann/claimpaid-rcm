import { useEffect, useState } from 'react';
import { api } from '../api';
import { PageHeader, Skeleton, useToast } from '../components/ui';
import { useAuth } from '../auth';
import EligibilityVendorSettings from '../components/EligibilityVendorSettings';

export default function Organization() {
  const { user } = useAuth();
  const toast = useToast();
  const [org, setOrg] = useState(null);
  const [name, setName] = useState('');
  const [saving, setSaving] = useState(false);
  const [showDelete, setShowDelete] = useState(false);
  const [deleteConfirm, setDeleteConfirm] = useState('');
  const [deleting, setDeleting] = useState(false);
  const isOwner = user?.role === 'owner';

  useEffect(() => {
    api.orgProfile().then((o) => { setOrg(o); setName(o.name); }).catch((e) => toast.error(e.message));
  }, []);

  const save = async () => {
    if (!name.trim() || saving) return;
    setSaving(true);
    try {
      const updated = await api.renameOrg(name.trim());
      setOrg((o) => ({ ...o, name: updated.name }));
      toast.success('Workspace name updated');
      // Refresh the sidebar label
      window.location.reload();
    } catch (e) {
      toast.error(e.message);
      setSaving(false);
    }
  };

  const doDelete = async () => {
    if (deleteConfirm !== org.name || deleting) return;
    setDeleting(true);
    try {
      const r = await api.deleteOrg(org.id);
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
      <PageHeader title="Organization" subtitle="Workspace identity and usage at a glance." />

      {!org ? (
        <div className="card p-6 space-y-3"><Skeleton className="h-10" /><Skeleton className="h-24" /></div>
      ) : (
        <div className="grid lg:grid-cols-2 gap-6 max-w-4xl">
          <div className="card p-6">
            <h3 className="font-bold text-slate-900 mb-1">Workspace profile</h3>
            <p className="text-sm text-slate-500 mb-4">This name appears in the sidebar and on reports.</p>
            <label className="label">Workspace name</label>
            <div className="flex gap-2">
              <input
                className="input flex-1"
                value={name}
                onChange={(e) => setName(e.target.value)}
                disabled={!isOwner}
                maxLength={80}
              />
              {isOwner && (
                <button className="btn btn-primary" onClick={save} disabled={saving || !name.trim() || name.trim() === org.name}>
                  {saving ? 'Saving…' : 'Save'}
                </button>
              )}
            </div>
            {!isOwner && <p className="text-xs text-slate-400 mt-2">Only owners can rename the workspace.</p>}
            <div className="mt-4 text-xs text-slate-400">
              Created {org.created_at ? new Date(org.created_at.replace(' ', 'T') + 'Z').toLocaleDateString() : '—'}
            </div>
          </div>

          <div className="card p-6">
            <h3 className="font-bold text-slate-900 mb-4">Usage</h3>
            <div className="grid grid-cols-3 gap-3">
              {[
                { label: 'Team members', value: org.users },
                { label: 'Claims', value: org.claims },
                { label: 'Appeals', value: org.appeals },
              ].map((s) => (
                <div key={s.label} className="rounded-xl bg-slate-50 border border-slate-100 p-4 text-center">
                  <div className="text-2xl font-extrabold text-slate-900 tabular-nums">{s.value ?? '—'}</div>
                  <div className="text-[11px] text-slate-500 mt-1">{s.label}</div>
                </div>
              ))}
            </div>
            <p className="text-xs text-slate-400 mt-4">
              All data is isolated to this workspace. Team members only see workspaces they've been added to.
            </p>
          </div>
        </div>
      )}

      {isOwner && org && (
        <div className="max-w-4xl mt-6">
          <EligibilityVendorSettings />
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
                    onClick={doDelete}
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
        </div>
      )}
    </div>
  );
}
