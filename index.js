// ─────────────────────────────────────────────────────────────────────────────
// index.js — Entry point for Resume AI backend
// Handles Razorpay order creation and payment verification
// ─────────────────────────────────────────────────────────────────────────────

require('dotenv').config(); // Must be first — loads .env before anything reads process.env

const express = require('express');
const cors    = require('cors');

const paymentRoutes            = require('./src/routes/paymentRoutes');
const humanReviewRoutes        = require('./src/routes/humanReviewRoutes');
const { requestLogger }        = require('./src/middleware/logger');
const { verifyEmailer }        = require('./src/config/emailer');
const { generalLimiter }       = require('./src/middleware/rateLimit');

const app  = express();
const PORT = process.env.PORT || 3000;

// ── Startup validation ────────────────────────────────────────────────────────
// Fail loudly at boot rather than silently at first request.
const REQUIRED_ENV = ['RAZORPAY_KEY_ID', 'RAZORPAY_KEY_SECRET', 'RESEND_API_KEY', 'ADMIN_EMAIL'];
const missing = REQUIRED_ENV.filter((k) => !process.env[k]);
if (missing.length > 0) {
  console.error(`❌ Missing required environment variables: ${missing.join(', ')}`);
  console.error('   Set them in .env (local) or your hosting platform (Render/Railway).');
  process.exit(1);
}

// Warn if ALLOWED_ORIGINS is still wildcard in production
if (process.env.NODE_ENV === 'production' && process.env.ALLOWED_ORIGINS === '*') {
  console.warn(
    '⚠️  ALLOWED_ORIGINS=* in production — consider restricting to your Flutter web domain.',
  );
}

// ── Middleware (order matters) ────────────────────────────────────────────────

// 1. Attach request ID + log every request
app.use(requestLogger);

// 2. General rate limit — 60 req/min per IP across all routes
app.use(generalLimiter);

// 3. Parse JSON bodies
app.use(express.json({ limit: '10kb' })); // Limit body size — payment payloads are tiny

// 4. CORS — allow Flutter web + mobile
const rawOrigins = process.env.ALLOWED_ORIGINS ?? '*';
const allowedOrigins = rawOrigins.split(',').map((o) => o.trim());

app.use(
  cors({
    origin: allowedOrigins.includes('*')
      ? '*'
      : (origin, callback) => {
          // Allow requests with no Origin header (native mobile apps, Postman)
          if (!origin) return callback(null, true);
          if (allowedOrigins.includes(origin)) return callback(null, true);
          callback(new Error(`CORS blocked: origin "${origin}" not in ALLOWED_ORIGINS`));
        },
    methods:       ['GET', 'POST'],
    allowedHeaders: ['Content-Type'],
  }),
);

// ── Routes ────────────────────────────────────────────────────────────────────

// Health check — Render uses GET / to confirm the service is alive.
// Returns uptime and environment so you can verify deployments at a glance.
app.get('/', (req, res) => {
  res.json({
    status:      'ok',
    service:     'Resume AI Payment Backend',
    environment: process.env.NODE_ENV || 'development',
    uptime_sec:  Math.floor(process.uptime()),
    version:     process.env.npm_package_version || '1.0.0',
  });
});

// All payment routes under /api/payment
app.use('/api/payment', paymentRoutes);

// Human review — multipart PDF upload + email with attachment
// Note: express.json() is NOT applied to this route (multer handles the body)
app.use('/api/human-review', humanReviewRoutes);

// ── 404 handler ───────────────────────────────────────────────────────────────
app.use((req, res) => {
  res.status(404).json({ error: `Route not found: ${req.method} ${req.path}` });
});

// ── Global error handler ──────────────────────────────────────────────────────
// Catches anything thrown or passed to next(err) from middleware or routes.
// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  const status = err.status || 500;
  console.error(`[${req.requestId}] 💥 Unhandled error (${status}): ${err.message}`);

  // Never leak stack traces to clients
  res.status(status).json({
    error: status === 500 ? 'Internal server error' : err.message,
  });
});

// ── Start server ──────────────────────────────────────────────────────────────
app.listen(PORT, () => {
  // Verify SMTP connection — non-fatal if it fails
  verifyEmailer();

  console.log(`\n✅ Resume AI backend running`);
  console.log(`   Port:    ${PORT}`);
  console.log(`   Mode:    ${process.env.NODE_ENV || 'development'}`);
  console.log(`   Origins: ${rawOrigins}`);
  console.log(`   Razorpay key: ${process.env.RAZORPAY_KEY_ID?.slice(0, 12)}...\n`);
});

// ── Keep-alive ping ───────────────────────────────────────────────────────────
// Render free tier spins down after 15 min of inactivity.
// Pings our own health endpoint every 14 min to stay warm.
// Node 18+ has native fetch — no extra dependency needed.
if (process.env.NODE_ENV === 'production') {
  const SELF = process.env.RENDER_EXTERNAL_URL || `http://localhost:${PORT}`;
  setInterval(async () => {
    try {
      await fetch(`${SELF}/`);
      console.log('🏓 Keep-alive ping sent');
    } catch (err) {
      console.warn('⚠️  Keep-alive ping failed:', err.message);
    }
  }, 14 * 60 * 1000);
}
