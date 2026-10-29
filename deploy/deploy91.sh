#!/usr/bin/env bash
# Deploy #91: Landing visual elevation + platform accordion. Copy is
# unchanged (verified by a word-level text diff vs #90 -- the only text
# differences are the payer marquee and the accordion index numerals).
# (A) The #platform section's 4 clusters become a single-open accordion:
# real <button> headers (index numeral, title, benefit line, plus icon
# that rotates on open) with aria-expanded/aria-controls, bodies animated
# via the grid-template-rows 0fr->1fr technique so content stays in the
# DOM; first panel open by default; the collapsed state is gated on a
# JS-added .js class, so with JS disabled every panel renders open.
# Feature rows stagger in on open (reduced-motion safe). (B) Visual pass:
# faint paid-stamp watermark + slow float in the hero, rAF parallax on
# the floating claim cards, the hero payer marquee replaced with the
# factual "Timely-filing rules built in for" band (the 7 payers whose
# rules ship in the product; slows to 48s, pauses on hover, static under
# reduced motion), #agent and #audit sections get the deep green-charcoal
# dark-band treatment (colors only -- same words), problem-card numbers
# join the count-up system, global :focus-visible rings, footer gains
# the stamp mark. All animation respects prefers-reduced-motion.
set -euo pipefail
export DOMAIN=claimpaid.io
export REPO_URL=https://github.com/Shehreyarkhann/claimpaid-rcm.git
export AI_REPO_URL=https://github.com/Shehreyarkhann/claimpaid-ai.git
export BRANCH=main
cd /tmp
curl -fsSL https://raw.githubusercontent.com/Shehreyarkhann/claimpaid-rcm/main/deploy/vps-setup.sh -o vps-setup91.sh
nohup bash vps-setup91.sh > /tmp/deploy91.log 2>&1 &
echo "deploy91 started, log: /tmp/deploy91.log"
