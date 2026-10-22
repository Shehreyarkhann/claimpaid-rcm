import { useState } from 'react';

// Floating quick-chat: ClaimPaid AI one tap away from anywhere in the RCM app.
const AI_URL = import.meta.env.VITE_AI_URL || 'http://localhost:4001';
const AI_SLUG = import.meta.env.VITE_AI_KB_SLUG || 'demo-northwind';

export default function FloatingChat() {
  const [open, setOpen] = useState(false);

  return (
    <>
      {open && (
        <div className="fixed bottom-24 right-6 z-50 w-[380px] h-[560px] max-h-[70vh] rounded-2xl overflow-hidden shadow-2xl border border-slate-200 bg-white flex flex-col">
          <div className="flex items-center justify-between px-4 py-3 bg-gradient-to-r from-violet-600 to-violet-700 text-white">
            <div className="flex items-center gap-2">
              <span className="text-xl">🤖</span>
              <div>
                <div className="font-bold text-sm leading-tight">ClaimPaid AI</div>
                <div className="text-[11px] opacity-80">Ask about payer policies</div>
              </div>
            </div>
            <button onClick={() => setOpen(false)} className="text-white/80 hover:text-white text-xl leading-none" aria-label="Close chat">✕</button>
          </div>
          <iframe
            src={`${AI_URL}/app/#/widget/${AI_SLUG}`}
            title="ClaimPaid AI quick chat"
            className="flex-1 w-full border-0"
          />
        </div>
      )}
      <button
        onClick={() => setOpen(!open)}
        aria-label="Chat with ClaimPaid AI"
        className="fixed bottom-6 right-6 z-50 w-14 h-14 rounded-full shadow-xl flex items-center justify-center text-2xl transition-transform hover:scale-110 active:scale-95"
        style={{ background: 'linear-gradient(135deg,#8b5cf6,#6d28d9)' }}
      >
        {open ? <span className="text-white text-xl">✕</span> : '🤖'}
      </button>
    </>
  );
}
