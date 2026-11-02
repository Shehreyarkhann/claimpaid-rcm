import { useEffect, useState } from 'react';
import { api, fmtMoney } from '../api';
import { PageHeader, EmptyState, Skeleton, useToast } from '../components/ui';

// AI data analyst (deploy #106, Phase D). Every answer on this page is
// computed server-side from this workspace's own claims and A/R by a
// fixed set of deterministic analyses — the model never does arithmetic
// and never writes anything. Each answer states its scope: workspace,
// period, basis, and how many records are behind it.

function fmtVal(v, format) {
  if (v == null) return '—';
  if (format === 'money') return fmtMoney(v);
  if (format === 'pct') return `${v}%`;
  if (format === 'days') return `${v}d`;
  return String(v);
}

function Bars({ chart }) {
  const bars = chart?.bars || [];
  if (!bars.length) return null;
  const max = Math.max(...bars.map((b) => Number(b.value) || 0), 0);
  return (
    <div className="space-y-2">
      {bars.map((b, i) => (
        <div key={i} className="flex items-center gap-3">
          <span className="text-xs text-stone-600 w-44 shrink-0 truncate" title={b.label}>{b.label}</span>
          <div className="grow bg-stone-100 rounded-full h-5 overflow-hidden">
            <div
              className="h-full rounded-full bg-emerald-600"
              style={{ width: `${max > 0 ? Math.max(2, ((Number(b.value) || 0) / max) * 100) : 0}%` }}
            />
          </div>
          <span className="text-xs font-semibold text-stone-800 w-20 shrink-0 text-right">{fmtVal(b.value, chart.format)}</span>
        </div>
      ))}
    </div>
  );
}

function Answer({ result }) {
  return (
    <section className="card p-4 sm:p-5 space-y-4">
      <div>
        <h3 className="font-semibold text-lg">{result.title}</h3>
        <p className="text-sm text-stone-700 mt-1">{result.summary}</p>
        <p className="text-xs text-stone-500 mt-1">
          Scope: {result.scope.workspace} · {result.scope.period}
          {result.scope.from ? ` · from ${result.scope.from}` : ''}
          {result.scope.to ? ` to ${result.scope.to}` : ''}
          {' '}· n = {result.scope.n} · {result.scope.basis}
        </p>
      </div>
      <Bars chart={result.chart} />
      {result.rows?.length > 0 && (
        <div className="overflow-x-auto">
          <table className="w-full tbl">
            <thead>
              <tr>{result.columns.map((c) => <th key={c.key} className={c.format && c.format !== 'count' ? '!text-right' : ''}>{c.label}</th>)}</tr>
            </thead>
            <tbody>
              {result.rows.map((r, i) => (
                <tr key={i}>
                  {result.columns.map((c) => (
                    <td key={c.key} className={c.format && c.format !== 'count' ? '!text-right' : ''}>{fmtVal(r[c.key], c.format)}</td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <p className="text-xs text-stone-400">Computed from this workspace's data just now — nothing here is estimated or generated.</p>
    </section>
  );
}

export default function Analyst() {
  const toast = useToast();
  const [chips, setChips] = useState([]);
  const [question, setQuestion] = useState('');
  const [busy, setBusy] = useState(false);
  const [notEnabled, setNotEnabled] = useState(false);
  const [result, setResult] = useState(null);
  const [noMatch, setNoMatch] = useState(null);

  useEffect(() => {
    api.agent.analystSuggestions()
      .then((d) => setChips(d.suggestions || []))
      .catch((e) => { if (e.status === 403) setNotEnabled(true); });
  }, []);

  const ask = (payload) => {
    setBusy(true);
    setNoMatch(null);
    api.agent.analystAsk(payload)
      .then((d) => {
        if (d.matched) setResult(d);
        else { setResult(null); setNoMatch(d); }
      })
      .catch((e) => {
        if (e.status === 403) setNotEnabled(true);
        else toast.error(e.message);
      })
      .finally(() => setBusy(false));
  };

  if (notEnabled) {
    return (
      <div className="space-y-6">
        <PageHeader title="Data Analyst" subtitle="Ask questions over your own claims and A/R data." />
        <EmptyState icon="📊" title="The analyst is not enabled on this server yet" hint="It runs with the ClaimPaid agent — once the agent is enabled, this page answers from your workspace data." />
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <PageHeader
        title="Data Analyst"
        subtitle="Ask about your own claims and A/R. Answers are computed from this workspace's data — every one shows its scope and record count."
      />

      <section className="card p-4 sm:p-5 space-y-3">
        <div className="flex flex-wrap gap-2">
          {chips.map((c) => (
            <button
              key={c.label}
              className="btn btn-outline btn-sm"
              disabled={busy}
              onClick={() => { setQuestion(c.label); ask({ analysis: c.analysis, period: c.period }); }}
            >
              {c.label}
            </button>
          ))}
        </div>
        <form
          className="flex gap-2"
          onSubmit={(e) => { e.preventDefault(); if (question.trim()) ask({ question: question.trim() }); }}
        >
          <input
            className="input grow"
            placeholder="Ask a question — e.g. “Top denial reasons this quarter” or “Denial rate by payer”"
            value={question}
            onChange={(e) => setQuestion(e.target.value)}
          />
          <button className="btn btn-primary" type="submit" disabled={busy || !question.trim()}>
            {busy ? 'Computing…' : 'Ask'}
          </button>
        </form>
        <p className="text-xs text-stone-500">
          The analyst runs a fixed set of analyses over claims, denials, A/R aging and posted collections.
          If a question doesn't map to one, it says so instead of guessing.
        </p>
      </section>

      {busy && <Skeleton className="h-40" />}
      {noMatch && (
        <section className="card p-4 sm:p-5">
          <p className="text-sm text-stone-700">{noMatch.message}</p>
        </section>
      )}
      {result && !busy && <Answer result={result} />}
    </div>
  );
}
