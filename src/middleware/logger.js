// ─────────────────────────────────────────────────────────────────────────────
// src/middleware/logger.js
// Attaches a unique request ID to every request and logs method + path + ms.
//
// Format: [req_abc123] POST /api/payment/create-order → 200 (45ms)
//
// The request ID propagates to all console.log calls in controllers,
// making it easy to trace a single payment through the server logs.
// ─────────────────────────────────────────────────────────────────────────────

const crypto = require('crypto');

function requestLogger(req, res, next) {
  // Short 8-char random ID — enough to correlate logs for one request
  req.requestId = 'req_' + crypto.randomBytes(4).toString('hex');

  const start = Date.now();
  const { method, path: urlPath } = req;

  // Log when response finishes (captures status code + duration)
  res.on('finish', () => {
    const ms     = Date.now() - start;
    const status = res.statusCode;
    const level  = status >= 500 ? '❌' : status >= 400 ? '⚠️ ' : '✅';

    // Skip logging health-check pings in production to avoid log spam
    if (urlPath === '/' && process.env.NODE_ENV === 'production') return;

    console.log(`[${req.requestId}] ${level} ${method} ${urlPath} → ${status} (${ms}ms)`);
  });

  next();
}

module.exports = { requestLogger };
