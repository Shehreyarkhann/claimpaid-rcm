import { useState, useEffect } from 'react';
import { authFetch } from '../auth';
import { useToast } from './ui';

const FIELDS = [
  ['billing_npi', 'Billing NPI *', '10 digits — required for 837 export', true],
  ['billing_tax_id', 'Tax ID (EIN)', 'For the REF*EI segment', false],
  ['billing_address', 'Street address', '', false],
  ['billing_city', 'City', '', false],
  ['billing_state', 'State', '2 letters', false],
  ['billing_zip', 'ZIP', '', false],
  ['billing_phone', 'Phone', '', false],
  ['billing_email', 'Email', 'Used in letter signatures', false],
  ['edi_submitter_id', 'Submitter ID', 'ISA06/GS02 — from your clearinghouse, else your NPI', false],
  ['edi_receiver_id', 'Receiver ID', 'ISA08/GS03 — your clearinghouse-assigned ID', false],
];

export default function EdiSettings() {
  const toast = useToast();
  const [form, setForm] = useState({});
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    authFetch('/api/org/edi-settings').then((r) => r.json()).then((d) => {
      const f = {};
      FIELDS.forEach(([k]) => { f[k] = d[k] || ''; });
      setForm(f);
    }).catch(() => {});
  }, []);

  const save = async () => {
    setError(null); setSaved(false); setBusy(true);
    try {
      const res = await authFetch('/api/org/edi-settings', {
        method: 'PUT', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(form),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error);
      setSaved(true);
      toast.success('EDI settings saved');
    } catch (e) { setError(e.message); }
    finally { setBusy(false); }
  };

  return (
    <div className="card p-6 mb-5">
      <div className="flex items-center gap-2.5 mb-1">
        <div className="text-xl">📡</div>
        <div className="font-semibold text-slate-900">EDI Settings</div>
      </div>
      <p className="text-sm text-slate-500 mb-5 max-w-2xl leading-relaxed">
        Your billing provider identity, used in the 837P claim files you export for your clearinghouse.
        Get these from your practice's credentialing paperwork — the NPI especially must be exact.
      </p>
      {error && <div className="mb-4 text-sm text-rose-700 bg-rose-50 border border-rose-200 rounded-xl px-4 py-3">{error}</div>}
      {saved && <div className="mb-4 text-sm text-emerald-700 bg-emerald-50 border border-emerald-200 rounded-xl px-4 py-3">Settings saved.</div>}
      <div className="grid sm:grid-cols-2 gap-4">
        {FIELDS.map(([k, label, hint]) => (
          <div key={k}>
            <label className="label">{label}</label>
            <input className="input font-mono" value={form[k] || ''} maxLength={k === 'billing_npi' ? 10 : 60}
              onChange={(e) => setForm({ ...form, [k]: e.target.value })} placeholder={hint} />
          </div>
        ))}
      </div>
      <div className="flex justify-end mt-5">
        <button className="btn btn-primary" disabled={busy} onClick={save}>{busy ? 'Saving…' : 'Save EDI settings'}</button>
      </div>
    </div>
  );
}
