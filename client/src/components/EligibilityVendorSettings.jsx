import { useState, useEffect } from 'react';
import { api } from '../api';
import { useToast } from './ui';

// Owner-only: which eligibility vendor backs real-time checks.
// Checks require a configured vendor (Availity or a custom REST endpoint).
export default function EligibilityVendorSettings() {
  const toast = useToast();
  const [form, setForm] = useState({ vendor: 'availity', endpoint: '', api_key: '', auth_scheme: 'Bearer' });
  const [av, setAv] = useState({ client_id: '', client_secret: '', payer_map_lines: '', env: 'production' });
  const [avSecretSet, setAvSecretSet] = useState(false);
  const [keySet, setKeySet] = useState(false);
  const [customHeader, setCustomHeader] = useState('');
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    api.eligibility.getConfig().then((c) => {
      const preset = ['Bearer', 'Basic'].includes(c.auth_scheme) ? c.auth_scheme : 'custom';
      setForm({ vendor: c.vendor || 'availity', endpoint: c.endpoint || '', api_key: '', auth_scheme: preset });
      if (preset === 'custom') setCustomHeader(c.auth_scheme);
      setKeySet(!!c.api_key);
      let lines = '';
      try {
        const pm = JSON.parse(c.availity_payer_map || '{}');
        lines = Object.entries(pm).map(([k, v]) => `${k} = ${v}`).join('\n');
      } catch { lines = ''; }
      setAv({ client_id: c.availity_client_id || '', client_secret: '', payer_map_lines: lines, env: ['demo-tst', 'demo-qua'].includes(c.availity_env) ? c.availity_env : 'production' });
      setAvSecretSet(!!c.availity_client_secret_set);
    }).catch(() => {});
  }, []);

  const save = async () => {
    setError(null); setSaved(false); setBusy(true);
    try {
      const payload = {
        vendor: form.vendor,
        endpoint: form.endpoint.trim(),
        auth_scheme: form.auth_scheme === 'custom' ? customHeader.trim() : form.auth_scheme,
      };
      if (form.api_key) payload.api_key = form.api_key;
      if (form.vendor === 'availity') {
        const map = {};
        for (const line of av.payer_map_lines.split('\n')) {
          const m = line.split('=');
          if (m.length >= 2 && m[0].trim()) map[m[0].trim()] = m.slice(1).join('=').trim();
        }
        payload.availity_client_id = av.client_id.trim();
        payload.availity_env = av.env;
        payload.availity_payer_map = JSON.stringify(map);
        if (av.client_secret) payload.availity_client_secret = av.client_secret;
      }
      await api.eligibility.saveConfig(payload);
      if (form.vendor === 'availity' && av.client_secret) { setAvSecretSet(true); setAv((a) => ({ ...a, client_secret: '' })); }
      setSaved(true);
      setKeySet(!!form.api_key || keySet);
      setForm((f) => ({ ...f, api_key: '' }));
      toast.success('Eligibility vendor saved');
    } catch (e) { setError(e.message); }
    finally { setBusy(false); }
  };

  const set = (k) => (e) => setForm({ ...form, [k]: e.target.value });

  return (
    <div className="card p-6 mb-5">
      <div className="flex items-center gap-2.5 mb-1">
        <div className="text-xl">🩺</div>
        <div className="font-semibold text-stone-900">Eligibility vendor</div>
      </div>
      <p className="text-sm text-stone-500 mb-5 max-w-2xl leading-relaxed">
        Real-time eligibility checks (270/271-style) run against this vendor. A vendor account —
        e.g. Availity, pVerify, Eligible, or Change Healthcare — <strong>plus payer enrollment</strong> for
        every payer you check against is required. Until a vendor is saved here, real-time checks
        return a "not configured" message instead of results.
      </p>
      {error && <div className="mb-4 text-sm text-rose-700 bg-rose-50 border border-rose-200 rounded-xl px-4 py-3">{error}</div>}
      {saved && <div className="mb-4 text-sm text-emerald-700 bg-emerald-50 border border-emerald-200 rounded-xl px-4 py-3">Vendor settings saved.</div>}
      <div className="grid sm:grid-cols-2 gap-4">
        <div>
          <label className="label">Vendor</label>
          <select className="input" value={form.vendor} onChange={set('vendor')}>
            <option value="availity">Availity (Coverages API — free Essentials account)</option>
            <option value="rest">Custom REST API (pVerify / Eligible / …)</option>
          </select>
        </div>
        {form.vendor === 'availity' && (
          <>
            <div>
              <label className="label">Availity Client ID *</label>
              <input className="input" value={av.client_id} onChange={(e) => setAv({ ...av, client_id: e.target.value })}
                placeholder="From developer.availity.com → My Apps" />
            </div>
            <div>
              <label className="label">Availity Client Secret * {avSecretSet && !av.client_secret && <span className="text-emerald-600 font-normal">(saved — leave blank to keep)</span>}</label>
              <input className="input" type="password" value={av.client_secret} onChange={(e) => setAv({ ...av, client_secret: e.target.value })}
                placeholder={avSecretSet ? '••••••••' : 'Paste client secret'} autoComplete="new-password" />
            </div>
            <div>
              <label className="label">Environment</label>
              <select className="input" value={av.env} onChange={(e) => setAv({ ...av, env: e.target.value })}>
                <option value="production">Production (Standard plan)</option>
                <option value="demo-tst">Demo — test host (tst.api.availity.com)</option>
                <option value="demo-qua">Demo — QA host (qua.api.availity.com)</option>
              </select>
              <p className="text-xs text-stone-400 mt-1.5 leading-relaxed">
                Demo-plan credentials are rejected by the production endpoints. Availity routes demo
                plans by host — if one demo host answers "Not Found", switch to the other and re-run
                the check. When your Standard plan is approved, switch back to Production.
              </p>
            </div>
            <div className="sm:col-span-2">
              <label className="label">Payer map — one per line: Your payer name = Availity payer ID</label>
              <textarea className="input font-mono text-xs" rows={4} value={av.payer_map_lines}
                onChange={(e) => setAv({ ...av, payer_map_lines: e.target.value })}
                placeholder={'Aetna = AETNA\nCigna = CIGNA'} />
              <p className="text-xs text-stone-400 mt-1.5 leading-relaxed">
                Availity identifies payers by its own IDs (see Availity's payer list). Checks also use your
                billing NPI from Organization / EDI settings, and your app must be subscribed to Availity's
                Coverages API product. Free signup: developer.availity.com.
              </p>
            </div>
          </>
        )}
        {form.vendor === 'rest' && (
          <>
            <div>
              <label className="label">Endpoint URL *</label>
              <input className="input" value={form.endpoint} onChange={set('endpoint')}
                placeholder="https://api.vendor.com/v1/eligibility/check" />
            </div>
            <div>
              <label className="label">API key {keySet && !form.api_key && <span className="text-emerald-600 font-normal">(saved — leave blank to keep)</span>}</label>
              <input className="input" type="password" value={form.api_key} onChange={set('api_key')}
                placeholder={keySet ? '••••••••' : 'Paste vendor API key'} autoComplete="new-password" />
            </div>
            <div>
              <label className="label">Auth scheme</label>
              <select className="input" value={form.auth_scheme} onChange={set('auth_scheme')}>
                <option value="Bearer">Bearer token (Authorization header)</option>
                <option value="Basic">Basic (base64 of key)</option>
                <option value="custom">Custom header name…</option>
              </select>
            </div>
            {form.auth_scheme === 'custom' && (
              <div>
                <label className="label">Header name</label>
                <input className="input" value={customHeader} onChange={(e) => setCustomHeader(e.target.value)}
                  placeholder="X-API-Key" />
              </div>
            )}
          </>
        )}
      </div>
      <div className="mt-5">
        <button className="btn btn-primary" onClick={save} disabled={busy}>{busy ? 'Saving…' : 'Save vendor'}</button>
      </div>
    </div>
  );
}
