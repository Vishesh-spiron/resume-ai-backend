// ─────────────────────────────────────────────────────────────────────────────
// src/services/playPurchaseStore.js
//
// Persistence for Google Play purchases and derived entitlements, kept behind
// a tiny interface so the billing logic can be unit-tested without Firestore.
// Uses the project's EXISTING database (Firestore via firebase-admin); no new
// database is introduced.
//
// Collections (all written ONLY by the backend via the Admin SDK — clients get
// read-only access to their own entitlements doc, see BILLING_SETUP.md):
//
//   playPurchases/{sha256(purchaseToken)}
//       uid, productId, status ('active'|'refunded'|'revoked'|'canceled'),
//       orderId, acknowledged, accountBound, isTestPurchase,
//       verifiedAtMs, lastSyncedAtMs, createdAtMs, updatedAtMs,
//       revokedAtMs?, revokeReason?
//     The doc id IS the uniqueness constraint: create() fails if the token was
//     ever seen, so one token can never be attached to two accounts and a
//     duplicate delivery can never grant twice. The raw token is never stored.
//
//   entitlements/{uid}
//       entitlements[], products[], updatedAtMs
//     Always RECOMPUTED from the user's active playPurchases (never
//     incremented), so it can be rebuilt/reconciled at any time.
//
//   playNotifications/{pubsubMessageId}
//       processedAtMs     (RTDN de-duplication marker)
// ─────────────────────────────────────────────────────────────────────────────

const { computeEntitlements } = require('../config/playCatalog');

const PURCHASES = 'playPurchases';
const ENTITLEMENTS = 'entitlements';
const NOTIFICATIONS = 'playNotifications';

// gRPC ALREADY_EXISTS (what Firestore's create() throws on a duplicate id).
const ALREADY_EXISTS = 6;

// ── Firestore implementation ────────────────────────────────────────────────
function createFirestoreStore(db) {
  const purchases = () => db.collection(PURCHASES);

  return {
    async getPurchase(id) {
      const snap = await purchases().doc(id).get();
      return snap.exists ? snap.data() : null;
    },

    // Atomic "insert if absent". Returns true when THIS call created it.
    async createPurchase(id, data) {
      try {
        await purchases().doc(id).create(data);
        return true;
      } catch (err) {
        if (err.code === ALREADY_EXISTS || /already exists/i.test(err.message || '')) {
          return false;
        }
        throw err;
      }
    },

    async updatePurchase(id, patch) {
      await purchases().doc(id).set(patch, { merge: true });
    },

    async listPurchasesByUid(uid) {
      const snap = await purchases().where('uid', '==', uid).get();
      return snap.docs.map((d) => ({ id: d.id, ...d.data() }));
    },

    async getEntitlements(uid) {
      const snap = await db.collection(ENTITLEMENTS).doc(uid).get();
      return snap.exists ? snap.data() : null;
    },

    // Recompute from ALL of the user's purchases inside a transaction so two
    // concurrent changes (e.g. a verify + a refund notification) cannot leave
    // a stale result behind.
    async recomputeEntitlements(uid, nowMs) {
      const ref = db.collection(ENTITLEMENTS).doc(uid);
      return db.runTransaction(async (tx) => {
        const snap = await tx.get(purchases().where('uid', '==', uid));
        const result = computeEntitlements(snap.docs.map((d) => d.data()));
        const doc = { ...result, updatedAtMs: nowMs };
        tx.set(ref, doc);
        return doc;
      });
    },

    async hasNotification(messageId) {
      const snap = await db.collection(NOTIFICATIONS).doc(messageId).get();
      return snap.exists;
    },

    async markNotification(messageId, nowMs) {
      await db.collection(NOTIFICATIONS).doc(messageId).set({ processedAtMs: nowMs });
    },
  };
}

// ── In-memory implementation (tests) ────────────────────────────────────────
function createMemoryStore() {
  const purchases = new Map();
  const entitlements = new Map();
  const notifications = new Map();
  const clone = (o) => (o == null ? o : JSON.parse(JSON.stringify(o)));

  return {
    _purchases: purchases,
    _entitlements: entitlements,

    async getPurchase(id) {
      return clone(purchases.get(id) || null);
    },
    async createPurchase(id, data) {
      if (purchases.has(id)) return false;
      purchases.set(id, clone(data));
      return true;
    },
    async updatePurchase(id, patch) {
      purchases.set(id, { ...(purchases.get(id) || {}), ...clone(patch) });
    },
    async listPurchasesByUid(uid) {
      return [...purchases.entries()]
        .filter(([, v]) => v.uid === uid)
        .map(([id, v]) => ({ id, ...clone(v) }));
    },
    async getEntitlements(uid) {
      return clone(entitlements.get(uid) || null);
    },
    async recomputeEntitlements(uid, nowMs) {
      const mine = [...purchases.values()].filter((p) => p.uid === uid);
      const doc = { ...computeEntitlements(mine), updatedAtMs: nowMs };
      entitlements.set(uid, doc);
      return clone(doc);
    },
    async hasNotification(id) {
      return notifications.has(id);
    },
    async markNotification(id, nowMs) {
      notifications.set(id, nowMs);
    },
  };
}

module.exports = { createFirestoreStore, createMemoryStore };
