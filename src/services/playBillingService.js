// ─────────────────────────────────────────────────────────────────────────────
// src/services/playBillingService.js
//
// Server-side Google Play Billing logic. The client is never trusted: every
// grant is backed by a purchase Google itself confirms through the Play
// Developer API (purchases.productsv2.getproductpurchasev2).
//
// Dependencies are injected so the whole flow is unit-testable with a mocked
// Google client and an in-memory store (see test/).
// ─────────────────────────────────────────────────────────────────────────────

const crypto = require('crypto');
const { getProduct } = require('../config/playCatalog');

// Current (v2) API enum strings.
const STATE_PURCHASED = 'PURCHASED';
const STATE_PENDING = 'PENDING';
const STATE_CANCELLED = 'CANCELLED';
const ACK_DONE = 'ACKNOWLEDGEMENT_STATE_ACKNOWLEDGED';

const DEFAULT_REVALIDATE_MS = 12 * 60 * 60 * 1000;
const MAX_REVALIDATE_PER_REQUEST = 5;

class BillingError extends Error {
  constructor(code, httpStatus, message, extra = {}) {
    super(message);
    this.code = code;
    this.httpStatus = httpStatus;
    Object.assign(this, extra);
  }
}

const tokenId = (token) => crypto.createHash('sha256').update(token).digest('hex');
const shortId = (id) => String(id).slice(0, 8); // safe-to-log reference

function googleStatus(err) {
  return Number(err?.code || err?.response?.status || err?.status) || 0;
}

// Map a Google API failure to a BillingError. Anything we cannot positively
// classify as "this purchase is bad" is TEMPORARY, so a transient outage can
// never be reported to the user as a failed payment.
function mapGoogleError(err) {
  const status = googleStatus(err);
  if (status === 400 || status === 404 || status === 410) {
    return new BillingError('INVALID_PURCHASE', 400, 'Purchase could not be verified.');
  }
  if (status === 401 || status === 403) {
    return new BillingError(
      'BILLING_MISCONFIGURED',
      503,
      'Purchase verification is temporarily unavailable.',
      { retryable: true, misconfigured: true },
    );
  }
  return new BillingError(
    'VERIFICATION_UNAVAILABLE',
    503,
    'Purchase verification is temporarily unavailable. Please try again shortly.',
    { retryable: true },
  );
}

function createPlayBillingService({
  store,
  getPublisher,
  packageName,
  now = () => Date.now(),
  logger = console,
  revalidateAfterMs = DEFAULT_REVALIDATE_MS,
  hooks = {}, // { onPurchaseRecorded, onPurchaseVoided } — best-effort bookkeeping
}) {
  const log = (level, msg) => logger[level]?.(`[billing] ${msg}`);

  async function fetchPurchase(purchaseToken) {
    try {
      const { data } = await getPublisher().purchases.productsv2.getproductpurchasev2({
        packageName,
        token: purchaseToken,
      });
      return data;
    } catch (err) {
      throw mapGoogleError(err);
    }
  }

  const stateOf = (purchase) => purchase?.purchaseStateContext?.purchaseState || null;

  // Exactly one line item, for exactly the product the client claimed.
  function lineItemFor(purchase, productId) {
    const items = purchase?.productLineItem || [];
    return items.length === 1 && items[0]?.productId === productId ? items[0] : null;
  }

  async function ensureAcknowledged(productId, purchaseToken, purchase) {
    if (purchase?.acknowledgementState === ACK_DONE) return true;
    try {
      await getPublisher().purchases.products.acknowledge({
        packageName,
        productId,
        token: purchaseToken,
        requestBody: {},
      });
      return true;
    } catch (err) {
      // Race: the device (completePurchase) or another request got there first.
      try {
        const fresh = await fetchPurchase(purchaseToken);
        if (fresh?.acknowledgementState === ACK_DONE) return true;
      } catch (_) { /* fall through */ }
      log('warn', `acknowledge failed (${googleStatus(err)}) token=${shortId(tokenId(purchaseToken))}`);
      return false;
    }
  }

  async function snapshot(uid) {
    const ent = await store.recomputeEntitlements(uid, now());
    return { entitlements: ent.entitlements, products: ent.products };
  }

  // ── POST /verify ──────────────────────────────────────────────────────────
  async function verifyAndGrant({ uid, productId, purchaseToken }) {
    const product = getProduct(productId);
    if (!product) throw new BillingError('UNKNOWN_PRODUCT', 400, 'Unknown product.');
    if (!uid) throw new BillingError('UNAUTHENTICATED', 401, 'Sign in required.');

    const id = tokenId(purchaseToken);
    let existing = await store.getPurchase(id);

    const handleExisting = async (rec) => {
      if (rec.uid !== uid) {
        log('warn', `token ${shortId(id)} already linked to another account`);
        throw new BillingError('LINKED_TO_OTHER_ACCOUNT', 409,
          'This purchase is already associated with another account.');
      }
      if (rec.productId !== productId) {
        throw new BillingError('PRODUCT_MISMATCH', 400, 'Purchase does not match this product.');
      }
      if (rec.status === 'refunded' || rec.status === 'revoked' || rec.status === 'canceled') {
        throw new BillingError('PURCHASE_REVOKED', 403, 'This purchase was refunded or revoked.', {
          ...(await snapshot(uid)),
        });
      }
      // Stale record (e.g. restore after a long time): re-check with Google so a
      // refund that was never notified is still caught. Temporary Google
      // failures here must not block a purchase we already verified.
      if (now() - (rec.lastSyncedAtMs || 0) > revalidateAfterMs) {
        try {
          const synced = await syncPurchase(purchaseToken);
          if (synced.status === 'revoked') {
            throw new BillingError('PURCHASE_REVOKED', 403, 'This purchase was refunded or revoked.', {
              ...(await snapshot(uid)),
            });
          }
        } catch (err) {
          if (err instanceof BillingError && err.code === 'PURCHASE_REVOKED') throw err;
          log('warn', `revalidation skipped: ${err.code || err.message}`);
        }
      }
      // Active duplicate/replay: idempotent. Retry acknowledgement if it never landed.
      let acknowledged = rec.acknowledged === true;
      if (!acknowledged) {
        const purchase = await fetchPurchase(purchaseToken);
        acknowledged = await ensureAcknowledged(productId, purchaseToken, purchase);
        if (acknowledged) await store.updatePurchase(id, { acknowledged: true, updatedAtMs: now() });
      }
      return { alreadyRecorded: true, acknowledged, status: 'active', ...(await snapshot(uid)) };
    };

    if (existing) return handleExisting(existing);

    const purchase = await fetchPurchase(purchaseToken);

    const item = lineItemFor(purchase, productId);
    if (!item) {
      log('warn', `product mismatch for token ${shortId(id)} (claimed ${productId})`);
      throw new BillingError('PRODUCT_MISMATCH', 400, 'Purchase does not match this product.');
    }
    const state = stateOf(purchase);
    if (state === STATE_PENDING) {
      throw new BillingError('PURCHASE_PENDING', 202, 'Payment is still pending with Google Play.', {
        pending: true,
      });
    }
    if (state !== STATE_PURCHASED) {
      throw new BillingError('PURCHASE_NOT_COMPLETED', 400, 'This purchase was canceled or refunded.');
    }

    // Account binding: the app sets obfuscatedAccountId = Firebase uid at purchase time.
    const boundTo = purchase.obfuscatedExternalAccountId || null;
    if (boundTo && boundTo !== uid) {
      log('warn', `token ${shortId(id)} bound to a different account id`);
      throw new BillingError('LINKED_TO_OTHER_ACCOUNT', 409,
        'This purchase is already associated with another account.');
    }

    const t = now();
    const created = await store.createPurchase(id, {
      uid,
      productId,
      status: 'active',
      orderId: purchase.orderId || null,
      acknowledged: false,
      accountBound: Boolean(boundTo),
      isTestPurchase: Boolean(purchase.testPurchaseContext),
      verifiedAtMs: t,
      lastSyncedAtMs: t,
      createdAtMs: t,
      updatedAtMs: t,
    });
    if (!created) {
      // Lost a race with a concurrent request for the same token.
      return handleExisting(await store.getPurchase(id));
    }

    const snap = await snapshot(uid);

    // Acknowledge ONLY now that the purchase is verified, completed and recorded.
    const acknowledged = await ensureAcknowledged(productId, purchaseToken, purchase);
    if (acknowledged) await store.updatePurchase(id, { acknowledged: true, updatedAtMs: now() });

    try {
      await hooks.onPurchaseRecorded?.({ uid, productId, purchaseId: id, orderId: purchase.orderId || '' });
    } catch (err) {
      log('error', `post-purchase bookkeeping failed (entitlement still granted): ${err.message}`);
    }

    log('info', `verified product=${productId} uid=${uid} token=${shortId(id)}${purchase.testPurchaseContext ? ' (test)' : ''}`);
    return { alreadyRecorded: false, acknowledged, status: 'active', ...snap };
  }

  // ── Revocation ────────────────────────────────────────────────────────────
  async function revoke(id, status, reason) {
    const rec = await store.getPurchase(id);
    if (!rec) return { found: false };
    if (rec.status === 'active') {
      const t = now();
      await store.updatePurchase(id, { status, revokeReason: reason, revokedAtMs: t, updatedAtMs: t });
      await store.recomputeEntitlements(rec.uid, t);
      try {
        await hooks.onPurchaseVoided?.({ uid: rec.uid, purchaseId: id });
      } catch (err) {
        log('error', `commission reversal failed: ${err.message}`);
      }
      log('info', `purchase ${shortId(id)} ${status} (${reason})`);
    }
    return { found: true, uid: rec.uid };
  }

  // Re-check one recorded purchase against Google (used for lazy revalidation
  // and for PURCHASED notifications).
  async function syncPurchase(purchaseToken) {
    const id = tokenId(purchaseToken);
    const rec = await store.getPurchase(id);
    if (!rec) return { found: false };
    let purchase;
    try {
      purchase = await fetchPurchase(purchaseToken);
    } catch (err) {
      if (err.code === 'INVALID_PURCHASE' && rec.status === 'active') {
        // Google no longer recognises the token: treat as revoked.
        await revoke(id, 'revoked', 'token_no_longer_valid');
        return { found: true, status: 'revoked' };
      }
      throw err;
    }
    const state = stateOf(purchase);
    if (state === STATE_CANCELLED) {
      await revoke(id, 'revoked', 'google_state_cancelled');
      return { found: true, status: 'revoked' };
    }
    const patch = { lastSyncedAtMs: now(), updatedAtMs: now() };
    if (state === STATE_PURCHASED && rec.status === 'active' && !rec.acknowledged) {
      if (await ensureAcknowledged(rec.productId, purchaseToken, purchase)) patch.acknowledged = true;
    }
    await store.updatePurchase(id, patch);
    return { found: true, status: rec.status };
  }

  // ── GET /entitlements ─────────────────────────────────────────────────────
  // Server-authoritative. Also lazily re-validates stale purchases so refunds
  // are reflected even if Pub/Sub notifications are not configured yet. Only
  // token hashes are stored (never raw tokens), so re-checking with Google
  // happens when the client re-presents a token (restore/verify) or via RTDN /
  // reconcileVoided. This endpoint recomputes from the stored records.
  async function getEntitlementsForUser(uid) {
    return snapshot(uid);
  }

  // ── Voided purchases (refunds / chargebacks) ──────────────────────────────
  async function markVoidedByToken(purchaseToken, reason = 'voided') {
    return revoke(tokenId(purchaseToken), 'refunded', reason);
  }

  // Poll Google's voided-purchases list — backup path to RTDN.
  async function reconcileVoided({ startTimeMs, maxPages = 10 } = {}) {
    let pageToken;
    let seen = 0;
    let revoked = 0;
    for (let page = 0; page < maxPages; page += 1) {
      let data;
      try {
        ({ data } = await getPublisher().purchases.voidedpurchases.list({
          packageName,
          type: 0, // in-app products only
          startTime: startTimeMs ? String(startTimeMs) : undefined,
          token: pageToken,
        }));
      } catch (err) {
        throw mapGoogleError(err);
      }
      for (const v of data?.voidedPurchases || []) {
        seen += 1;
        if (!v.purchaseToken) continue;
        const r = await markVoidedByToken(v.purchaseToken, `voided_reason_${v.voidedReason ?? 'unknown'}`);
        if (r.found) revoked += 1;
      }
      pageToken = data?.tokenPagination?.nextPageToken;
      if (!pageToken) break;
    }
    return { seen, matched: revoked };
  }

  // ── Real-time developer notifications ─────────────────────────────────────
  // Returns { handled, reason }. THROWS a BillingError with retryable=true on
  // temporary failures so the HTTP layer can ask Pub/Sub to redeliver.
  async function handleNotification({ messageId, payload }) {
    if (messageId && (await store.hasNotification(messageId))) {
      return { handled: false, reason: 'duplicate' };
    }
    if (!payload || payload.packageName !== packageName) {
      log('warn', 'RTDN for unexpected package ignored');
      return { handled: false, reason: 'wrong_package' };
    }

    let reason = 'ignored';
    if (payload.voidedPurchaseNotification?.purchaseToken) {
      const v = payload.voidedPurchaseNotification;
      // productType 2 = one-time product; refundType 2 = quantity-based partial.
      if (v.productType === 2 && v.refundType !== 2) {
        await markVoidedByToken(v.purchaseToken, 'rtdn_voided');
        reason = 'voided';
      }
    } else if (payload.oneTimeProductNotification?.purchaseToken) {
      const n = payload.oneTimeProductNotification;
      if (n.notificationType === 2) {
        // ONE_TIME_PRODUCT_CANCELED (pending purchase canceled)
        await revoke(tokenId(n.purchaseToken), 'canceled', 'rtdn_canceled');
        reason = 'canceled';
      } else if (n.notificationType === 1) {
        // ONE_TIME_PRODUCT_PURCHASED: never grants (no uid here) — only heals
        // acknowledgement/state of a purchase the user already verified.
        await syncPurchase(n.purchaseToken);
        reason = 'synced';
      }
    } else if (payload.testNotification) {
      reason = 'test';
    }

    if (messageId) await store.markNotification(messageId, now());
    return { handled: true, reason };
  }

  return {
    verifyAndGrant,
    getEntitlementsForUser,
    handleNotification,
    reconcileVoided,
    markVoidedByToken,
    syncPurchase,
    revalidateAfterMs,
    _tokenId: tokenId,
  };
}

module.exports = {
  createPlayBillingService,
  BillingError,
  tokenId,
  DEFAULT_REVALIDATE_MS,
  MAX_REVALIDATE_PER_REQUEST,
};
