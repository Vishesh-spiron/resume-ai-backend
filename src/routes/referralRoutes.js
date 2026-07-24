// ─────────────────────────────────────────────────────────────────────────────
// src/routes/referralRoutes.js
// Wires rate limiting → (auth) → controller for referral endpoints.
// ─────────────────────────────────────────────────────────────────────────────

const express = require('express');
const router  = express.Router();

const {
  validateCode, attachReferral, getQuote, getWallet, getReferralHistory,
  trackClick, requestWithdrawal, getNotifications, markNotificationsRead,
} = require('../controllers/referralController');
const { requireAuth, optionalAuth }     = require('../middleware/firebaseAuth');
const { referralLimiter }               = require('../middleware/rateLimit');

// POST /api/referral/validate-code — public, used for live feedback while typing
router.post('/validate-code', referralLimiter, validateCode);

// POST /api/referral/attach — requires a verified Firebase ID token
router.post('/attach', referralLimiter, requireAuth, attachReferral);

// GET /api/referral/quote?plan=fixResume — pricing preview before checkout.
// optionalAuth: works for a logged-out view (full price) and never blocks.
router.get('/quote', referralLimiter, optionalAuth, getQuote);

// GET /api/referral/wallet — requires auth, this is the user's own dashboard data
router.get('/wallet', referralLimiter, requireAuth, getWallet);

// GET /api/referral/history — requires auth, this user's referral history list
router.get('/history', referralLimiter, requireAuth, getReferralHistory);

// POST /api/referral/track-click — public, fired when a ?ref= link is visited
router.post('/track-click', referralLimiter, trackClick);

// POST /api/referral/withdraw — requires auth, creates a withdrawal request
router.post('/withdraw', referralLimiter, requireAuth, requestWithdrawal);

// GET /api/referral/notifications — requires auth, this user's unread notifications
router.get('/notifications', referralLimiter, requireAuth, getNotifications);

// POST /api/referral/notifications/mark-read — requires auth
router.post('/notifications/mark-read', referralLimiter, requireAuth, markNotificationsRead);

module.exports = router;
