import { useEffect, useRef, useState } from 'react';
import { api, fmtMoney2 } from '../api';
import { authFetch } from '../auth';
import { Modal, useToast } from './ui';

// Import wizard (Phase 5, WS4) — Rescue visual language for bulk claim
// intake. Steps: source → upload → mapping review → validation preview
// → commit summary. NOTHING is created before the explicit commit on
// the validation step: the server keeps the preview, validation shows
// every problem with its file row number, and commit runs the rows
// through the same claim-creation path as the New Claim form, landing
// them as 'pending'. The 837 EDI import stays the alternate first step
// — it is linked, not reimplemented.

const STEPS = ['Source', 'Upload', 'Mapping', 'Validation', 'Done'];

export default function ImportWizard({ onClose, onImported }) {
  const toast = useToast();
  const [step, setStep] = useState(0);
  const [busy, setBusy] = useState(false);
  const [preview, setPreview] = useState(null);
  const [mapping, setMapping] = useState({});
  const [result, setResult] = useState(null);
  const [ediSummary, setEdiSummary] = useState(null);
  const [error, setError] = useState('');
  const csvRef = useRef(null);
  const ediRef = useRef(null);
  // Deploy #101: saved column mappings for this workspace.
  const [savedMappings, setSavedMappings] = useState([]);
  const [mappingName, setMappingName] = useState('');

  useEffect(() => {
    api.agent.importMappings().then((r) => setSavedMappings(r.mappings || [])).catch(() => {});
  }, []);

  const applySavedMapping = (id) => {
    const m = savedMappings.find((x) => x.id === Number(id));
    if (m) setMapping({ ...m.mapping });
  };
  const saveCurrentMapping = async () => {
    const name = mappingName.trim();
    if (!name) { toast.error('Name the mapping first'); return; }
    try {
      await api.agent.saveImportMapping({ name, mapping });
      const r = await api.agent.importMappings();
      setSavedMappings(r.mappings || []);
      setMappingName('');
      toast.success(`Mapping "${name}" saved for this workspace`);
    } catch (e) {
      toast.error(e.message || 'Could not save the mapping');
    }
  };
  const deleteSavedMapping = async (id) => {
    try {
      await api.agent.deleteImportMapping(id);
      setSavedMappings((list) => list.filter((x) => x.id !== id));
    } catch (e) {
      toast.error(e.message || 'Could not delete the mapping');
    }
  };

  const downloadTemplate = async () => {
    try {
      const res = await api.agent.importTemplate();
      if (!res.ok) throw new Error('Template download failed');
      const blob = await res.blob();
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = 'claimpaid-import-template.csv';
      a.click();
      URL.revokeObjectURL(a.href);
    } catch (e) {
      toast.error(e.message || 'Template download failed');
    }
  };

  const onCsv = async (file) => {
    if (!file) return;
    setBusy(true); setError('');
    try {
      const r = await api.agent.importPreview(file);
      setPreview(r.preview);
      setMapping(r.preview.mapping || {});
      setStep(2);
    } catch (e) {
      if (e.code === 'AGENT_DISABLED') setError('The agent isn\u2019t enabled on this workspace yet, so the import wizard is unavailable.');
      else setError(e.message || 'That CSV could not be read');
    } finally {
      setBusy(false);
      if (csvRef.current) csvRef.current.value = '';
    }
  };

  const onEdi = async (file) => {
    if (!file) return;
    setBusy(true); setError('');
    try {
      const fd = new FormData();
      fd.append('file', file);
      const res = await authFetch('/api/claims/upload/837', { method: 'POST', body: fd });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || 'The 837 file could not be imported');
      setEdiSummary(data);
      setStep(4);
      if (onImported) onImported();
    } catch (e) {
      setError(e.message || 'The 837 file could not be imported');
    } finally {
      setBusy(false);
      if (ediRef.current) ediRef.current.value = '';
    }
  };

  const applyMapping = async () => {
    setBusy(true); setError('');
    try {
      const r = await api.agent.importRemap(preview.id, mapping);
      setPreview(r.preview);
      setStep(3);
    } catch (e) {
      setError(e.message || 'The mapping could not be applied');
    } finally {
      setBusy(false);
    }
  };

  const commit = async () => {
    setBusy(true); setError('');
    try {
      const r = await api.agent.importCommit(preview.id);
      setResult(r.result);
      setStep(4);
      toast.success(`Imported ${r.result.created} claim${r.result.created === 1 ? '' : 's'}`);
      if (onImported) onImported();
    } catch (e) {
      setError(e.message || 'The import could not be committed');
    } finally {
      setBusy(false);
    }
  };

  const v = preview?.validation;
  const summary = v?.summary;

  return (
    <Modal wide onClose={onClose}>
      <div className="p-6 sm:p-7">
        <div className="flex items-start gap-3">
          <div className="w-10 h-10 rounded-xl bg-emerald-50 ring-1 ring-emerald-200 flex items-center justify-center text-xl shrink-0">🧾</div>
          <div className="min-w-0">
            <h3 className="font-display text-xl font-semibold text-stone-900">Import claims</h3>
            <p className="text-sm text-stone-500">Bring a spreadsheet of claims in — mapped, checked, and only created when you say so.</p>
          </div>
        </div>

        <div className="flex flex-wrap gap-1.5 mt-5">
          {STEPS.map((label, i) => (
            <span key={label}
              className={`inline-flex items-center gap-1.5 rounded-full px-3 py-1.5 text-xs font-medium ${i === step ? 'bg-[#17251F] text-white' : i < step ? 'bg-emerald-50 text-emerald-800 ring-1 ring-emerald-200' : 'bg-stone-100 text-stone-500'}`}>
              <span className={`w-[18px] h-[18px] rounded-full text-[10px] font-bold flex items-center justify-center ${i === step ? 'bg-emerald-500 text-white' : 'bg-white ring-1 ring-stone-300 text-stone-500'}`}>{i < step ? '✓' : i + 1}</span>
              {label}
            </span>
          ))}
        </div>

        {error && <div className="mt-4 text-sm text-rose-700 bg-rose-50 border border-rose-200 rounded-xl px-4 py-3">{error}</div>}

        <div className="mt-5 min-h-[260px]">
          {step === 0 && (
            <div className="grid sm:grid-cols-2 gap-3">
              <div className="rounded-2xl border border-stone-200 bg-[#FFFDF8] p-5">
                <div className="text-2xl mb-2">📊</div>
                <div className="font-semibold text-stone-900">CSV spreadsheet</div>
                <p className="text-sm text-stone-500 mt-1">Export from your current system as CSV. The wizard maps the columns, checks every row, and shows you exactly what will happen before anything is created.</p>
                <button className="btn btn-outline btn-sm mt-4" onClick={downloadTemplate}>⬇ Download the CSV template</button>
                <p className="text-[11px] text-stone-400 mt-2">The template's two example rows are fictional — replace them with your data.</p>
                <button className="btn btn-primary mt-3" onClick={() => setStep(1)}>Start with CSV →</button>
              </div>
              <div className="rounded-2xl border border-stone-200 bg-[#FFFDF8] p-5">
                <div className="text-2xl mb-2">🔌</div>
                <div className="font-semibold text-stone-900">837 EDI file</div>
                <p className="text-sm text-stone-500 mt-1">Already have an 837 claim file from your clearinghouse or EHR? The existing 837 importer takes it from there — same parser, same results.</p>
                <label className={`btn btn-dark mt-4 ${busy ? 'opacity-60 pointer-events-none' : ''}`}>
                  {busy ? 'Importing…' : 'Upload an 837 file'}
                  <input ref={ediRef} type="file" accept=".837,.edi,.txt" className="hidden" onChange={(e) => onEdi(e.target.files && e.target.files[0])} />
                </label>
                <p className="text-[11px] text-stone-400 mt-2">837 files import immediately through the standard importer (no preview step — that's the CSV wizard's job).</p>
              </div>
            </div>
          )}

          {step === 1 && (
            <div>
              <div className="text-[10px] font-semibold uppercase tracking-widest text-stone-400 mb-2">Upload the CSV</div>
              <label className={`flex flex-col items-center justify-center rounded-2xl border-2 border-dashed border-stone-300 bg-[#FAF5EB]/60 px-4 py-10 text-center cursor-pointer transition hover:border-emerald-400 ${busy ? 'opacity-60 pointer-events-none' : ''}`}
                onDragOver={(e) => e.preventDefault()}
                onDrop={(e) => { e.preventDefault(); onCsv(e.dataTransfer.files && e.dataTransfer.files[0]); }}>
                <span className="text-3xl mb-2">📊</span>
                <span className="text-sm font-medium text-stone-700">{busy ? 'Reading the file…' : 'Drop the CSV here, or click to choose'}</span>
                <span className="text-xs text-stone-400 mt-0.5">Up to 5 MB · up to 5,000 rows · nothing is created at this step</span>
                <input ref={csvRef} type="file" accept=".csv,text/csv" className="hidden" onChange={(e) => onCsv(e.target.files && e.target.files[0])} />
              </label>
            </div>
          )}

          {step === 2 && preview && (
            <div>
              <div className="text-[10px] font-semibold uppercase tracking-widest text-stone-400 mb-2">Column mapping — adjust anything the wizard guessed wrong</div>
              <p className="text-sm text-stone-500 mb-3">File: <b className="text-stone-700">{preview.filename}</b> · {preview.row_count} data rows. Required fields are marked *.</p>
              <div className="flex flex-wrap items-center gap-2 mb-4 rounded-xl bg-stone-50 border border-stone-200 px-3 py-2.5">
                <span className="text-xs font-semibold text-stone-500">Saved mappings</span>
                <select className="input !py-1.5 !text-[13px] !w-56" defaultValue=""
                  onChange={(e) => { if (e.target.value) applySavedMapping(e.target.value); e.target.value = ''; }}>
                  <option value="">Apply a saved mapping…</option>
                  {savedMappings.map((m) => <option key={m.id} value={m.id}>{m.name}</option>)}
                </select>
                <input className="input !py-1.5 !text-[13px] !w-48" placeholder="Name this mapping"
                  value={mappingName} onChange={(e) => setMappingName(e.target.value)} />
                <button type="button" className="btn btn-outline btn-sm" onClick={saveCurrentMapping}>Save mapping</button>
                {savedMappings.length > 0 && (
                  <span className="flex flex-wrap gap-1.5">
                    {savedMappings.map((m) => (
                      <span key={m.id} className="inline-flex items-center gap-1 text-[11px] bg-white border border-stone-200 rounded-full px-2 py-0.5">
                        {m.name}
                        <button type="button" aria-label={`Delete mapping ${m.name}`} className="text-stone-400 hover:text-rose-600"
                          onClick={() => deleteSavedMapping(m.id)}>✕</button>
                      </span>
                    ))}
                  </span>
                )}
              </div>
              <div className="grid sm:grid-cols-2 gap-x-5 gap-y-2.5">
                {preview.fields.map((f) => (
                  <div key={f.key} className="flex items-center gap-3">
                    <span className="text-sm text-stone-700 w-32 shrink-0">{f.label}{f.required ? ' *' : ''}</span>
                    <select className="input !py-1.5 !text-[13px]" value={mapping[f.key] || ''}
                      onChange={(e) => setMapping((m) => ({ ...m, [f.key]: e.target.value || undefined }))}>
                      <option value="">— not mapped —</option>
                      {preview.headers.map((h) => <option key={h} value={h}>{h}</option>)}
                    </select>
                  </div>
                ))}
              </div>
            </div>
          )}

          {step === 3 && preview && v && (
            <div>
              <div className="text-[10px] font-semibold uppercase tracking-widest text-stone-400 mb-2">Validation — what will happen on import</div>
              <div className="grid grid-cols-2 sm:grid-cols-5 gap-2.5 mb-3">
                {[
                  ['Rows', summary.total], ['Valid', summary.valid], ['Warnings', summary.with_warnings],
                  ['Errors', summary.with_errors], ['Duplicates', summary.duplicates],
                ].map(([label, n]) => (
                  <div key={label} className="rounded-xl bg-[#FAF5EB] ring-1 ring-stone-200/70 px-3 py-2.5 text-center">
                    <div className="font-display text-lg font-semibold text-stone-900">{n}</div>
                    <div className="text-[10px] font-medium uppercase tracking-wide text-stone-500">{label}</div>
                  </div>
                ))}
              </div>
              {summary.new_payers.length > 0 && (
                <p className="text-[13px] text-amber-800 bg-amber-50 border border-amber-200 rounded-xl px-3.5 py-2.5 mb-3">
                  New payers will be created: {summary.new_payers.join(', ')}.
                </p>
              )}
              <div className="max-h-64 overflow-auto rounded-xl border border-stone-200">
                <table className="w-full text-[13px]">
                  <thead>
                    <tr className="bg-stone-50 text-left text-[11px] uppercase tracking-wide text-stone-500">
                      <th className="px-3 py-2">Row</th><th className="px-3 py-2">Claim</th><th className="px-3 py-2">Patient</th>
                      <th className="px-3 py-2">Payer</th><th className="px-3 py-2">Service</th>
                      <th className="px-3 py-2 text-right">Billed</th><th className="px-3 py-2">Check</th>
                    </tr>
                  </thead>
                  <tbody>
                    {v.rows.map((r) => (
                      <tr key={r.row} className={`border-t border-stone-100 ${!r.valid ? 'bg-rose-50/50' : r.warnings.length ? 'bg-amber-50/30' : ''}`}>
                        <td className="px-3 py-2 text-stone-400">{r.row}</td>
                        <td className="px-3 py-2 font-medium text-stone-800">{r.values.claim_number || '—'}</td>
                        <td className="px-3 py-2 text-stone-600">{r.values.patient_name || '—'}</td>
                        <td className="px-3 py-2 text-stone-600">{r.values.payer || '—'}{r.payer_status === 'new' && <span className="badge badge-amber ml-1.5">new</span>}</td>
                        <td className="px-3 py-2 text-stone-600">{r.values.service_date || '—'}</td>
                        <td className="px-3 py-2 text-right">{r.values.billed_amount != null ? fmtMoney2(r.values.billed_amount) : '—'}</td>
                        <td className="px-3 py-2">
                          {r.valid
                            ? <span className="text-emerald-700 font-medium">✓ Ready</span>
                            : <span className="text-rose-700">{r.errors.join('; ')}</span>}
                          {r.valid && r.warnings.length > 0 && <span className="block text-amber-700 text-xs mt-0.5">{r.warnings.join('; ')}</span>}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <p className="text-[11px] text-stone-400 mt-2.5">Valid rows import as <b>pending</b> claims through the standard claim-creation path. Rows with errors or duplicates are skipped — fix them in the spreadsheet and re-run the wizard for those.</p>
            </div>
          )}

          {step === 4 && (
            <div className="text-center py-6">
              <img src="/app/claimpaid-icon.webp" alt="" className="motion-stamp w-24 h-24 mx-auto drop-shadow-xl" />
              {ediSummary ? (
                <>
                  <div className="font-display text-xl font-semibold text-stone-900 mt-5">837 import complete</div>
                  <p className="text-sm text-stone-500 mt-1.5 max-w-md mx-auto">
                    The standard 837 importer processed the file
                    {ediSummary.claims_created != null ? <> — <b className="text-stone-700">{ediSummary.claims_created} claims created</b></> : ''}
                    {ediSummary.payers_created ? <>, {ediSummary.payers_created} payers created</> : ''}
                    {ediSummary.errors && ediSummary.errors.length ? <>, {ediSummary.errors.length} rows with errors</> : ''}.
                    Find the claims in the Claims tab.
                  </p>
                </>
              ) : result ? (
                <>
                  <div className="font-display text-xl font-semibold text-stone-900 mt-5">Import complete</div>
                  <p className="text-sm text-stone-500 mt-1.5 max-w-md mx-auto">
                    <b className="text-stone-700">{result.created} claim{result.created === 1 ? '' : 's'} created</b> as pending
                    {result.payers_created && result.payers_created.length ? <> · payers created: {result.payers_created.join(', ')}</> : ''}
                    {' '}· {result.skipped} skipped.
                  </p>
                  {result.errors && result.errors.length > 0 && (
                    <div className="text-left max-w-md mx-auto mt-3 text-[13px] text-rose-700 bg-rose-50 border border-rose-200 rounded-xl px-4 py-3">
                      {result.errors.map((e, i) => <div key={i}>Row {e.row}: {e.error}</div>)}
                    </div>
                  )}
                </>
              ) : null}
              <button className="btn btn-primary mt-5" onClick={onClose}>Done</button>
            </div>
          )}
        </div>

        {step !== 4 && (
          <div className="flex items-center gap-2 mt-5 pt-4 border-t border-stone-100">
            <button className="btn btn-ghost" onClick={onClose}>Cancel</button>
            <div className="ml-auto flex gap-2">
              {step > 0 && step < 3 && <button className="btn btn-outline" onClick={() => setStep(step - 1)}>Back</button>}
              {step === 3 && <button className="btn btn-outline" onClick={() => setStep(2)}>Back to mapping</button>}
              {step === 2 && <button className="btn btn-primary" disabled={busy} onClick={applyMapping}>{busy ? 'Checking…' : 'Validate rows →'}</button>}
              {step === 3 && (
                <button className="btn btn-primary" disabled={busy || !summary || summary.valid === 0} onClick={commit}>
                  {busy ? 'Importing…' : `Import ${summary ? summary.valid : 0} valid claim${summary && summary.valid === 1 ? '' : 's'} 🧾`}
                </button>
              )}
            </div>
          </div>
        )}
      </div>
    </Modal>
  );
}
