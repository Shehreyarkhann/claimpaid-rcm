import { useEffect, useState } from 'react';
import { api } from '../api';
import { PageHeader, Skeleton, useToast } from '../components/ui';
import { useAuth } from '../auth';

export default function Organization() {
  const { user } = useAuth();
  const toast = useToast();
  const [org, setOrg] = useState(null);
  const [name, setName] = useState('');
  const [saving, setSaving] = useState(false);
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
    </div>
  );
}
