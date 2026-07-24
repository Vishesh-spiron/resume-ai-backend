// ─────────────────────────────────────────────────────────────────────────────
// src/controllers/referralController.js
// Phase 1: checking a code is real, and linking a brand-new account to its
// referrer exactly once.
// Phase 2: pricing quotes (for display before checkout) and wallet reads
// (releasing matured holds on access) — the actual discount/commission
// writes live in paymentController.js + referralEngine.js.
// ─────────────────────────────────────────────────────────────────────────────

const { admin, db, isFirebaseReady } = require('../config/firebaseAdmin');
const { PLAN_AMOUNTS, VALID_PLANS } = require('../middleware/validate');
const { evaluateDiscount, releaseMaturedHolds, getCampaignConfig, createWithdrawalRequest } = require('../services/referralEngine');
const { queueNotification, getUnreadNotifications, markAllNotificationsRead } = require('../services/notificationService');

const CODE_FORMAT = /^[A-Z0-9]{4,20}$/;

function sanitizeCode(raw) {
  return (raw || '').toString().trim().toUpperCase();
}

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/referral/validate-code
// Public (no auth) — a visitor typing a code in during signup doesn't have
// an account yet. Returns only the referrer's display name, never their
// email/uid, to avoid leaking account data through this open endpoint.
// ─────────────────────────────────────────────────────────────────────────────
async function validateCode(req, res) {
  const { requestId } = req;
  const code = sanitizeCode(req.body?.code);

  if (!isFirebaseReady()) {
    return res.status(503).json({ valid: false, error: 'Referral system is not configured on the server yet.' });
  }
  if (!code) {
    return res.status(400).json({ valid: false, error: 'Missing required field: code' });
  }
  if (!CODE_FORMAT.test(code)) {
    return res.json({ valid: false, error: 'That code doesn\u2019t look right.' });
  }

  try {
    const codeDoc = await db.collection('referral_codes').doc(code).get();
    if (!codeDoc.exists) {
      return res.json({ valid: false, error: 'Referral code not found.' });
    }

    const referrerUid = codeDoc.data().uid;
    const referrerDoc = await db.collection('users').doc(referrerUid).get();
    const referrerName = referrerDoc.exists ? (referrerDoc.data().name || 'a friend') : 'a friend';

    return res.json({ valid: true, referrerName });
  } catch (err) {
    console.error(`[${requestId}] \u274c validate-code error: ${err.message}`);
    return res.status(500).json({ valid: false, error: 'Could not validate referral code right now.' });
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/referral/attach          (requires Authorization: Bearer <token>)
// Links req.uid (the newly-created account, from the verified token — never
// trust a uid in the body) to the referrer behind `code`. Runs inside a
// Firestore transaction so a double-click or retry can never attach twice or
// credit totalReferrals twice.
//
// Anti-fraud rules enforced here (server-side, per spec):
//   - Referral code must exist
//   - Caller cannot refer themselves
//   - One referral per account, and it can never be changed afterwards
// ─────────────────────────────────────────────────────────────────────────────
async function attachReferral(req, res) {
  const { requestId, uid } = req;
  const code = sanitizeCode(req.body?.code);

  if (!code) {
    return res.status(400).json({ success: false, error: 'Missing required field: code' });
  }

  try {
    const codeDoc = await db.collection('referral_codes').doc(code).get();
    if (!codeDoc.exists) {
      return res.status(400).json({ success: false, error: 'Referral code not found.' });
    }
    const referrerUid = codeDoc.data().uid;

    if (referrerUid === uid) {
      return res.status(400).json({ success: false, error: 'You cannot refer yourself.' });
    }

    const userRef = db.collection('users').doc(uid);
    const referrerRef = db.collection('users').doc(referrerUid);

    const outcome = await db.runTransaction(async (tx) => {
      const [userSnap, referrerSnap] = await Promise.all([tx.get(userRef), tx.get(referrerRef)]);

      if (!userSnap.exists) return { status: 'USER_NOT_FOUND' };
      if (!referrerSnap.exists) return { status: 'REFERRER_NOT_FOUND' };
      if (userSnap.data().referredBy) return { status: 'ALREADY_LINKED' };

      tx.update(userRef, { referredBy: referrerUid });
      tx.update(referrerRef, { totalReferrals: admin.firestore.FieldValue.increment(1) });

      const eventRef = db.collection('referral_events').doc();
      tx.set(eventRef, {
        type: 'signup_linked',
        referrerUid,
        referredUid: uid,
        referralCode: code,
        createdAt: admin.firestore.FieldValue.serverTimestamp(),
      });

      const referredName = userSnap.data().name || 'Someone';
      queueNotification(tx, {
        uid: referrerUid,
        type: 'referral_signup',
        message: `\ud83c\udf89 ${referredName} just signed up using your referral code!`,
      });

      return { status: 'OK' };
    });

    switch (outcome.status) {
      case 'OK':
        console.log(`[${requestId}] \u2705 Referral attached | referrer=${referrerUid} referred=${uid}`);
        return res.json({ success: true, referrerUid });
      case 'ALREADY_LINKED':
        return res.status(409).json({ success: false, error: 'This account is already linked to a referral.' });
      case 'USER_NOT_FOUND':
        return res.status(404).json({ success: false, error: 'User profile not found yet \u2014 please try again in a moment.' });
      case 'REFERRER_NOT_FOUND':
        return res.status(400).json({ success: false, error: 'Referrer account no longer exists.' });
      default:
        return res.status(500).json({ success: false, error: 'Could not link referral right now.' });
    }
  } catch (err) {
    console.error(`[${requestId}] \u274c attach-referral error: ${err.message}`);
    return res.status(500).json({ success: false, error: 'Could not link referral right now.' });
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/referral/quote?plan=fixResume     (optionalAuth — req.uid may be unset)
// Pricing preview shown in the paywall sheet BEFORE the user taps "Pay".
// Uses the exact same evaluateDiscount() logic createOrder uses, so the
// quoted price and the actually-charged price can never drift apart.
// ─────────────────────────────────────────────────────────────────────────────
async function getQuote(req, res) {
  const { requestId, uid } = req;
  const plan = (req.query?.plan || '').toString();

  if (!VALID_PLANS.includes(plan)) {
    return res.status(400).json({ error: `Invalid plan "${plan}". Must be one of: ${VALID_PLANS.join(', ')}` });
  }

  const originalAmountPaise = PLAN_AMOUNTS[plan];

  if (!isFirebaseReady()) {
    // Referral system not configured yet — just the sticker price, no discount.
    return res.json({
      plan,
      originalAmount: originalAmountPaise / 100,
      finalAmount: originalAmountPaise / 100,
      discountPercent: 0,
      eligible: false,
    });
  }

  try {
    const result = await evaluateDiscount(uid, originalAmountPaise);
    return res.json({
      plan,
      originalAmount: originalAmountPaise / 100,
      finalAmount: result.finalAmountPaise / 100,
      discountPercent: result.discountPercent,
      eligible: result.eligible,
    });
  } catch (err) {
    console.error(`[${requestId}] \u274c get-quote error: ${err.message}`);
    // Fail safe to full price rather than blocking the paywall from rendering.
    return res.json({
      plan,
      originalAmount: originalAmountPaise / 100,
      finalAmount: originalAmountPaise / 100,
      discountPercent: 0,
      eligible: false,
    });
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/referral/wallet          (requires Authorization: Bearer <token>)
// Releases any matured commission holds for this user, then returns a full
// dashboard snapshot: wallet balances + the stats row (clicks, signups,
// first purchases, conversion rate) + minWithdrawal. One call, everything
// the Earn & Refer dashboard needs to render.
// ─────────────────────────────────────────────────────────────────────────────
async function getWallet(req, res) {
  const { requestId, uid } = req;

  try {
    await releaseMaturedHolds(uid);

    const userSnap = await db.collection('users').doc(uid).get();
    if (!userSnap.exists) {
      return res.status(404).json({ error: 'User profile not found.' });
    }
    const data = userSnap.data();
    const walletBalance = data.walletBalance || 0;
    const pendingBalance = data.pendingBalance || 0;
    const totalReferrals = data.totalReferrals || 0;
    const referralCode = data.referralCode || null;

    // Clicks live on the referral_codes doc (incremented by trackClick).
    let referralClicks = 0;
    if (referralCode) {
      const codeDoc = await db.collection('referral_codes').doc(referralCode).get();
      referralClicks = codeDoc.exists ? (codeDoc.data().clicks || 0) : 0;
    }

    // Count query — no extra field to keep in sync on every commission credit.
    const firstPurchasesSnap = await db.collection('referral_transactions')
      .where('referrerId', '==', uid)
      .count()
      .get();
    const firstPurchases = firstPurchasesSnap.data().count;

    const conversionRate = totalReferrals > 0 ? Math.round((firstPurchases / totalReferrals) * 1000) / 10 : 0;

    const config = await getCampaignConfig();

    const pendingWithdrawalSnap = await db.collection('withdrawal_requests')
      .where('userId', '==', uid)
      .where('status', '==', 'pending')
      .limit(1)
      .get();

    return res.json({
      referralCode,
      walletBalance,
      pendingBalance,
      withdrawableBalance: Math.max(0, walletBalance - pendingBalance),
      lifetimeEarnings: data.lifetimeEarnings || 0,
      minWithdrawal: config.minWithdrawal,
      hasPendingWithdrawal: !pendingWithdrawalSnap.empty,
      stats: {
        referralClicks,
        totalSignups: totalReferrals,
        firstPurchases,
        conversionRatePercent: conversionRate,
      },
    });
  } catch (err) {
    console.error(`[${requestId}] \u274c get-wallet error: ${err.message}`);
    return res.status(500).json({ error: 'Could not load wallet right now.' });
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/referral/history          (requires Authorization: Bearer <token>)
// The "Referral History" list — everyone this user has referred who went on
// to make a first purchase, most recent first.
// ─────────────────────────────────────────────────────────────────────────────
async function getReferralHistory(req, res) {
  const { requestId, uid } = req;

  try {
    const snap = await db.collection('referral_transactions')
      .where('referrerId', '==', uid)
      .orderBy('createdAt', 'desc')
      .limit(50)
      .get();

    const history = snap.docs.map((doc) => {
      const d = doc.data();
      return {
        id: doc.id,
        userName: d.referredUserName || 'A referred user',
        plan: d.planName,
        purchaseAmount: d.discountedAmount,
        commission: d.commission,
        date: d.createdAt ? d.createdAt.toDate().toISOString() : null,
        status: d.status, // 'pending' | 'completed' | 'refunded'
      };
    });

    return res.json({ history });
  } catch (err) {
    console.error(`[${requestId}] \u274c get-history error: ${err.message}`);
    return res.status(500).json({ error: 'Could not load referral history right now.' });
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/referral/track-click     (public — a visitor hasn't signed up yet)
// Fired once when someone lands on a ?ref= link. Feeds the "Referral Clicks"
// stat. Not money-related, so this stays lightweight and best-effort —
// nothing here can affect a balance, so there's no need for a transaction.
// ─────────────────────────────────────────────────────────────────────────────
async function trackClick(req, res) {
  const { requestId } = req;
  const code = sanitizeCode(req.body?.code);

  if (!isFirebaseReady() || !code || !CODE_FORMAT.test(code)) {
    // Never surface an error for this — it's a vanity metric, not core flow.
    return res.status(204).end();
  }

  try {
    const codeRef = db.collection('referral_codes').doc(code);
    const codeDoc = await codeRef.get();
    if (!codeDoc.exists) return res.status(204).end();

    await codeRef.update({ clicks: admin.firestore.FieldValue.increment(1) });
    await db.collection('referral_events').add({
      type: 'link_clicked',
      referralCode: code,
      referrerUid: codeDoc.data().uid,
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
    });

    return res.status(204).end();
  } catch (err) {
    console.warn(`[${requestId}] \u26a0\ufe0f track-click failed (non-critical): ${err.message}`);
    return res.status(204).end();
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/referral/withdraw          (requires Authorization: Bearer <token>)
// Creates a withdrawal request — doesn't move money (payouts stay manual for
// now, per spec). All the real validation (one pending request at a time,
// amount within bounds) lives in referralEngine.createWithdrawalRequest.
// ─────────────────────────────────────────────────────────────────────────────
async function requestWithdrawal(req, res) {
  const { requestId, uid } = req;
  const amount = Number(req.body?.amount);

  try {
    const result = await createWithdrawalRequest(uid, amount);
    if (!result.success) {
      return res.status(400).json({ success: false, error: result.error });
    }
    console.log(`[${requestId}] \ud83d\udce4 Withdrawal requested | uid=${uid} amount=\u20b9${amount}`);
    return res.json({ success: true, requestId: result.requestId });
  } catch (err) {
    console.error(`[${requestId}] \u274c request-withdrawal error: ${err.message}`);
    return res.status(500).json({ success: false, error: 'Could not submit withdrawal request right now.' });
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/referral/notifications          (requires Authorization: Bearer <token>)
// Unread notifications for events that happened while the user wasn't in the
// app (a referral signing up, a commission being credited). The dashboard
// shows these as snackbars on load, then calls mark-read below.
// ─────────────────────────────────────────────────────────────────────────────
async function getNotifications(req, res) {
  const { requestId, uid } = req;
  try {
    const notifications = await getUnreadNotifications(uid);
    return res.json({ notifications });
  } catch (err) {
    console.error(`[${requestId}] \u274c get-notifications error: ${err.message}`);
    return res.status(500).json({ notifications: [] });
  }
}

// POST /api/referral/notifications/mark-read     (requires auth)
// Marks ALL of this user's unread notifications as read — no IDs accepted
// from the client, so there's nothing to validate ownership of.
async function markNotificationsReadHandler(req, res) {
  const { requestId, uid } = req;
  try {
    const result = await markAllNotificationsRead(uid);
    return res.json({ success: true, updated: result.updated });
  } catch (err) {
    console.error(`[${requestId}] \u274c mark-notifications-read error: ${err.message}`);
    return res.status(500).json({ success: false });
  }
}

module.exports = {
  validateCode,
  attachReferral,
  getQuote,
  getWallet,
  getReferralHistory,
  trackClick,
  requestWithdrawal,
  getNotifications,
  markNotificationsRead: markNotificationsReadHandler,
};
