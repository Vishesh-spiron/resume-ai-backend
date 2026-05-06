# 🚀 Backend Setup + Render Deployment Guide

---

## 📁 Where to Put Each File

### Backend (completely separate from Flutter)
Create a NEW folder OUTSIDE your Flutter project:

```
resume_ai_backend/          ← NEW folder, NOT inside Flutter project
├── index.js
├── package.json
├── .env.example
├── .gitignore
└── src/
    ├── config/
    │   └── razorpay.js
    ├── controllers/
    │   └── paymentController.js
    ├── middleware/
    │   └── validate.js
    └── routes/
        └── paymentRoutes.js
```

### Flutter changes (inside your existing Flutter project)
```
your_flutter_project/
├── .env                          ← ADD: BACKEND_URL=https://your-app.onrender.com
├── web/
│   └── index.html                ← REPLACE (has Razorpay Checkout.js script)
└── lib/
    └── core/
        └── services/
            ├── payment_service.dart       ← REPLACE (full web+mobile payment)
            ├── razorpay_web_stub.dart     ← NEW FILE
            └── js_stub.dart               ← NEW FILE
```

---

## ⚙️ Step 1 — Run Backend Locally

```bash
# 1. Go into backend folder
cd resume_ai_backend

# 2. Install dependencies
npm install

# 3. Create your .env from the example
cp .env.example .env

# 4. Open .env and fill in your Razorpay keys:
#    RAZORPAY_KEY_ID=rzp_test_xxxxxxxxxxxxxxxx
#    RAZORPAY_KEY_SECRET=xxxxxxxxxxxxxxxxxxxxxxxx
#    ALLOWED_ORIGINS=*
#    PORT=3000

# 5. Start server
npm start

# You should see:
# ✅ Resume AI backend running on port 3000
```

**Test it with curl:**
```bash
# Test create-order
curl -X POST http://localhost:3000/api/payment/create-order \
  -H "Content-Type: application/json" \
  -d '{"plan": "fixResume"}'

# Expected response:
# {
#   "success": true,
#   "order_id": "order_xxxxxxxxxxxx",
#   "amount": 3900,
#   "currency": "INR",
#   "plan": "fixResume",
#   "plan_name": "Fix My Resume",
#   "key_id": "rzp_test_xxx"
# }
```

---

## ☁️ Step 2 — Deploy on Render (Free)

### 2a. Push backend to GitHub

```bash
cd resume_ai_backend

# Initialize git (first time)
git init
git add .
git commit -m "Initial backend"

# Create a new repo on github.com then:
git remote add origin https://github.com/YOUR_USERNAME/resume-ai-backend.git
git push -u origin main
```

> ⚠️ Make sure `.gitignore` includes `.env` — NEVER push your secret key

### 2b. Create service on Render

1. Go to **[render.com](https://render.com)** → Sign up free
2. Click **"New +"** → **"Web Service"**
3. Connect your GitHub account → select `resume-ai-backend` repo
4. Fill in these settings:

| Field | Value |
|-------|-------|
| **Name** | `resume-ai-backend` (or anything) |
| **Region** | Singapore (closest to India) |
| **Branch** | `main` |
| **Runtime** | `Node` |
| **Build Command** | `npm install` |
| **Start Command** | `npm start` |
| **Plan** | Free |

5. Click **"Add Environment Variable"** and add:

| Key | Value |
|-----|-------|
| `RAZORPAY_KEY_ID` | `rzp_test_xxxxxxxx` |
| `RAZORPAY_KEY_SECRET` | `xxxxxxxxxxxxxxxx` |
| `ALLOWED_ORIGINS` | `*` (dev) or `https://your-flutter-web-url.com` (prod) |
| `NODE_ENV` | `production` |

6. Click **"Create Web Service"**
7. Wait ~2 minutes for deployment
8. Your backend URL will be: `https://resume-ai-backend-xxxx.onrender.com`

### 2c. Test deployed backend

```bash
curl https://resume-ai-backend-xxxx.onrender.com/
# { "status": "ok", "service": "Resume AI Payment Backend" }

curl -X POST https://resume-ai-backend-xxxx.onrender.com/api/payment/create-order \
  -H "Content-Type: application/json" \
  -d '{"plan": "bundle"}'
```

---

## 📱 Step 3 — Update Flutter .env

Open your Flutter `.env` file and add/update:

```env
# Existing keys (keep these)
GROQ_API_KEY=gsk_xxxxxxxx
RAZORPAY_KEY_ID=rzp_test_xxxxxxxx

# NEW — your Render backend URL
BACKEND_URL=https://resume-ai-backend-xxxx.onrender.com
```

Then rebuild Flutter:
```bash
flutter clean
flutter pub get
flutter run -d chrome   # test web
flutter run             # test mobile
```

---

## 🔄 How the Payment Flow Works

### Web Flow:
```
User taps "Pay ₹39"
    ↓
Flutter → POST /api/payment/create-order {"plan": "fixResume"}
    ↓
Backend creates Razorpay order → returns order_id
    ↓
Flutter opens Razorpay Checkout.js modal (browser popup)
    ↓
User pays via UPI / Card / NetBanking
    ↓
Checkout.js calls Flutter handler with {payment_id, signature}
    ↓
Flutter → POST /api/payment/verify-payment {order_id, payment_id, signature}
    ↓
Backend verifies HMAC signature → returns {success: true}
    ↓
Flutter unlocks the feature ✅
```

### Mobile Flow:
```
User taps "Pay ₹39"
    ↓
Flutter → POST /api/payment/create-order {"plan": "fixResume"}
    ↓
Backend creates Razorpay order → returns order_id
    ↓
Flutter opens native Razorpay plugin with order_id
    ↓
User pays via native checkout
    ↓
Plugin returns success → Flutter unlocks feature ✅
```

---

## 🔒 Security Notes

| What | Why it's secure |
|------|----------------|
| Secret key only in backend `.env` | Never sent to Flutter or browser |
| Server sets the price, not client | Flutter sends plan name, backend looks up price |
| HMAC verification on backend | Prevents fake payment confirmations |
| `timingSafeEqual` for signature | Prevents timing attacks |
| `.env` in `.gitignore` | Keys never pushed to GitHub |

---

## ❌ Common Errors

| Error | Fix |
|-------|-----|
| `CORS blocked` | Add your Flutter web URL to `ALLOWED_ORIGINS` in Render env vars |
| `RAZORPAY_KEY_SECRET missing` | Add it to Render environment variables |
| `Checkout.js not loaded` | Ensure `<script src="...checkout.js">` is in `web/index.html` |
| `order_id not found` | Backend must be running and `BACKEND_URL` in Flutter `.env` must be correct |
| Render shows 502 | Check Render logs → usually a missing env variable |

---

## 💡 Going Live (Real Money)

1. Complete KYC on [Razorpay Dashboard](https://dashboard.razorpay.com)
2. Get Live keys (start with `rzp_live_`)
3. Update Render env vars: `RAZORPAY_KEY_ID` and `RAZORPAY_KEY_SECRET`
4. Update Flutter `.env`: `RAZORPAY_KEY_ID=rzp_live_xxx`
5. Change `ALLOWED_ORIGINS` to your real domain
6. Rebuild and redeploy — **no code changes needed**
