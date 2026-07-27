// src/routes/aiRoutes.js
const express    = require('express');
const rateLimit  = require('express-rate-limit');
const { chatCompletion } = require('../controllers/aiController');
const { optionalAuth } = require('../middleware/firebaseAuth');
const { requirePremiumAccess } = require('../middleware/requirePremiumAccess');

const router = express.Router();

// Strict rate limit — Groq has its own limits, and AI calls are expensive.
// 30 requests per 5 minutes per IP.
// A real user running 5-6 resume features uses ~10 requests max.
const aiLimiter = rateLimit({
  windowMs:        5 * 60 * 1000, // 5 minutes
  max:             30,
  standardHeaders: true,
  legacyHeaders:   false,
  message: { success: false, error: 'Too many AI requests. Please wait 5 minutes.' },
});

// POST /api/ai/chat
// Body: { prompt: string, model?: string, maxTokens?: number, feature?: string }
//
// `feature` is optional and only matters for premium tools (fixResume,
// jdOptimize, resumeGenerator, whyRejected, projectImprove,
// selectionBooster — see config/premiumConfig.js#PREMIUM_FEATURES). The
// core free ATS-match flow and the guest preview never send it, so
// optionalAuth + requirePremiumAccess are both complete no-ops for them —
// this route's existing free behaviour is unchanged.
//
// optionalAuth populates req.uid when a valid Firebase ID token is
// present (silently continues without one otherwise); requirePremiumAccess
// then decides, based on `feature` + req.uid, whether to block the request.
router.post('/chat', aiLimiter, optionalAuth, requirePremiumAccess, chatCompletion);

module.exports = router;
