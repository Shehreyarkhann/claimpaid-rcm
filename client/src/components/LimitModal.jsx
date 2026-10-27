import { Modal } from './ui';

// Friendly "plan limit hit" modal, shown when any API call answers 402 with
// claim_limit_reached / seat_limit_reached / ai_query_limit_reached.
// Wired in App.jsx via the 'plan-limit' window event dispatched by api.js.
const NOUNS = {
  claim_limit_reached: 'claims',
  seat_limit_reached: 'team seats',
  ai_query_limit_reached: 'AI queries',
};

const PLAN_LABELS = {
  starter: 'RCM Starter',
  pro: 'RCM Pro + AI',
  ai: 'ClaimPaid AI',
  enterprise: 'Enterprise',
};

function fmtLimit(limit) {
  if (limit === null || limit === undefined) return 'unlimited';
  return Number(limit).toLocaleString('en-US');
}

export default function LimitModal({ info, onClose, onUpgrade }) {
  const planLabel = info.planLabel || PLAN_LABELS[info.plan] || 'your';
  const noun = NOUNS[info.error] || 'usage';
  return (
    <Modal onClose={onClose}>
      <div className="p-8 text-center">
        <div className="w-14 h-14 mx-auto rounded-2xl bg-amber-100 text-amber-600 flex items-center justify-center text-2xl mb-4">
          ⚠
        </div>
        <h2 className="text-xl font-bold text-stone-900 mb-2">
          You've hit your {planLabel} limit
        </h2>
        <p className="text-sm text-stone-500 mb-1">
          You've used <strong className="text-stone-800">{Number(info.used || 0).toLocaleString('en-US')}</strong> of{' '}
          <strong className="text-stone-800">{fmtLimit(info.limit)}</strong> {noun} this month.
        </p>
        <p className="text-sm text-stone-500 mb-6">
          Upgrade your plan to keep working without interruption.
        </p>
        <div className="flex gap-3 justify-center">
          <button onClick={onUpgrade} className="btn btn-primary !px-6">
            Upgrade plan →
          </button>
          <button onClick={onClose} className="btn btn-outline !px-6">
            Not now
          </button>
        </div>
      </div>
    </Modal>
  );
}
