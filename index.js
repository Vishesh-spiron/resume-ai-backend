// ─────────────────────────────────────────────────────────────────────────────
// index.js — Entry point for Resume AI backend
// Handles Razorpay order creation and payment verification
// ─────────────────────────────────────────────────────────────────────────────

require('dotenv').config(); // Load .env variables before anything else

const express = require('express');
const cors    = require('cors');

const paymentRoutes = require('./src/routes/paymentRoutes');

const app  = express();
const PORT = process.env.PORT || 3000;

// ── Middleware ────────────────────────────────────────────────────────────────

// Parse JSON request bodies
app.use(express.json());

// CORS — allow Flutter web and mobile to call this backend
// In production: replace '*' with your actual Flutter web domain
const allowedOrigins = process.env.ALLOWED_ORIGINS
  ? process.env.ALLOWED_ORIGINS.split(',').map(o => o.trim())
  : ['*'];

app.use(cors({
  origin: allowedOrigins.includes('*') ? '*' : function (origin, callback) {
    // Allow requests with no origin (mobile apps, Postman)
    if (!origin) return callback(null, true);
    if (allowedOrigins.includes(origin)) return callback(null, true);
    callback(new Error(`CORS blocked: origin ${origin} not allowed`));
  },
  methods: ['GET', 'POST'],
  allowedHeaders: ['Content-Type'],
}));

// ── Routes ────────────────────────────────────────────────────────────────────

// Health check — Render uses this to verify the server is alive
app.get('/', (req, res) => {
  res.json({ status: 'ok', service: 'Resume AI Payment Backend' });
});

// All payment routes under /api/payment
app.use('/api/payment', paymentRoutes);

// ── 404 handler ───────────────────────────────────────────────────────────────
app.use((req, res) => {
  res.status(404).json({ error: 'Route not found' });
});

// ── Global error handler ──────────────────────────────────────────────────────
app.use((err, req, res, next) => {
  console.error('Unhandled error:', err.message);
  res.status(500).json({ error: 'Internal server error' });
});

// ── Start server ──────────────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`✅ Resume AI backend running on port ${PORT}`);
  console.log(`   Mode: ${process.env.NODE_ENV || 'development'}`);
});
