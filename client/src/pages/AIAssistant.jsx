import { useState } from 'react';

// ClaimPaid AI embedded as a full tab inside the RCM workspace.
// Loads the AI chat widget in a full-height frame — ask payer-policy
// questions without leaving the platform.
// ClaimPaid AI endpoint resolution:
// - VITE_AI_URL env var wins (explicit config)
// - On a deployed domain, /ai is reverse-proxied to the AI service (same URL, no CORS)
// - Local dev falls back to the AI dev server
const AI_URL = import.meta.env.VITE_AI_URL ||
  (window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1'
    ? 'http://localhost:4001'
    : `${window.location.origin}/ai`);
const AI_SLUG = import.meta.env.VITE_AI_KB_SLUG || 'payer-policy-handbook';

export default function AIAssistant() {
  const [failed, setFailed] = useState(false);
  const src = `${AI_URL}/app/#/widget/${AI_SLUG}`;

  if (failed) {
    return (
      <div className="flex flex-col items-center justify-center h-[60vh] text-center px-6">
        <div className="text-5xl mb-4">🤖</div>
        <h2 className="text-xl font-bold text-slate-800 mb-2">ClaimPaid AI isn't reachable</h2>
        <p className="text-slate-500 text-sm max-w-md">
          The AI service at <code className="bg-slate-100 px-1 rounded">{AI_URL}</code> didn't respond.
          Make sure it's running, or set <code className="bg-slate-100 px-1 rounded">VITE_AI_URL</code> to its address.
        </p>
      </div>
    );
  }

  return (
    <div className="flex flex-col h-[calc(100vh-120px)]">
      <div className="flex items-center justify-between mb-4">
        <div>
          <h1 className="text-2xl font-bold text-slate-900">🤖 ClaimPaid AI</h1>
          <p className="text-sm text-slate-500">Ask anything about payer policies, filing rules, and billing — answers cite your documents.</p>
        </div>
        <span className="text-xs font-semibold px-3 py-1 rounded-full bg-violet-100 text-violet-700">POWERED BY CLAIMPAID AI</span>
      </div>
      <div className="mb-3 flex justify-end">
        <a href={`${AI_URL}/app/`} target="_blank" rel="noreferrer" className="text-xs font-semibold text-violet-700 hover:text-violet-900">
          Open full AI dashboard → manage knowledge bases, documents & API
        </a>
      </div>
      <div className="flex-1 rounded-2xl overflow-hidden border border-slate-200 shadow-sm bg-white">
        <iframe
          src={src}
          title="ClaimPaid AI Assistant"
          className="w-full h-full border-0"
          onError={() => setFailed(true)}
        />
      </div>
    </div>
  );
}
