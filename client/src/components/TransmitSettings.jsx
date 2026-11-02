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
  const [stedi, setStedi] = useState(null);
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
      setStedi(c.stedi || null);
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
            <option value="stedi">Stedi — direct API submission</option>
          </select>
        </div>
        {form.vendor === 'stedi' && (
          <div className="rounded-lg border border-stone-200 bg-stone-50 p-4 text-sm text-stone-600 space-y-2">
            <div className="flex items-center gap-2">
              <span className="font-medium text-stone-800">Direct submission through Stedi</span>
              {stedi && !stedi.configured && <span className="badge badge-slate">NOT CONFIGURED</span>}
              {stedi?.mode === 'test' && <span className="badge badge-amber">TEST MODE</span>}
              {stedi?.mode === 'production' && <span className="badge badge-green">PRODUCTION</span>}
            </div>
            <p>
              Batches are submitted straight from ClaimPaid to Stedi, which routes them to the payer.
              Stedi's own claim edits come back instantly on the batch; the payer's acknowledgment (277CA)
              follows. No files to download or upload.
            </p>
            {stedi && !stedi.configured && (
              <p className="text-amber-700">Stedi isn't configured on this server yet — submissions will fail until the platform key is installed.</p>
            )}
            {stedi?.mode === 'test' && (
              <p className="text-amber-700">The server is running with a Stedi <strong>test key</strong>: submissions reach Stedi's test flow only, and real-time claim status checks are unavailable (Stedi doesn't support them on test keys). Everything else — batching, edits, acknowledgments — works the same.</p>
            )}
            {stedi?.mode === 'production' && (
              <p>Live: submissions go to real payers, and transmitted claims can be status-checked in real time from the Transmission page.</p>
            )}
          </div>
        )}
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
