export default function KpiCard({ label, value, sub, tone = 'slate' }) {
  const tones = {
    slate: 'border-stone-200',
    green: 'border-emerald-300',
    amber: 'border-amber-300',
    red: 'border-rose-300',
    blue: 'border-amber-300',
    violet: 'border-amber-300',
  };
  return (
    <div className={`bg-white rounded-xl shadow-sm border-l-4 ${tones[tone]} p-5`}>
      <div className="text-xs font-semibold uppercase tracking-wide text-stone-500">{label}</div>
      <div className="mt-1 text-2xl font-bold text-stone-900">{value}</div>
      {sub && <div className="mt-1 text-xs text-stone-500">{sub}</div>}
    </div>
  );
}
