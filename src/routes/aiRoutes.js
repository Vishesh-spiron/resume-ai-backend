// src/routes/aiRoutes.js
const express    = require('express');
const rateLimit  = require('express-rate-limit');
const { chatCompletion } = require('../controllers/aiController');

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
// Body: { prompt: string, model?: string, maxTokens?: number }
router.post('/chat', aiLimiter, chatCompletion);

module.exports = router;
