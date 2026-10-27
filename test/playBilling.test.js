const test = require('node:test');
const assert = require('node:assert/strict');
const { setup, TOKEN, PKG, purchaseResponse, googleErr } = require('./helpers');
const { computeEntitlements, getProduct } = require('../src/config/playCatalog');

const T = TOKEN(1);
const rejects = (p, code) => assert.rejects(p, (e) => e.code === code);

test('valid purchase grants only its entitlements, acknowledges, and queries the right package', async () => {
  const { service, google, hookCalls } = setup({ [T]: purchaseResponse() });
  const r = await service.verifyAndGrant({ uid: 'user1', productId: 'fix_my_resume', purchaseToken: T });
  assert.deepEqual(r.entitlements, ['resume_improvement']);
  assert.equal(r.acknowledged, true);
  assert.equal(google.calls.get[0].packageName, PKG);
  assert.equal(google.calls.ack.length, 1);
  assert.equal(hookCalls.recorded.length, 1);
});

test('invalid token (Google 404/410) is rejected as invalid, not as a server fault', async () => {
  const { service } = setup({});
  await rejects(service.verifyAndGrant({ uid: 'user1', productId: 'fix_my_resume', purchaseToken: T }), 'INVALID_PURCHASE');
});

test('wrong product id (token is for a different product) is rejected and grants nothing', async () => {
  const { service, store } = setup({ [T]: purchaseResponse({ productLineItem: [{ productId: 'interview_prep' }] }) });
  await rejects(service.verifyAndGrant({ uid: 'user1', productId: 'full_bundle', purchaseToken: T }), 'PRODUCT_MISMATCH');
  assert.equal(store._purchases.size, 0);
});

test('unknown product id never reaches Google', async () => {
  const { service, google } = setup({});
  await rejects(service.verifyAndGrant({ uid: 'u', productId: 'fix_resume', purchaseToken: T }), 'UNKNOWN_PRODUCT');
  assert.equal(google.calls.get.length, 0);
});

test('wrong package: service always queries the configured package; RTDN for another package is ignored', async () => {
  const { service, store } = setup({});
  const r = await service.handleNotification({
    messageId: 'm1',
    payload: { packageName: 'com.attacker.app', voidedPurchaseNotification: { purchaseToken: T, productType: 2 } },
  });
  assert.equal(r.reason, 'wrong_package');
  assert.equal(store._purchases.size, 0);
});

test('pending purchase: no grant, no acknowledge, no record', async () => {
  const { service, google, store } = setup({ [T]: purchaseResponse({ purchaseStateContext: { purchaseState: 'PENDING' } }) });
  await assert.rejects(service.verifyAndGrant({ uid: 'user1', productId: 'fix_my_resume', purchaseToken: T }),
    (e) => e.code === 'PURCHASE_PENDING' && e.pending === true);
  assert.equal(google.calls.ack.length, 0);
  assert.equal(store._purchases.size, 0);
});

test('canceled purchase is rejected', async () => {
  const { service } = setup({ [T]: purchaseResponse({ purchaseStateContext: { purchaseState: 'CANCELLED' } }) });
  await rejects(service.verifyAndGrant({ uid: 'user1', productId: 'fix_my_resume', purchaseToken: T }), 'PURCHASE_NOT_COMPLETED');
});

test('duplicate token by same user is idempotent (one record, one ack, one commission)', async () => {
  const { service, google, store, hookCalls } = setup({ [T]: purchaseResponse() });
  const a = await service.verifyAndGrant({ uid: 'user1', productId: 'fix_my_resume', purchaseToken: T });
  const b = await service.verifyAndGrant({ uid: 'user1', productId: 'fix_my_resume', purchaseToken: T });
  assert.equal(b.alreadyRecorded, true);
  assert.deepEqual(a.entitlements, b.entitlements);
  assert.equal(store._purchases.size, 1);
  assert.equal(google.calls.ack.length, 1);
  assert.equal(hookCalls.recorded.length, 1);
});

test('concurrent duplicate requests create exactly one record', async () => {
  const { service, store, hookCalls } = setup({ [T]: purchaseResponse() });
  const args = { uid: 'user1', productId: 'fix_my_resume', purchaseToken: T };
  await Promise.all([service.verifyAndGrant(args), service.verifyAndGrant(args), service.verifyAndGrant(args)]);
  assert.equal(store._purchases.size, 1);
  assert.equal(hookCalls.recorded.length, 1);
});

test('token already linked to another account is refused (409) and does not change either account', async () => {
  const { service } = setup({ [T]: purchaseResponse({ obfuscatedExternalAccountId: null }) });
  await service.verifyAndGrant({ uid: 'user1', productId: 'fix_my_resume', purchaseToken: T });
  await rejects(service.verifyAndGrant({ uid: 'user2', productId: 'fix_my_resume', purchaseToken: T }), 'LINKED_TO_OTHER_ACCOUNT');
  assert.deepEqual((await service.getEntitlementsForUser('user2')).entitlements, []);
});

test('token bound by Google to a different account id is refused on first claim', async () => {
  const { service } = setup({ [T]: purchaseResponse({ obfuscatedExternalAccountId: 'someoneElse' }) });
  await rejects(service.verifyAndGrant({ uid: 'user1', productId: 'fix_my_resume', purchaseToken: T }), 'LINKED_TO_OTHER_ACCOUNT');
});

test('Google API failure is a retryable 503 and records nothing (payment never reported as failed)', async () => {
  for (const code of [500, 503, 429, 0]) {
    const { service, store } = setup({ [T]: googleErr(code) });
    await assert.rejects(service.verifyAndGrant({ uid: 'user1', productId: 'fix_my_resume', purchaseToken: T }),
      (e) => e.httpStatus === 503 && e.retryable === true);
    assert.equal(store._purchases.size, 0);
  }
});

test('service-account permission errors (401/403) are retryable 503 + flagged misconfigured', async () => {
  const { service } = setup({ [T]: googleErr(403) });
  await assert.rejects(service.verifyAndGrant({ uid: 'user1', productId: 'fix_my_resume', purchaseToken: T }),
    (e) => e.httpStatus === 503 && e.misconfigured === true);
});

test('acknowledge failure still records the purchase, reports acknowledged:false, and a retry re-acknowledges', async () => {
  const { service, google } = setup({ [T]: purchaseResponse(), __ackFails: true });
  const a = await service.verifyAndGrant({ uid: 'user1', productId: 'fix_my_resume', purchaseToken: T });
  assert.equal(a.acknowledged, false);
  google.responses.__ackFails = false;
  const b = await service.verifyAndGrant({ uid: 'user1', productId: 'fix_my_resume', purchaseToken: T });
  assert.equal(b.acknowledged, true);
});

test('already-acknowledged purchase is not acknowledged again', async () => {
  const { service, google } = setup({ [T]: purchaseResponse({ acknowledgementState: 'ACKNOWLEDGEMENT_STATE_ACKNOWLEDGED' }) });
  await service.verifyAndGrant({ uid: 'user1', productId: 'fix_my_resume', purchaseToken: T });
  assert.equal(google.calls.ack.length, 0);
});

test('full_bundle grants exactly the three tools — not human review or interview prep', async () => {
  const B = TOKEN(2);
  const { service } = setup({ [B]: purchaseResponse({ productLineItem: [{ productId: 'full_bundle' }] }) });
  const r = await service.verifyAndGrant({ uid: 'user1', productId: 'full_bundle', purchaseToken: B });
  assert.deepEqual(r.entitlements, ['resume_improvement', 'job_description_match', 'resume_builder']);
  assert.ok(!r.entitlements.includes('human_expert_review'));
  assert.ok(!r.entitlements.includes('interview_prep'));
});

test('catalog: each product id maps to the specified entitlements', () => {
  assert.deepEqual(getProduct('fix_my_resume').entitlements, ['resume_improvement']);
  assert.deepEqual(getProduct('jd_match_optimizer').entitlements, ['job_description_match']);
  assert.deepEqual(getProduct('ai_resume_builder').entitlements, ['resume_builder']);
  assert.deepEqual(getProduct('expert_review').entitlements, ['human_expert_review']);
  assert.deepEqual(getProduct('interview_prep').entitlements, ['interview_prep']);
  assert.equal(getProduct('bundle'), null);
});

test('refund via RTDN revokes the purchase and recomputes; bundle refund keeps a feature still covered by another purchase', async () => {
  const B = TOKEN(2), F = TOKEN(3);
  const { service, hookCalls } = setup({
    [B]: purchaseResponse({ productLineItem: [{ productId: 'full_bundle' }] }),
    [F]: purchaseResponse({ productLineItem: [{ productId: 'fix_my_resume' }] }),
  });
  await service.verifyAndGrant({ uid: 'user1', productId: 'full_bundle', purchaseToken: B });
  await service.verifyAndGrant({ uid: 'user1', productId: 'fix_my_resume', purchaseToken: F });
  const note = { packageName: PKG, voidedPurchaseNotification: { purchaseToken: B, productType: 2, refundType: 1 } };
  await service.handleNotification({ messageId: 'n1', payload: note });
  const ent = await service.getEntitlementsForUser('user1');
  assert.deepEqual(ent.entitlements, ['resume_improvement']); // still covered by fix_my_resume
  assert.equal(hookCalls.voided.length, 1);
});

test('refunded purchase can no longer be re-verified or restored', async () => {
  const { service } = setup({ [T]: purchaseResponse() });
  await service.verifyAndGrant({ uid: 'user1', productId: 'fix_my_resume', purchaseToken: T });
  await service.markVoidedByToken(T);
  await rejects(service.verifyAndGrant({ uid: 'user1', productId: 'fix_my_resume', purchaseToken: T }), 'PURCHASE_REVOKED');
  assert.deepEqual((await service.getEntitlementsForUser('user1')).entitlements, []);
});

test('duplicate / replayed notifications are processed once', async () => {
  const { service, hookCalls } = setup({ [T]: purchaseResponse() });
  await service.verifyAndGrant({ uid: 'user1', productId: 'fix_my_resume', purchaseToken: T });
  const note = { packageName: PKG, voidedPurchaseNotification: { purchaseToken: T, productType: 2, refundType: 1 } };
  const a = await service.handleNotification({ messageId: 'dup', payload: note });
  const b = await service.handleNotification({ messageId: 'dup', payload: note });
  assert.equal(a.handled, true);
  assert.equal(b.reason, 'duplicate');
  assert.equal(hookCalls.voided.length, 1);
  // Even without the message-id marker the handler itself is idempotent:
  await service.handleNotification({ messageId: 'dup2', payload: note });
  assert.equal(hookCalls.voided.length, 1);
});

test('RTDN for an unknown token changes nothing; test notification is accepted', async () => {
  const { service, store } = setup({});
  const r = await service.handleNotification({ messageId: 'x', payload: { packageName: PKG, voidedPurchaseNotification: { purchaseToken: TOKEN(9), productType: 2 } } });
  assert.equal(r.handled, true);
  assert.equal(store._purchases.size, 0);
  const t = await service.handleNotification({ messageId: 'y', payload: { packageName: PKG, testNotification: { version: '1.0' } } });
  assert.equal(t.reason, 'test');
});

test('temporary Google failure while handling a notification surfaces as retryable (so Pub/Sub redelivers) and is not marked processed', async () => {
  const { service, store } = setup({ [T]: purchaseResponse() });
  await service.verifyAndGrant({ uid: 'user1', productId: 'fix_my_resume', purchaseToken: T });
  const g = setup({ [T]: googleErr(503) });
  g.store._purchases.set(service._tokenId(T), { uid: 'user1', productId: 'fix_my_resume', status: 'active', acknowledged: false });
  await assert.rejects(g.service.handleNotification({ messageId: 'r', payload: { packageName: PKG, oneTimeProductNotification: { notificationType: 1, purchaseToken: T } } }),
    (e) => e.retryable === true);
  assert.equal(await g.store.hasNotification('r'), false);
  assert.ok(store);
});

test('stale record re-checked on restore: Google says CANCELLED → revoked', async () => {
  const { service, google, clock } = setup({ [T]: purchaseResponse() });
  await service.verifyAndGrant({ uid: 'user1', productId: 'fix_my_resume', purchaseToken: T });
  google.responses[T] = purchaseResponse({ purchaseStateContext: { purchaseState: 'CANCELLED' } });
  clock.t += 13 * 3600 * 1000;
  await rejects(service.verifyAndGrant({ uid: 'user1', productId: 'fix_my_resume', purchaseToken: T }), 'PURCHASE_REVOKED');
  assert.deepEqual((await service.getEntitlementsForUser('user1')).entitlements, []);
});

test('stale record + temporary Google outage does NOT take away a verified purchase', async () => {
  const { service, google, clock } = setup({ [T]: purchaseResponse() });
  await service.verifyAndGrant({ uid: 'user1', productId: 'fix_my_resume', purchaseToken: T });
  google.responses[T] = googleErr(503);
  clock.t += 13 * 3600 * 1000;
  const r = await service.verifyAndGrant({ uid: 'user1', productId: 'fix_my_resume', purchaseToken: T });
  assert.deepEqual(r.entitlements, ['resume_improvement']);
});

test('reconcileVoided revokes tokens Google lists as voided', async () => {
  const { service } = setup({ [T]: purchaseResponse() });
  await service.verifyAndGrant({ uid: 'user1', productId: 'fix_my_resume', purchaseToken: T });
  const { service: s2 } = { service };
  // reuse same google mock: inject a voided list
  const ctx = setup({ [T]: purchaseResponse(), __voided: [{ purchaseToken: T, voidedReason: 4 }] });
  await ctx.service.verifyAndGrant({ uid: 'user1', productId: 'fix_my_resume', purchaseToken: T });
  const r = await ctx.service.reconcileVoided({});
  assert.equal(r.matched, 1);
  assert.deepEqual((await ctx.service.getEntitlementsForUser('user1')).entitlements, []);
  assert.ok(s2);
});

test('computeEntitlements ignores non-active and unknown-product records', () => {
  const r = computeEntitlements([
    { productId: 'fix_my_resume', status: 'refunded' },
    { productId: 'fix_resume', status: 'active' },
    { productId: 'interview_prep', status: 'active' },
  ]);
  assert.deepEqual(r.entitlements, ['interview_prep']);
});
