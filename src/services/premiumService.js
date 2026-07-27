// ─────────────────────────────────────────────────────────────────────────────
// src/services/premiumService.js
//
// All read/write access to the premium + reward-unlock fields on
// users/{uid} lives here. Nothing else in the backend should touch
// isPremium / premiumExpiry / rewardUnlockExpiry / weeklyRewardCount /
// lastRewardReset directly — go through getPremiumStatus() /
// unlockRewardForUser() so the rolling-reset and limit logic can't drift
// out of sync between call sites.
//
// Firestore schema (users/{uid}):
//   isPremium:          boolean   — true if the user has a premium subscription/bundle
//   premiumExpiry:      Timestamp | null — null while isPremium=true means "lifetime";
//                                          a future Timestamp means a time-boxed premium
//                                          period (e.g. a monthly plan)
//   rewardUnlockExpiry: Timestamp | null — when the current ad-granted unlock expires
//   weeklyRewardCount:  number    — rewarded-ad unlocks used in the current window
//   lastRewardReset:    Timestamp | null — when weeklyRewardCount was last reset to 0
//
// All five fields are OPTIONAL on the document — a user created before this
// feature shipped simply reads as "not premium, 0 unlocks used, no active
// window yet". No migration script is required.
// ─────────────────────────────────────────────────────────────────────────────

const { admin, db } = require('../config/firebaseAdmin');
const {
  UNLOCK_DURATION_MINUTES,
  WEEKLY_REWARD_LIMIT,
  RESET_WINDOW_MS,
} = require('../config/premiumConfig');

const USERS_COLLECTION = 'users';

// Typed errors the controller maps to HTTP responses. Using a `code` field
// (rather than parsing err.message strings) keeps the controller's switch
// unambiguous even if the message copy changes later.
class PremiumError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

// ── Pure helpers (no I/O — easy to unit test) ─────────────────────────────

function toMillis(timestamp) {
  if (!timestamp) return null;
  // Firestore Timestamp has toMillis(); guard for plain Date/number too,
  // since data written by other tooling might not always be a Timestamp.
  if (typeof timestamp.toMillis === 'function') return timestamp.toMillis();
  if (timestamp instanceof Date) return timestamp.getTime();
  if (typeof timestamp === 'number') return timestamp;
  return null;
}

/**
 * Computes the user-facing premium/unlock status from raw Firestore data.
 * Pure function — given the same (data, nowMs) it always returns the same
 * result, and it never writes anything. Used by BOTH the read-only status
 * endpoint and (as a first pass) the unlock transaction below.
 */
function computeStatus(data, nowMs) {
  const isPremiumFlag = data?.isPremium === true;
  const premiumExpiryMs = toMillis(data?.premiumExpiry);
  // isPremium with no expiry = lifetime premium. isPremium with a past
  // expiry is treated as expired even though the flag is still `true` —
  // callers that want to "renew" should update premiumExpiry, not just
  // leave a stale isPremium:true lying around.
  const isPremiumActive =
    isPremiumFlag && (premiumExpiryMs === null || premiumExpiryMs > nowMs);

  const rewardUnlockExpiryMs = toMillis(data?.rewardUnlockExpiry);
  const rewardUnlockActive =
    rewardUnlockExpiryMs !== null && rewardUnlockExpiryMs > nowMs;

  const lastResetMs = toMillis(data?.lastRewardReset);
  const needsReset = lastResetMs === null || nowMs - lastResetMs >= RESET_WINDOW_MS;
  // "Effective" count is what the count WOULD be right now, applying the
  // rolling reset — computed for display even though a pure status read
  // never persists the reset (only unlockRewardForUser does, atomically,
  // at the moment a reset actually matters).
  const effectiveWeeklyCount = needsReset ? 0 : (data?.weeklyRewardCount || 0);
  const weeklyRemaining = Math.max(0, WEEKLY_REWARD_LIMIT - effectiveWeeklyCount);

  // When the next reset happens, for UI countdowns ("resets in 3 days").
  const nextResetAtMs = needsReset ? null : lastResetMs + RESET_WINDOW_MS;

  return {
    isPremium: isPremiumActive,
    premiumExpiry: premiumExpiryMs,
    rewardUnlockActive,
    rewardUnlockExpiry: rewardUnlockExpiryMs,
    canAccessPremium: isPremiumActive || rewardUnlockActive,
    weeklyRewardLimit: WEEKLY_REWARD_LIMIT,
    weeklyRewardCount: effectiveWeeklyCount,
    weeklyRemaining,
    nextResetAt: nextResetAtMs,
    unlockDurationMinutes: UNLOCK_DURATION_MINUTES,
  };
}

// ── Public API ─────────────────────────────────────────────────────────────

/**
 * GET-style read. Never writes. Safe to call as often as the UI needs
 * (app resume, pull-to-refresh, before opening a premium screen, etc).
 */
async function getPremiumStatus(uid) {
  const doc = await db.collection(USERS_COLLECTION).doc(uid).get();
  const data = doc.exists ? doc.data() : {};
  return computeStatus(data, Date.now());
}

/**
 * Called ONLY after the Flutter client's rewarded-ad SDK reports a
 * successful reward callback. Runs as a single Firestore transaction so
 * two rapid calls (e.g. a double-tap, or a retried request after a flaky
 * network response) can't both succeed and grant two unlocks for one ad.
 *
 * Throws PremiumError with code:
 *   'ALREADY_PREMIUM'       — caller has an active premium subscription;
 *                              they never need a rewarded-ad unlock.
 *   'WEEKLY_LIMIT_REACHED'  — all weekly unlocks already used; message is
 *                              the exact copy the product spec asked for.
 */
async function unlockRewardForUser(uid) {
  const ref = db.collection(USERS_COLLECTION).doc(uid);

  return db.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    const data = snap.exists ? snap.data() : {};
    const now = Date.now();

    const current = computeStatus(data, now);
    if (current.isPremium) {
      throw new PremiumError(
        'ALREADY_PREMIUM',
        'You already have Premium — no need to watch an ad.',
      );
    }

    // Re-derive the reset decision (computeStatus already tells us the
    // effective count, but we need to know explicitly whether a reset
    // happens on THIS write so we know what to store for lastRewardReset).
    const lastResetMs = toMillis(data?.lastRewardReset);
    const needsReset = lastResetMs === null || now - lastResetMs >= RESET_WINDOW_MS;
    const baselineCount = needsReset ? 0 : (data?.weeklyRewardCount || 0);

    if (baselineCount >= WEEKLY_REWARD_LIMIT) {
      throw new PremiumError(
        'WEEKLY_LIMIT_REACHED',
        'Your weekly free unlock limit has been reached. ' +
          'You can:\n' +
          '\u2022 Wait until next week for more free unlocks.\n' +
          '\u2022 Purchase Premium for unlimited access and no rewarded ads.',
      );
    }

    const newCount = baselineCount + 1;
    const unlockExpiryMs = now + UNLOCK_DURATION_MINUTES * 60 * 1000;

    const update = {
      rewardUnlockExpiry: admin.firestore.Timestamp.fromMillis(unlockExpiryMs),
      weeklyRewardCount: newCount,
      // Only stamp lastRewardReset when a reset is actually happening (or
      // it's genuinely never been set) — this IS "Update lastRewardReset"
      // from the spec, scoped to the moment the window actually rolls over.
      ...(needsReset ? { lastRewardReset: admin.firestore.Timestamp.fromMillis(now) } : {}),
    };

    tx.set(ref, update, { merge: true });

    return computeStatus({ ...data, ...update }, now);
  });
}

module.exports = {
  getPremiumStatus,
  unlockRewardForUser,
  computeStatus, // exported for unit tests
  PremiumError,
};
