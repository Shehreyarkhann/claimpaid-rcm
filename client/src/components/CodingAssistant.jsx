import { useEffect, useRef, useState } from 'react';
import { api } from '../api';
import { Modal } from './ui';

// Reusable AI coding assistant: clinical note -> LLM-suggested CPT/ICD-10 codes.
// HUMAN-IN-THE-LOOP: suggestions are never auto-applied. A human must accept
// each code before anything touches a claim. Unverified codes (not in the
// curated library) require explicit final_code confirmation.
export default function CodingAssistant({ initialNote = '', claimId = null, encounterId = null, onApplied, onClose }) {
  const [note, setNote] = useState(initialNote);
  const [phase, setPhase] = useState('input'); // input | analyzing | done | failed
  const [job, setJob] = useState(null);
  const [error, setError] = useState('');
  const [elapsed, setElapsed] = useState(0);
  // selections: key `${type}:${code}` -> { decision: 'accepted'|'rejected'|null, finalCode: '' }
  const [sel, setSel] = useState({});
  const [applying, setApplying] = useState(false);
  const [applied, setApplied] = useState(null);
  const pollRef = useRef(null);
  const timerRef = useRef(null);

  const stopPolling = () => {
    if (pollRef.current) { clearInterval(pollRef.current); pollRef.current = null; }
    if (timerRef.current) { clearInterval(timerRef.current); timerRef.current = null; }
  };
  useEffect(() => stopPolling, []);

  const analyze = async () => {
    setError('');
    if (note.trim().length < 50) {
      setError('The note needs at least 50 characters for the AI to code from.');
      return;
    }
    try {
      setPhase('analyzing');
      setElapsed(0);
      setApplied(null);
      const r = await api.coding.analyze({ note_text: note.trim(), claim_id: claimId, encounter_id: encounterId });
      const jobId = r.job_id;
      timerRef.current = setInterval(() => setElapsed((e) => e + 1), 1000);
      const poll = async () => {
        try {
          const j = await api.coding.job(jobId);
          if (j.status === 'complete' || j.status === 'failed') {
            stopPolling();
            setJob(j);
            setPhase(j.status === 'complete' ? 'done' : 'failed');
            if (j.status === 'failed') setError(j.error || 'Analysis failed.');
          }
        } catch (e) {
          stopPolling();
          setPhase('failed');
          setError(e.message);
        }
      };
      pollRef.current = setInterval(poll, 3000);
      poll();
    } catch (e) {
      setPhase('input');
      setError(e.message);
    }
  };

  const key = (s) => `${s.type}:${s.code}`;
  const toggle = (s, decision) => {
    const k = key(s);
    setSel((prev) => {
      const cur = prev[k] || { decision: null, finalCode: '' };
      return { ...prev, [k]: { ...cur, decision: cur.decision === decision ? null : decision } };
    });
  };
  const setFinalCode = (s, v) => {
    const k = key(s);
    setSel((prev) => ({ ...prev, [k]: { ...(prev[k] || { decision: null }), finalCode: v } }));
  };

  const applyDecisions = async () => {
    const decisions = (job?.suggestions || [])
      .map((s) => ({ s, d: sel[key(s)] }))
      .filter(({ d }) => d && d.decision)
      .map(({ s, d }) => ({
        code: s.code,
        type: s.type,
        decision: d.decision,
        ...(d.decision === 'accepted' && !s.in_library ? { final_code: d.finalCode.trim().toUpperCase() } : {}),
        ...(d.decision === 'modified' ? { final_code: d.finalCode.trim().toUpperCase() } : {}),
      }));
    // Guard: unverified accept without confirmation
    const bad = decisions.find(
      (d) => d.decision === 'accepted' &&
        !job.suggestions.find((s) => s.code === d.code && s.type === d.type)?.in_library &&
        !d.final_code
    );
    if (bad) {
      setError(`Code ${bad.code} is not in the verified library — type the confirmed code before accepting.`);
      return;
    }
    setError('');
    setApplying(true);
    try {
      const r = await api.coding.decide(job.id, { decisions });
      setApplied(r);
      onApplied && onApplied(r);
    } catch (e) {
      setError(e.message);
    } finally {
      setApplying(false);
    }
  };

  const acceptedCount = Object.values(sel).filter((d) => d.decision === 'accepted' || d.decision === 'modified').length;

  const body = (
    <div>
      <div className="mb-4 rounded-xl border border-amber-300 bg-amber-50 px-4 py-3 text-sm text-amber-900">
        <span className="font-semibold">AI suggestions — review required.</span>{' '}
        These are machine-generated suggestions from a small local model. A human coder must review and
        explicitly accept each code. Nothing is applied to a claim until you accept it below.
      </div>

      {phase === 'input' && (
        <>
          <label className="label">Clinical note</label>
          <textarea
            className="input min-h-[180px] font-normal"
            value={note}
            onChange={(e) => setNote(e.target.value)}
            placeholder="Paste the visit note, SOAP note, or encounter summary here (min 50 characters)…"
          />
          <div className="mt-3 flex items-center justify-between">
            <span className="text-xs text-stone-500">Analysis takes 30–90 seconds on the local AI model.</span>
            <button className="btn btn-primary" onClick={analyze} disabled={note.trim().length < 50}>
              Analyze note
            </button>
          </div>
        </>
      )}

      {phase === 'analyzing' && (
        <div className="py-10 text-center">
          <div className="mx-auto mb-4 h-8 w-8 animate-spin rounded-full border-2 border-stone-300 border-t-emerald-600" />
          <div className="font-medium text-stone-800">Analyzing clinical note… {elapsed}s</div>
          <div className="mt-1 text-sm text-stone-500">The local AI model is reading the note and matching codes. This takes 30–90 seconds.</div>
          <button className="btn btn-ghost btn-sm mt-4" onClick={() => { stopPolling(); setPhase('input'); }}>Cancel</button>
        </div>
      )}

      {phase === 'failed' && (
        <div className="py-8 text-center">
          <div className="text-rose-700 font-medium">Analysis failed</div>
          <button className="btn btn-primary mt-4" onClick={() => setPhase('input')}>Try again</button>
        </div>
      )}

      {(phase === 'done' || phase === 'analyzing') && job && phase === 'done' && (
        <div>
          {job.suggestions.length === 0 ? (
            <div className="rounded-xl border border-stone-300 bg-stone-50 px-5 py-6 text-center">
              <div className="font-semibold text-stone-800">The assistant abstained on this note.</div>
              <p className="mx-auto mt-1 max-w-md text-sm text-stone-600">
                No code in the library is supported by the note's own words, so it suggested nothing rather
                than guess. Code this note manually, or add documentation to the note and re-run.
              </p>
            </div>
          ) : (
            <div className="space-y-3">
              {job.summary && (
                <div className="text-sm text-stone-500">
                  {job.summary.total} suggestion{job.summary.total === 1 ? '' : 's'} —{' '}
                  <span className="font-medium text-emerald-700">{job.summary.valid} grounded</span>
                  {job.summary.review > 0 && (
                    <> · <span className="font-medium text-amber-700">{job.summary.review} need{job.summary.review === 1 ? 's' : ''} review</span></>
                  )}
                </div>
              )}
              {job.suggestions.map((s) => {
                const k = key(s);
                const d = sel[k] || { decision: null, finalCode: '' };
                return (
                  <div key={k} className={`rounded-xl border p-4 ${d.decision === 'accepted' || d.decision === 'modified' ? 'border-emerald-300 bg-emerald-50/40' : d.decision === 'rejected' ? 'border-stone-200 bg-stone-50 opacity-70' : 'border-stone-200'}`}>
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="font-mono font-bold text-stone-900">{s.code}</span>
                      <span className={`badge ${s.type === 'CPT' ? 'badge-blue' : 'badge-purple'}`}>{s.type}</span>
                      {s.in_library
                        ? <span className="badge badge-green">verified in library</span>
                        : <span className="badge badge-amber">unverified — not in library</span>}
                      {s.status === 'valid'
                        ? <span className="badge badge-green">grounded</span>
                        : s.status === 'review'
                          ? <span className="badge badge-amber">needs review</span>
                          : null}
                      <span className="ml-auto text-xs text-stone-500">confidence</span>
                      <div className="h-2 w-20 overflow-hidden rounded-full bg-stone-200">
                        <div className={`h-full rounded-full ${s.status === 'review' ? 'bg-amber-500' : 'bg-emerald-500'}`} style={{ width: `${Math.round((s.confidence || 0) * 100)}%` }} />
                      </div>
                      <span className="text-xs font-medium text-stone-600">{Math.round((s.confidence || 0) * 100)}%</span>
                    </div>
                    <div className="mt-1 text-sm text-stone-700">
                      {s.in_library ? s.library_description : <span className="italic text-stone-500">No library description — human confirmation required.</span>}
                    </div>
                    {s.evidence ? (
                      <div className={`mt-2 border-l-2 pl-3 text-xs italic text-stone-600 ${s.evidence_verified ? 'border-emerald-400' : 'border-rose-300'}`}>
                        “{s.evidence}”
                        <div className={`mt-0.5 font-medium not-italic ${s.evidence_verified ? 'text-emerald-700' : 'text-rose-600'}`}>
                          {s.evidence_verified ? '✓ Quote verified in the note' : '⚠ Quote not found in the note — verify manually'}
                        </div>
                      </div>
                    ) : (
                      <div className="mt-2 text-xs font-medium text-rose-600">⚠ No evidence quote provided — verify manually</div>
                    )}
                    {s.rationale && <div className="mt-1 text-xs text-stone-500">{s.rationale}</div>}
                    {!s.in_library && (d.decision === 'accepted' || d.decision === 'modified') && (
                      <div className="mt-2">
                        <label className="label">Confirm the correct code (required for unverified suggestions)</label>
                        <input
                          className="input font-mono"
                          value={d.finalCode}
                          onChange={(e) => setFinalCode(s, e.target.value)}
                          placeholder="Type the verified code, e.g. 99213"
                        />
                      </div>
                    )}
                    {d.decision === 'modified' && s.in_library && (
                      <div className="mt-2">
                        <label className="label">Corrected code</label>
                        <input
                          className="input font-mono"
                          value={d.finalCode}
                          onChange={(e) => setFinalCode(s, e.target.value)}
                          placeholder="Type the corrected code"
                        />
                      </div>
                    )}
                    <div className="mt-3 flex gap-2">
                      <button
                        className={`btn btn-sm ${d.decision === 'accepted' ? 'btn-primary' : 'btn-outline'}`}
                        onClick={() => toggle(s, 'accepted')}
                      >{d.decision === 'accepted' ? '✓ Accepted' : 'Accept'}</button>
                      {s.in_library && (
                        <button
                          className={`btn btn-sm ${d.decision === 'modified' ? 'btn-primary' : 'btn-outline'}`}
                          onClick={() => toggle(s, 'modified')}
                        >{d.decision === 'modified' ? '✓ Modify' : 'Modify'}</button>
                      )}
                      <button
                        className={`btn btn-sm ${d.decision === 'rejected' ? 'btn-primary' : 'btn-ghost'}`}
                        onClick={() => toggle(s, 'rejected')}
                      >{d.decision === 'rejected' ? '✕ Rejected' : 'Reject'}</button>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
          {job.suggestions.length > 0 && (
            <div className="mt-5 flex items-center justify-between border-t border-stone-100 pt-4">
              <div className="text-sm text-stone-500">
                {acceptedCount} code{acceptedCount === 1 ? '' : 's'} selected
                {!claimId && ' — save/link a claim to apply them'}
              </div>
              <button
                className="btn btn-primary"
                disabled={applying || acceptedCount === 0 || !claimId}
                onClick={applyDecisions}
                title={!claimId ? 'Link a claim to apply accepted codes' : ''}
              >
                {applying ? 'Applying…' : `Apply ${acceptedCount} to claim`}
              </button>
            </div>
          )}
          {applied && (
            <div className="mt-3 rounded-xl border border-emerald-300 bg-emerald-50 px-4 py-3 text-sm text-emerald-900">
              Applied {applied.applied} code{applied.applied === 1 ? '' : 's'} to the claim draft after your review.
            </div>
          )}
        </div>
      )}

      {error && <div className="mt-4 text-sm text-rose-700 bg-rose-50 border border-rose-200 rounded-xl px-4 py-3">{error}</div>}
    </div>
  );

  if (onClose) {
    return (
      <Modal onClose={onClose} wide>
        <div className="p-7">
          <h3 className="text-xl font-bold tracking-tight mb-4">AI code assist</h3>
          {body}
        </div>
      </Modal>
    );
  }
  return body;
}
