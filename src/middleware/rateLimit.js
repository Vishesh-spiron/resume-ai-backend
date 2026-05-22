// ─────────────────────────────────────────────────────────────────────────────
// src/middleware/rateLimit.js
// Protects payment endpoints from abuse and brute-force attacks.
//
// Uses express-rate-limit (in-memory store — resets on server restart).
// For multi-instance deployments, swap windowMs store to Redis:
//   npm install rate-limit-redis ioredis
//   new RedisStore({ client: redisClient })
// ─────────────────────────────────────────────────────────────────────────────

const rateLimit = require('express-rate-limit');

// ── General API limiter — 60 requests per minute per IP ───────────────────────
// Applied to all /api/* routes. Prevents basic abuse and scraping.
const generalLimiter = rateLimit({
  windowMs:         60 * 1000, // 1 minute
  max:              60,
  standardHeaders:  true,     // Return RateLimit-* headers (RFC 7231)
  legacyHeaders:    false,    // Disable X-RateLimit-* (old format)
  message: {
    error: 'Too many requests. Please wait a moment and try again.',
  },
  // Skip for health check — Render's health probe should never be rate-limited
  skip: (req) => req.path === '/',
});

// ── Payment endpoint limiter — 10 requests per 15 minutes per IP ──────────────
// Much stricter — a real user would never create more than a few orders.
// Prevents automated order-spam attacks.
const paymentLimiter = rateLimit({
  windowMs:         15 * 60 * 1000, // 15 minutes
  max:              10,
  standardHeaders:  true,
  legacyHeaders:    false,
  message: {
    error: 'Too many payment requests. Please wait 15 minutes and try again.',
  },
});

// ── Verify-payment limiter — 5 requests per 15 minutes per IP ─────────────────
// The strictest limiter — legitimate users verify exactly once per payment.
// Prevents signature brute-force attacks.
const verifyLimiter = rateLimit({
  windowMs:         15 * 60 * 1000, // 15 minutes
  max:              5,
  standardHeaders:  true,
  legacyHeaders:    false,
  message: {
    error: 'Too many verification attempts. Please wait 15 minutes.',
  },
});

module.exports = { generalLimiter, paymentLimiter, verifyLimiter };
