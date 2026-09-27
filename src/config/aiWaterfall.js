// ─────────────────────────────────────────────────────────────────────────────
// src/config/aiWaterfall.js
// 3-key waterfall across Groq API keys for /api/ai/chat.
//
// WHY: Groq's free tier rate-limits per API key (requests/minute AND
// requests/day). One key alone means every user hits the SAME shared quota —
// busy periods return 429s to real users. Spreading load across up to 3 keys
// (e.g. 3 separate free Groq accounts) multiplies your effective free
// capacity by up to 3x, with automatic failover.
//
// HOW IT WORKS (matches "1 → 2 → 3 → back to 1"):
//   • Keys are tried in order, ALWAYS preferring the lowest-numbered key
//     that isn't currently "cooling down" — so once key 1 recovers (its
//     per-minute/per-day window resets), traffic naturally goes right back
//     to using key 1 first. Nothing needs to remember "whose turn it is".
//   • A 429 (rate limited) puts that key on a cooldown timer (from Groq's
//     Retry-After header if present, else a sensible default) and the SAME
//     request is immediately retried on the next available key — the user
//     never sees the failure.
//   • A 401/403 (bad/revoked key) disables that key for a long cooldown and
//     logs loudly, since that needs a human to fix the key in Render's env
//     vars — but the OTHER keys keep serving requests meanwhile.
//   • A 5xx / network error / timeout gets a short cooldown (transient) and
//     also fails over to the next key.
//   • A 400/413 (bad prompt / payload too large) is NOT retried on another
//     key — every key hits the same wall, so it's returned to the client
//     immediately as an actual error.
//
// SETUP: put up to 3 Groq API keys in Render's env vars:
//   GROQ_API_KEY      (required — key 1, used alone if the others are unset)
//   GROQ_API_KEY_2     (optional — key 2)
//   GROQ_API_KEY_3     (optional — key 3)
// Get free keys at https://console.groq.com/keys (a few seconds each, no
// card required) — different email per key if you want 3 independent
// free-tier quotas.
// ─────────────────────────────────────────────────────────────────────────────

const GROQ_URL = 'https://api.groq.com/openai/v1/chat/completions';

// Cooldown durations (ms) — how long a key sits out after each error type.
const COOLDOWN_RATE_LIMIT_DEFAULT_MS = 65 * 1000; // used only if Groq sends no Retry-After
const COOLDOWN_TRANSIENT_MS          = 20 * 1000; // 5xx / network / timeout
const COOLDOWN_DAILY_QUOTA_MS        = 6 * 60 * 60 * 1000; // "requests per day" message
const COOLDOWN_INVALID_KEY_MS        = 24 * 60 * 60 * 1000; // 401/403 — needs a human

function buildProviders() {
  const raw = [
    { name: 'groq-key-1', apiKey: process.env.GROQ_API_KEY },
    { name: 'groq-key-2', apiKey: process.env.GROQ_API_KEY_2 },
    { name: 'groq-key-3', apiKey: process.env.GROQ_API_KEY_3 },
  ];
  return raw
    .map((p, i) => ({ ...p, index: i, baseUrl: GROQ_URL }))
    .filter((p) => Boolean(p.apiKey && p.apiKey.trim()));
}

class AiWaterfall {
  constructor(providers) {
    this.providers = providers; // configured (non-empty-key) providers only
    // cooldownUntil[index] — epoch ms; index keyed by the provider's ORIGINAL
    // slot (0/1/2), not position in `providers`, so logs always say "key 2"
    // regardless of which keys are actually configured.
    this.cooldownUntil = {};
  }

  isConfigured() {
    return this.providers.length > 0;
  }

  /// Order to try providers in for one request: not-cooling first (ascending
  /// by original key slot — this is what makes it fall back to key 1 the
  /// moment key 1's cooldown clears), then cooling ones as a last resort
  /// (a cooldown estimate can be wrong; better to try than to hard-fail).
  order() {
    const now = Date.now();
    const ready = [];
    const cooling = [];
    for (const p of this.providers) {
      if ((this.cooldownUntil[p.index] || 0) > now) cooling.push(p);
      else ready.push(p);
    }
    return [...ready, ...cooling];
  }

  markCooldown(index, ms) {
    this.cooldownUntil[index] = Date.now() + ms;
  }

  statusSnapshot() {
    const now = Date.now();
    return this.providers.map((p) => {
      const until = this.cooldownUntil[p.index] || 0;
      return {
        name: p.name,
        available: until <= now,
        cooldownRemainingMs: Math.max(0, until - now),
      };
    });
  }
}

const waterfall = new AiWaterfall(buildProviders());

function cooldownForRateLimit(retryAfterHeader, errorBodyText) {
  if (retryAfterHeader) {
    const seconds = Number(retryAfterHeader);
    if (Number.isFinite(seconds) && seconds > 0) {
      // Cap it — a huge Retry-After (e.g. a per-day quota reported in
      // seconds) shouldn't idle a key for absurdly long; the daily-quota
      // cooldown below already covers that case explicitly.
      return Math.min(seconds * 1000, COOLDOWN_DAILY_QUOTA_MS);
    }
  }
  const text = (errorBodyText || '').toLowerCase();
  if (text.includes('per day') || text.includes('daily')) {
    return COOLDOWN_DAILY_QUOTA_MS;
  }
  return COOLDOWN_RATE_LIMIT_DEFAULT_MS;
}

module.exports = {
  GROQ_URL,
  waterfall,
  cooldownForRateLimit,
  COOLDOWN_TRANSIENT_MS,
  COOLDOWN_INVALID_KEY_MS,
};
