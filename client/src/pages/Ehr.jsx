import { useState, useEffect } from 'react';
import { api } from '../api';
import { useAuth } from '../auth';
import { useToast } from '../components/ui';

// EHR integration: pull encounters from the practice's EHR and convert them
// into claim drafts. athenahealth is the live adapter; the demo provider
// serves clearly-labeled synthetic encounters. Epic (certification ~$10k+,
// 6-12 months) and eClinicalWorks (partner program) are honestly out of scope.
export default function Ehr({ onViewClaim }) {
  const { user } = useAuth();
  const toast = useToast();
  const isOwner = user?.role === 'owner';
  const canWrite = ['owner', 'biller'].includes(user?.role);

  const [conns, setConns] = useState(null);
  const [athenaConfigured, setAthenaConfigured] = useState(false);
  const [athenaEnv, setAthenaEnv] = useState('preview');
  const [encounters, setEncounters] = useState([]);
  const [tab, setTab] = useState('new');
  const [syncing, setSyncing] = useState(false);
  const [busy, setBusy] = useState(null);
  const [showAthenaSetup, setShowAthenaSetup] = useState(false);
  const [cfg, setCfg] = useState({ env: 'preview', practice_id: '', client_id: '', client_secret: '' });
  const [cfgMeta, setCfgMeta] = useState(null);

  const load = () => {
    api.ehr.connections().then((d) => {
      setConns(d.connections || []);
      setAthenaConfigured(!!d.athena_configured);
      setAthenaEnv(d.athena_env || 'preview');
    }).catch((e) => toast.error(e.message));
    api.ehr.encounters(tab).then(setEncounters).catch((e) => toast.error(e.message));
  };
  useEffect(() => { load(); }, [tab]);

  const connFor = (p) => (conns || []).find((c) => c.provider === p);
  const demoConn = connFor('demo');
  const athenaConn = connFor('athenahealth');

  const connectDemo = async () => {
    setBusy('demo'); try { await api.ehr.connectDemo(); toast.success('Demo EHR connected'); load(); }
    catch (e) { toast.error(e.message); } finally { setBusy(null); }
  };

  const disconnect = async (provider) => {
    if (!window.confirm(`Disconnect ${provider}? Stored tokens will be wiped.`)) return;
    setBusy(provider); try { await api.ehr.disconnect(provider); toast.success('Disconnected'); load(); }
    catch (e) { toast.error(e.message); } finally { setBusy(null); }
  };

  const startAthenaOAuth = async () => {
    setBusy('athena');
    try {
      const { authorize_url } = await api.ehr.athenaAuthorize();
      // Full-page redirect: athenahealth sends the browser back to our callback.
      window.location.href = authorize_url;
    } catch (e) { toast.error(e.message); setBusy(null); }
  };

  const sync = async () => {
    setSyncing(true);
    try {
      const s = await api.ehr.sync();
      const parts = (s.synced || []).map((x) => `${x.provider}: ${x.new_encounters} new`);
      toast.success(parts.length ? `Sync complete — ${parts.join(', ')}` : 'Sync complete');
      if ((s.errors || []).length) toast.error(s.errors.map((x) => x.errors.join('; ')).join(' | '));
      load();
    } catch (e) { toast.error(e.message); } finally { setSyncing(false); }
  };

  const convert = async (id) => {
    setBusy(`c${id}`);
    try {
      const r = await api.ehr.convert(id);
      toast.success(`Claim draft ${r.claim_number} created`);
      load();
      if (onViewClaim) onViewClaim(r.claim_id);
    } catch (e) { toast.error(e.message); } finally { setBusy(null); }
  };

  const ignore = async (id) => {
    setBusy(`i${id}`);
    try { await api.ehr.ignore(id); load(); }
    catch (e) { toast.error(e.message); } finally { setBusy(null); }
  };

  const openAthenaSetup = async () => {
    try {
      const c = await api.ehr.getAthenaConfig();
      setCfg({ env: c.env || 'preview', practice_id: c.practice_id || '', client_id: '', client_secret: '' });
      setCfgMeta(c);
      setShowAthenaSetup(true);
    } catch (e) { toast.error(e.message); }
  };

  const saveAthenaSetup = async () => {
    setBusy('cfg');
    try {
      const payload = { env: cfg.env, practice_id: cfg.practice_id.trim() };
      if (cfg.client_id.trim()) payload.client_id = cfg.client_id.trim();
      if (cfg.client_secret) payload.client_secret = cfg.client_secret;
      await api.ehr.saveAthenaConfig(payload);
      toast.success('athenahealth settings saved');
      setShowAthenaSetup(false); load();
    } catch (e) { toast.error(e.message); } finally { setBusy(null); }
  };

  const statusBadge = (s) => (
    <span className={`badge ${s === 'connected' ? 'badge-green' : s === 'error' ? 'badge-red' : 'badge-slate'}`}>{s}</span>
  );

  return (
    <div className="p-6 max-w-6xl mx-auto">
      <div className="flex items-center justify-between mb-1">
        <h1 className="text-2xl font-bold text-slate-900">EHR Integration</h1>
        {canWrite && (demoConn?.status === 'connected' || athenaConn?.status === 'connected') && (
          <button className="btn btn-primary" onClick={sync} disabled={syncing}>
            {syncing ? 'Syncing…' : '⟳ Sync now'}
          </button>
        )}
      </div>
      <p className="text-sm text-slate-500 mb-6 max-w-3xl leading-relaxed">
        Pull recent encounters from your EHR and convert them into claim drafts — no more retyping
        patient, payer, and code data. Sync is manual for now; automatic sync is a planned follow-up.
      </p>

      <div className="grid md:grid-cols-2 gap-4 mb-8">
        {/* athenahealth */}
        <div className="card p-6">
          <div className="flex items-center justify-between mb-1">
            <div className="font-semibold text-slate-900">athenahealth</div>
            {athenaConn ? statusBadge(athenaConn.status) : <span className="badge badge-slate">not connected</span>}
          </div>
          <p className="text-sm text-slate-500 mb-4 leading-relaxed">
            Live adapter against athenahealth's athenaOne APIs (OAuth2). Works against the
            Preview sandbox today; production needs your Developer Console app + practice authorization.
          </p>
          {athenaConn?.status === 'error' && athenaConn.last_error && (
            <div className="mb-3 text-xs text-rose-700 bg-rose-50 border border-rose-200 rounded-lg px-3 py-2">{athenaConn.last_error}</div>
          )}
          {athenaConn?.status === 'connected' && (
            <div className="text-xs text-slate-500 mb-3 space-y-1">
              <div>Practice ID: <span className="font-mono text-slate-700">{athenaConn.practice_id || '—'}</span></div>
              <div>Environment: <span className="text-slate-700">{athenaEnv}</span></div>
              <div>Last sync: <span className="text-slate-700">{athenaConn.last_sync_at ? new Date(athenaConn.last_sync_at).toLocaleString() : 'never'}</span></div>
            </div>
          )}
          <div className="flex gap-2 flex-wrap">
            {!athenaConn || athenaConn.status !== 'connected' ? (
              <>
                <button className="btn btn-primary btn-sm" onClick={startAthenaOAuth} disabled={busy === 'athena' || !isOwner}>
                  {busy === 'athena' ? 'Starting…' : 'Connect athenahealth'}
                </button>
                {isOwner && (
                  <button className="btn btn-sm" onClick={openAthenaSetup}>App settings</button>
                )}
              </>
            ) : (
              isOwner && <button className="btn btn-sm" onClick={() => disconnect('athenahealth')} disabled={busy === 'athenahealth'}>Disconnect</button>
            )}
          </div>
          {!athenaConfigured && (
            <p className="text-xs text-amber-700 mt-3">⚠ No athenahealth app credentials yet — {isOwner ? 'open App settings to add them.' : 'an owner must add them in App settings.'}</p>
          )}
          {!isOwner && (!athenaConn || athenaConn.status !== 'connected') && (
            <p className="text-xs text-slate-400 mt-3">Only owners can connect athenahealth.</p>
          )}
        </div>

        {/* Demo EHR */}
        <div className="card p-6">
          <div className="flex items-center justify-between mb-1">
            <div className="font-semibold text-slate-900">Demo EHR</div>
            {demoConn?.status === 'connected'
              ? <span className="badge badge-amber">DEMO — synthetic encounters</span>
              : <span className="badge badge-slate">not connected</span>}
          </div>
          <p className="text-sm text-slate-500 mb-4 leading-relaxed">
            Synthetic encounters for testing the sync → convert workflow end-to-end.
            Never real data — every encounter is clearly labeled.
          </p>
          {demoConn?.status === 'connected' ? (
            <div className="flex gap-2 items-center flex-wrap">
              <span className="text-xs text-slate-500">Last sync: {demoConn.last_sync_at ? new Date(demoConn.last_sync_at).toLocaleString() : 'never'}</span>
              {isOwner && <button className="btn btn-sm" onClick={() => disconnect('demo')} disabled={busy === 'demo'}>Disable</button>}
            </div>
          ) : (
            <button className="btn btn-sm" onClick={connectDemo} disabled={busy === 'demo'}>
              {busy === 'demo' ? 'Enabling…' : 'Enable demo EHR'}
            </button>
          )}
        </div>

        {/* Out of scope — honest */}
        <div className="card p-6 opacity-75">
          <div className="flex items-center justify-between mb-1">
            <div className="font-semibold text-slate-900">Epic</div>
            <span className="badge badge-slate">not available</span>
          </div>
          <p className="text-sm text-slate-500 leading-relaxed">
            Epic requires formal certification (~$10k+, 6–12 months) before any integration
            can go live. Out of scope for now.
          </p>
        </div>
        <div className="card p-6 opacity-75">
          <div className="flex items-center justify-between mb-1">
            <div className="font-semibold text-slate-900">eClinicalWorks</div>
            <span className="badge badge-slate">not available</span>
          </div>
          <p className="text-sm text-slate-500 leading-relaxed">
            eClinicalWorks requires partner-program enrollment. Out of scope for now.
          </p>
        </div>
      </div>

      {/* Encounter inbox */}
      <div className="flex items-center gap-2 mb-4">
        <h2 className="text-lg font-semibold text-slate-900">Encounter inbox</h2>
        <div className="flex gap-1 ml-2">
          {['new', 'converted', 'ignored'].map((t) => (
            <button key={t} onClick={() => setTab(t)}
              className={`btn btn-sm ${tab === t ? 'btn-primary' : ''}`}>{t}</button>
          ))}
        </div>
      </div>

      {encounters.length === 0 ? (
        <div className="card p-8 text-center text-sm text-slate-500">
          No {tab} encounters. {tab === 'new' && 'Connect an EHR above and press “Sync now”.'}
        </div>
      ) : (
        <div className="card overflow-hidden">
          <table className="w-full text-sm">
            <thead>
              <tr className="text-left text-xs text-slate-500 border-b border-slate-200">
                <th className="px-4 py-3">Patient</th>
                <th className="px-4 py-3">Date of service</th>
                <th className="px-4 py-3">Payer</th>
                <th className="px-4 py-3">CPT</th>
                <th className="px-4 py-3">ICD</th>
                <th className="px-4 py-3">Source</th>
                <th className="px-4 py-3 text-right">Actions</th>
              </tr>
            </thead>
            <tbody>
              {encounters.map((e) => (
                <tr key={e.id} className="border-b border-slate-100 last:border-0 hover:bg-slate-50">
                  <td className="px-4 py-3 font-medium text-slate-900">{e.patient_first} {e.patient_last}</td>
                  <td className="px-4 py-3 text-slate-600">{e.date_of_service || '—'}</td>
                  <td className="px-4 py-3 text-slate-600">{e.payer_name || <span className="text-amber-600">no payer</span>}</td>
                  <td className="px-4 py-3 font-mono text-xs text-slate-600">{(e.cpt_codes || []).join(', ') || '—'}</td>
                  <td className="px-4 py-3 font-mono text-xs text-slate-600">{(e.icd_codes || []).join(', ') || '—'}</td>
                  <td className="px-4 py-3">
                    {e.connection_provider === 'demo'
                      ? <span className="badge badge-amber">demo</span>
                      : <span className="badge badge-green">athenahealth</span>}
                  </td>
                  <td className="px-4 py-3 text-right whitespace-nowrap">
                    {e.status === 'new' && canWrite && (
                      <>
                        <button className="btn btn-sm btn-primary mr-1" onClick={() => convert(e.id)} disabled={busy === `c${e.id}`}>
                          {busy === `c${e.id}` ? '…' : 'Convert to claim'}
                        </button>
                        <button className="btn btn-sm" onClick={() => ignore(e.id)} disabled={busy === `i${e.id}`}>Ignore</button>
                      </>
                    )}
                    {e.status === 'converted' && e.converted_claim_id && (
                      <button className="btn btn-sm" onClick={() => onViewClaim && onViewClaim(e.converted_claim_id)}>View claim</button>
                    )}
                    {e.status === 'ignored' && <span className="text-xs text-slate-400">ignored</span>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {/* athenahealth app settings modal */}
      {showAthenaSetup && (
        <div className="fixed inset-0 bg-slate-900/50 flex items-center justify-center z-50 p-4" onClick={() => setShowAthenaSetup(false)}>
          <div className="bg-white rounded-2xl p-6 w-full max-w-lg" onClick={(e) => e.stopPropagation()}>
            <h3 className="font-semibold text-slate-900 mb-1">athenahealth app settings</h3>
            <p className="text-xs text-slate-500 mb-4 leading-relaxed">
              From your app in the athenahealth Developer Console (developer.api.athena.io).
              Server environment variables (<code className="font-mono">ATHENA_CLIENT_ID</code> /
              <code className="font-mono">ATHENA_CLIENT_SECRET</code>) take precedence when set.
              {cfgMeta?.env_provides_id && <span className="text-emerald-600 font-medium"> Env credentials are active.</span>}
            </p>
            <div className="space-y-3">
              <div>
                <label className="label">Environment</label>
                <select className="input" value={cfg.env} onChange={(e) => setCfg({ ...cfg, env: e.target.value })}>
                  <option value="preview">Preview (sandbox, practice 195900)</option>
                  <option value="production">Production</option>
                </select>
              </div>
              <div>
                <label className="label">Practice ID</label>
                <input className="input" value={cfg.practice_id} onChange={(e) => setCfg({ ...cfg, practice_id: e.target.value })}
                  placeholder="195900 (sandbox)" />
              </div>
              <div>
                <label className="label">Client ID {cfgMeta?.client_id_set && <span className="text-emerald-600 font-normal">(saved)</span>}</label>
                <input className="input" value={cfg.client_id} onChange={(e) => setCfg({ ...cfg, client_id: e.target.value })}
                  placeholder={cfgMeta?.client_id_set ? 'Leave blank to keep' : 'Paste client ID'} autoComplete="off" />
              </div>
              <div>
                <label className="label">Client secret</label>
                <input className="input" type="password" value={cfg.client_secret} onChange={(e) => setCfg({ ...cfg, client_secret: e.target.value })}
                  placeholder="Leave blank to keep" autoComplete="new-password" />
              </div>
              <div className="text-xs text-slate-500 bg-slate-50 border border-slate-200 rounded-lg p-3 leading-relaxed">
                Register this redirect URI in your athenahealth app:<br />
                <code className="font-mono text-slate-700 break-all">{cfgMeta?.redirect_uri}</code>
              </div>
            </div>
            <div className="flex justify-end gap-2 mt-5">
              <button className="btn" onClick={() => setShowAthenaSetup(false)}>Cancel</button>
              <button className="btn btn-primary" onClick={saveAthenaSetup} disabled={busy === 'cfg'}>
                {busy === 'cfg' ? 'Saving…' : 'Save'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
