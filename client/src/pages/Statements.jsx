import { useEffect, useState } from 'react';
import { useAuth, authFetch } from '../auth';
import { api, fmtMoney, fmtDate } from '../api';
import { PageHeader, EmptyState, Modal, Skeleton, useToast } from '../components/ui';

const STATUS = {
  draft: ['Draft', 'badge-slate'],
  open: ['Sent — awaiting payment', 'badge-blue'],
  partially_paid: ['Partially paid', 'badge-amber'],
  paid: ['Paid', 'badge-green'],
  void: ['Void', 'badge-rose'],
};

function downloadPdf(id, number) {
  return authFetch(`/api/statements/${id}/pdf`)
    .then((r) => { if (!r.ok) throw new Error('PDF failed'); return r.blob(); })
    .then((blob) => {
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url; a.download = `${number}.pdf`;
      document.body.appendChild(a); a.click(); a.remove();
      URL.revokeObjectURL(url);
    });
}

function copyLink(url, toast) {
  if (navigator.clipboard?.writeText) {
    navigator.clipboard.writeText(url)
      .then(() => toast.success('Pay link copied'))
      .catch(() => toast.error('Copy failed — open the statement to see the link'));
  } else {
    toast.error('Copy is not available in this browser — open the statement to see the link');
  }
}

function PayModal({ stmt, onClose, onDone }) {
  const toast = useToast();
  const [amount, setAmount] = useState(String(stmt.balance ?? (stmt.amount_due - stmt.amount_paid)));
  const [method, setMethod] = useState('check');
  const [busy, setBusy] = useState(false);
  const save = () => {
    setBusy(true);
    api.statements.recordPayment(stmt.id, { amount: Number(amount), method })
      .then(() => { toast.success('Payment recorded'); onDone(); })
      .catch((e) => { toast.error(e.message); setBusy(false); });
  };
  return (
    <Modal onClose={onClose}>
      <div className="p-7">
        <h3 className="text-xl font-bold tracking-tight mb-1">Record payment — {stmt.statement_number}</h3>
        <p className="text-sm text-stone-500 mb-5">{stmt.patient_name} · balance {fmtMoney(stmt.balance ?? (stmt.amount_due - stmt.amount_paid))}</p>
        <div className="space-y-4">
          <div>
            <label className="label">Amount</label>
            <input className="input" type="number" min="0" step="0.01" value={amount} onChange={(e) => setAmount(e.target.value)} />
          </div>
          <div>
            <label className="label">Method</label>
            <select className="input" value={method} onChange={(e) => setMethod(e.target.value)}>
              <option value="check">Check</option>
              <option value="cash">Cash</option>
              <option value="card_offline">Card (in office)</option>
              <option value="money_order">Money order</option>
              <option value="other">Other</option>
            </select>
          </div>
          <p className="text-xs text-stone-500">Payments allocate to the oldest charges on the statement first.</p>
          <div className="flex gap-2 justify-end pt-1">
            <button className="btn btn-ghost" onClick={onClose}>Cancel</button>
            <button className="btn btn-primary" disabled={busy} onClick={save}>{busy ? 'Saving…' : 'Record payment'}</button>
          </div>
        </div>
      </div>
    </Modal>
  );
}

function DetailModal({ id, onClose, refresh }) {
  const toast = useToast();
  const [stmt, setStmt] = useState(null);
  const [paying, setPaying] = useState(false);
  useEffect(() => { api.statements.detail(id).then(setStmt).catch((e) => toast.error(e.message)); }, [id]);
  if (!stmt) return (
    <Modal onClose={onClose}>
      <div className="p-7 space-y-3">
        <Skeleton className="h-6 w-56" />
        <Skeleton className="h-14" />
        <Skeleton className="h-14" />
        <Skeleton className="h-14" />
      </div>
    </Modal>
  );
  const [label, badge] = STATUS[stmt.status] || [stmt.status, 'badge-slate'];
  return (
    <Modal onClose={onClose} wide>
      <div className="p-7">
        <h3 className="text-xl font-bold tracking-tight mb-4">{stmt.statement_number} — {stmt.patient_name}</h3>
        <div className="space-y-4">
          <div className="flex flex-wrap gap-2 items-center">
            <span className={`badge ${badge}`}>{label}</span>
            <span className="text-sm text-stone-500">Due {fmtDate(stmt.due_date)} · Total {fmtMoney(stmt.amount_due)} · Paid {fmtMoney(stmt.amount_paid)} · <strong className="text-stone-900">Balance {fmtMoney(stmt.balance)}</strong></span>
          </div>
          <div className="overflow-x-auto">
            <table className="w-full tbl">
              <thead><tr><th>Date</th><th>Claim</th><th>Payer</th><th className="!text-right">Billed</th><th className="!text-right">Ins paid</th><th className="!text-right">Adjust</th><th className="!text-right">Patient owes</th></tr></thead>
              <tbody>
                {stmt.lines.map((l) => (
                  <tr key={l.id}>
                    <td>{fmtDate(l.service_date)}</td><td>{l.claim_number}</td><td>{l.payer_name}</td>
                    <td className="!text-right">{fmtMoney(l.billed)}</td><td className="!text-right">{fmtMoney(l.insurance_paid)}</td>
                    <td className="!text-right">{fmtMoney(l.adjustments)}</td><td className="!text-right">{fmtMoney(l.amount)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {stmt.payments?.length > 0 && (
            <div>
              <p className="label mb-1">Payments</p>
              {stmt.payments.map((p) => (
                <p key={p.id} className="text-sm text-stone-600">{fmtDate(p.created_at)} — {fmtMoney(p.amount)} ({p.method === 'stripe' ? 'Stripe (online)' : p.method})</p>
              ))}
            </div>
          )}
          {stmt.payment_link_url && stmt.status !== 'paid' && (
            <div className="flex flex-wrap items-center gap-2 bg-stone-50 border border-stone-200 rounded-xl px-4 py-3">
              <span className="text-sm font-medium text-stone-700 mr-auto">Online pay link is live on this statement</span>
              <a className="btn btn-outline !py-1.5 !text-xs" href={stmt.payment_link_url} target="_blank" rel="noreferrer">Open pay link</a>
              <button className="btn btn-ghost !py-1.5 !text-xs" onClick={() => copyLink(stmt.payment_link_url, toast)}>Copy link</button>
            </div>
          )}
          <div className="flex flex-wrap gap-2 justify-end">
            <button className="btn btn-ghost" onClick={() => downloadPdf(stmt.id, stmt.statement_number).catch((e) => toast.error(e.message))}>Download PDF</button>
            {stmt.status !== 'paid' && stmt.status !== 'void' && (
              <button className="btn btn-ghost" onClick={() => setPaying(true)}>Record payment</button>
            )}
            <button className="btn btn-primary" onClick={onClose}>Done</button>
          </div>
        </div>
      </div>
      {paying && <PayModal stmt={stmt} onClose={() => setPaying(false)} onDone={() => { setPaying(false); api.statements.detail(id).then(setStmt); refresh(); }} />}
    </Modal>
  );
}

function LoadingRows({ n = 3 }) {
  return (
    <div className="space-y-3">
      {Array.from({ length: n }).map((_, i) => <Skeleton key={i} className="h-14" />)}
    </div>
  );
}

export default function Statements() {
  const { user } = useAuth();
  const toast = useToast();
  const canWrite = ['owner', 'biller'].includes(user?.role);
  const [balances, setBalances] = useState(null);
  const [list, setList] = useState(null);
  const [detailId, setDetailId] = useState(null);
  const [payStmt, setPayStmt] = useState(null);
  const [busyId, setBusyId] = useState(null);

  const load = () => {
    api.statements.balances().then((d) => setBalances(d.patients)).catch((e) => toast.error(e.message));
    api.statements.list().then(setList).catch((e) => toast.error(e.message));
  };
  useEffect(load, []);

  const generate = (b) => {
    setBusyId(`gen-${b.patient_name}`);
    api.statements.generate({ patient_name: b.patient_name, member_id: b.member_id })
      .then((s) => { toast.success(`Statement ${s.statement_number} created`); load(); })
      .catch((e) => toast.error(e.message))
      .finally(() => setBusyId(null));
  };
  const payLink = (s) => {
    setBusyId(`link-${s.id}`);
    api.statements.paymentLink(s.id)
      .then(() => { toast.success('Payment link created — open or copy it from the statements list'); load(); })
      .catch((e) => toast.error(e.message))
      .finally(() => setBusyId(null));
  };
  const voidStmt = (s) => {
    setBusyId(`void-${s.id}`);
    api.statements.void(s.id)
      .then(() => { toast.success('Statement voided — balances released'); load(); })
      .catch((e) => toast.error(e.message))
      .finally(() => setBusyId(null));
  };

  const totalOutstanding = (balances || []).reduce((s, b) => s + b.total_due, 0);

  return (
    <div className="space-y-6">
      <PageHeader title="Patient Statements" subtitle="Bill patients for what insurance left behind — statement, PDF, and an online pay link per statement." />

      <section className="card p-4 sm:p-5">
        <div className="flex items-baseline justify-between mb-3">
          <h3 className="font-semibold">Patient balances</h3>
          <span className="text-sm text-stone-500">{balances ? `${fmtMoney(totalOutstanding)} outstanding across ${balances.length} patient(s)` : ''}</span>
        </div>
        {balances === null ? <LoadingRows /> : balances.length === 0 ? (
          <EmptyState icon="🧾" title="No patient balances" hint="When an ERA posts patient responsibility to a claim, the patient shows up here ready to bill." />
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full tbl">
              <thead><tr><th>Patient</th><th>Member ID</th><th>Claims</th><th>Oldest visit</th><th className="!text-right">Balance due</th><th /></tr></thead>
              <tbody>
                {balances.map((b) => (
                  <tr key={`${b.patient_name}-${b.member_id || ''}`}>
                    <td className="font-medium">{b.patient_name}</td>
                    <td>{b.member_id || '—'}</td>
                    <td>{b.claims}</td>
                    <td>{fmtDate(b.oldest_service_date)}</td>
                    <td className="!text-right font-semibold">{fmtMoney(b.total_due)}</td>
                    <td className="!text-right">
                      {canWrite && (
                        <button className="btn btn-primary !py-2 !text-[13px]" disabled={busyId === `gen-${b.patient_name}`} onClick={() => generate(b)}>
                          {busyId === `gen-${b.patient_name}` ? 'Creating…' : 'Create statement'}
                        </button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <section className="card p-4 sm:p-5">
        <h3 className="font-semibold mb-3">Statements</h3>
        {list === null ? <LoadingRows /> : list.length === 0 ? (
          <EmptyState icon="📄" title="No statements yet" hint="Create one from a patient balance above." />
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full tbl">
              <thead><tr><th>Statement</th><th>Patient</th><th>Created</th><th>Due date</th><th>Status</th><th className="!text-right">Total</th><th className="!text-right">Balance</th><th /></tr></thead>
              <tbody>
                {list.map((s) => {
                  const [label, badge] = STATUS[s.status] || [s.status, 'badge-slate'];
                  return (
                    <tr key={s.id}>
                      <td className="font-medium">{s.statement_number}</td>
                      <td>{s.patient_name}</td>
                      <td>{fmtDate(s.created_at)}</td>
                      <td>{fmtDate(s.due_date)}</td>
                      <td><span className={`badge ${badge}`}>{label}</span></td>
                      <td className="!text-right">{fmtMoney(s.amount_due)}</td>
                      <td className="!text-right font-semibold">{fmtMoney(s.balance)}</td>
                      <td className="!text-right whitespace-nowrap">
                        <button className="btn btn-ghost !py-1.5 !text-xs" onClick={() => setDetailId(s.id)}>View</button>
                        <button className="btn btn-ghost !py-1.5 !text-xs" onClick={() => downloadPdf(s.id, s.statement_number).catch((e) => toast.error(e.message))}>PDF</button>
                        {canWrite && s.status !== 'paid' && s.status !== 'void' && !s.payment_link_url && (
                          <button className="btn btn-ghost !py-1.5 !text-xs" disabled={busyId === `link-${s.id}`} onClick={() => payLink(s)}>
                            {busyId === `link-${s.id}` ? 'Creating…' : 'Pay link'}
                          </button>
                        )}
                        {canWrite && s.status !== 'paid' && s.status !== 'void' && s.payment_link_url && (
                          <>
                            <a className="btn btn-ghost !py-1.5 !text-xs" href={s.payment_link_url} target="_blank" rel="noreferrer">Open pay link</a>
                            <button className="btn btn-ghost !py-1.5 !text-xs" onClick={() => copyLink(s.payment_link_url, toast)}>Copy link</button>
                          </>
                        )}
                        {canWrite && s.status !== 'paid' && s.status !== 'void' && (
                          <button className="btn btn-ghost !py-1.5 !text-xs" onClick={() => setPayStmt(s)}>Record payment</button>
                        )}
                        {canWrite && s.amount_paid === 0 && s.status !== 'paid' && s.status !== 'void' && (
                          <button className="btn btn-ghost !py-1.5 !text-xs" disabled={busyId === `void-${s.id}`} onClick={() => voidStmt(s)}>Void</button>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
        <p className="text-xs text-stone-500 mt-3">
          Online payments run through Stripe — patients pay from the link on the statement PDF, and the
          statement settles itself when the payment lands. Cash and check payments can be recorded manually.
        </p>
      </section>

      {detailId && <DetailModal id={detailId} onClose={() => setDetailId(null)} refresh={load} />}
      {payStmt && <PayModal stmt={payStmt} onClose={() => setPayStmt(null)} onDone={() => { setPayStmt(null); load(); }} />}
    </div>
  );
}
