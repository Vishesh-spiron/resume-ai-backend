// ─────────────────────────────────────────────────────────────────────────────
// src/config/premiumConfig.js
//
// Single source of truth for the hybrid monetization system's tunables.
// Change a number here — never touch premiumService.js — to retune the
// product (e.g. "30 minutes" → "1 hour", "3 unlocks" → "5 unlocks").
//
// IMPORTANT: This file is only meaningful on the BACKEND. The Flutter side
// mirrors these same defaults in lib/core/services/premium_service.dart
// purely for optimistic UI (e.g. showing "~30 min" before the network call
// returns) — the backend value below is always the one that's enforced.
// ─────────────────────────────────────────────────────────────────────────────

module.exports = {
  // How long one rewarded-ad watch unlocks all premium AI features for.
  UNLOCK_DURATION_MINUTES: 30,

  // Max rewarded-ad unlocks a free user gets per reset window.
  WEEKLY_REWARD_LIMIT: 3,

  // Reset window, in milliseconds. 7 days = rolling window (see note below).
  //
  // DESIGN DECISION — rolling 7-day window, not calendar week:
  // We reset `weeklyRewardCount` 7 days after `lastRewardReset`, not at a
  // fixed calendar boundary (e.g. "every Monday 00:00"). Two reasons:
  //   1. No timezone ambiguity — "calendar week" requires picking a timezone
  //      to anchor the boundary, and the same instant is a different day in
  //      IST vs UTC. A rolling window sidesteps that entirely.
  //   2. No burst exploit — with a fixed weekly boundary, a user could use
  //      3 unlocks at 11:59pm Saturday and 3 more at 12:01am Sunday, getting
  //      6 unlocks within 3 minutes. A rolling window can't be gamed that way.
  // If you deliberately want calendar-week resets instead (e.g. to line up
  // with a marketing cadence), change this to compute the most recent
  // Monday 00:00 in your target timezone — but that's a bigger change than
  // one constant, so it's called out here rather than silently supported.
  RESET_WINDOW_MS: 7 * 24 * 60 * 60 * 1000,

  // Feature keys that require isPremium OR an active reward-unlock.
  // The Flutter side sends one of these in the `feature` field of every
  // POST /api/ai/chat call that originates from a premium tool (see
  // resume_improve_service.dart). Anything NOT in this list (e.g. the core
  // free ATS match flow, or the guest preview) is left completely alone —
  // adding a key here is the only step needed to gate a new AI feature.
  //
  // Mapped from the app's existing premium screens / Razorpay plan keys
  // (see PLAN_NAMES in paymentController.js) — adjust freely if your
  // intended free/premium split differs:
  // Note: fullBundleUpgrade() in resume_improve_service.dart composes
  // fixResume + jdOptimize rather than sending its own feature key, so
  // gating those two automatically covers the bundle flow too.
  PREMIUM_FEATURES: [
    'fixResume',         // Fix My Resume — features/premium/screens/fix_resume_screen.dart
    'jdOptimize',        // JD Optimization — features/premium/screens/jd_optimize_screen.dart
    'resumeGenerator',   // AI Resume Builder — features/premium/screens/resume_generator_screen.dart
    'whyRejected',       // Why Rejected — features/premium/screens/why_rejected_screen.dart
    'projectImprove',    // Project bullet improver — premium_tools_screen.dart
    'selectionBooster',  // Selection booster — premium_tools_screen.dart
  ],
};
