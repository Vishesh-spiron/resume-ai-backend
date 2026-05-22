# Resume AI Backend — Setup & Deployment Guide

---

## ⚠️ Critical: Credentials Security

**Never commit `.env` to Git.** It is already in `.gitignore`, but double-check:

```bash
git status   # .env must NOT appear here
```

If you accidentally committed it:
```bash
git rm --cached .env
git commit -m "Remove .env from tracking"
# Then rotate your Razorpay keys immediately at dashboard.razorpay.com
```

---

## 📁 Project Structure

```
resume_ai_backend/
├── index.js                          ← Entry point
├── package.json
├── .env                              ← Your secrets (never commit)
├── .env.example                      → Safe template (commit this)
├── .gitignore
├── DEPLOY.md
└── src/
    ├── config/
    │   └── razorpay.js               ← Razorpay SDK init
    ├── controllers/
    │   └── paymentController.js      ← Order creation + HMAC verify
    ├── middleware/
    │   ├── validate.js               ← Request validation + pricing
    │   ├── rateLimit.js              ← Rate limiting (new)
    │   └── logger.js                 ← Request ID + timing logs (new)
    └── routes/
        └── paymentRoutes.js          ← Route → middleware → controller
```

---

## ⚙️ Step 1 — Run Locally

```bash
cd resume_ai_backend

# Install all dependencies (including new express-rate-limit)
npm install

# Copy template and fill in your keys
cp .env.example .env
# Edit .env → add your real RAZORPAY_KEY_ID and RAZORPAY_KEY_SECRET

# Start in dev mode (auto-restarts on file changes)
npm run dev

# You should see:
# ✅ Resume AI backend running
#    Port:    3000
#    Mode:    development
#    Origins: *
#    Razorpay key: rzp_test_xxx...
```

**Test with curl:**
```bash
# Health check
curl http://localhost:3000/
# → { "status": "ok", "uptime_sec": 12, ... }

# Create order
curl -X POST http://localhost:3000/api/payment/create-order \
  -H "Content-Type: application/json" \
  -d '{"plan": "fixResume"}'
# → { "success": true, "order_id": "order_xxx", "amount": 3900, ... }

# Test rate limiting (run 11+ times — 11th should return 429)
for i in {1..12}; do
  curl -s -o /dev/null -w "%{http_code}\n" \
    -X POST http://localhost:3000/api/payment/create-order \
    -H "Content-Type: application/json" \
    -d '{"plan": "fixResume"}'
done
```

---

## ☁️ Step 2 — Deploy

### Option A: Render (free tier, recommended)

1. Push backend to its own GitHub repo:
```bash
cd resume_ai_backend
git init
git add .
git commit -m "Initial backend"
# Create repo at github.com, then:
git remote add origin https://github.com/YOUR/resume-ai-backend.git
git push -u origin main
```

2. Go to [render.com](https://render.com) → New → Web Service → connect repo

| Setting | Value |
|---------|-------|
| Runtime | Node |
| Region | Singapore (closest to India) |
| Build command | `npm install` |
| Start command | `npm start` |
| Plan | Free |

3. Add Environment Variables in Render dashboard:

| Key | Value |
|-----|-------|
| `RAZORPAY_KEY_ID` | `rzp_test_xxxxxxxx` |
| `RAZORPAY_KEY_SECRET` | `xxxxxxxxxxxxxxxx` |
| `ALLOWED_ORIGINS` | `*` (dev) or your Flutter web URL (prod) |
| `NODE_ENV` | `production` |

4. After deploy, copy your URL: `https://resume-ai-backend-xxxx.onrender.com`

### Option B: Railway (better free tier limits)

```bash
npm install -g @railway/cli
railway login
railway init
railway up
# Add env vars: railway variables set RAZORPAY_KEY_ID=xxx RAZORPAY_KEY_SECRET=xxx NODE_ENV=production
```

---

## 📱 Step 3 — Update Flutter

Open your Flutter `.env`:
```env
RAZORPAY_KEY_ID=rzp_test_xxxxxxxx
BACKEND_URL=https://your-backend.onrender.com   ← add/update this
```

Rebuild:
```bash
flutter clean && flutter pub get
flutter run -d chrome   # web
flutter run             # mobile
```

---

## 🔄 Payment Flow

### Web (full verification):
```
Flutter → POST /create-order → backend creates Razorpay order
        → Razorpay Checkout.js modal
        → user pays
        → Flutter → POST /verify-payment → backend verifies HMAC → { success: true }
        → Flutter unlocks feature ✅
```

### Mobile (native plugin):
```
Flutter → POST /create-order → backend creates Razorpay order
        → native Razorpay plugin modal
        → user pays
        → plugin fires PaymentSuccessResponse → Flutter unlocks feature ✅
```

> ⚠️ **Mobile verify gap**: The mobile flow currently trusts the native plugin's
> success callback without calling `/verify-payment`. For a low-price app (₹39-₹129)
> the risk is low, but for higher-value transactions you should call
> `/verify-payment` after the mobile plugin succeeds, the same way the web flow does.

---

## 🔒 Security Summary

| Layer | What it does |
|-------|-------------|
| `.gitignore` | Prevents `.env` from being committed |
| `validate.js` | Input sanitization + server-side pricing |
| `rateLimit.js` | 60 req/min general, 10/15min payment, 5/15min verify |
| `paymentController.js` | `timingSafeEqual` prevents timing attacks on HMAC |
| CORS | Restricts which origins can call the API |
| Body size limit | `10kb` max prevents large payload attacks |

---

## 🚀 Going Live (Real Money)

1. Complete KYC on [Razorpay Dashboard](https://dashboard.razorpay.com)
2. Get Live keys (`rzp_live_` prefix)
3. Update Render env vars: `RAZORPAY_KEY_ID` + `RAZORPAY_KEY_SECRET`
4. Update Flutter `.env`: `RAZORPAY_KEY_ID=rzp_live_xxx`
5. Set `ALLOWED_ORIGINS` to your real Flutter web domain
6. Redeploy — **no code changes needed**

---

## ❌ Common Errors

| Error | Fix |
|-------|-----|
| `Missing required environment variables` | Add `RAZORPAY_KEY_ID` and `RAZORPAY_KEY_SECRET` to Render env vars |
| `CORS blocked` | Add your Flutter web URL to `ALLOWED_ORIGINS` in Render |
| 429 Too Many Requests | Rate limit hit — wait the window and retry |
| `order_id not found` | Check `BACKEND_URL` in Flutter `.env` points to deployed backend |
| Render shows 502 | Check Render logs → usually a missing env variable |
| `Invalid plan` | Plan key sent by Flutter doesn't match `VALID_PLANS` in `validate.js` |
