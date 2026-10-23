import { useEffect, useState } from 'react';
import { api } from '../api';
import { PageHeader, Skeleton, useToast } from '../components/ui';
import { useAuth } from '../auth';

export default function Compliance() {
  const { user } = useAuth();
  const toast = useToast();
  const [status, setStatus] = useState(null);
  const [baaText, setBaaText] = useState('');
  const [baaVersion, setBaaVersion] = useState('');
  const [form, setForm] = useState({ org_legal_name: '', signed_by_name: '', signed_by_title: '', agree: false });
  const [signing, setSigning] = useState(false);
  const isOwner = user?.role === 'owner';

  const load = () => {
    api.baaStatus()
      .then(setStatus)
      .catch((e) => toast.error(e.message));
    fetch('/api/legal/documents')
      .then((r) => r.json())
      .then((d) => { setBaaText(d.baa?.text || ''); setBaaVersion(d.baa?.version || ''); })
      .catch(() => {});
  };

  useEffect(load, []);

  const sign = async () => {
    if (!form.org_legal_name.trim() || !form.signed_by_name.trim()) {
      toast.error('Organization legal name and signer name are required');
      return;
    }
    if (!form.agree) {
      toast.error('You must agree to the BAA to sign it');
      return;
    }
    setSigning(true);
    try {
      const r = await api.signBaa({
        org_legal_name: form.org_legal_name.trim(),
        signed_by_name: form.signed_by_name.trim(),
        signed_by_title: form.signed_by_title.trim(),
        agree: true,
      });
      setStatus({ signed: true, current: true, signature: r.signature });
      toast.success('BAA signed — your workspace is HIPAA-covered');
    } catch (e) {
      toast.error(e.message);
    } finally {
      setSigning(false);
    }
  };

  if (!isOwner) {
    return (
      <div className="p-6 max-w-3xl mx-auto">
        <PageHeader title="Compliance" subtitle="HIPAA Business Associate Agreement." />
        <div className="card p-6 mt-6 text-sm text-slate-500">
          Only workspace owners can view and sign the BAA. Ask your workspace owner to complete this step.
        </div>
      </div>
    );
  }

  if (!status) {
    return (
      <div className="p-6 max-w-3xl mx-auto">
        <PageHeader title="Compliance" subtitle="HIPAA Business Associate Agreement." />
        <div className="card p-6 mt-6"><Skeleton className="h-32" /></div>
      </div>
    );
  }

  const sig = status.signature;

  return (
    <div className="p-6 max-w-3xl mx-auto space-y-6">
      <PageHeader title="Compliance" subtitle="HIPAA Business Associate Agreement (BAA)." />

      {status.signed ? (
        <div className="card p-6 border-emerald-200 bg-emerald-50/50">
          <div className="flex items-center gap-3 mb-4">
            <div className="w-10 h-10 rounded-full bg-emerald-500/15 border border-emerald-500/40 flex items-center justify-center text-emerald-600 text-lg">✓</div>
            <div>
              <div className="font-bold text-slate-900">BAA signed</div>
              <div className="text-xs text-slate-500">Your workspace is covered for PHI processing.</div>
            </div>
          </div>
          <dl className="grid sm:grid-cols-2 gap-x-6 gap-y-3 text-sm">
            <div><dt className="text-[11px] uppercase tracking-widest text-slate-500">Organization</dt><dd className="font-medium text-slate-900">{sig.org_legal_name}</dd></div>
            <div><dt className="text-[11px] uppercase tracking-widest text-slate-500">Signed by</dt><dd className="font-medium text-slate-900">{sig.signed_by_name}{sig.signed_by_title ? `, ${sig.signed_by_title}` : ''}</dd></div>
            <div><dt className="text-[11px] uppercase tracking-widest text-slate-500">Signer email</dt><dd className="font-medium text-slate-900">{sig.signed_by_email}</dd></div>
            <div><dt className="text-[11px] uppercase tracking-widest text-slate-500">Signed at</dt><dd className="font-medium text-slate-900">{new Date(sig.signed_at).toLocaleString()}</dd></div>
            <div><dt className="text-[11px] uppercase tracking-widest text-slate-500">BAA version</dt><dd className="font-mono text-slate-900">{sig.baa_version}</dd></div>
            <div><dt className="text-[11px] uppercase tracking-widest text-slate-500">Text hash (SHA-256)</dt><dd className="font-mono text-xs text-slate-700 break-all">{sig.text_hash?.slice(0, 24)}…</dd></div>
          </dl>
          {!status.current && (
            <div className="mt-4 text-sm text-amber-800 bg-amber-50 border border-amber-200 rounded-xl px-4 py-3">
              A newer BAA version is available. Re-sign below to stay current.
            </div>
          )}
          <p className="text-xs text-amber-700 mt-4">Draft pending attorney review — this BAA text has not yet been reviewed by a healthcare attorney.</p>
        </div>
      ) : (
        <div className="space-y-4">
          <div className="text-sm text-slate-600 bg-sky-50 border border-sky-200 rounded-xl px-4 py-3">
            A signed BAA is <strong>required before activating a paid subscription</strong> and before uploading any PHI. Signing takes under a minute.
          </div>

          <div className="card p-0 overflow-hidden">
            <div className="px-6 py-4 border-b border-slate-200 flex items-center justify-between">
              <div className="font-bold text-slate-900">Business Associate Agreement</div>
              <div className="flex items-center gap-2">
                <span className="text-[11px] font-mono bg-slate-100 text-slate-500 px-2 py-0.5 rounded">{baaVersion}</span>
                <span className="text-[11px] text-amber-600">Draft pending attorney review</span>
              </div>
            </div>
            <div className="max-h-[420px] overflow-y-auto px-6 py-5 text-sm text-slate-600 whitespace-pre-wrap leading-relaxed bg-slate-50/50">
              {baaText || 'Loading BAA text…'}
            </div>
          </div>

          <div className="card p-6 space-y-4">
            <div>
              <label className="label">Organization legal name *</label>
              <input className="input" placeholder="Acme Billing LLC"
                value={form.org_legal_name}
                onChange={(e) => setForm({ ...form, org_legal_name: e.target.value })} maxLength={200} />
            </div>
            <div className="grid sm:grid-cols-2 gap-4">
              <div>
                <label className="label">Signer name *</label>
                <input className="input" placeholder="Jane Doe"
                  value={form.signed_by_name}
                  onChange={(e) => setForm({ ...form, signed_by_name: e.target.value })} maxLength={120} />
              </div>
              <div>
                <label className="label">Signer title</label>
                <input className="input" placeholder="Owner / CEO"
                  value={form.signed_by_title}
                  onChange={(e) => setForm({ ...form, signed_by_title: e.target.value })} maxLength={120} />
              </div>
            </div>
            <label className="flex items-start gap-3 text-sm text-slate-700 cursor-pointer">
              <input type="checkbox" className="mt-1 rounded"
                checked={form.agree}
                onChange={(e) => setForm({ ...form, agree: e.target.checked })} />
              <span>
                I have read the Business Associate Agreement above and I am authorized to sign on behalf of the
                organization named. I agree to its terms as of today's date.
              </span>
            </label>
            <button className="btn btn-primary w-full !py-3" disabled={signing} onClick={sign}>
              {signing ? 'Recording signature…' : 'Sign BAA electronically'}
            </button>
            <p className="text-xs text-slate-400">
              Your name, email ({user?.email}), timestamp, and IP address are recorded with a SHA-256 hash of the
              agreement text as the executed counterpart.
            </p>
          </div>
        </div>
      )}

      <div className="card p-6">
        <h3 className="font-bold text-slate-900 mb-2">Our documents</h3>
        <div className="flex gap-3 text-sm">
          <a href="/legal/terms" target="_blank" rel="noreferrer" className="text-emerald-700 font-medium hover:underline">Terms of Service →</a>
          <a href="/legal/privacy" target="_blank" rel="noreferrer" className="text-emerald-700 font-medium hover:underline">Privacy Policy →</a>
        </div>
      </div>
    </div>
  );
}
