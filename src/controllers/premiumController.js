// ─────────────────────────────────────────────────────────────────────────────
// src/controllers/premiumController.js
// HTTP layer for GET /api/premium/status and POST /api/premium/unlock-reward.
// All the actual logic lives in services/premiumService.js — this file only
// translates between HTTP and that service.
// ─────────────────────────────────────────────────────────────────────────────

const { getPremiumStatus, unlockRewardForUser, PremiumError } = require('../services/premiumService');

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/premium/status                                    (requireAuth)
//
// Returns the caller's current premium/unlock status. Read-only — safe to
// poll. Flutter calls this on app resume, before opening a premium screen,
// and to drive the countdown timer / "⭐⭐⭐ 3/3 Available" badge.
// ─────────────────────────────────────────────────────────────────────────────
async function status(req, res) {
  const { uid, requestId } = req;
  try {
    const result = await getPremiumStatus(uid);
    return res.json({ success: true, ...result });
  } catch (err) {
    console.error(`[${requestId}] \u274c premium/status failed for ${uid}: ${err.message}`);
    return res.status(500).json({ success: false, error: 'Could not load premium status.' });
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/premium/unlock-reward                             (requireAuth)
//
// Call this ONLY after RewardedAd's onUserEarnedReward callback fires —
// never optimistically. Body is empty; the caller is identified entirely
// by the verified Firebase ID token (req.uid), so a client can't unlock
// premium for someone else or forge a higher weeklyRewardCount.
// ─────────────────────────────────────────────────────────────────────────────
async function unlockReward(req, res) {
  const { uid, requestId } = req;
  try {
    const result = await unlockRewardForUser(uid);
    console.log(`[${requestId}] \ud83c\udf81 Reward unlock granted | uid=${uid} count=${result.weeklyRewardCount}/${result.weeklyRewardLimit}`);
    return res.json({ success: true, ...result });
  } catch (err) {
    if (err instanceof PremiumError) {
      // 409 Conflict for ALREADY_PREMIUM (nothing to do, not really an
      // error the user needs to react to); 403 Forbidden for the weekly
      // cap (the specific, user-facing copy from the product spec).
      const statusCode = err.code === 'ALREADY_PREMIUM' ? 409 : 403;
      console.warn(`[${requestId}] \u26a0\ufe0f  unlock-reward rejected (${err.code}) | uid=${uid}`);
      return res.status(statusCode).json({ success: false, code: err.code, error: err.message });
    }
    console.error(`[${requestId}] \u274c unlock-reward failed for ${uid}: ${err.message}`);
    return res.status(500).json({ success: false, error: 'Could not grant unlock. Please try again.' });
  }
}

module.exports = { status, unlockReward };
