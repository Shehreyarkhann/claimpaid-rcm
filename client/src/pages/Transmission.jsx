import { useState, useEffect } from 'react';
import { api, fmtMoney2, fmtDate } from '../api';
import { authFetch } from '../auth';
import { PageHeader, EmptyState, Modal, useToast } from '../components/ui';

const STATUS_BADGE = {
  draft: 'badge-slate', generated: 'badge-blue', transmitted: 'badge-violet',
  acknowledged: 'badge-amber', accepted: 'badge-green', rejected: 'badge-rose', partial: 'badge-amber',
};
const X12_BADGE = {
  not_sent: 'badge-slate', in_batch: 'badge-blue', transmitted: 'badge-violet',
  accepted: 'badge-green', rejected: 'badge-rose',
};

function downloadBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = filename;
  document.body.appendChild(a); a.click(); a.remove();
  URL.revokeObjectURL(url);
}

// --- New batch: pick scrub-clean claims, fix missing subscriber data inline ---
function NewBatchModal({ onClose, onCreated }) {
  const toast = useToast();
  const [rows, setRows] = useState(null);
  const [sel, setSel] = useState(new Set());
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const [edits, setEdits] = useState({}); // claimId -> { member_id, patient_dob }

  useEffect(() => {
    api.transmission.transmittable()
      .then((d) => setRows(d.claims))
      .catch((e) => setError(e.message));
  }, []);

  const toggle = (id) => setSel((s) => {
    const n = new Set(s);
    n.has(id) ? n.delete(id) : n.add(id);
    return n;
  });

  const saveField = async (claimId, field, value) => {
    try {
      await authFetch(`/api/claims/${claimId}`, {
        method: 'PUT', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ [field]: value }),
      }).then((r) => r.json().then((b) => { if (!r.ok) throw new Error(b.error || 'Save failed'); return b; }));
      setRows((rs) => rs.map((r) => r.id === claimId ? { ...r, [field]: value, missing: r.missing.filter((m) => !m.toLowerCase().includes(field === 'member_id' ? 'member id' : 'dob')) } : r));
      setEdits((e) => { const n = { ...e }; delete n[`${claimId}:${field}`]; return n; });
    } catch (e) { toast.error(e.message); }
  };

  const create = async () => {
    if (!sel.size) return;
    setBusy(true); setError(null);
    try {
      const b = await api.transmission.createBatch([...sel]);
      toast.success(`Batch ${b.batch_number} created`);
      onCreated(b.id);
    } catch (e) { setError(e.message); }
    finally { setBusy(false); }
  };

  return (
    <Modal onClose={onClose} wide>
      <h3 className="text-lg font-semibold text-slate-900 mb-1">New transmission batch</h3>
      <p className="text-sm text-slate-500 mb-4">
        Only scrub-clean claims (or warnings) that aren't in another batch are listed.
        Claims missing subscriber data show what's needed — fill it inline before generating.
      </p>
      {error && <div className="mb-4 text-sm text-rose-700 bg-rose-50 border border-rose-200 rounded-xl px-4 py-3">{error}</div>}
      {!rows && <div className="text-sm text-slate-500">Loading claims…</div>}
      {rows && !rows.length && <EmptyState icon="📭" title="Nothing to transmit" hint="Scrub claims clean first — transmittable claims appear here." />}
      {rows && rows.length > 0 && (
        <>
          <div className="max-h-96 overflow-auto border border-slate-200 rounded-xl">
            <table className="w-full text-sm">
              <thead className="sticky top-0 bg-slate-50">
                <tr>
                  <th className="p-2 w-8"><input type="checkbox" checked={sel.size === rows.length && rows.length > 0}
                    onChange={() => setSel(sel.size === rows.length ? new Set() : new Set(rows.map((r) => r.id)))} /></th>
                  <th className="text-left p-2">Claim</th>
                  <th className="text-left p-2">Patient</th>
                  <th className="text-left p-2">Payer</th>
                  <th className="text-right p-2">Amount</th>
                  <th className="text-left p-2">Subscriber data</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={r.id} className="border-t border-slate-100 hover:bg-slate-50">
                    <td className="p-2"><input type="checkbox" checked={sel.has(r.id)} onChange={() => toggle(r.id)} /></td>
                    <td className="p-2 font-mono text-xs">{r.claim_number}</td>
                    <td className="p-2">{r.patient_name}</td>
                    <td className="p-2">{r.payer_name}</td>
                    <td className="p-2 text-right">{fmtMoney2(r.billed_amount)}</td>
                    <td className="p-2">
                      {r.missing.length === 0
                        ? <span className="badge badge-green">ready</span>
                        : (
                          <div className="space-y-1">
                            {r.missing.map((m, i) => <div key={i} className="badge badge-amber mr-1">{m}</div>)}
                            <div className="flex gap-1 mt-1">
                              <input className="input !py-1 !text-xs" style={{ width: 110 }} placeholder="Member ID"
                                defaultValue={r.member_id || ''}
                                onBlur={(e) => e.target.value !== (r.member_id || '') && saveField(r.id, 'member_id', e.target.value)} />
                              <input className="input !py-1 !text-xs" style={{ width: 120 }} placeholder="DOB YYYY-MM-DD"
                                defaultValue={r.patient_dob || ''}
                                onBlur={(e) => e.target.value !== (r.patient_dob || '') && saveField(r.id, 'patient_dob', e.target.value)} />
                            </div>
                          </div>
                        )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div className="flex items-center justify-between mt-4">
            <div className="text-sm text-slate-500">{sel.size} claim(s) selected</div>
            <button className="btn btn-primary" disabled={busy || !sel.size} onClick={create}>
              {busy ? 'Creating…' : 'Create draft batch'}
            </button>
          </div>
        </>
      )}
    </Modal>
  );
}

// --- Batch detail: generate → transmit → ack ---
function BatchDetail({ id, onBack }) {
  const toast = useToast();
  const [batch, setBatch] = useState(null);
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);
  const [validation, setValidation] = useState(null);
  const [dataIssues, setDataIssues] = useState(null);
  const [confirmManual, setConfirmManual] = useState(false);
  const [ackType, setAckType] = useState('999');
  const [ackFile, setAckFile] = useState(null);
  const [ackResult, setAckResult] = useState(null);
  const [vendor, setVendor] = useState('manual');

  const load = () => {
    setError(null);
    api.transmission.batchDetail(id)
      .then(setBatch)
      .catch((e) => setError(e.message));
    api.transmission.getConfig().then((c) => setVendor(c.vendor || 'manual')).catch(() => {});
  };
  useEffect(load, [id]);

  const run = async (fn, okMsg) => {
    setBusy(true); setError(null);
    try {
      const b = await fn();
      await load();
      if (okMsg) toast.success(okMsg);
      return b;
    } catch (e) {
      setError(e.message);
      return null;
    } finally { setBusy(false); }
  };

  const generate = async () => {
    setBusy(true); setError(null); setValidation(null); setDataIssues(null);
    try {
      const res = await authFetch(`/api/transmission/batches/${id}/generate`, { method: 'POST' });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) {
        if (body.dataIssues) setDataIssues(body.dataIssues);
        throw new Error((body.errors || [body.error || 'Generate failed']).join('; '));
      }
      if (body.validation) setValidation(body.validation);
      await load();
      toast.success('837P generated and validated');
    } catch (e) { setError(e.message); }
    finally { setBusy(false); }
  };

  const download = async () => {
    setBusy(true);
    try {
      const res = await authFetch(`/api/transmission/batches/${id}/download`);
      if (!res.ok) {
        const b = await res.json().catch(() => ({}));
        throw new Error(b.error || 'Download failed');
      }
      const blob = await res.blob();
      downloadBlob(blob, `claimpaid-837P-${batch.batch_number}.txt`);
      toast.success('837P file downloaded');
    } catch (e) { setError(e.message); }
    finally { setBusy(false); }
  };

  const transmit = () => run(
    () => api.transmission.transmitBatch(id, { vendor, confirmed: confirmManual }),
    vendor === 'manual' ? 'Batch marked transmitted (manual)' : `Batch transmitted via ${vendor}`
  );

  const uploadAck = async () => {
    if (!ackFile) return;
    setBusy(true); setError(null); setAckResult(null);
    try {
      const b = await api.transmission.uploadAck(id, ackFile, ackType);
      setAckResult(b.ack);
      await load();
      toast.success(`${ackType.toUpperCase()} processed → ${b.ack.batchStatus}`);
    } catch (e) { setError(e.message); }
    finally { setBusy(false); }
  };

  if (!batch) return <div className="card p-6">{error ? <div className="text-rose-700 text-sm">{error}</div> : 'Loading…'}</div>;

  const st = batch.status;
  return (
    <div>
      <button className="btn btn-ghost mb-3" onClick={onBack}>← All batches</button>
      <PageHeader
        title={`Batch ${batch.batch_number}`}
        subtitle={`${batch.claims?.length || 0} claims · created ${fmtDate(batch.created_at?.slice(0, 10))}${batch.transmitted_at ? ` · transmitted ${fmtDate(batch.transmitted_at.slice(0, 10))}` : ''}`}
        actions={<span className={`badge ${STATUS_BADGE[st]}`}>{st}</span>}
      />
      {error && <div className="mb-4 text-sm text-rose-700 bg-rose-50 border border-rose-200 rounded-xl px-4 py-3">{error}</div>}
      {dataIssues && (
        <div className="mb-4 text-sm bg-amber-50 border border-amber-200 rounded-xl px-4 py-3">
          <div className="font-medium text-amber-800 mb-2">These claims are missing data required for a valid 837P — fix and regenerate:</div>
          {dataIssues.map((d) => (
            <div key={d.id} className="py-1">
              <span className="font-mono text-xs">{d.claim_number}</span>
              <span className="text-amber-700"> — {d.issues.join('; ')}</span>
            </div>
          ))}
        </div>
      )}

      {/* Step 1: generate */}
      {st === 'draft' && (
        <div className="card p-6 mb-5">
          <div className="font-semibold text-slate-900 mb-1">1 · Generate the 837P file</div>
          <p className="text-sm text-slate-500 mb-4">Builds a valid 005010X222A1 file from these claims and runs structural validation (segment counts, control numbers, required loops).</p>
          <button className="btn btn-primary" disabled={busy} onClick={generate}>{busy ? 'Generating…' : '⚙️ Generate 837P'}</button>
          {validation && (
            <div className="mt-4 text-sm text-emerald-700 bg-emerald-50 border border-emerald-200 rounded-xl px-4 py-3">
              ✓ Validation passed — {validation.claimCount} claims, ISA control {validation.controlNumber}, {validation.segmentCount} segments.
            </div>
          )}
        </div>
      )}

      {/* Step 2: download + transmit */}
      {st === 'generated' && (
        <div className="card p-6 mb-5">
          <div className="font-semibold text-slate-900 mb-1">2 · Transmit</div>
          <p className="text-sm text-slate-500 mb-4">
            Method: <strong>{vendor}</strong>.{' '}
            {vendor === 'manual'
              ? 'Download the file, upload it in your clearinghouse portal, then confirm below — nothing is marked transmitted without your confirmation.'
              : vendor === 'sftp'
                ? 'The file will be dropped into your clearinghouse SFTP inbox using your Transmission settings.'
                : 'The file will be POSTed to your configured vendor endpoint.'}
          </p>
          <div className="flex flex-wrap gap-2 items-center">
            <button className="btn" disabled={busy} onClick={download}>⬇ Download 837P</button>
            {vendor === 'manual' && (
              <label className="flex items-center gap-2 text-sm text-slate-700 ml-2">
                <input type="checkbox" checked={confirmManual} onChange={(e) => setConfirmManual(e.target.checked)} />
                I uploaded this file to my clearinghouse portal
              </label>
            )}
            <button className="btn btn-primary" disabled={busy || (vendor === 'manual' && !confirmManual)} onClick={transmit}>
              {busy ? 'Transmitting…' : `📤 Transmit via ${vendor}`}
            </button>
          </div>
        </div>
      )}

      {/* Step 3: ack upload */}
      {['transmitted', 'acknowledged', 'partial'].includes(st) && (
        <div className="card p-6 mb-5">
          <div className="font-semibold text-slate-900 mb-1">3 · Upload acknowledgement</div>
          <p className="text-sm text-slate-500 mb-4">Upload the 999 (functional ack) or 277CA (claim-level accept/reject) your clearinghouse returns. Statuses update per claim with reason codes.</p>
          <div className="flex flex-wrap gap-2 items-center">
            <select className="input" style={{ width: 160 }} value={ackType} onChange={(e) => setAckType(e.target.value)}>
              <option value="999">999 — functional ack</option>
              <option value="277ca">277CA — claim status</option>
            </select>
            <input type="file" accept=".txt,.dat,.x12,.edi" onChange={(e) => setAckFile(e.target.files[0])} className="text-sm" />
            <button className="btn btn-primary" disabled={busy || !ackFile} onClick={uploadAck}>
              {busy ? 'Processing…' : 'Process ack'}
            </button>
          </div>
          {ackResult && (
            <div className="mt-4 text-sm bg-slate-50 border border-slate-200 rounded-xl px-4 py-3">
              <div className="font-medium mb-2">Result: <span className={`badge ${STATUS_BADGE[ackResult.batchStatus] || 'badge-slate'}`}>{ackResult.batchStatus}</span></div>
              {ackResult.claims?.map((c, i) => (
                <div key={i} className="flex items-center gap-2 py-1 text-xs font-mono">
                  <span>claim #{c.claimId}</span>
                  <span className={`badge ${c.status === 'accepted' ? 'badge-green' : 'badge-rose'}`}>{c.status}</span>
                  {c.category && <span className="text-slate-500">{c.category}{c.reasonCode ? `:${c.reasonCode}` : ''}</span>}
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {/* Claims in batch */}
      <div className="card p-6">
        <div className="font-semibold text-slate-900 mb-3">Claims in this batch</div>
        <table className="w-full text-sm">
          <thead>
            <tr className="text-left text-slate-500">
              <th className="p-2">Claim</th><th className="p-2">Patient</th><th className="p-2">Payer</th>
              <th className="p-2 text-right">Amount</th><th className="p-2">X12 status</th>
            </tr>
          </thead>
          <tbody>
            {batch.claims?.map((c) => (
              <tr key={c.id} className="border-t border-slate-100">
                <td className="p-2 font-mono text-xs">{c.claim_number}</td>
                <td className="p-2">{c.patient_name}</td>
                <td className="p-2">{c.payer_name}</td>
                <td className="p-2 text-right">{fmtMoney2(c.billed_amount)}</td>
                <td className="p-2"><span className={`badge ${X12_BADGE[c.x12_status] || 'badge-slate'}`}>{c.x12_status?.replace('_', ' ')}</span></td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

const OUTBOX_BADGE = { queued: 'badge-slate', sent: 'badge-blue', acknowledged: 'badge-green', failed: 'badge-rose', requeued: 'badge-amber' };

function OutboxPanel() {
  const toast = useToast();
  const [rows, setRows] = useState(null);
  const load = () => { api.transmission.outbox().then((d) => setRows(d.outbox)).catch(() => setRows([])); };
  useEffect(load, []);
  const requeue = async (id) => {
    try { await api.transmission.requeueOutbox(id); toast.success('Claim released — it can be added to a new batch'); load(); }
    catch (e) { toast.error(e.message); }
  };
  if (!rows || !rows.length) return null;
  return (
    <div className="card p-6 mt-5">
      <div className="font-semibold text-slate-900 mb-1">Transmission outbox</div>
      <p className="text-sm text-slate-500 mb-4">Every claim's path through the clearinghouse: queued → sent → acknowledged. A failed (rejected) claim can be released back for correction and re-batching.</p>
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="text-left text-slate-500">
              <th className="p-2">Claim</th><th className="p-2">Batch</th><th className="p-2">Vendor</th>
              <th className="p-2">Status</th><th className="p-2">Sent</th><th className="p-2">Ack</th><th className="p-2" />
            </tr>
          </thead>
          <tbody>
            {rows.map((o) => (
              <tr key={o.id} className="border-t border-slate-100">
                <td className="p-2 font-mono text-xs">{o.claim_number}</td>
                <td className="p-2 font-mono text-xs text-slate-500">{o.batch_number || '—'}</td>
                <td className="p-2">{o.vendor || '—'}</td>
                <td className="p-2"><span className={`badge ${OUTBOX_BADGE[o.status] || 'badge-slate'}`}>{o.status}</span></td>
                <td className="p-2 text-slate-500">{o.sent_at ? fmtDate(o.sent_at.slice(0, 10)) : '—'}</td>
                <td className="p-2 text-slate-500">{o.ack_at ? fmtDate(o.ack_at.slice(0, 10)) : '—'}</td>
                <td className="p-2 text-right">
                  {o.status === 'failed' && <button className="btn btn-sm btn-outline" onClick={() => requeue(o.id)}>Release for re-batch</button>}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

export default function Transmission() {
  const toast = useToast();
  const [batches, setBatches] = useState(null);
  const [selected, setSelected] = useState(null);
  const [showNew, setShowNew] = useState(false);
  const [error, setError] = useState(null);

  const load = () => {
    setError(null);
    api.transmission.batches().then((d) => setBatches(d.batches)).catch((e) => setError(e.message));
  };
  useEffect(load, []);

  const del = async (id, batch_number) => {
    if (!window.confirm(`Delete draft batch ${batch_number}? Claims return to unbatched.`)) return;
    try {
      await api.transmission.deleteBatch(id);
      toast.success('Draft batch deleted');
      load();
    } catch (e) { setError(e.message); }
  };

  if (selected) {
    return <BatchDetail id={selected} onBack={() => { setSelected(null); load(); }} />;
  }

  return (
    <div>
      <PageHeader
        title="Claim transmission"
        subtitle="Build 837P batches, transmit to your clearinghouse, process 999/277CA acknowledgements."
        actions={<button className="btn btn-primary" onClick={() => setShowNew(true)}>+ New batch</button>}
      />
      {error && <div className="mb-4 text-sm text-rose-700 bg-rose-50 border border-rose-200 rounded-xl px-4 py-3">{error}</div>}
      {!batches && <div className="text-sm text-slate-500">Loading batches…</div>}
      {batches && !batches.length && (
        <EmptyState icon="📤" title="No batches yet"
          hint="Create a batch from scrub-clean claims, generate the 837P, transmit, then process the ack."
          action={<button className="btn btn-primary" onClick={() => setShowNew(true)}>+ New batch</button>} />
      )}
      {batches && batches.length > 0 && (
        <div className="card p-6">
          <table className="w-full text-sm">
            <thead>
              <tr className="text-left text-slate-500">
                <th className="p-2">Batch</th><th className="p-2 text-right">Claims</th><th className="p-2">Status</th>
                <th className="p-2">Vendor</th><th className="p-2">Created</th><th className="p-2">Transmitted</th><th className="p-2" />
              </tr>
            </thead>
            <tbody>
              {batches.map((b) => (
                <tr key={b.id} className="border-t border-slate-100 hover:bg-slate-50 cursor-pointer" onClick={() => setSelected(b.id)}>
                  <td className="p-2 font-mono text-xs font-medium">{b.batch_number}</td>
                  <td className="p-2 text-right">{b.claim_count}</td>
                  <td className="p-2"><span className={`badge ${STATUS_BADGE[b.status] || 'badge-slate'}`}>{b.status}</span></td>
                  <td className="p-2">{b.vendor}</td>
                  <td className="p-2 text-slate-500">{fmtDate(b.created_at?.slice(0, 10))}</td>
                  <td className="p-2 text-slate-500">{b.transmitted_at ? fmtDate(b.transmitted_at.slice(0, 10)) : '—'}</td>
                  <td className="p-2 text-right" onClick={(e) => e.stopPropagation()}>
                    {b.status === 'draft' && (
                      <button className="btn btn-ghost !text-rose-600 text-xs" onClick={() => del(b.id, b.batch_number)}>Delete</button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <OutboxPanel />
      {showNew && <NewBatchModal onClose={() => setShowNew(false)} onCreated={(id) => { setShowNew(false); setSelected(id); load(); }} />}
    </div>
  );
}
