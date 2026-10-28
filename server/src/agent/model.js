'use strict';
// Model client for the in-app agent — PROVIDER CONFIG-SWAPPABLE by env alone.
//
// One canonical tool-use loop (runTurn) drives two wire formats:
//   1. Anthropic native (default): POST https://api.anthropic.com/v1/messages
//      with the x-api-key header + anthropic-version.
//   2. OpenAI-compatible (when AGENT_BASE_URL is set): POST
//      {AGENT_BASE_URL}/chat/completions with a Bearer key — DeepSeek / Grok /
//      any OpenAI-shaped endpoint drops in by configuration, no code change.
//
// Config surface (env ONLY; keys are never logged, never hardcoded):
//   AGENT_MODEL    model id. Defaults: 'claude-sonnet-5-5' (native) or
//                  'deepseek-chat' (when AGENT_BASE_URL is set). NOTE: the
//                  native default must name a model the account can call at
//                  enable time — override via AGENT_MODEL when it can't.
//   AGENT_API_KEY  generic provider key. Native mode falls back to
//                  ANTHROPIC_API_KEY; compat mode prefers AGENT_API_KEY.
//   AGENT_BASE_URL presence selects the OpenAI-compatible transport.
//   AGENT_TRANSPORT_MODULE (tests only): absolute path to a module exporting
//                  a canonical transport function — deploy/agent-test.cjs
//                  points it at a scripted fake so the suite never needs a
//                  real key or network.
//
// Canonical shapes used between runTurn and every transport:
//   message  { role:'user'|'assistant', content:'text' }
//            { role:'assistant', content:'text', toolCalls:[{id,name,input}] }
//            { role:'user', toolResults:[{id, output:'json string', isError}] }
//   response { text:'', toolCalls:[{id,name,input}], stopReason,
//              usage?: { inputTokens, outputTokens } }
//   tool def { name, description, input_schema }  (JSON Schema, Anthropic-style;
//              adapters translate to each provider's dialect)
// runTurn accumulates per-call usage across tool iterations and returns it
// as result.usage { inputTokens, outputTokens, calls } — the metering layer
// (server/src/usage.js) counts COMPLETED turns from that. Transports that
// report no usage (scripted test fakes may omit it) count as zeros.

const ANTHROPIC_URL = 'https://api.anthropic.com/v1/messages';
const ANTHROPIC_VERSION = '2023-06-01';
const REQUEST_TIMEOUT_MS = 60 * 1000;
const MAX_TOOL_ITERATIONS = 6;

function resolveProviderConfig(env = process.env) {
  const baseUrl = String(env.AGENT_BASE_URL || '').trim().replace(/\/+$/, '');
  const apiKey = String(env.AGENT_API_KEY || env.ANTHROPIC_API_KEY || '').trim();
  const model = String(env.AGENT_MODEL || '').trim() || (baseUrl ? 'deepseek-chat' : 'claude-sonnet-5-5');
  return {
    provider: baseUrl ? 'openai-compatible' : 'anthropic',
    baseUrl: baseUrl || null,
    apiKey,
    model,
    timeoutMs: REQUEST_TIMEOUT_MS,
  };
}

// ---------- Anthropic dialect (pure conversions — unit-tested) ----------

function buildAnthropicRequest({ system, messages, tools, model, maxTokens }) {
  const out = [];
  for (const m of messages) {
    if (m.toolResults) {
      out.push({
        role: 'user',
        content: m.toolResults.map((r) => ({
          type: 'tool_result',
          tool_use_id: r.id,
          content: r.output,
          ...(r.isError ? { is_error: true } : {}),
        })),
      });
    } else if (m.toolCalls && m.toolCalls.length) {
      const blocks = [];
      if (m.content) blocks.push({ type: 'text', text: m.content });
      for (const tc of m.toolCalls) blocks.push({ type: 'tool_use', id: tc.id, name: tc.name, input: tc.input || {} });
      out.push({ role: 'assistant', content: blocks });
    } else {
      out.push({ role: m.role, content: m.content || '' });
    }
  }
  const body = { model, max_tokens: maxTokens, system, messages: out };
  if (tools && tools.length) {
    body.tools = tools.map((t) => ({ name: t.name, description: t.description, input_schema: t.input_schema }));
  }
  return body;
}

function parseAnthropicResponse(json) {
  const blocks = Array.isArray(json && json.content) ? json.content : [];
  const text = blocks.filter((b) => b.type === 'text').map((b) => b.text || '').join('');
  const toolCalls = blocks
    .filter((b) => b.type === 'tool_use')
    .map((b) => ({ id: b.id, name: b.name, input: b.input || {} }));
  const u = (json && json.usage) || {};
  return {
    text,
    toolCalls,
    stopReason: json && json.stop_reason,
    usage: { inputTokens: u.input_tokens || 0, outputTokens: u.output_tokens || 0 },
  };
}

// ---------- OpenAI-compatible dialect (pure conversions — unit-tested) ----------

function buildOpenAiRequest({ system, messages, tools, model, maxTokens }) {
  const out = [{ role: 'system', content: system }];
  for (const m of messages) {
    if (m.toolResults) {
      for (const r of m.toolResults) out.push({ role: 'tool', tool_call_id: r.id, content: r.output });
    } else if (m.toolCalls && m.toolCalls.length) {
      out.push({
        role: 'assistant',
        content: m.content || null,
        tool_calls: m.toolCalls.map((tc) => ({
          id: tc.id,
          type: 'function',
          function: { name: tc.name, arguments: JSON.stringify(tc.input || {}) },
        })),
      });
    } else {
      out.push({ role: m.role, content: m.content || '' });
    }
  }
  const body = { model, max_tokens: maxTokens, messages: out };
  if (tools && tools.length) {
    body.tools = tools.map((t) => ({
      type: 'function',
      function: { name: t.name, description: t.description, parameters: t.input_schema },
    }));
    body.tool_choice = 'auto';
  }
  return body;
}

function safeParseArgs(args) {
  if (args == null) return {};
  if (typeof args === 'object') return args;
  try { return JSON.parse(args); } catch { return {}; }
}

function parseOpenAiResponse(json) {
  const msg = (json && json.choices && json.choices[0] && json.choices[0].message) || {};
  const toolCalls = (Array.isArray(msg.tool_calls) ? msg.tool_calls : []).map((tc) => ({
    id: tc.id,
    name: tc.function && tc.function.name,
    input: safeParseArgs(tc.function && tc.function.arguments),
  }));
  const u = (json && json.usage) || {};
  return {
    text: typeof msg.content === 'string' ? msg.content : '',
    toolCalls,
    stopReason: json && json.choices && json.choices[0] && json.choices[0].finish_reason,
    usage: {
      inputTokens: u.prompt_tokens ?? u.input_tokens ?? 0,
      outputTokens: u.completion_tokens ?? u.output_tokens ?? 0,
    },
  };
}

// ---------- Real transports (network) ----------

async function postJson(url, headers, body, timeoutMs) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      method: 'POST',
      signal: ctrl.signal,
      headers: { 'content-type': 'application/json', ...headers },
      body: JSON.stringify(body),
    });
    const text = await res.text();
    if (!res.ok) {
      const err = new Error(`Model provider returned HTTP ${res.status}: ${text.slice(0, 200)}`);
      err.status = res.status;
      throw err;
    }
    try { return JSON.parse(text); } catch { throw new Error('Model provider returned a non-JSON response'); }
  } finally {
    clearTimeout(timer);
  }
}

function anthropicTransport(cfg) {
  return async ({ system, messages, tools, model, maxTokens }) => {
    const body = buildAnthropicRequest({ system, messages, tools, model: model || cfg.model, maxTokens });
    const json = await postJson(
      ANTHROPIC_URL,
      { 'x-api-key': cfg.apiKey, 'anthropic-version': ANTHROPIC_VERSION },
      body,
      cfg.timeoutMs,
    );
    return parseAnthropicResponse(json);
  };
}

function openAiTransport(cfg) {
  return async ({ system, messages, tools, model, maxTokens }) => {
    const body = buildOpenAiRequest({ system, messages, tools, model: model || cfg.model, maxTokens });
    const json = await postJson(
      `${cfg.baseUrl}/chat/completions`,
      { authorization: `Bearer ${cfg.apiKey}` },
      body,
      cfg.timeoutMs,
    );
    return parseOpenAiResponse(json);
  };
}

// Resolve the transport for this process: test-module override first, then
// the provider selected by config. Resolved per call so env changes on
// restart are always honored.
function createTransport(env = process.env) {
  const modPath = String(env.AGENT_TRANSPORT_MODULE || '').trim();
  if (modPath) {
    const m = require(modPath);
    const fn = (m && (m.transport || m.default)) || m;
    if (typeof fn !== 'function') throw new Error('AGENT_TRANSPORT_MODULE does not export a transport function');
    return fn;
  }
  const cfg = resolveProviderConfig(env);
  return cfg.baseUrl ? openAiTransport(cfg) : anthropicTransport(cfg);
}

// ---------- The canonical tool-use loop ----------
// history: prior turns as [{role, content}] plain text. executeTool(name,
// input) must resolve to { output, isError?, event, action? } and never
// throw (tool implementations convert their own errors into isError results
// so the model can recover and explain).
async function runTurn({ system, history = [], userText, tools = [], executeTool, transport, model, maxTokens = 2048 }) {
  const t = transport || createTransport();
  const messages = [
    ...history.filter((m) => m && (m.role === 'user' || m.role === 'assistant') && m.content)
      .map((m) => ({ role: m.role, content: String(m.content) })),
    { role: 'user', content: userText },
  ];
  const toolEvents = [];
  const actions = [];
  const usage = { inputTokens: 0, outputTokens: 0, calls: 0 };
  let lastText = '';

  for (let i = 0; i < MAX_TOOL_ITERATIONS; i++) {
    const resp = await t({ system, messages, tools, model, maxTokens });
    usage.calls += 1;
    if (resp.usage) {
      usage.inputTokens += resp.usage.inputTokens ?? resp.usage.input_tokens ?? 0;
      usage.outputTokens += resp.usage.outputTokens ?? resp.usage.output_tokens ?? 0;
    }
    if (resp.text) lastText = resp.text;
    if (!resp.toolCalls || resp.toolCalls.length === 0) {
      return { reply: resp.text || lastText || '', toolEvents, actions, usage };
    }
    messages.push({ role: 'assistant', content: resp.text || '', toolCalls: resp.toolCalls });
    const results = [];
    for (const call of resp.toolCalls) {
      const r = await executeTool(call.name, call.input || {});
      if (r.event) toolEvents.push(r.event);
      if (r.action) actions.push(r.action);
      results.push({
        id: call.id,
        output: typeof r.output === 'string' ? r.output : JSON.stringify(r.output ?? {}),
        isError: !!r.isError,
      });
    }
    messages.push({ role: 'user', toolResults: results });
    if (i === MAX_TOOL_ITERATIONS - 1) {
      return {
        reply: lastText || 'I started that but hit the step limit before finishing — the work so far is above, and you can ask me to continue.',
        toolEvents,
        actions,
        usage,
        truncated: true,
      };
    }
  }
  return { reply: lastText, toolEvents, actions, usage };
}

module.exports = {
  resolveProviderConfig,
  buildAnthropicRequest,
  parseAnthropicResponse,
  buildOpenAiRequest,
  parseOpenAiResponse,
  createTransport,
  runTurn,
  MAX_TOOL_ITERATIONS,
};
