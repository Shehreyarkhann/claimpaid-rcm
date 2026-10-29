import { useEffect, useState } from 'react';
import { useAuth } from '../auth';
import { api } from '../api';
import { PageHeader, Skeleton, Modal, confirmDialog } from '../components/ui';
import { useToast } from '../components/ui';

const PAYER_TYPES = ['Commercial', 'Government', 'Patient'];

function AddPayerModal({ onClose, onSaved }) {
  const toast = useToast();
  const [form, setForm] = useState({ name: '', type: 'Commercial', filing_days: 365 });
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);
  const set = (k) => (e) => setForm({ ...form, [k]: e.target.value });

  const save = async () => {
    setError(null);
    const days = parseInt(form.filing_days);
    if (!form.name.trim()) { setError('Payer name is required'); return; }
    if (!days || days < 1 || days > 730) { setError('Filing deadline must be 1–730 days'); return; }
    setBusy(true);
    try {
      await api.createPayer({ name: form.name.trim(), type: form.type, filing_days: days });
      toast.success(`Payer "${form.name.trim()}" added`);
      onSaved();
    } catch (e) { setError(e.message); }
    finally { setBusy(false); }
  };

  return (
    <Modal onClose={onClose}>
      <div className="p-7">
        <h3 className="text-xl font-bold tracking-tight mb-1">Add payer</h3>
        <p className="text-sm text-stone-500 mb-5">The payer will appear in filing rules, claims, and the playbook's payer filter.</p>
        {error && <div className="mb-4 text-sm text-rose-700 bg-rose-50 border border-rose-200 rounded-xl px-4 py-3">{error}</div>}
        <div className="mb-4"><label className="label">Payer name</label>
          <input className="input" autoFocus value={form.name} onChange={set('name')}
            placeholder="e.g. Empire BlueCross" onKeyDown={(e) => e.key === 'Enter' && save()} /></div>
        <div className="grid sm:grid-cols-2 gap-4 mb-5">
          <div><label className="label">Type</label>
            <select className="input" value={form.type} onChange={set('type')}>
              {PAYER_TYPES.map((t) => <option key={t} value={t}>{t}</option>)}
            </select></div>
          <div><label className="label">Filing deadline (days)</label>
            <input type="number" min="1" max="730" className="input" value={form.filing_days} onChange={set('filing_days')} /></div>
        </div>
        <div className="flex justify-end gap-2">
          <button className="btn btn-ghost" onClick={onClose}>Cancel</button>
          <button className="btn btn-primary" disabled={busy} onClick={save}>{busy ? 'Adding…' : 'Add payer'}</button>
        </div>
      </div>
    </Modal>
  );
}

export default function FilingRules() {
  const { user } = useAuth();
  const toast = useToast();
  const [rules, setRules] = useState(null);
  const [editing, setEditing] = useState({});
  const [editingResp, setEditingResp] = useState({});
  const [showAdd, setShowAdd] = useState(false);
  const [suggestions, setSuggestions] = useState([]);
  const [customRules, setCustomRules] = useState([]);
  const [payers, setPayers] = useState([]);
  const [analyzing, setAnalyzing] = useState(false);
  const [showRuleForm, setShowRuleForm] = useState(false);
  const [ruleForm, setRuleForm] = useState({ name: '', severity: 'warning', payer_id: '', cpt_code: '', icd_code: '', message: '' });
  const canWrite = ['owner', 'biller'].includes(user?.role);
  const isOwner = user?.role === 'owner';

  const load = () => api.filingRules().then(setRules).catch((e) => toast.error(e.message));
  const loadRules = () => {
    api.ruleSuggestions().then(setSuggestions).catch(() => {});
    api.customRules().then(setCustomRules).catch(() => {});
    api.payers().then(setPayers).catch(() => {});
  };
  useEffect(() => { load(); loadRules(); }, []);

  const analyze = async () => {
    setAnalyzing(true);
    try {
      const r = await api.analyzeDenials();
      toast.success(r.created + r.updated === 0
        ? `Analyzed ${r.analyzed} denials — no recurring patterns found`
        : `Found ${r.created + r.updated} recurring denial pattern${r.created + r.updated > 1 ? 's' : ''}`);
      loadRules();
    } catch (e) { toast.error(e.message); }
    finally { setAnalyzing(false); }
  };

  const accept = async (id) => {
    try { await api.acceptSuggestion(id); toast.success('Rule activated'); loadRules(); }
    catch (e) { toast.error(e.message); }
  };
  const dismiss = async (id) => {
    try { await api.dismissSuggestion(id); loadRules(); }
    catch (e) { toast.error(e.message); }
  };
  const removeRule = async (id, name) => {
    if (!(await confirmDialog({ title: `Delete custom rule "${name}"?`, confirmLabel: 'Delete rule' }))) return;
    try { await api.deleteCustomRule(id); toast.success('Rule deleted'); loadRules(); }
    catch (e) { toast.error(e.message); }
  };
  const saveRule = async () => {
    try {
      await api.createCustomRule({ ...ruleForm, payer_id: ruleForm.payer_id ? Number(ruleForm.payer_id) : null });
      toast.success('Custom rule added');
      setRuleForm({ name: '', severity: 'warning', payer_id: '', cpt_code: '', icd_code: '', message: '' });
      setShowRuleForm(false);
      loadRules();
    } catch (e) { toast.error(e.message); }
  };
  const setRF = (k) => (e) => setRuleForm({ ...ruleForm, [k]: e.target.value });

  const save = async (payerId) => {
    const days = parseInt(editing[payerId]);
    if (!days || days < 1 || days > 730) { toast.error('Enter 1–730 days'); return; }
    try {
      await api.setFilingRule(payerId, days, null);
      toast.success('Filing rule updated');
      setEditing((e) => { const n = { ...e }; delete n[payerId]; return n; });
      load();
    } catch (e) { toast.error(e.message); }
  };

  // Deploy #101: the typical response window rides the same rule row —
  // saving it must not clobber the filing deadline, so it sends the
  // payer's current filing_days alongside.
  const saveResp = async (payerId) => {
    const rule = (rules || []).find((r) => r.payer_id === payerId);
    const days = parseInt(editingResp[payerId]);
    if (!days || days < 1 || days > 365) { toast.error('Enter 1–365 days'); return; }
    try {
      await api.setFilingRule(payerId, rule ? rule.filing_days : 365, null, days);
      toast.success('Typical response window updated');
      setEditingResp((e) => { const n = { ...e }; delete n[payerId]; return n; });
      load();
    } catch (e) { toast.error(e.message); }
  };

  return (
    <div>
      <PageHeader
        title="Timely Filing Rules"
        subtitle="How many days from date of service each payer allows. Deadlines drive the work queue and risk alerts."
        actions={isOwner && (
          <button className="btn btn-primary" onClick={() => setShowAdd(true)}>+ Add payer</button>
        )}
      />
      {showAdd && <AddPayerModal onClose={() => setShowAdd(false)} onSaved={() => { setShowAdd(false); load(); }} />}

      <div className="card p-5 mb-5 bg-gradient-to-r from-amber-50 to-emerald-50 !border-amber-100">
        <div className="text-sm font-semibold text-stone-800 mb-1">Why this matters</div>
        <p className="text-sm text-stone-600 leading-relaxed">
          Every payer sets its own clock from the date of service. Miss it and the claim is denied with no appeal rights —
          the revenue is gone permanently. These deadlines power the <strong>My Work</strong> queue prioritization and the
          filing-risk alerts on your dashboard. Defaults are industry-standard; adjust them to match your payer contracts.
        </p>
      </div>

      {/* Suggested rules — learned from denial patterns */}
      <div className="card p-5 mb-5">
        <div className="flex items-center justify-between mb-1">
          <div>
            <div className="font-semibold text-stone-900 tracking-tight">Suggested rules</div>
            <p className="text-xs text-stone-500 mt-0.5">Recurring denial patterns from the last 90 days — accept to turn one into a live scrubber rule</p>
          </div>
          {canWrite && (
            <button onClick={analyze} disabled={analyzing} className="btn btn-outline !py-1.5 !text-xs shrink-0">
              {analyzing ? 'Analyzing…' : 'Analyze denials'}
            </button>
          )}
        </div>
        {suggestions.length === 0 ? (
          <div className="text-sm text-stone-400 py-4 text-center">
            No suggestions yet. {canWrite ? 'Run "Analyze denials" to find recurring patterns.' : ''}
          </div>
        ) : (
          <div className="divide-y divide-stone-100">
            {suggestions.map((s) => (
              <div key={s.id} className="py-3 flex items-center gap-3 flex-wrap">
                <span className="badge badge-violet shrink-0">{s.occurrences}× denied</span>
                <div className="min-w-0 flex-1">
                  <div className="text-sm font-semibold text-stone-800">
                    {s.payer_name || 'Any payer'}{s.cpt_code ? ` · CPT ${s.cpt_code}` : ''}{s.denial_reason ? ` · ${s.denial_reason}` : ''}
                  </div>
                  <div className="text-xs text-stone-400">
                    First seen {s.first_seen?.slice(0, 10)} · Last seen {s.last_seen?.slice(0, 10)}
                  </div>
                </div>
                {canWrite && (
                  <div className="flex gap-2 shrink-0">
                    <button onClick={() => accept(s.id)} className="btn btn-primary !py-1.5 !text-xs">Accept</button>
                    <button onClick={() => dismiss(s.id)} className="btn btn-ghost !py-1.5 !text-xs">Dismiss</button>
                  </div>
                )}
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Custom scrub rules */}
      <div className="card p-5 mb-5">
        <div className="flex items-center justify-between mb-3">
          <div>
            <div className="font-semibold text-stone-900 tracking-tight">Custom scrub rules</div>
            <p className="text-xs text-stone-500 mt-0.5">Your own pre-bill checks — run on every claim alongside the built-in rules</p>
          </div>
          {canWrite && !showRuleForm && (
            <button onClick={() => setShowRuleForm(true)} className="btn btn-outline !py-1.5 !text-xs shrink-0">+ Add rule</button>
          )}
        </div>
        {showRuleForm && (
          <div className="rounded-xl border border-stone-200 bg-stone-50/60 p-4 mb-4">
            <div className="grid sm:grid-cols-2 gap-3 mb-3">
              <div><label className="label">Rule name</label>
                <input className="input" value={ruleForm.name} onChange={setRF('name')} placeholder="e.g. Aetna requires modifier 25" /></div>
              <div><label className="label">Severity</label>
                <select className="input" value={ruleForm.severity} onChange={setRF('severity')}>
                  <option value="warning">Warning — flag for review</option>
                  <option value="error">Error — block submission</option>
                </select></div>
              <div><label className="label">Payer (optional)</label>
                <select className="input" value={ruleForm.payer_id} onChange={setRF('payer_id')}>
                  <option value="">Any payer</option>
                  {payers.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
                </select></div>
              <div className="grid grid-cols-2 gap-3">
                <div><label className="label">CPT (optional)</label>
                  <input className="input font-mono" value={ruleForm.cpt_code} onChange={setRF('cpt_code')} placeholder="99213" /></div>
                <div><label className="label">ICD (optional)</label>
                  <input className="input font-mono" value={ruleForm.icd_code} onChange={setRF('icd_code')} placeholder="M54.5" /></div>
              </div>
            </div>
            <div className="mb-4"><label className="label">Message shown to billers</label>
              <input className="input" value={ruleForm.message} onChange={setRF('message')} placeholder="What should the biller check before submitting?" /></div>
            <div className="flex justify-end gap-2">
              <button onClick={() => setShowRuleForm(false)} className="btn btn-ghost !py-1.5 !text-xs">Cancel</button>
              <button onClick={saveRule} className="btn btn-primary !py-1.5 !text-xs">Add rule</button>
            </div>
          </div>
        )}
        {customRules.length === 0 ? (
          <div className="text-sm text-stone-400 py-4 text-center">No custom rules yet — accepted suggestions and manual rules appear here.</div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full tbl">
              <thead><tr><th>Rule</th><th>Severity</th><th>Payer</th><th>CPT</th><th>ICD</th><th>Source</th>{canWrite && <th className="!text-right">Actions</th>}</tr></thead>
              <tbody>
                {customRules.map((r) => (
                  <tr key={r.id}>
                    <td className="font-medium text-sm">{r.name}</td>
                    <td><span className={`badge ${r.severity === 'error' ? 'badge-rose' : 'badge-amber'}`}>{r.severity}</span></td>
                    <td className="text-sm text-stone-500">{r.payer_name || 'Any'}</td>
                    <td className="text-sm font-mono text-stone-500">{r.cpt_code || '—'}</td>
                    <td className="text-sm font-mono text-stone-500">{r.icd_code || '—'}</td>
                    <td><span className="badge badge-slate">{r.source === 'suggestion' ? 'Suggested' : 'Manual'}</span></td>
                    {canWrite && (
                      <td className="!text-right">
                        <button onClick={() => removeRule(r.id, r.name)} className="text-rose-600 hover:text-rose-800 text-xs font-semibold">Delete</button>
                      </td>
                    )}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {!rules ? (
        <div className="card p-6 space-y-3">{Array.from({ length: 8 }).map((_, i) => <Skeleton key={i} className="h-14" />)}</div>
      ) : (
        <div className="card overflow-hidden">
          <div className="px-5 py-3 border-b border-stone-100 text-xs text-stone-500">
            <strong className="text-stone-700">Typical response window</strong> — how long the payer usually takes to answer an appeal. It sets follow-ups when you mark an appeal submitted and flags payers who go silent. Typical only — an expectation, not a payer promise.
          </div>
          <table className="w-full tbl">
            <thead><tr><th>Payer</th><th>Type</th><th>Filing deadline</th><th>Typical response window</th>{canWrite && <th className="!text-right">Edit</th>}</tr></thead>
            <tbody>
              {rules.map((r) => (
                <tr key={r.payer_id}>
                  <td className="font-medium">{r.payer}</td>
                  <td><span className="badge badge-slate">{r.type}</span></td>
                  <td>
                    {editing[r.payer_id] !== undefined ? (
                      <span className="text-sm font-semibold text-stone-700">{editing[r.payer_id] || '—'} days</span>
                    ) : (
                      <span className="text-sm">
                        <strong className="text-stone-900">{r.filing_days} days</strong>
                        {r.is_default && <span className="ml-2 text-[11px] text-stone-400">(default)</span>}
                      </span>
                    )}
                  </td>
                  <td>
                    {editingResp[r.payer_id] !== undefined ? (
                      <span className="text-sm font-semibold text-stone-700">{editingResp[r.payer_id] || '—'} days</span>
                    ) : (
                      <span className="text-sm">
                        <strong className="text-stone-900">{r.response_days} days</strong>
                        {r.response_is_default && <span className="ml-2 text-[11px] text-stone-400">(typical default)</span>}
                      </span>
                    )}
                  </td>
                  {canWrite && (
                    <td className="!text-right">
                      {editing[r.payer_id] !== undefined ? (
                        <div className="flex items-center justify-end gap-2">
                          <input type="number" min="1" max="730" autoFocus
                            className="input !w-24 !py-1.5"
                            value={editing[r.payer_id]}
                            onChange={(e) => setEditing({ ...editing, [r.payer_id]: e.target.value })}
                            onKeyDown={(e) => e.key === 'Enter' && save(r.payer_id)} />
                          <button onClick={() => save(r.payer_id)} className="btn btn-primary !py-1.5 !text-xs">Save</button>
                          <button onClick={() => setEditing((e) => { const n = { ...e }; delete n[r.payer_id]; return n; })}
                            className="btn btn-ghost !py-1.5 !text-xs">Cancel</button>
                        </div>
                      ) : editingResp[r.payer_id] !== undefined ? (
                        <div className="flex items-center justify-end gap-2">
                          <input type="number" min="1" max="365" autoFocus
                            className="input !w-24 !py-1.5"
                            value={editingResp[r.payer_id]}
                            onChange={(e) => setEditingResp({ ...editingResp, [r.payer_id]: e.target.value })}
                            onKeyDown={(e) => e.key === 'Enter' && saveResp(r.payer_id)} />
                          <button onClick={() => saveResp(r.payer_id)} className="btn btn-primary !py-1.5 !text-xs">Save</button>
                          <button onClick={() => setEditingResp((e) => { const n = { ...e }; delete n[r.payer_id]; return n; })}
                            className="btn btn-ghost !py-1.5 !text-xs">Cancel</button>
                        </div>
                      ) : (
                        <span className="flex justify-end gap-3">
                          <button onClick={() => setEditing({ ...editing, [r.payer_id]: r.filing_days })}
                            className="text-amber-700 hover:text-amber-800 text-xs font-semibold">Edit deadline</button>
                          <button onClick={() => setEditingResp({ ...editingResp, [r.payer_id]: r.response_days })}
                            className="text-amber-700 hover:text-amber-800 text-xs font-semibold">Edit window</button>
                        </span>
                      )}
                    </td>
                  )}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
