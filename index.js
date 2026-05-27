require('dotenv').config();

const express = require('express');
const cors    = require('cors');

const paymentRoutes            = require('./src/routes/paymentRoutes');
const humanReviewRoutes        = require('./src/routes/humanReviewRoutes');
const aiRoutes                 = require('./src/routes/aiRoutes');
const { requestLogger }        = require('./src/middleware/logger');
const { generalLimiter }       = require('./src/middleware/rateLimit');
const { verifyEmailer }        = require('./src/config/emailer');

const app  = express();
const PORT = process.env.PORT || 3000;

// ── Startup validation ────────────────────────────────────────────────────────
const REQUIRED_ENV = ['RAZORPAY_KEY_ID', 'RAZORPAY_KEY_SECRET', 'RESEND_API_KEY', 'ADMIN_EMAIL', 'GROQ_API_KEY'];
const missing = REQUIRED_ENV.filter((k) => !process.env[k]);
if (missing.length > 0) {
  console.error(`❌ Missing required environment variables: ${missing.join(', ')}`);
  process.exit(1);
}

if (process.env.NODE_ENV === 'production' && process.env.ALLOWED_ORIGINS === '*') {
  console.warn('⚠️  ALLOWED_ORIGINS=* in production — consider restricting to your Flutter web domain.');
}

// Trust Render/Railway proxy — fixes express-rate-limit X-Forwarded-For error
app.set('trust proxy', 1);

// ── Middleware (order is critical) ────────────────────────────────────────────

// 1. Request ID + logging
app.use(requestLogger);

// 2. CORS — MUST be first middleware before body parser and rate limiter.
//    Reason: if body parser rejects with 413 (payload too large) before CORS runs,
//    the error response has no Access-Control-Allow-Origin header.
//    The browser then treats it as a CORS violation → XMLHttpRequest error in Flutter web.
//    Putting CORS first ensures ALL responses (including errors) carry CORS headers.
const rawOrigins    = process.env.ALLOWED_ORIGINS ?? '*';
const allowedOrigins = rawOrigins.split(',').map((o) => o.trim());

app.use(
  cors({
    origin: allowedOrigins.includes('*')
      ? '*'
      : (origin, callback) => {
          if (!origin) return callback(null, true);
          if (allowedOrigins.includes(origin)) return callback(null, true);
          callback(new Error(`CORS blocked: origin "${origin}" not in ALLOWED_ORIGINS`));
        },
    methods:        ['GET', 'POST', 'OPTIONS'],
    allowedHeaders: ['Content-Type'],
  }),
);

// 3. Rate limiting
app.use(generalLimiter);

// 4. JSON body parser — 5mb allows large AI prompts that include full resume text.
//    AI prompts with resume (~5kb) + instructions (~3kb) = 8-15kb easily.
//    Payment endpoints only send a plan key (~30 bytes), so 5mb doesn't loosen security there.
app.use(express.json({ limit: '5mb' }));

// ── Routes ────────────────────────────────────────────────────────────────────

app.get('/', (req, res) => {
  res.json({
    status:      'ok',
    service:     'Resume AI Payment Backend',
    environment: process.env.NODE_ENV || 'development',
    uptime_sec:  Math.floor(process.uptime()),
    version:     process.env.npm_package_version || '1.0.0',
  });
});

// Payment routes
app.use('/api/payment', paymentRoutes);

// AI proxy — Flutter calls this; backend calls Groq with server-side key
app.use('/api/ai', aiRoutes);

// Human review — multipart PDF upload + email
// Note: express.json() is NOT applied inside multer routes (multer handles parsing)
app.use('/api/human-review', humanReviewRoutes);

// ── 404 handler ───────────────────────────────────────────────────────────────
app.use((req, res) => {
  res.status(404).json({ error: `Route not found: ${req.method} ${req.path}` });
});

// ── Global error handler ──────────────────────────────────────────────────────
// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  const status = err.status || 500;
  console.error(`[${req.requestId}] 💥 Unhandled error (${status}): ${err.message}`);
  res.status(status).json({
    error: status === 500 ? 'Internal server error' : err.message,
  });
});

// ── Start server ──────────────────────────────────────────────────────────────
app.listen(PORT, () => {
  verifyEmailer();
  console.log(`\n✅ Resume AI backend running`);
  console.log(`   Port:    ${PORT}`);
  console.log(`   Mode:    ${process.env.NODE_ENV || 'development'}`);
  console.log(`   Origins: ${rawOrigins}`);
  console.log(`   Razorpay key: ${process.env.RAZORPAY_KEY_ID?.slice(0, 12)}...\n`);
});

// ── Keep-alive ping (Render free tier) ───────────────────────────────────────
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
