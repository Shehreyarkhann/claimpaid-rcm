import { useEffect, useState } from 'react';
import {
  BarChart, Bar, XAxis, YAxis, Tooltip, ResponsiveContainer, CartesianGrid, Legend,
  LineChart, Line,
} from 'recharts';
import { api, authFetch, fmtMoney } from '../api';
import { PageHeader, Skeleton, EmptyState } from '../components/ui';
import { useToast } from '../components/ui';

const chartTooltip = {
  contentStyle: { borderRadius: 12, border: '1px solid #E7E5E4', boxShadow: '0 8px 24px rgba(15,23,42,0.12)', fontSize: 12 },
};

async function downloadCSV(path, filename, toast) {
  try {
    const token = localStorage.getItem('pulse_token');
    const res = await fetch(`${path}?format=csv`, { headers: { Authorization: `Bearer ${token}` } });
    if (!res.ok) throw new Error('Export failed');
    const blob = await res.blob();
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = filename;
    document.body.appendChild(a); a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
    toast.success('Report exported');
  } catch (e) { toast.error(e.message); }
}

function ExportButton({ path, filename }) {
  const toast = useToast();
  return (
    <button onClick={() => downloadCSV(path, filename, toast)} className="btn btn-outline !py-2 !text-[13px]">
      ⬇ Export CSV
    </button>
  );
}

function ReportCard({ title, subtitle, action, children }) {
  return (
    <div className="card p-6">
      <div className="flex items-start justify-between mb-4">
        <div>
          <h3 className="font-semibold text-stone-900 tracking-tight">{title}</h3>
          {subtitle && <p className="text-xs text-stone-500 mt-0.5">{subtitle}</p>}
        </div>
        {action}
      </div>
      {children}
    </div>
  );
}

// --- 1. A/R Aging ---
function ArAgingReport() {
  const [data, setData] = useState(null);
  useEffect(() => { api.reportArAging().then(setData).catch(console.error); }, []);
  if (!data) return <Skeleton className="h-64" />;

  const chartData = data.map((r) => ({
    payer: r.payer.length > 12 ? r.payer.slice(0, 12) + '…' : r.payer,
    '0-30': r.b0_30, '31-60': r.b31_60, '61-90': r.b61_90, '91-120': r.b91_120, '120+': r.b120p,
  }));

  return (
    <div className="space-y-5">
      <ReportCard title="Outstanding A/R by Payer × Aging Bucket"
        subtitle="Where your receivables are stuck"
        action={<ExportButton path="/api/reports/ar-aging" filename="ar-aging-report.csv" />}>
        <ResponsiveContainer width="100%" height={320}>
          <BarChart data={chartData}>
            <CartesianGrid strokeDasharray="3 3" stroke="#F5EFE3" vertical={false} />
            <XAxis dataKey="payer" tick={{ fontSize: 11, fill: '#A8A29E' }} axisLine={false} tickLine={false} />
            <YAxis tickFormatter={(v) => `$${Math.round(v / 1000)}k`} tick={{ fontSize: 11, fill: '#A8A29E' }} axisLine={false} tickLine={false} />
            <Tooltip {...chartTooltip} formatter={(v) => fmtMoney(v)} />
            <Legend wrapperStyle={{ fontSize: 11 }} iconType="circle" />
            <Bar dataKey="0-30" stackId="a" fill="#10b981" />
            <Bar dataKey="31-60" stackId="a" fill="#B45309" />
            <Bar dataKey="61-90" stackId="a" fill="#f59e0b" />
            <Bar dataKey="91-120" stackId="a" fill="#f97316" />
            <Bar dataKey="120+" stackId="a" fill="#f43f5e" radius={[4, 4, 0, 0]} />
          </BarChart>
        </ResponsiveContainer>
      </ReportCard>
      <div className="card overflow-hidden">
        <table className="w-full tbl">
          <thead><tr><th>Payer</th><th className="!text-right">0–30</th><th className="!text-right">31–60</th><th className="!text-right">61–90</th><th className="!text-right">91–120</th><th className="!text-right">120+</th><th className="!text-right">Total</th></tr></thead>
          <tbody>
            {data.map((r) => (
              <tr key={r.payer}>
                <td className="font-medium">{r.payer}</td>
                <td className="!text-right">{fmtMoney(r.b0_30)}</td>
                <td className="!text-right">{fmtMoney(r.b31_60)}</td>
                <td className="!text-right">{fmtMoney(r.b61_90)}</td>
                <td className="!text-right">{fmtMoney(r.b91_120)}</td>
                <td className="!text-right text-rose-600 font-medium">{fmtMoney(r.b120p)}</td>
                <td className="!text-right font-bold">{fmtMoney(r.total)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

// --- 2. Denial Analysis ---
function DenialReport() {
  const [data, setData] = useState(null);
  useEffect(() => { api.reportDenials().then(setData).catch(console.error); }, []);
  if (!data) return <Skeleton className="h-64" />;

  return (
    <div className="space-y-5">
      <ReportCard title="Denial Rate Trend" subtitle="Are denials getting better or worse?"
        action={<ExportButton path="/api/reports/denial-analysis" filename="denial-analysis.csv" />}>
        <ResponsiveContainer width="100%" height={240}>
          <LineChart data={data.trend}>
            <CartesianGrid strokeDasharray="3 3" stroke="#F5EFE3" vertical={false} />
            <XAxis dataKey="month" tick={{ fontSize: 11, fill: '#A8A29E' }} axisLine={false} tickLine={false} />
            <YAxis tickFormatter={(v) => `${v}%`} tick={{ fontSize: 11, fill: '#A8A29E' }} axisLine={false} tickLine={false} />
            <Tooltip {...chartTooltip} formatter={(v) => `${v}%`} />
            <Line type="monotone" dataKey="rate" name="Denial rate" stroke="#f43f5e" strokeWidth={2.5} dot={false} />
          </LineChart>
        </ResponsiveContainer>
      </ReportCard>
      <div className="grid lg:grid-cols-2 gap-5">
        <ReportCard title="By Denial Reason" subtitle="Root causes, ranked">
          <div className="space-y-2.5 max-h-[320px] overflow-y-auto pr-1">
            {data.byReason.map((r) => (
              <div key={r.reason} className="flex items-center gap-3">
                <div className="flex-1 min-w-0">
                  <div className="text-sm font-medium truncate">{r.reason}</div>
                  <div className="text-xs text-stone-400">{r.count} claims · {fmtMoney(r.billed)}</div>
                </div>
                <div className="w-32 bg-stone-100 rounded-full h-2 overflow-hidden">
                  <div className="bg-rose-500 h-2 rounded-full" style={{ width: `${Math.min(100, (r.count / data.byReason[0].count) * 100)}%` }} />
                </div>
                <div className="text-sm font-bold w-8 text-right">{r.count}</div>
              </div>
            ))}
          </div>
        </ReportCard>
        <ReportCard title="By Payer" subtitle="Which payers deny most">
          <table className="w-full tbl">
            <thead><tr><th>Payer</th><th className="!text-right">Claims</th><th className="!text-right">Denied</th><th className="!text-right">Rate</th></tr></thead>
            <tbody>
              {data.byPayer.map((r) => (
                <tr key={r.payer}>
                  <td className="font-medium">{r.payer}</td>
                  <td className="!text-right">{r.total}</td>
                  <td className="!text-right">{r.denied}</td>
                  <td className="!text-right"><span className={`badge ${r.rate > 15 ? 'badge-rose' : r.rate > 8 ? 'badge-amber' : 'badge-green'}`}>{r.rate}%</span></td>
                </tr>
              ))}
            </tbody>
          </table>
        </ReportCard>
      </div>
    </div>
  );
}

// --- 3. Team Productivity ---
function ProductivityReport() {
  const [data, setData] = useState(null);
  const [days, setDays] = useState(30);
  useEffect(() => { api.reportProductivity(days).then(setData).catch(console.error); }, [days]);
  if (!data) return <Skeleton className="h-64" />;

  return (
    <div className="space-y-5">
      <div className="flex items-center gap-3">
        <label className="label !mb-0">Period</label>
        <select value={days} onChange={(e) => setDays(Number(e.target.value))} className="input !w-auto">
          <option value={7}>Last 7 days</option>
          <option value={30}>Last 30 days</option>
          <option value={90}>Last 90 days</option>
        </select>
      </div>
      <ReportCard title="Appeals by Team Member" subtitle={`Win rates and dollars recovered · last ${days} days`}
        action={<ExportButton path="/api/reports/productivity" filename="team-productivity.csv" />}>
        <table className="w-full tbl">
          <thead><tr><th>Member</th><th className="!text-right">Appeals</th><th className="!text-right">Won</th><th className="!text-right">Lost</th><th className="!text-right">Open</th><th className="!text-right">Win rate</th><th className="!text-right">$ Recovered</th></tr></thead>
          <tbody>
            {data.appeals.map((r, i) => (
              <tr key={i}>
                <td className="font-medium">{r.name}</td>
                <td className="!text-right">{r.total}</td>
                <td className="!text-right text-emerald-600 font-medium">{r.won}</td>
                <td className="!text-right text-rose-600">{r.lost}</td>
                <td className="!text-right">{r.open}</td>
                <td className="!text-right"><span className={`badge ${r.winRate >= 60 ? 'badge-green' : r.winRate >= 40 ? 'badge-amber' : 'badge-slate'}`}>{r.winRate}%</span></td>
                <td className="!text-right font-bold text-emerald-700">{fmtMoney(r.recovered)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </ReportCard>
      {data.touches.length > 0 && (
        <ReportCard title="Claim Touches" subtitle="Activity logged per team member">
          <div className="flex flex-wrap gap-3">
            {data.touches.map((t) => (
              <div key={t.id} className="card !rounded-xl px-4 py-3 flex items-center gap-3">
                <div className="w-9 h-9 rounded-full bg-gradient-to-br from-emerald-400 to-amber-500 flex items-center justify-center text-xs font-bold text-white">
                  {t.name.split(' ').map((w) => w[0]).join('').slice(0, 2)}
                </div>
                <div>
                  <div className="text-sm font-semibold">{t.name}</div>
                  <div className="text-xs text-stone-500">{t.touches} touches</div>
                </div>
              </div>
            ))}
          </div>
        </ReportCard>
      )}
    </div>
  );
}

// --- 4. Collections ---
function CollectionsReport() {
  const [data, setData] = useState(null);
  useEffect(() => { api.reportCollections().then(setData).catch(console.error); }, []);
  if (!data) return <Skeleton className="h-64" />;

  return (
    <div className="space-y-5">
      <ReportCard title="Monthly Collections" subtitle="Billed vs collected with collection rate"
        action={<ExportButton path="/api/reports/collections" filename="collections-summary.csv" />}>
        <ResponsiveContainer width="100%" height={260}>
          <BarChart data={data.monthly} barGap={4}>
            <CartesianGrid strokeDasharray="3 3" stroke="#F5EFE3" vertical={false} />
            <XAxis dataKey="month" tick={{ fontSize: 11, fill: '#A8A29E' }} axisLine={false} tickLine={false} />
            <YAxis tickFormatter={(v) => `$${Math.round(v / 1000)}k`} tick={{ fontSize: 11, fill: '#A8A29E' }} axisLine={false} tickLine={false} />
            <Tooltip {...chartTooltip} formatter={(v) => fmtMoney(v)} />
            <Legend wrapperStyle={{ fontSize: 11 }} iconType="circle" />
            <Bar dataKey="billed" name="Billed" fill="#B45309" radius={[4, 4, 0, 0]} />
            <Bar dataKey="collected" name="Collected" fill="#10b981" radius={[4, 4, 0, 0]} />
          </BarChart>
        </ResponsiveContainer>
      </ReportCard>
      <ReportCard title="By Payer" subtitle="Collection rate per payer">
        <table className="w-full tbl">
          <thead><tr><th>Payer</th><th className="!text-right">Billed</th><th className="!text-right">Collected</th><th className="!text-right">Rate</th><th className="!text-right">Claims</th></tr></thead>
          <tbody>
            {data.byPayer.map((r) => (
              <tr key={r.payer}>
                <td className="font-medium">{r.payer}</td>
                <td className="!text-right">{fmtMoney(r.billed)}</td>
                <td className="!text-right text-emerald-700 font-medium">{fmtMoney(r.collected)}</td>
                <td className="!text-right"><span className={`badge ${r.rate >= 70 ? 'badge-green' : r.rate >= 50 ? 'badge-amber' : 'badge-rose'}`}>{r.rate}%</span></td>
                <td className="!text-right text-stone-500">{r.claims}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </ReportCard>
    </div>
  );
}

// --- 5. Filing Compliance ---
function FilingReport() {
  const [data, setData] = useState(null);
  useEffect(() => { api.reportFiling().then(setData).catch(console.error); }, []);
  if (!data) return <Skeleton className="h-64" />;

  return (
    <ReportCard title="Timely Filing Compliance by Payer" subtitle="On-time filing rate — expired deadlines are unrecoverable"
      action={<ExportButton path="/api/reports/filing-compliance" filename="filing-at-risk.csv" />}>
      <table className="w-full tbl">
        <thead><tr><th>Payer</th><th className="!text-right">Open claims</th><th className="!text-right">Expired</th><th className="!text-right">At risk (≤30d)</th><th className="!text-right">On-time %</th></tr></thead>
        <tbody>
          {data.map((r) => (
            <tr key={r.payer}>
              <td className="font-medium">{r.payer}</td>
              <td className="!text-right">{r.total}</td>
              <td className="!text-right">{r.expired > 0 ? <span className="badge badge-rose">{r.expired}</span> : <span className="text-stone-300">0</span>}</td>
              <td className="!text-right">{r.atRisk > 0 ? <span className="badge badge-amber">{r.atRisk}</span> : <span className="text-stone-300">0</span>}</td>
              <td className="!text-right"><span className={`badge ${r.onTime >= 95 ? 'badge-green' : r.onTime >= 85 ? 'badge-amber' : 'badge-rose'}`}>{r.onTime}%</span></td>
            </tr>
          ))}
        </tbody>
      </table>
      <p className="text-xs text-stone-400 mt-4">CSV export downloads the full at-risk claim list — perfect for the morning huddle.</p>
    </ReportCard>
  );
}

const TABS = [
  { id: 'ar', label: 'A/R Aging', component: ArAgingReport },
  { id: 'denials', label: 'Denial Analysis', component: DenialReport },
  { id: 'team', label: 'Team Productivity', component: ProductivityReport },
  { id: 'collections', label: 'Collections', component: CollectionsReport },
  { id: 'filing', label: 'Filing Compliance', component: FilingReport },
];

export default function Reports() {
  const [tab, setTab] = useState('ar');
  const Active = TABS.find((t) => t.id === tab).component;

  return (
    <div>
      <PageHeader title="Reports" subtitle="The numbers your Monday meeting runs on — every report exports to CSV" />
      <div className="flex flex-wrap gap-2 mb-6">
        {TABS.map((t) => (
          <button key={t.id} onClick={() => setTab(t.id)}
            className={`px-4 py-2 rounded-xl text-sm font-medium transition ${tab === t.id ? 'bg-stone-900 text-white' : 'bg-white border border-stone-200 text-stone-600 hover:border-stone-300'}`}>
            {t.label}
          </button>
        ))}
      </div>
      <Active key={tab} />
    </div>
  );
}
