// ─────────────────────────────────────────────────────────────────────────────
// src/routes/adminReferralRoutes.js
// Every route here requires requireAdmin — a verified Firebase token AND
// role === 'admin' on that user's Firestore doc.
// ─────────────────────────────────────────────────────────────────────────────

const express = require('express');
const router  = express.Router();

const {
  getConfig, updateConfig, getAnalytics,
  listWithdrawals, approveWithdrawal, rejectWithdrawal,
} = require('../controllers/adminReferralController');
const { requireAdmin } = require('../middleware/firebaseAuth');
const { referralLimiter } = require('../middleware/rateLimit');

router.get('/config', referralLimiter, requireAdmin, getConfig);
router.put('/config', referralLimiter, requireAdmin, updateConfig);

router.get('/analytics', referralLimiter, requireAdmin, getAnalytics);

router.get('/withdrawals', referralLimiter, requireAdmin, listWithdrawals);
router.post('/withdrawals/:id/approve', referralLimiter, requireAdmin, approveWithdrawal);
router.post('/withdrawals/:id/reject', referralLimiter, requireAdmin, rejectWithdrawal);

module.exports = router;
