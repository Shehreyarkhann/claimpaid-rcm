'use strict';
// Lightweight server metrics (deploy #101) — the data behind the /super
// Health tab. Deliberately boring engineering:
//   * A middleware counts every request by ROUTE GROUP (never the raw
//     path — no ids, no query strings) + status class, and times it.
//   * Counts land in an in-memory current-hour bucket, flushed to the
//     metrics_hourly rollup table every 5 minutes (and on demand), so
//     24h / 7d request + error totals survive restarts.
//   * Latency p95 comes from a bounded in-memory sample ring per route
//     group (last 24h, capped) — honest live data, labeled as sampled.
//   * NO request bodies, NO headers, NO PHI. Overhead is a Map increment
//     and a Date.now() pair per request.
const { db } = require('./db');

const BOOT_TIME = new Date();
const RING_CAP = 5000; // samples per route group
const WINDOW_MS = 24 * 3600 * 1000;

// routeGroup -> Map(statusClass -> { count, errors, totalMs })
let currentHourKey = null;
let current = new Map();
// routeGroup -> [{ t, ms }] ring (oldest first)
const rings = new Map();

function hourKey(d = new Date()) {
  return d.toISOString().slice(0, 13); // 'YYYY-MM-DDTHH' in UTC
}

function routeGroup(req) {
  const p = (req.path || req.url || '').split('?')[0];
  if (p.startsWith('/api/')) {
    const seg = p.split('/').filter(Boolean); // ['api', 'agent', ...]
    return seg.length >= 2 ? `api/${seg[1]}` : 'api';
  }
  if (p === '/app' || p.startsWith('/app/')) return 'app';
  if (p === '/super' || p === '/support') return 'app';
  if (p.startsWith('/uploads/')) return 'uploads';
  return 'web';
}

function statusClass(status) {
  if (status >= 500) return '5xx';
  if (status >= 400) return '4xx';
  if (status >= 300) return '3xx';
  return '2xx';
}

function rolloverIfNeeded(now = new Date()) {
  const key = hourKey(now);
  if (currentHourKey === null) { currentHourKey = key; return; }
  if (key !== currentHourKey) {
    flushHour(currentHourKey);
    current = new Map();
    currentHourKey = key;
  }
}

function flushHour(key) {
  if (!current || current.size === 0) return;
  try {
    const up = db.prepare(`
      INSERT INTO metrics_hourly (hour, route_group, status_class, count, errors, total_ms)
      VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(hour, route_group, status_class) DO UPDATE SET
        count = excluded.count, errors = excluded.errors, total_ms = excluded.total_ms
    `);
    for (const [group, byClass] of current) {
      for (const [cls, v] of byClass) {
        up.run(key.replace('T', ' '), group, cls, v.count, v.errors, Math.round(v.totalMs * 10) / 10);
      }
    }
  } catch (e) {
    console.error('[metrics] rollup flush failed:', e.message);
  }
}

// Express middleware. Register once, before the routes.
function metricsMiddleware(req, res, next) {
  const start = Date.now();
  res.on('finish', () => {
    try {
      const ms = Date.now() - start;
      const now = new Date();
      rolloverIfNeeded(now);
      const group = routeGroup(req);
      const cls = statusClass(res.statusCode);
      if (!current.has(group)) current.set(group, new Map());
      const byClass = current.get(group);
      const cell = byClass.get(cls) || { count: 0, errors: 0, totalMs: 0 };
      cell.count += 1;
      if (res.statusCode >= 500) cell.errors += 1; // errors = 5xx only
      cell.totalMs += ms;
      byClass.set(cls, cell);
      let ring = rings.get(group);
      if (!ring) { ring = []; rings.set(group, ring); }
      ring.push({ t: now.getTime(), ms });
      if (ring.length > RING_CAP) ring.splice(0, ring.length - RING_CAP);
    } catch { /* metrics must never break a request */ }
  });
  next();
}

// ---- Reads for the health endpoint ----

function p95For(group, now = Date.now()) {
  const ring = rings.get(group) || [];
  const fresh = ring.filter((s) => now - s.t <= WINDOW_MS);
  if (!fresh.length) return null;
  const sorted = fresh.map((s) => s.ms).sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * 0.95))];
}

// Requests/errors totals for a trailing window, merging the durable
// rollup with the live current-hour bucket.
function totals(windowHours, now = new Date()) {
  rolloverIfNeeded(now);
  const since = new Date(now.getTime() - windowHours * 3600 * 1000);
  const sinceKey = since.toISOString().slice(0, 13).replace('T', ' ');
  let requests = 0;
  let errors = 0;
  try {
    // Rollup hours are stored as 'YYYY-MM-DD HH' (space-separated).
    const rows = db.prepare(
      'SELECT COALESCE(SUM(count),0) AS c, COALESCE(SUM(errors),0) AS e FROM metrics_hourly WHERE hour >= ?'
    ).get(sinceKey);
    requests += rows.c || 0;
    errors += rows.e || 0;
  } catch { /* table missing on a pre-#101 boot path — report live only */ }
  for (const byClass of current.values()) {
    for (const v of byClass.values()) { requests += v.count; errors += v.errors; }
  }
  return {
    requests,
    errors,
    error_rate: requests ? Math.round((errors / requests) * 10000) / 10000 : 0,
  };
}

function latencyByGroup() {
  const out = [];
  for (const group of rings.keys()) {
    const p95 = p95For(group);
    if (p95 != null) out.push({ group, p95_ms: p95 });
  }
  return out.sort((a, b) => b.p95_ms - a.p95_ms);
}

// Error definition for the rollup: 5xx only (4xx are client behavior —
// auth failures, validation — not service errors). The status_class rows
// still record 4xx volume separately.

setInterval(() => { try { rolloverIfNeeded(); flushHour(currentHourKey); } catch { /* noop */ } }, 5 * 60 * 1000).unref();

module.exports = {
  metricsMiddleware, totals, latencyByGroup, BOOT_TIME, routeGroup, statusClass, _flushNow: () => { rolloverIfNeeded(); flushHour(currentHourKey); },
};
