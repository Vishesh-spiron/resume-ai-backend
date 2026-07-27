// src/routes/premiumRoutes.js
const express = require('express');
const rateLimit = require('express-rate-limit');
const { requireAuth } = require('../middleware/firebaseAuth');
const { status, unlockReward } = require('../controllers/premiumController');

const router = express.Router();

// Generous but real limit — status is polled fairly often (app resume,
// screen opens), unlock-reward is called at most a few times per day per
// user by design (weekly cap is 3), so this mainly guards against a buggy
// retry loop rather than a legitimate use pattern.
const premiumLimiter = rateLimit({
  windowMs: 5 * 60 * 1000,
  max: 60,
  standardHeaders: true,
  legacyHeaders: false,
  message: { success: false, error: 'Too many requests. Please wait a moment.' },
});

router.use(premiumLimiter);

// GET /api/premium/status
router.get('/status', requireAuth, status);

// POST /api/premium/unlock-reward
router.post('/unlock-reward', requireAuth, unlockReward);

module.exports = router;
