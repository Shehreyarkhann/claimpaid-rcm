# Render smoke-test gate for vps-setup.sh — READY TO APPLY (after deploy8 finishes)
#
# WHAT: inserts a fail-closed render smoke test into the deploy pipeline, fulfilling
# the 2026-10-22 commitment ("a broken build can never ship silently again").
# Today deploy7 shipped a bundle that passed `npm run build` but blank-screened
# /app for every logged-in user (useState without import). This gate would have
# aborted that deploy BEFORE services restarted, leaving the last good build live.
#
# VALIDATION (2026-10-22, local):
#   - Fixed build  -> PASS (logged-out + logged-in render, asset refs correct)
#   - Bug reintroduced (import removed) -> FAIL "logged-in render left #root empty
#     (blank screen)", exit 1, with `ReferenceError: useState is not defined`
#   - AI client   -> PASS (renders, /ai/app/ asset base correct)
#
# WHERE: in deploy/vps-setup.sh, insert the block below immediately AFTER the
# "# ---------- build ----------" section's closing quote, i.e. after this line:
#     "
# and BEFORE this line:
#     # ---------- .env (preserves existing secrets on re-run) ----------
#
# The block aborts (exit 1) before `systemctl restart` (line ~275), so a failed
# smoke test leaves the previous working build serving.
#
# ALSO REQUIRED: commit + push deploy/render-smoke-test.cjs alongside this edit —
# the droplet pulls it via `git pull --ff-only` and the gate references it at
# ${APP_DIR}/deploy/render-smoke-test.cjs. If the file is missing on the droplet,
# the gate refuses to deploy blind (fail-closed).
#
# DROPLET DEPENDENCY: jsdom, installed once globally by the block itself
# (`npm install -g jsdom` if missing). No other new dependencies.
#
# --- BEGIN BLOCK (paste verbatim, keep the "# ----------" header style) ---

# ---------- render smoke test (fail-closed blank-screen guard) ----------
echo "==> Render smoke test (blank-screen guard)"
if [[ ! -d "$(npm root -g)/jsdom" ]]; then
  echo "    installing jsdom (one-time, for smoke test)..."
  npm install -g jsdom --no-audit --no-fund
fi
export NODE_PATH="$(npm root -g)${NODE_PATH:+:${NODE_PATH}}"
SMOKE="${APP_DIR}/deploy/render-smoke-test.cjs"
if [[ ! -f "${SMOKE}" ]]; then
  echo "!! smoke test script missing at ${SMOKE} — refusing to deploy blind"
  exit 1
fi
node "${SMOKE}" "${APP_DIR}/client/dist" "/app/" || {
  echo ""
  echo "!! RENDER SMOKE TEST FAILED — deploy aborted BEFORE restarting services."
  echo "   The previous working build is still serving. Fix the frontend and re-run."
  exit 1
}
node "${SMOKE}" "${AI_DIR}/client/dist" "/ai/app/" --ai || {
  echo ""
  echo "!! AI RENDER SMOKE TEST FAILED — deploy aborted BEFORE restarting services."
  echo "   The previous working build is still serving. Fix the frontend and re-run."
  exit 1
}

# --- END BLOCK ---
