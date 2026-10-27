import { useState } from 'react';

// Floating quick-chat: ClaimPaid AI one tap away from anywhere in the RCM app.
// ClaimPaid AI endpoint resolution:
// - VITE_AI_URL env var wins (explicit config)
// - On a deployed domain, /ai is reverse-proxied to the AI service (same URL, no CORS)
// - Local dev falls back to the AI dev server
const AI_URL = import.meta.env.VITE_AI_URL ||
  (window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1'
    ? 'http://localhost:4001'
    : `${window.location.origin}/ai`);
const AI_SLUG = import.meta.env.VITE_AI_KB_SLUG || 'payer-policy-handbook';

export default function FloatingChat() {
  const [open, setOpen] = useState(false);

  return (
    <>
      {open && (
        <div className="fixed bottom-[168px] lg:bottom-24 right-4 lg:right-6 z-50 w-[calc(100vw-2rem)] sm:w-[380px] h-[560px] max-h-[70vh] rounded-2xl overflow-hidden shadow-2xl border border-stone-200 bg-white flex flex-col">
          <div className="flex items-center justify-between px-4 py-3 text-white" style={{ background: 'linear-gradient(135deg,#17251F,#24382E)' }}>
            <div className="flex items-center gap-2">
              <img src="/app/claimpaid-icon-reverse.webp" alt="ClaimPaid" className="w-7 h-7 rounded-lg shrink-0" />
              <div>
                <div className="wordmark font-bold text-sm leading-tight">ClaimPaid AI</div>
                <div className="text-[11px] text-stone-300">Ask about payer policies</div>
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
        className="fixed bottom-[92px] lg:bottom-6 right-4 lg:right-6 z-50 w-14 h-14 rounded-full shadow-xl flex items-center justify-center text-2xl transition-transform hover:scale-110 active:scale-95"
        style={{ background: 'linear-gradient(135deg,#10B981,#0A7A54)' }}
      >
        {open ? <span className="text-white text-xl">✕</span> : (
          <svg width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="white" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M21 11.5a8.38 8.38 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.38 8.38 0 0 1-3.8-.9L3 21l1.9-5.7a8.38 8.38 0 0 1-.9-3.8 8.5 8.5 0 0 1 4.7-7.6 8.38 8.38 0 0 1 3.8-.9h.5a8.48 8.48 0 0 1 8 8v.5z"/></svg>
        )}
      </button>
    </>
  );
}
