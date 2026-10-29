import { useEffect, useState } from 'react';
import { api } from '../api';
import { useAuth } from '../auth';
import { useToast } from './ui';

// First-run activation checklist (Deploy #101, WS-D). State is DERIVED
// on the server from the workspace's real data — nothing here is a
// fake stat: claims exist, an audit has run, a brief exists, and one
// approval was decided (or a manual appeal created). The card hides
// when the path is complete and the owner can dismiss it. Framed
// honestly: this is the path to the first recovered dollar.
export default function ActivationChecklist({ onNavigate }) {
  const { user } = useAuth();
  const toast = useToast();
  const [data, setData] = useState(null);
  const [hidden, setHidden] = useState(false);
  const isOwner = user?.role === 'owner';

  useEffect(() => {
    let alive = true;
    api.agent.checklist()
      .then((d) => { if (alive) setData(d); })
      .catch(() => { if (alive) setData({ error: true }); });
    return () => { alive = false; };
  }, []);

  const dismiss = async () => {
    try {
      await api.agent.dismissChecklist();
      setHidden(true);
    } catch (e) {
      toast.error(e.message || 'Could not dismiss the checklist');
    }
  };

  const steps = data && Array.isArray(data.steps) ? data.steps : [];
  if (!data || data.error || data.complete || data.dismissed || hidden || steps.length === 0) return null;

  const doneCount = steps.filter((s) => s.done).length;
  return (
    <div className="card p-5 mb-6 !border-emerald-200 bg-gradient-to-r from-emerald-50/70 to-[#FFFDF8]" data-testid="activation-checklist">
      <div className="flex items-start gap-3 flex-wrap">
        <div className="min-w-0 flex-1">
          <div className="text-[10px] font-semibold uppercase tracking-widest text-emerald-700">Getting started</div>
          <h3 className="font-serif text-lg font-semibold text-stone-900">Your path to the first recovered dollar</h3>
          <p className="text-sm text-stone-500 mt-0.5">
            Four steps between this workspace and money back from a payer. {doneCount} of {steps.length} done.
          </p>
        </div>
        <div className="flex items-center gap-2 shrink-0">
          <div className="w-28 h-2 rounded-full bg-stone-200 overflow-hidden">
            <div className="h-full bg-emerald-500 rounded-full" style={{ width: `${(doneCount / steps.length) * 100}%` }} />
          </div>
          {isOwner && (
            <button type="button" className="btn btn-ghost btn-sm !text-stone-400" onClick={dismiss}>Dismiss</button>
          )}
        </div>
      </div>
      <ol className="mt-4 space-y-2">
        {steps.map((s, i) => (
          <li key={s.key} className="flex items-center gap-3 rounded-xl bg-white/70 ring-1 ring-stone-200/60 px-3.5 py-2.5">
            <span className={`w-6 h-6 rounded-full flex items-center justify-center text-xs font-bold shrink-0 ${s.done ? 'bg-emerald-500 text-white' : 'bg-stone-200 text-stone-500'}`}>
              {s.done ? '✓' : i + 1}
            </span>
            <span className="min-w-0 flex-1">
              <span className={`block text-sm font-medium ${s.done ? 'text-stone-400 line-through' : 'text-stone-800'}`}>{s.label}</span>
              {!s.done && <span className="block text-xs text-stone-400">{s.hint}</span>}
            </span>
            {!s.done && (
              <button type="button" className="btn btn-primary btn-sm shrink-0" onClick={() => onNavigate && onNavigate(s.target)}>
                Go →
              </button>
            )}
          </li>
        ))}
      </ol>
    </div>
  );
}
