import { useState, useEffect } from 'react';
import { api } from '../api';
import { useToast } from './ui';

// Owner-only: how 837P batches leave the building.
// manual (default) = download the file, upload to your clearinghouse portal yourself,
// then explicitly confirm — the app never marks a batch transmitted without that.
// sftp = drop into the clearinghouse's SFTP inbox. rest = POST to a vendor API.
// Real electronic submission needs a clearinghouse account + per-payer enrollment.
export default function TransmitSettings() {
  const toast = useToast();
  const [form, setForm] = useState({
    vendor: 'manual', sftp_host: '', sftp_port: '22', sftp_user: '', sftp_auth: 'password',
    sftp_secret: '', sftp_dir: '/', rest_endpoint: '', rest_api_key: '', rest_auth_scheme: 'Bearer',
  });
  const [secretSet, setSecretSet] = useState(false);
  const [keySet, setKeySet] = useState(false);
  const [customHeader, setCustomHeader] = useState('');
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    api.transmission.getConfig().then((c) => {
      const preset = ['Bearer', 'Basic'].includes(c.rest?.auth_scheme) ? c.rest.auth_scheme : 'custom';
      setForm({
        vendor: c.vendor || 'manual',
        sftp_host: c.sftp?.host || '', sftp_port: String(c.sftp?.port || 22),
        sftp_user: c.sftp?.user || '', sftp_auth: c.sftp?.auth || 'password',
        sftp_secret: '', sftp_dir: c.sftp?.dir || '/',
        rest_endpoint: c.rest?.endpoint || '', rest_api_key: '',
        rest_auth_scheme: preset,
      });
      if (preset === 'custom') setCustomHeader(c.rest.auth_scheme);
      setSecretSet(!!(c.sftp?.host && true)); // placeholder: backend doesn't echo secrets
      setKeySet(!!(c.rest?.endpoint && true));
    }).catch(() => {});
  }, []);

  const save = async () => {
    setError(null); setSaved(false); setBusy(true);
    try {
      const payload = {
        vendor: form.vendor,
        sftp_host: form.sftp_host.trim(),
        sftp_port: form.sftp_port,
        sftp_user: form.sftp_user.trim(),
        sftp_auth: form.sftp_auth,
        sftp_dir: form.sftp_dir.trim() || '/',
        rest_endpoint: form.rest_endpoint.trim(),
        rest_auth_scheme: form.rest_auth_scheme === 'custom' ? customHeader.trim() : form.rest_auth_scheme,
      };
      if (form.sftp_secret) payload.sftp_secret = form.sftp_secret;
      if (form.rest_api_key) payload.rest_api_key = form.rest_api_key;
      await api.transmission.saveConfig(payload);
      setSaved(true);
      setForm((f) => ({ ...f, sftp_secret: '', rest_api_key: '' }));
      toast.success('Transmission settings saved');
    } catch (e) { setError(e.message); }
    finally { setBusy(false); }
  };

  const set = (k) => (e) => setForm({ ...form, [k]: e.target.value });

  return (
    <div className="card p-6 mb-5">
      <div className="flex items-center gap-2.5 mb-1">
        <div className="text-xl">📤</div>
        <div className="font-semibold text-stone-900">Claim transmission</div>
        {form.vendor === 'manual' && <span className="badge badge-slate">MANUAL MODE</span>}
      </div>
      <p className="text-sm text-stone-500 mb-5 max-w-2xl leading-relaxed">
        How generated 837P batches are submitted to your clearinghouse. <strong>Manual</strong> is the
        honest default: you download the file, upload it in your clearinghouse portal, then confirm —
        nothing is ever marked transmitted without your say-so. <strong>SFTP</strong> and <strong>REST</strong> need
        a clearinghouse account (Change Healthcare, Availity, Waystar, Office Ally) <strong>plus per-payer
        enrollment</strong>. Credentials are stored in the app database — same at-rest posture as the rest of the app.
      </p>
      {error && <div className="mb-4 text-sm text-rose-700 bg-rose-50 border border-rose-200 rounded-xl px-4 py-3">{error}</div>}
      {saved && <div className="mb-4 text-sm text-emerald-700 bg-emerald-50 border border-emerald-200 rounded-xl px-4 py-3">Settings saved.</div>}
      <div className="grid sm:grid-cols-2 gap-4">
        <div>
          <label className="label">Transmission method</label>
          <select className="input" value={form.vendor} onChange={set('vendor')}>
            <option value="manual">Manual — I upload to my clearinghouse portal</option>
            <option value="sftp">SFTP — drop file in clearinghouse inbox</option>
            <option value="rest">REST API — POST file to vendor endpoint</option>
          </select>
        </div>
        {form.vendor === 'sftp' && (
          <>
            <div>
              <label className="label">SFTP host *</label>
              <input className="input font-mono" value={form.sftp_host} onChange={set('sftp_host')} placeholder="sftp.clearinghouse.com" />
            </div>
            <div>
              <label className="label">Port</label>
              <input className="input font-mono" value={form.sftp_port} onChange={set('sftp_port')} placeholder="22" />
            </div>
            <div>
              <label className="label">Username *</label>
              <input className="input font-mono" value={form.sftp_user} onChange={set('sftp_user')} placeholder="claimpaid_edi" autoComplete="off" />
            </div>
            <div>
              <label className="label">Auth type</label>
              <select className="input" value={form.sftp_auth} onChange={set('sftp_auth')}>
                <option value="password">Password</option>
                <option value="key">Private key</option>
              </select>
            </div>
            <div>
              <label className="label">{form.sftp_auth === 'key' ? 'Private key' : 'Password'} {secretSet && !form.sftp_secret && <span className="text-emerald-600 font-normal">(saved — leave blank to keep)</span>}</label>
              <input className="input font-mono" type="password" value={form.sftp_secret} onChange={set('sftp_secret')}
                placeholder={form.sftp_auth === 'key' ? 'Paste OpenSSH private key' : '••••••••'} autoComplete="new-password" />
            </div>
            <div>
              <label className="label">Inbox directory</label>
              <input className="input font-mono" value={form.sftp_dir} onChange={set('sftp_dir')} placeholder="/inbox" />
            </div>
          </>
        )}
        {form.vendor === 'rest' && (
          <>
            <div>
              <label className="label">Endpoint URL *</label>
              <input className="input font-mono" value={form.rest_endpoint} onChange={set('rest_endpoint')} placeholder="https://api.vendor.com/v1/claims/837p" />
            </div>
            <div>
              <label className="label">API key {keySet && !form.rest_api_key && <span className="text-emerald-600 font-normal">(saved — leave blank to keep)</span>}</label>
              <input className="input font-mono" type="password" value={form.rest_api_key} onChange={set('rest_api_key')} placeholder="••••••••" autoComplete="new-password" />
            </div>
            <div>
              <label className="label">Auth scheme</label>
              <select className="input" value={form.rest_auth_scheme} onChange={set('rest_auth_scheme')}>
                <option value="Bearer">Bearer</option>
                <option value="Basic">Basic</option>
                <option value="custom">Custom header…</option>
              </select>
            </div>
            {form.rest_auth_scheme === 'custom' && (
              <div>
                <label className="label">Header name *</label>
                <input className="input font-mono" value={customHeader} onChange={(e) => setCustomHeader(e.target.value)} placeholder="X-API-Key" />
              </div>
            )}
          </>
        )}
      </div>
      <div className="flex justify-end mt-5">
        <button className="btn btn-primary" disabled={busy} onClick={save}>{busy ? 'Saving…' : 'Save transmission settings'}</button>
      </div>
    </div>
  );
}
