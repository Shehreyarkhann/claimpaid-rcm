import { useEffect, useState } from 'react';
import {
  BarChart, Bar, XAxis, YAxis, Tooltip, ResponsiveContainer,
  LineChart, Line, CartesianGrid, PieChart, Pie, Cell, Legend,
} from 'recharts';
import { api, fmtMoney, fmtDate } from '../api';
import { Skeleton, PageHeader } from '../components/ui';

const COLORS = ['#10b981', '#0ea5e9', '#8b5cf6', '#f59e0b', '#f43f5e', '#64748b', '#14b8a6', '#6366f1'];

function Kpi({ label, value, sub, accent, icon }) {
  return (
    <div className="card p-5 relative overflow-hidden group hover:shadow-md transition-shadow">
      <div className={`absolute left-0 top-0 bottom-0 w-1 ${accent}`} />
      <div className="flex items-start justify-between">
        <div>
          <div className="text-[11px] font-semibold uppercase tracking-wider text-slate-400">{label}</div>
          <div className="mt-1.5 text-[26px] font-bold text-slate-900 tracking-tight">{value}</div>
          {sub && <div className="mt-1 text-xs text-slate-500">{sub}</div>}
        </div>
        <div className="text-xl opacity-60 group-hover:opacity-100 group-hover:scale-110 transition-all">{icon}</div>
      </div>
    </div>
  );
}

function ChartCard({ title, subtitle, children, className = '' }) {
  return (
    <div className={`card p-6 ${className}`}>
      <h3 className="font-semibold text-slate-900 tracking-tight">{title}</h3>
      {subtitle && <p className="text-xs text-slate-500 mt-0.5 mb-4">{subtitle}</p>}
      {!subtitle && <div className="mb-4" />}
      {children}
    </div>
  );
}

const chartTooltip = {
  contentStyle: { borderRadius: 12, border: '1px solid #e2e8f0', boxShadow: '0 8px 24px rgba(15,23,42,0.12)', fontSize: 12 },
};

export default function Dashboard({ goDenials }) {
  const [kpis, setKpis] = useState(null);
  const [aging, setAging] = useState([]);
  const [trend, setTrend] = useState([]);
  const [denials, setDenials] = useState([]);
  const [payerMix, setPayerMix] = useState([]);
  const [due, setDue] = useState([]);
  const [appealStats, setAppealStats] = useState(null);
  const [filingRisk, setFilingRisk] = useState(null);

  useEffect(() => {
    Promise.all([api.kpis(), api.arAging(), api.revenueTrend(), api.denialsByReason(), api.payerMix(), api.dueFollowups(), api.appealStats(), api.filingRisk()])
      .then(([k, a, t, d, p, du, as, fr]) => {
        setKpis(k); setAging(a); setTrend(t); setDenials(d); setPayerMix(p); setDue(du); setAppealStats(as); setFilingRisk(fr);
      })
      .catch(console.error);
  }, []);

  if (!kpis) {
    return (
      <div>
        <PageHeader title="Dashboard" subtitle="Revenue cycle at a glance" />
        <div className="grid grid-cols-2 md:grid-cols-3 xl:grid-cols-6 gap-4 mb-6">
          {Array.from({ length: 6 }).map((_, i) => <Skeleton key={i} className="h-[104px]" />)}
        </div>
        <div className="grid lg:grid-cols-2 gap-5">
          <Skeleton className="h-[340px]" /><Skeleton className="h-[340px]" />
        </div>
      </div>
    );
  }

  return (
    <div>
      <PageHeader title="Dashboard" subtitle="Revenue cycle at a glance" />

      {due.length > 0 && (
        <button onClick={goDenials}
          className="w-full mb-5 flex items-center gap-3 bg-amber-50 border border-amber-200 rounded-2xl px-5 py-3.5 text-left hover:bg-amber-100/70 transition">
          <span className="text-xl">⏰</span>
          <span className="text-sm">
            <strong className="text-amber-900">{due.length} appeal{due.length > 1 ? 's' : ''} need{due.length === 1 ? 's' : ''} follow-up</strong>
            <span className="text-amber-700"> — {due[0].claim_number} due {fmtDate(due[0].follow_up_date)}{due.length > 1 ? ` and ${due.length - 1} more` : ''}. </span>
            <span className="text-amber-800 font-semibold underline underline-offset-2">Open work queue →</span>
          </span>
        </button>
      )}

      {filingRisk && (filingRisk.expired > 0 || filingRisk.critical > 0) && (
        <div className="mb-5 card !border-rose-200 p-5">
          <div className="flex items-center gap-3 mb-3">
            <span className="text-xl">🚨</span>
            <div>
              <div className="font-bold text-slate-900">Timely filing at risk</div>
              <div className="text-xs text-slate-500">Missed deadlines = unrecoverable revenue</div>
            </div>
          </div>
          <div className="grid grid-cols-3 gap-4">
            <div className="rounded-xl bg-rose-50 border border-rose-200 p-4">
              <div className="text-2xl font-bold text-rose-700">{filingRisk.expired}</div>
              <div className="text-xs font-semibold text-rose-600 uppercase tracking-wide mt-0.5">Expired</div>
              <div className="text-xs text-rose-500 mt-1">{fmtMoney(filingRisk.expiredAmount)} lost</div>
            </div>
            <div className="rounded-xl bg-amber-50 border border-amber-200 p-4">
              <div className="text-2xl font-bold text-amber-700">{filingRisk.critical}</div>
              <div className="text-xs font-semibold text-amber-600 uppercase tracking-wide mt-0.5">≤ 14 days</div>
              <div className="text-xs text-amber-500 mt-1">{fmtMoney(filingRisk.criticalAmount)} at stake</div>
            </div>
            <div className="rounded-xl bg-slate-50 border border-slate-200 p-4">
              <div className="text-2xl font-bold text-slate-700">{filingRisk.warning}</div>
              <div className="text-xs font-semibold text-slate-500 uppercase tracking-wide mt-0.5">15–30 days</div>
              <div className="text-xs text-slate-400 mt-1">approaching deadline</div>
            </div>
          </div>
        </div>
      )}

      <div className="grid grid-cols-2 md:grid-cols-3 xl:grid-cols-6 gap-4 mb-6">
        <Kpi label="Total Billed" value={fmtMoney(kpis.totalBilled)} sub={`${kpis.totalClaims} claims`} accent="bg-sky-400" icon="💰" />
        <Kpi label="Collected" value={fmtMoney(kpis.totalCollected)} accent="bg-emerald-400" icon="✅" />
        <Kpi label="Outstanding A/R" value={fmtMoney(kpis.totalAR)} accent="bg-amber-400" icon="⏳" />
        <Kpi label="Avg Days in A/R" value={kpis.avgDaysInAR} sub="days" accent="bg-violet-400" icon="📅" />
        <Kpi label="Clean Claim Rate" value={`${kpis.cleanClaimRate}%`} accent="bg-emerald-400" icon="✨" />
        <Kpi label="Denial Rate" value={`${kpis.denialRate}%`} accent="bg-rose-400" icon="⚠️" />
      </div>

      {appealStats && (
        <div className="card p-5 mb-6 flex flex-wrap items-center gap-x-8 gap-y-3">
          <div className="text-sm font-semibold text-slate-700">Appeal pipeline</div>
          {[['open', 'Open', 'badge-slate'], ['in_progress', 'In Progress', 'badge-blue'], ['submitted', 'Submitted', 'badge-amber'], ['won', 'Won', 'badge-green'], ['lost', 'Lost', 'badge-rose']].map(([k, label, badge]) => (
            <div key={k} className="flex items-center gap-2 text-sm">
              <span className={`badge ${badge}`}>{label}</span>
              <span className="font-bold text-slate-900">{appealStats.byStatus[k]?.count || 0}</span>
            </div>
          ))}
          <div className="ml-auto text-sm text-slate-500">Win rate: <strong className="text-emerald-600">{appealStats.winRate}%</strong></div>
        </div>
      )}

      <div className="grid lg:grid-cols-2 gap-5 mb-5">
        <ChartCard title="Billed vs Collected" subtitle="Monthly revenue performance">
          <ResponsiveContainer width="100%" height={280}>
            <BarChart data={trend} barGap={3}>
              <CartesianGrid strokeDasharray="3 3" stroke="#eef2f7" vertical={false} />
              <XAxis dataKey="month" tick={{ fontSize: 11, fill: '#94a3b8' }} axisLine={false} tickLine={false} />
              <YAxis tickFormatter={(v) => `$${Math.round(v / 1000)}k`} tick={{ fontSize: 11, fill: '#94a3b8' }} axisLine={false} tickLine={false} />
              <Tooltip {...chartTooltip} formatter={(v) => fmtMoney(v)} />
              <Legend wrapperStyle={{ fontSize: 12 }} iconType="circle" />
              <Bar dataKey="billed" name="Billed" fill="#0ea5e9" radius={[5, 5, 0, 0]} />
              <Bar dataKey="collected" name="Collected" fill="#10b981" radius={[5, 5, 0, 0]} />
            </BarChart>
          </ResponsiveContainer>
        </ChartCard>

        <ChartCard title="A/R Aging" subtitle="Outstanding receivables by age">
          <ResponsiveContainer width="100%" height={280}>
            <BarChart data={aging} layout="vertical">
              <CartesianGrid strokeDasharray="3 3" stroke="#eef2f7" horizontal={false} />
              <XAxis type="number" tickFormatter={(v) => `$${Math.round(v / 1000)}k`} tick={{ fontSize: 11, fill: '#94a3b8' }} axisLine={false} tickLine={false} />
              <YAxis type="category" dataKey="bucket" tick={{ fontSize: 12, fill: '#475569' }} width={56} axisLine={false} tickLine={false} />
              <Tooltip {...chartTooltip} formatter={(v, name, p) => [`${fmtMoney(v)} · ${p.payload.count} claims`, 'Outstanding']} />
              <Bar dataKey="amount" name="Outstanding" fill="#f59e0b" radius={[0, 6, 6, 0]} barSize={22} />
            </BarChart>
          </ResponsiveContainer>
        </ChartCard>

        <ChartCard title="Denials by Reason" subtitle="Where claims are getting stuck">
          <ResponsiveContainer width="100%" height={300}>
            <BarChart data={denials} layout="vertical">
              <CartesianGrid strokeDasharray="3 3" stroke="#eef2f7" horizontal={false} />
              <XAxis type="number" tick={{ fontSize: 11, fill: '#94a3b8' }} axisLine={false} tickLine={false} />
              <YAxis type="category" dataKey="reason" tick={{ fontSize: 10.5, fill: '#475569' }} width={168} axisLine={false} tickLine={false} />
              <Tooltip {...chartTooltip} />
              <Bar dataKey="count" name="Denied claims" fill="#f43f5e" radius={[0, 6, 6, 0]} barSize={20} />
            </BarChart>
          </ResponsiveContainer>
        </ChartCard>

        <ChartCard title="Payer Mix" subtitle="Billed revenue by payer">
          <ResponsiveContainer width="100%" height={300}>
            <PieChart>
              <Pie data={payerMix} dataKey="billed" nameKey="payer" cx="50%" cy="50%" outerRadius={105} innerRadius={58} paddingAngle={2}
                label={{ fontSize: 10, fill: '#64748b' }} labelLine={false}>
                {payerMix.map((_, i) => <Cell key={i} fill={COLORS[i % COLORS.length]} strokeWidth={0} />)}
              </Pie>
              <Tooltip {...chartTooltip} formatter={(v) => fmtMoney(v)} />
              <Legend wrapperStyle={{ fontSize: 11 }} iconType="circle" />
            </PieChart>
          </ResponsiveContainer>
        </ChartCard>
      </div>

      <ChartCard title="Collection Trend" subtitle="Billed vs collected over time" className="mb-2">
        <ResponsiveContainer width="100%" height={220}>
          <LineChart data={trend}>
            <CartesianGrid strokeDasharray="3 3" stroke="#eef2f7" vertical={false} />
            <XAxis dataKey="month" tick={{ fontSize: 11, fill: '#94a3b8' }} axisLine={false} tickLine={false} />
            <YAxis tickFormatter={(v) => `$${Math.round(v / 1000)}k`} tick={{ fontSize: 11, fill: '#94a3b8' }} axisLine={false} tickLine={false} />
            <Tooltip {...chartTooltip} formatter={(v) => fmtMoney(v)} />
            <Legend wrapperStyle={{ fontSize: 12 }} iconType="circle" />
            <Line type="monotone" dataKey="collected" name="Collected" stroke="#10b981" strokeWidth={2.5} dot={false} />
            <Line type="monotone" dataKey="billed" name="Billed" stroke="#0ea5e9" strokeWidth={2} dot={false} strokeDasharray="6 4" />
          </LineChart>
        </ResponsiveContainer>
      </ChartCard>
    </div>
  );
}
