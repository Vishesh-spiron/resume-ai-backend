// Server-side feature gate. Usage (after requireAuth):
//   router.post('/x', requireAuth, requireEntitlement('human_expert_review'), handler)
// NOT yet mounted on existing routes: current Android/web clients do not send
// Firebase tokens to /api/ai/chat or /api/human-review, and Razorpay (web)
// purchases are not recorded in the Play entitlement store. See BILLING_SETUP.md.
const { db } = require('../config/firebaseAdmin');
const { createFirestoreStore } = require('../services/playPurchaseStore');

function requireEntitlement(entitlement, { store = createFirestoreStore(db) } = {}) {
  return async (req, res, next) => {
    if (!req.uid) return res.status(401).json({ success: false, error: 'Please sign in.' });
    try {
      const doc = await store.getEntitlements(req.uid);
      if (doc?.entitlements?.includes(entitlement)) return next();
      return res.status(403).json({ success: false, code: 'ENTITLEMENT_REQUIRED', error: 'This feature requires a purchase.' });
    } catch (err) {
      return res.status(503).json({ success: false, error: 'Could not verify access.' });
    }
  };
}
module.exports = { requireEntitlement };
