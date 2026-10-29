import { useEffect, useState } from 'react';
import { api } from '../api';

function fmtDateTime(s) {
  if (!s) return '—';
  const d = new Date(String(s).replace(' ', 'T') + (String(s).includes('T') ? '' : 'Z'));
  return isNaN(d.getTime()) ? String(s) : d.toLocaleString();
}

// System health tab (Deploy #101, WS-C). Renders GET /api/super/health:
// liveness, traffic/latency from the metrics rollup, agent usage cost
// (an ESTIMATE from config pricing, labeled as such), storage, service
// probes, scheduler last-runs, and config PRESENCE booleans only —
// never a secret value. Super-admin only by construction (the whole
// /super shell is).

function fmtBytes(n) {
  if (n == null) return '—';
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / (1024 * 1024)).toFixed(1)} MB`;
  return `${(n / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

function fmtUptime(s) {
  if (s == null) return '—';
  const d = Math.floor(s / 86400);
  const h = Math.floor((s % 86400) / 3600);
  const m = Math.floor((s % 3600) / 60);
  return d > 0 ? `${d}d ${h}h` : h > 0 ? `${h}h ${m}m` : `${m}m`;
}

function Dot({ up, label }) {
  return (
    <span className="inline-flex items-center gap-2">
      <span className={`w-2.5 h-2.5 rounded-full ${up ? 'bg-emerald-400' : 'bg-rose-500'}`} />
      <span className="text-stone-200">{label}</span>
      <span className={up ? 'text-emerald-400 text-xs' : 'text-rose-400 text-xs'}>{up ? 'up' : 'down'}</span>
    </span>
  );
}

function Card({ title, children }) {
  return (
    <div className="rounded-2xl bg-stone-900 border border-stone-800 p-5">
      <div className="text-[10px] font-semibold uppercase tracking-widest text-stone-500 mb-3">{title}</div>
      {children}
    </div>
  );
}

function Row({ k, v }) {
  return (
    <div className="flex items-baseline justify-between gap-3 py-1.5 border-b border-stone-800/60 last:border-0">
      <span className="text-sm text-stone-400">{k}</span>
      <span className="text-sm text-stone-100 font-medium text-right">{v}</span>
    </div>
  );
}

export default function SuperHealthTab() {
  const [health, setHealth] = useState(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);

  const load = () => {
    setLoading(true);
    api.super.health()
      .then((h) => { setHealth(h); setError(''); })
      .catch((e) => setError(e.message || 'Health endpoint failed'))
      .finally(() => setLoading(false));
  };
  useEffect(() => { load(); }, []);

  if (loading && !health) return <div className="text-stone-400 text-sm py-8 text-center">Loading system health…</div>;
  if (error && !health) return <div className="rounded-2xl bg-rose-950/40 border border-rose-900 text-rose-200 text-sm px-5 py-4">{error}</div>;
  if (!health) return null;

  const t24 = health.traffic.last_24h || {};
  const t7 = health.traffic.last_7d || {};
  const rate = (t) => (t.requests ? `${((t.errors / t.requests) * 100).toFixed(2)}%` : '—');

  return (
    <div data-testid="super-health">
      <div className="flex items-center justify-between mb-4">
        <div className="text-sm text-stone-400">
          Server started {health.server.started_at ? fmtDateTime(health.server.started_at) : '—'} · up {fmtUptime(health.server.uptime_seconds)}
          {health.server.bundle_hash && <> · bundle <span className="font-mono text-stone-300">index-{health.server.bundle_hash}</span></>}
          {health.server.node && <> · {health.server.node}</>}
        </div>
        <button onClick={load} className="px-3 py-1.5 rounded-lg bg-stone-800 hover:bg-stone-700 text-stone-200 text-sm transition">Refresh</button>
      </div>

      <div className="grid md:grid-cols-2 xl:grid-cols-3 gap-4">
        <Card title="Services">
          <div className="space-y-2.5">
            <div><Dot up label="RCM API (this server)" /></div>
            <div><Dot up={health.services.ai === 'up'} label="AI service (AskBase)" /></div>
            <div><Dot up={health.services.ollama === 'up'} label="Ollama (local models)" /></div>
          </div>
          <div className="mt-4">
            <Row k="Workspaces" v={health.totals.orgs} />
            <Row k="User logins" v={health.totals.users} />
          </div>
        </Card>

        <Card title="Traffic & latency">
          <Row k="Requests (24h)" v={(t24.requests ?? 0).toLocaleString()} />
          <Row k="Server errors (24h)" v={t24.errors ?? 0} />
          <Row k="Error rate (24h)" v={rate(t24)} />
          <Row k="Requests (7d)" v={(t7.requests ?? 0).toLocaleString()} />
          <Row k="Server errors (7d)" v={t7.errors ?? 0} />
          <Row k="Error rate (7d)" v={rate(t7)} />
          {(health.traffic.latency_p95_by_group || []).length > 0 && (
            <div className="mt-3">
              <div className="text-[10px] font-semibold uppercase tracking-widest text-stone-500 mb-1.5">p95 latency by route group (24h, sampled)</div>
              {health.traffic.latency_p95_by_group.map((row) => (
                <Row key={row.group} k={row.group} v={`${row.p95_ms} ms`} />
              ))}
            </div>
          )}
        </Card>

        <Card title="Agent usage & cost (30d)">
          <Row k="Agent turns" v={(health.agent.turns ?? 0).toLocaleString()} />
          <Row k="Input tokens" v={(health.agent.input_tokens ?? 0).toLocaleString()} />
          <Row k="Output tokens" v={(health.agent.output_tokens ?? 0).toLocaleString()} />
          <Row k="Estimated cost" v={`$${Number(health.agent.est_cost_usd || 0).toFixed(2)}`} />
          <div className="text-[11px] text-stone-500 mt-2">
            Estimate only — {health.agent.pricing?.model_label}: ${health.agent.pricing?.input_per_mtok_usd}/MTok in, ${health.agent.pricing?.output_per_mtok_usd}/MTok out. From usage metering, not the Anthropic invoice.
          </div>
          {(health.agent.top_orgs || []).length > 0 && (
            <div className="mt-3">
              <div className="text-[10px] font-semibold uppercase tracking-widest text-stone-500 mb-1.5">Top workspaces by AI use</div>
              {health.agent.top_orgs.map((o) => (
                <Row key={o.org_id} k={o.org_name} v={`${o.turns.toLocaleString()} turns · $${Number(o.est_cost_usd).toFixed(2)}`} />
              ))}
            </div>
          )}
        </Card>

        <Card title="Storage & backups">
          <Row k="Database size" v={fmtBytes(health.storage.db_bytes)} />
          <Row k="Disk free" v={`${fmtBytes(health.storage.disk?.free_bytes)} of ${fmtBytes(health.storage.disk?.total_bytes)}`} />
          <Row k="Latest backup" v={health.storage.latest_backup
            ? `${health.storage.latest_backup.file} · ${health.storage.latest_backup.age_hours}h old`
            : 'No backups directory found'} />
        </Card>

        <Card title="Scheduler">
          <Row k="Watchdog digest last run" v={health.scheduler.watchdog_last_run ? fmtDateTime(health.scheduler.watchdog_last_run) : '—'} />
          <Row k="Brief precompute last run" v={health.scheduler.brief_precompute_last_run ? fmtDateTime(health.scheduler.brief_precompute_last_run) : '—'} />
          <Row k="Last digest attempt" v={health.scheduler.last_digest_attempt ? fmtDateTime(health.scheduler.last_digest_attempt) : '—'} />
        </Card>

        <Card title="Config (presence only)">
          <Row k="Anthropic API key" v={health.config.anthropic_api_key ? '✓ set' : '✗ not set'} />
          <Row k="Stedi API key" v={health.config.stedi_api_key ? '✓ set' : '✗ not set'} />
          <Row k="Resend / email" v={health.config.resend ? '✓ set' : '✗ not set'} />
          <Row k="Stripe secret" v={health.config.stripe ? '✓ set' : '✗ not set'} />
          <Row k="Agent enabled" v={health.config.agent_enabled ? '✓ on' : '✗ off'} />
          <div className="text-[11px] text-stone-500 mt-2">Presence only — values are never read or shown here.</div>
        </Card>
      </div>
    </div>
  );
}
