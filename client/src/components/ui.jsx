import { createContext, useContext, useState, useCallback, useEffect } from 'react';
import { createPortal } from 'react-dom';

const ToastContext = createContext(null);
export const useToast = () => useContext(ToastContext);

let idCounter = 0;

export function ToastProvider({ children }) {
  const [toasts, setToasts] = useState([]);

  const push = useCallback((message, type = 'success') => {
    const id = ++idCounter;
    setToasts((t) => [...t, { id, message, type }]);
    setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), 3800);
  }, []);

  const toast = {
    success: (m) => push(m, 'success'),
    error: (m) => push(m, 'error'),
    info: (m) => push(m, 'info'),
  };

  return (
    <ToastContext.Provider value={toast}>
      {children}
      <div className="fixed bottom-6 right-6 z-[100] flex flex-col gap-2 items-end">
        {toasts.map((t) => (
          <div key={t.id} className={`toast flex items-center gap-2.5 pl-3 pr-4 py-3 rounded-xl shadow-lg text-sm font-medium text-white max-w-sm
            ${t.type === 'success' ? 'bg-stone-900' : t.type === 'error' ? 'bg-rose-600' : 'bg-amber-700'}`}>
            <span className={`w-6 h-6 rounded-full flex items-center justify-center text-xs shrink-0
              ${t.type === 'success' ? 'bg-emerald-500' : t.type === 'error' ? 'bg-white/25' : 'bg-white/25'}`}>
              {t.type === 'success' ? '✓' : t.type === 'error' ? '!' : 'i'}
            </span>
            {t.message}
          </div>
        ))}
      </div>
    </ToastContext.Provider>
  );
}

export function Modal({ onClose, children, wide }) {
  // Portal to <body>: a plain fixed inset-0 render is laid out against the
  // nearest TRANSFORMED ancestor, not the viewport — and the app sidebar
  // always carries a Tailwind translate transform. Modals mounted inside the
  // sidebar subtree (the account modal in the collapsed rail) were trapped
  // inside the sidebar's box and clipped. Portaling makes every modal a
  // true app-level overlay at any mount point.
  return createPortal(
    <div className="modal-backdrop fixed inset-0 bg-stone-900/50 backdrop-blur-[2px] flex items-center justify-center z-50 p-2 sm:p-4" onClick={onClose}>
      <div className={`modal-panel bg-white rounded-2xl shadow-2xl w-full ${wide ? 'max-w-3xl' : 'max-w-lg'} max-h-[90vh] overflow-y-auto`} onClick={(e) => e.stopPropagation()}>
        {children}
      </div>
    </div>,
    document.body
  );
}

// Themed confirmation dialog — the app-wide replacement for window.confirm.
// Call sites: if (!(await confirmDialog({ title, body, confirmLabel }))) return;
// App.jsx (and the super-admin gate) mount <ConfirmHost /> once.
let confirmSetter = null;
export function confirmDialog(opts = {}) {
  return new Promise((resolve) => {
    if (!confirmSetter) { // host not mounted (shouldn't happen) — fail closed to native
      resolve(window.confirm(opts.body || opts.title || 'Are you sure?'));
      return;
    }
    confirmSetter({ ...opts, resolve });
  });
}

export function ConfirmHost() {
  const [pending, setPending] = useState(null);
  useEffect(() => {
    confirmSetter = setPending;
    return () => { confirmSetter = null; };
  }, []);
  if (!pending) return null;
  const done = (v) => { pending.resolve(v); setPending(null); };
  return (
    <Modal onClose={() => done(false)}>
      <div className="p-7">
        <h3 className="text-xl font-bold tracking-tight mb-2">{pending.title || 'Are you sure?'}</h3>
        {pending.body && <p className="text-sm text-stone-600 mb-6">{pending.body}</p>}
        <div className="flex justify-end gap-2">
          <button className="btn btn-ghost" onClick={() => done(false)}>{pending.cancelLabel || 'Cancel'}</button>
          <button className="btn !bg-rose-600 hover:!bg-rose-700 !text-white" onClick={() => done(true)}>
            {pending.confirmLabel || 'Confirm'}
          </button>
        </div>
      </div>
    </Modal>
  );
}

export function Skeleton({ className = '' }) {
  return <div className={`skeleton ${className}`} />;
}

export function EmptyState({ icon, title, hint, action }) {
  return (
    <div className="flex flex-col items-center justify-center py-16 px-6 text-center">
      <div className="w-14 h-14 rounded-2xl bg-stone-100 flex items-center justify-center text-2xl mb-4">{icon}</div>
      <div className="font-semibold text-stone-800">{title}</div>
      {hint && <div className="text-sm text-stone-500 mt-1 max-w-sm">{hint}</div>}
      {action && <div className="mt-4">{action}</div>}
    </div>
  );
}

export function PageHeader({ title, subtitle, actions }) {
  return (
    <div className="flex flex-wrap items-start justify-between gap-4 mb-6">
      <div>
        <h1 className="text-2xl font-bold text-stone-900 tracking-tight">{title}</h1>
        {subtitle && <p className="text-sm text-stone-500 mt-1">{subtitle}</p>}
      </div>
      {actions && <div className="flex gap-2 flex-wrap">{actions}</div>}
    </div>
  );
}
