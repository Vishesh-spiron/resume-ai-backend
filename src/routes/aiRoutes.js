// src/routes/aiRoutes.js
const express    = require('express');
const rateLimit  = require('express-rate-limit');
const { chatCompletion, waterfallStatus } = require('../controllers/aiController');
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
//
// Internally this now tries up to 3 Groq API keys in a waterfall (see
// config/aiWaterfall.js) — entirely invisible to the client.
router.post('/chat', aiLimiter, optionalAuth, requirePremiumAccess, chatCompletion);

// GET /api/ai/waterfall-status — which Groq keys are configured and whether
// any are currently cooling down from a rate limit. No key values or prompt
// content are ever exposed. Useful for a quick "is key 2 actually being
// used" sanity check after adding GROQ_API_KEY_2/_3.
router.get('/waterfall-status', waterfallStatus);

module.exports = router;
