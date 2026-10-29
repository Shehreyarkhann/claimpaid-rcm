'use strict';
// Agent model pricing — ONE config spot (deploy #101) for the /super
// health cost estimate. Prices are per 1M tokens for the Haiku-class
// model the agent runs (AGENT_MODEL). These are ESTIMATES for internal
// cost visibility only: the health tab labels them as such, and nothing
// customer-facing ever reads this file.
const AGENT_PRICING = {
  model_label: 'Haiku-class (agent default)',
  input_per_mtok_usd: 1.0,
  output_per_mtok_usd: 5.0,
};

function estimateCostUsd(inputTokens, outputTokens) {
  const usd = ((Number(inputTokens) || 0) / 1e6) * AGENT_PRICING.input_per_mtok_usd
    + ((Number(outputTokens) || 0) / 1e6) * AGENT_PRICING.output_per_mtok_usd;
  return Math.round(usd * 10000) / 10000;
}

module.exports = { AGENT_PRICING, estimateCostUsd };
