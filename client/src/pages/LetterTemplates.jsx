import { useEffect, useState, useRef } from 'react';
import { authFetch } from '../auth';
import { PageHeader, Skeleton } from '../components/ui';
import { useToast } from '../components/ui';

const SAMPLE = {
  patient_name: 'Jane Doe', claim_number: 'CLM-100001', service_date: '2026-09-15',
  billed_amount: '$5,183.64', denial_reason: 'Services denied as not medically necessary',
  payer: 'Aetna', cpt: '97110, 97140', icd: 'M54.5',
  auth_number: 'AUTH123456', auth_valid: '2026-09-01 through 2026-12-01',
  org_name: 'Your Billing Co.', org_phone: '(631) 555-0100', org_email: 'appeals@yourbillingco.com',
  biller_name: 'Alex Morgan', biller_email: 'alex@yourbillingco.com', today: 'October 20, 2026',
};

const SAMPLE_SIG = {
  biller_name: 'Alex Morgan', biller_email: 'alex@yourbillingco.com',
  org_name: 'Your Billing Co.', org_phone: '(631) 555-0100',
  org_email: 'appeals@yourbillingco.com', today: 'October 20, 2026',
};

function previewBody(body, sampleData = SAMPLE) {
  let out = String(body).replace(/\{\{(\w+)\}\}/g, (m, k) => sampleData[k] ?? `[${k}]`);
  out = out.replace('{{auth_section}}',
    `Prior authorization WAS obtained for these services. Authorization number ${sampleData.auth_number || ''}, valid ${sampleData.auth_valid || ''}. A copy of the authorization approval is enclosed. We request that you reprocess this claim against the valid authorization on file.\n\n`);
  return out;
}

export default function LetterTemplates() {
  const toast = useToast();
  const [data, setData] = useState(null);
  const [active, setActive] = useState('medical_necessity');
  const [body, setBody] = useState('');
  const [enclosures, setEnclosures] = useState('');
  const [showPreview, setShowPreview] = useState(false);
  const [busy, setBusy] = useState(false);
  const bodyRef = useRef(null);
  const isSig = active === 'signature';

  const load = () => {
    authFetch('/api/appeals/letter-templates').then((r) => r.json()).then((d) => {
      setData(d);
      if (active === 'signature') {
        setBody(d.signature.body);
        setEnclosures('');
      } else {
        const t = d.templates.find((t) => t.category === active) || d.templates[0];
        setActive(t.category);
        setBody(t.body);
        setEnclosures(t.enclosures.join('\n'));
      }
    }).catch((e) => toast.error(e.message));
  };
  useEffect(() => { load(); }, []);

  const select = (cat) => {
    setActive(cat);
    setShowPreview(false);
    if (cat === 'signature') {
      setBody(data.signature.body);
      setEnclosures('');
    } else {
      const t = data.templates.find((t) => t.category === cat);
      setBody(t.body);
      setEnclosures(t.enclosures.join('\n'));
    }
  };

  const insertPlaceholder = (key) => {
    const el = bodyRef.current;
    const tag = `{{${key}}}`;
    if (!el) { setBody(body + tag); return; }
    const { selectionStart, selectionEnd } = el;
    setBody(body.slice(0, selectionStart) + tag + body.slice(selectionEnd));
    setTimeout(() => { el.focus(); el.setSelectionRange(selectionStart + tag.length, selectionStart + tag.length); }, 0);
  };

  const save = async () => {
    setBusy(true);
    try {
      const res = await authFetch(`/api/appeals/letter-templates/${active}`, {
        method: 'PUT', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ body, enclosures }),
      });
      const d = await res.json();
      if (!res.ok) throw new Error(d.error);
      toast.success('Template saved — it will be used for every new letter');
      load();
    } catch (e) { toast.error(e.message); }
    finally { setBusy(false); }
  };

  const reset = async () => {
    if (!window.confirm('Reset this template to the Pulse default? Your custom version will be lost.')) return;
    try {
      const res = await authFetch(`/api/appeals/letter-templates/${active}`, { method: 'DELETE' });
      if (!res.ok) throw new Error('Reset failed');
      toast.success('Template reset to default');
      load();
    } catch (e) { toast.error(e.message); }
  };

  const current = isSig ? null : data?.templates.find((t) => t.category === active);
  const placeholders = isSig ? data?.signature_placeholders : data?.placeholders;
  const previewData = isSig ? SAMPLE_SIG : SAMPLE;

  return (
    <div>
      <PageHeader
        title="Appeal Letter Templates"
        subtitle="Customize the letters Pulse drafts — your wording is used every time, for every appeal"
      />

      {!data ? (
        <div className="grid lg:grid-cols-[240px_1fr] gap-5">
          <Skeleton className="h-64" /><Skeleton className="h-64" />
        </div>
      ) : (
        <div className="grid lg:grid-cols-[240px_1fr] gap-5 items-start">
          {/* Categories */}
          <div className="card p-3 space-y-1">
            {data.templates.map((t) => (
              <button key={t.category} onClick={() => select(t.category)}
                className={`w-full text-left px-4 py-2.5 rounded-xl text-sm font-medium transition flex items-center justify-between ${active === t.category ? 'bg-stone-900 text-white' : 'hover:bg-stone-100 text-stone-600'}`}>
                {t.label}
                {t.is_custom && <span className={`text-[10px] font-bold px-1.5 py-0.5 rounded ${active === t.category ? 'bg-emerald-500/30 text-emerald-200' : 'bg-emerald-100 text-emerald-700'}`}>CUSTOM</span>}
              </button>
            ))}
            <div className="border-t border-stone-100 my-2" />
            <button onClick={() => select('signature')}
              className={`w-full text-left px-4 py-2.5 rounded-xl text-sm font-medium transition flex items-center justify-between ${isSig ? 'bg-stone-900 text-white' : 'hover:bg-stone-100 text-stone-600'}`}>
              <span>✒️ Signature block</span>
              {data.signature.is_custom && <span className={`text-[10px] font-bold px-1.5 py-0.5 rounded ${isSig ? 'bg-emerald-500/30 text-emerald-200' : 'bg-emerald-100 text-emerald-700'}`}>CUSTOM</span>}
            </button>
          </div>

          {/* Editor */}
          <div className="card p-6">
            <div className="flex items-center justify-between mb-1">
              <h3 className="font-bold text-lg">{isSig ? 'Signature block' : current?.label}</h3>
              {(isSig ? data.signature.is_custom : current?.is_custom)
                ? <span className="badge badge-green">Customized</span>
                : <span className="badge badge-slate">Pulse default</span>}
            </div>
            <p className="text-sm text-stone-500 mb-5">
              {isSig
                ? 'This appears at the end of every appeal letter, after the enclosures. Add your email, title, direct line — whatever your organization uses.'
                : 'This is the argument section of the letter. The letterhead, claim details, and signature are filled in automatically.'}
            </p>

            <label className="label">{isSig ? 'Signature' : 'Letter body'}</label>
            <textarea ref={bodyRef} value={body} onChange={(e) => setBody(e.target.value)}
              className={`input min-h-[220px] ${isSig ? '' : 'font-serif !leading-relaxed'} mb-3`} />

            <label className="label">Insert placeholder</label>
            <div className="flex flex-wrap gap-1.5 mb-5">
              {placeholders.map(([key, desc]) => (
                <button key={key} title={desc} onClick={() => insertPlaceholder(key)}
                  className="text-[11px] font-mono bg-amber-50 hover:bg-amber-100 text-amber-700 border border-amber-200 rounded-lg px-2 py-1 transition">
                  {`{{${key}}}`}
                </button>
              ))}
              {!isSig && (
                <button title="Conditional: shows auth details when a linked auth exists, retro-auth request text otherwise"
                  onClick={() => insertPlaceholder('auth_section')}
                  className="text-[11px] font-mono bg-amber-50 hover:bg-amber-100 text-amber-800 border border-amber-200 rounded-lg px-2 py-1 transition">
                  {'{{auth_section}}'}
                </button>
              )}
            </div>

            {!isSig && (
              <>
                <label className="label">Enclosures <span className="font-normal text-stone-400">(one per line)</span></label>
                <textarea value={enclosures} onChange={(e) => setEnclosures(e.target.value)}
                  className="input min-h-[90px] mb-5" />
              </>
            )}

            <div className="flex flex-wrap gap-2 mb-6">
              <button className="btn btn-primary" disabled={busy} onClick={save}>{busy ? 'Saving…' : isSig ? 'Save signature' : 'Save template'}</button>
              <button className="btn btn-outline" onClick={() => setShowPreview(!showPreview)}>
                {showPreview ? 'Hide preview' : '👁 Preview with sample data'}
              </button>
              {((isSig && data.signature.is_custom) || (!isSig && current?.is_custom)) && (
                <button className="btn btn-ghost !text-rose-600" onClick={reset}>Reset to default</button>
              )}
            </div>

            {showPreview && (
              <div className="border border-stone-200 rounded-2xl overflow-hidden">
                <div className="bg-stone-100 px-5 py-2.5 text-xs font-semibold text-stone-500 uppercase tracking-wide">
                  Preview — sample data
                </div>
                <pre className={`whitespace-pre-wrap text-[13px] leading-relaxed text-stone-700 px-6 py-5 bg-white max-h-[320px] overflow-y-auto ${isSig ? '' : 'font-serif'}`}>
                  {previewBody(body, previewData)}
                  {!isSig && '\n\nEnclosures:\n' + enclosures.split('\n').map((e) => e.trim()).filter(Boolean).map((e, i) => `  ${i + 1}. ${e}`).join('\n')}
                </pre>
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
