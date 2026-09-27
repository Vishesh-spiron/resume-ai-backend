// src/controllers/aiController.js
// ─────────────────────────────────────────────────────────────────────────────
// Proxy between Flutter and Groq API — now with a 3-key waterfall.
//
// WHY THIS EXISTS:
//   GROQ_API_KEY must never be in Flutter's bundled .env — anyone can read
//   files from a web app's asset bundle. Keeping the key on Render means it
//   never leaves the server.
//
// WATERFALL:
//   Requests try up to 3 Groq keys (GROQ_API_KEY / _2 / _3), always
//   preferring the lowest-numbered one that isn't cooling down from a
//   recent rate limit. A rate limit or transient failure on one key fails
//   over to the next automatically — the client never sees it — and once a
//   key's cooldown clears, traffic naturally goes back to preferring it.
//   See config/aiWaterfall.js for the full mechanics.
//
// Flutter sends:  POST /api/ai/chat  { prompt, model, maxTokens }
// We call:        Groq API (server-side, key from process.env)
// We return:      { success, content }  or  { success, error, status }
//   (the response shape is unchanged — the waterfall is entirely invisible
//   to the client; only the debug log shows which key served each request)
// ─────────────────────────────────────────────────────────────────────────────

const {
  waterfall,
  cooldownForRateLimit,
  COOLDOWN_TRANSIENT_MS,
  COOLDOWN_INVALID_KEY_MS,
} = require('../config/aiWaterfall');

// Allowed models — whitelist prevents client from using arbitrary models
const ALLOWED_MODELS = new Set([
  'openai/gpt-oss-120b',
]);

// Total wall-clock budget across every provider attempt combined. Flutter's
// own HTTP call times out at 90s, so this stays comfortably under that even
// in the worst case (all 3 keys tried).
const TOTAL_BUDGET_MS = 80_000;
const PER_PROVIDER_TIMEOUT_MS = 28_000;

async function chatCompletion(req, res) {
  const { requestId } = req;
  const {
    prompt,
    model      = 'openai/gpt-oss-120b',
    maxTokens  = 1024,
    temperature,
  } = req.body ?? {};

  // ── Validate request ───────────────────────────────────────────────────────
  if (!prompt || typeof prompt !== 'string' || prompt.trim().length < 10) {
    return res.status(400).json({ success: false, error: 'Missing or too-short prompt.' });
  }
  if (!ALLOWED_MODELS.has(model)) {
    return res.status(400).json({ success: false, error: `Model "${model}" not allowed.` });
  }
  const tokens = Math.min(Math.max(Number(maxTokens) || 1024, 64), 8192);
  const temp = Number.isFinite(Number(temperature)) ? Number(temperature) : 0.10;

  if (!waterfall.isConfigured()) {
    console.error(`[${requestId}] ❌ No Groq API key configured (GROQ_API_KEY missing).`);
    return res.status(503).json({
      success: false,
      error: 'AI service is not configured on the server.',
    });
  }

  const order = waterfall.order();
  const deadline = Date.now() + TOTAL_BUDGET_MS;
  let lastClientError = { status: 502, message: 'AI service unreachable. Please try again.' };

  for (let attempt = 0; attempt < order.length; attempt++) {
    const provider = order[attempt];
    const remainingMs = deadline - Date.now();
    if (remainingMs < 3000) {
      debugLog(requestId, `⏱ waterfall budget exhausted before trying ${provider.name}`);
      break;
    }
    const attemptTimeout = Math.min(PER_PROVIDER_TIMEOUT_MS, remainingMs);

    debugLog(
      requestId,
      `→ ${provider.name} (attempt ${attempt + 1}/${order.length}) | model=${model} tokens=${tokens} prompt_len=${prompt.length}`,
    );

    let groqRes;
    try {
      groqRes = await fetch(provider.baseUrl, {
        method:  'POST',
        headers: {
          'Authorization': `Bearer ${provider.apiKey}`,
          'Content-Type':  'application/json',
        },
        body: JSON.stringify({
          model,
          messages:    [{ role: 'user', content: prompt }],
          temperature: temp,
          max_tokens:  tokens,
          top_p:       0.90,
          stream:      false,
        }),
        signal: AbortSignal.timeout(attemptTimeout),
      });
    } catch (err) {
      // Network error / timeout — transient, try the next key.
      console.warn(`[${requestId}] ⚠️  ${provider.name} network error: ${err.message}`);
      waterfall.markCooldown(provider.index, COOLDOWN_TRANSIENT_MS);
      lastClientError = { status: 502, message: 'AI service unreachable. Please try again.' };
      continue;
    }

    const status = groqRes.status;

    if (status === 429) {
      const bodyText = await groqRes.text();
      const retryAfter = groqRes.headers.get('retry-after');
      const cooldownMs = cooldownForRateLimit(retryAfter, bodyText);
      waterfall.markCooldown(provider.index, cooldownMs);
      console.warn(
        `[${requestId}] ⚠️  ${provider.name} rate limited (429, cooldown ${Math.round(cooldownMs / 1000)}s) — failing over`,
      );
      lastClientError = { status: 429, message: 'AI rate limit reached. Please wait a moment and try again.' };
      continue; // try next key in the waterfall
    }

    if (status === 401 || status === 403) {
      // This key itself is bad/revoked — not the request's fault. Disable it
      // for a long cooldown (needs a human to fix in Render's env vars) and
      // keep going with whatever keys remain.
      console.error(
        `[${requestId}] ❌ ${provider.name} auth error (${status}) — check its value in Render env vars. Disabling it for now.`,
      );
      waterfall.markCooldown(provider.index, COOLDOWN_INVALID_KEY_MS);
      lastClientError = { status: 502, message: 'AI service authentication error. Contact support.' };
      continue;
    }

    if (status >= 500) {
      const bodyText = await groqRes.text();
      console.warn(`[${requestId}] ⚠️  ${provider.name} ${status}: ${bodyText.slice(0, 200)} — failing over`);
      waterfall.markCooldown(provider.index, COOLDOWN_TRANSIENT_MS);
      lastClientError = { status: 502, message: 'AI service temporarily unavailable. Please try again shortly.' };
      continue;
    }

    if (!groqRes.ok) {
      // 400/404/413 etc — the request itself (prompt/model/payload), not the
      // key or the load. Every key would hit the same wall, so return this
      // to the client immediately instead of burning through the waterfall.
      const bodyText = await groqRes.text();
      console.error(`[${requestId}] ❌ ${provider.name} ${status}: ${bodyText.slice(0, 200)}`);
      return res.status(status === 413 ? 413 : 400).json({
        success: false,
        error:   groqErrorMessage(status),
        status,
      });
    }

    // ── Success ────────────────────────────────────────────────────────────
    const body = await groqRes.text();
    let content;
    try {
      const data = JSON.parse(body);
      content = data?.choices?.[0]?.message?.content;
    } catch (_) {
      console.error(`[${requestId}] ❌ ${provider.name} response parse failed`);
      waterfall.markCooldown(provider.index, COOLDOWN_TRANSIENT_MS);
      lastClientError = { status: 502, message: 'Invalid response from AI service.' };
      continue;
    }

    if (!content || content.trim().length === 0) {
      console.warn(`[${requestId}] ⚠️  ${provider.name} returned empty content — failing over`);
      waterfall.markCooldown(provider.index, COOLDOWN_TRANSIENT_MS);
      lastClientError = { status: 502, message: 'Empty response from AI service.' };
      continue;
    }

    debugLog(
      requestId,
      `✅ ${provider.name} ok | response_len=${content.length}${attempt > 0 ? ` (after ${attempt} failover${attempt > 1 ? 's' : ''})` : ''}`,
    );
    return res.json({ success: true, content });
  }

  // Every configured key failed (or the time budget ran out).
  console.error(`[${requestId}] ❌ All AI keys exhausted | last=${lastClientError.status} ${lastClientError.message}`);
  return res.status(lastClientError.status === 429 ? 429 : 503).json({
    success: false,
    error: waterfall.providers.length > 1
      ? 'All AI providers are busy right now. Please try again in a moment.'
      : lastClientError.message,
    status: lastClientError.status,
  });
}

// Human-readable messages for Groq error codes that are returned as-is
// (request/payload problems — not solved by switching keys).
function groqErrorMessage(status) {
  switch (status) {
    case 400: return 'Invalid request. Please try again with a different file.';
    case 413: return 'Resume text is too long. Try a shorter or cleaner PDF.';
    default:  return `AI service error (${status}). Please try again.`;
  }
}

function debugLog(requestId, msg) {
  if (process.env.NODE_ENV !== 'production') {
    console.log(`[${requestId}] [AI] ${msg}`);
  } else {
    // In production, only log the non-prompt part — prompts may contain PII.
    console.log(`[${requestId}] [AI] ${msg.split('|')[0].trim()}`);
  }
}

// GET /api/ai/waterfall-status — quick operational visibility (which keys
// are configured and whether any are currently cooling down). Safe to leave
// public: reveals no key values or prompts, just health.
function waterfallStatus(req, res) {
  res.json({ configured: waterfall.isConfigured(), providers: waterfall.statusSnapshot() });
}

module.exports = { chatCompletion, waterfallStatus };
