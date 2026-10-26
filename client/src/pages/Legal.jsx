import { useEffect, useState } from 'react';

// Minimal markdown renderer for our legal docs (headings, bold, lists, tables, hr, paragraphs)
function renderInline(text) {
  const parts = text.split(/(\*\*[^*]+\*\*)/g);
  return parts.map((p, i) =>
    p.startsWith('**') && p.endsWith('**') && p.length > 4
      ? <strong key={i} className="font-semibold text-stone-200">{p.slice(2, -2)}</strong>
      : <span key={i}>{p}</span>
  );
}

function Markdown({ text }) {
  const lines = text.split('\n');
  const blocks = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (/^#{1,3}\s/.test(line)) {
      const level = line.match(/^#+/)[0].length;
      const content = line.replace(/^#+\s*/, '');
      const Tag = level === 1 ? 'h1' : level === 2 ? 'h2' : 'h3';
      const cls = level === 1
        ? 'text-2xl font-extrabold text-white tracking-tight mt-2 mb-4'
        : level === 2
          ? 'text-lg font-bold text-white mt-8 mb-3'
          : 'text-base font-semibold text-stone-200 mt-6 mb-2';
      blocks.push(<Tag key={i} className={cls}>{renderInline(content)}</Tag>);
      i++;
    } else if (/^\s*---\s*$/.test(line)) {
      blocks.push(<hr key={i} className="border-stone-800 my-6" />);
      i++;
    } else if (/^\s*-\s+/.test(line)) {
      const items = [];
      while (i < lines.length && /^\s*-\s+/.test(lines[i])) {
        items.push(lines[i].replace(/^\s*-\s+/, ''));
        i++;
      }
      blocks.push(
        <ul key={i} className="list-disc pl-6 space-y-1.5 text-stone-300 text-[15px] leading-relaxed my-3">
          {items.map((it, j) => <li key={j}>{renderInline(it)}</li>)}
        </ul>
      );
    } else if (/^\s*\|.*\|\s*$/.test(line)) {
      const rows = [];
      while (i < lines.length && /^\s*\|.*\|\s*$/.test(lines[i])) {
        rows.push(lines[i].trim());
        i++;
      }
      const cells = (r) => r.split('|').slice(1, -1).map((c) => c.trim());
      const isSep = (r) => /^[\s|:-]+$/.test(r);
      const body = rows.filter((r) => !isSep(r));
      const head = body[0] ? cells(body[0]) : [];
      blocks.push(
        <div key={i} className="overflow-x-auto my-4 rounded-xl border border-stone-800">
          <table className="w-full text-sm">
            <thead><tr className="bg-stone-800/60">
              {head.map((h, j) => <th key={j} className="text-left px-4 py-2.5 text-stone-300 font-semibold">{renderInline(h)}</th>)}
            </tr></thead>
            <tbody>
              {body.slice(1).map((r, ri) => (
                <tr key={ri} className="border-t border-stone-800">
                  {cells(r).map((c, ci) => <td key={ci} className="px-4 py-2.5 text-stone-400">{renderInline(c)}</td>)}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      );
    } else if (line.trim() === '') {
      i++;
    } else {
      const paras = [];
      while (i < lines.length && lines[i].trim() !== '' && !/^(#{1,3}\s|---\s*$|\s*-\s+|\s*\|)/.test(lines[i])) {
        paras.push(lines[i]);
        i++;
      }
      blocks.push(<p key={i} className="text-stone-300 text-[15px] leading-relaxed my-3">{renderInline(paras.join(' '))}</p>);
    }
  }
  return <div>{blocks}</div>;
}

export default function Legal({ doc = 'terms' }) {
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);

  useEffect(() => {
    fetch('/api/legal/documents')
      .then((r) => { if (!r.ok) throw new Error('Could not load document'); return r.json(); })
      .then(setData)
      .catch((e) => setError(e.message));
  }, []);

  const title = doc === 'privacy' ? 'Privacy Policy' : 'Terms of Service';
  const text = data?.[doc]?.text;
  const version = data?.[doc]?.version;

  return (
    <div className="min-h-screen bg-[#17251F] px-6 py-12">
      <div className="max-w-3xl mx-auto">
        <div className="flex items-center gap-3 mb-8">
          <div className="w-10 h-10 rounded-xl bg-emerald-500 flex items-center justify-center font-extrabold text-[#17251F] text-lg">C</div>
          <div>
            <div className="text-white font-bold">ClaimPaid</div>
            <div className="text-stone-500 text-xs">claimpaid.io</div>
          </div>
        </div>

        <div className="flex items-center gap-3 mb-6">
          <a href="/legal/terms" className={`text-sm px-4 py-2 rounded-xl transition ${doc === 'terms' ? 'bg-emerald-500/15 text-emerald-300 border border-emerald-500/30' : 'text-stone-400 hover:text-white'}`}>Terms</a>
          <a href="/legal/privacy" className={`text-sm px-4 py-2 rounded-xl transition ${doc === 'privacy' ? 'bg-emerald-500/15 text-emerald-300 border border-emerald-500/30' : 'text-stone-400 hover:text-white'}`}>Privacy</a>
        </div>

        {error && <div className="text-rose-300 bg-rose-950/60 border border-rose-800 rounded-xl px-4 py-3 text-sm">{error}</div>}
        {!data && !error && <div className="text-stone-500 text-sm">Loading…</div>}
        {data && (
          <div className="bg-stone-900 border border-stone-800 rounded-2xl p-8">
            {version && (
              <div className="mb-4 flex items-center gap-2">
                <span className="text-[11px] font-mono bg-stone-800 text-stone-400 px-2 py-0.5 rounded">{version}</span>
                <span className="text-[11px] text-amber-300/90">Draft pending attorney review</span>
              </div>
            )}
            <Markdown text={text || ''} />
          </div>
        )}

        <div className="mt-8 text-center text-xs text-stone-500">
          <a href="/app/" className="hover:text-stone-300 hover:underline">Back to the app</a>
          {' · '}<a href="/support" className="hover:text-stone-300 hover:underline">Support</a>
        </div>
      </div>
    </div>
  );
}
