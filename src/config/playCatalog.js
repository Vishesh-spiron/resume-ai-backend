// ─────────────────────────────────────────────────────────────────────────────
// src/config/playCatalog.js
//
// Single source of truth for Google Play products and the entitlements they
// grant. Product IDs must match Play Console EXACTLY — never rename or alias
// them here without creating the matching product in Play Console first.
//
// All six products are ONE-TIME, NON-CONSUMABLE purchases (permanent unlocks).
//
// `intendedPricePaise` is documentation + referral-commission bookkeeping only.
// It is NEVER shown to users and NEVER used as proof of payment — the price a
// user pays is whatever Play Console says, and the app displays the localized
// price returned by Google Play.
// ─────────────────────────────────────────────────────────────────────────────

const ENTITLEMENTS = Object.freeze({
  RESUME_IMPROVEMENT: 'resume_improvement',
  JOB_DESCRIPTION_MATCH: 'job_description_match',
  RESUME_BUILDER: 'resume_builder',
  HUMAN_EXPERT_REVIEW: 'human_expert_review',
  INTERVIEW_PREP: 'interview_prep',
});

const ALL_ENTITLEMENTS = Object.freeze(Object.values(ENTITLEMENTS));

const PLAY_PRODUCTS = Object.freeze({
  fix_my_resume: {
    entitlements: [ENTITLEMENTS.RESUME_IMPROVEMENT],
    planKey: 'fixResume',
    intendedPricePaise: 3900,
  },
  jd_match_optimizer: {
    entitlements: [ENTITLEMENTS.JOB_DESCRIPTION_MATCH],
    planKey: 'jdOptimize',
    intendedPricePaise: 4900,
  },
  ai_resume_builder: {
    entitlements: [ENTITLEMENTS.RESUME_BUILDER],
    planKey: 'resumeGenerator',
    intendedPricePaise: 4900,
  },
  // Exactly the three tools above — deliberately NOT human review / interview prep.
  full_bundle: {
    entitlements: [
      ENTITLEMENTS.RESUME_IMPROVEMENT,
      ENTITLEMENTS.JOB_DESCRIPTION_MATCH,
      ENTITLEMENTS.RESUME_BUILDER,
    ],
    planKey: 'bundle',
    intendedPricePaise: 7900,
  },
  expert_review: {
    entitlements: [ENTITLEMENTS.HUMAN_EXPERT_REVIEW],
    planKey: 'humanReview',
    intendedPricePaise: 12900,
  },
  interview_prep: {
    entitlements: [ENTITLEMENTS.INTERVIEW_PREP],
    planKey: 'interviewPrep',
    intendedPricePaise: 3900,
  },
});

const PRODUCT_IDS = Object.freeze(Object.keys(PLAY_PRODUCTS));

function getProduct(productId) {
  return Object.prototype.hasOwnProperty.call(PLAY_PRODUCTS, productId)
    ? PLAY_PRODUCTS[productId]
    : null;
}

/**
 * Pure function: the union of entitlements granted by a set of purchase
 * records. Only records whose status is 'active' count, so a refund of one
 * purchase never removes a feature that another active purchase still covers.
 * Output order is stable (catalog order) so equality checks/tests are simple.
 */
function computeEntitlements(purchases) {
  const granted = new Set();
  const products = new Set();
  for (const p of purchases || []) {
    if (!p || p.status !== 'active') continue;
    const product = getProduct(p.productId);
    if (!product) continue; // unknown/legacy id: grants nothing
    products.add(p.productId);
    for (const e of product.entitlements) granted.add(e);
  }
  return {
    entitlements: ALL_ENTITLEMENTS.filter((e) => granted.has(e)),
    products: PRODUCT_IDS.filter((id) => products.has(id)),
  };
}

module.exports = {
  ENTITLEMENTS,
  ALL_ENTITLEMENTS,
  PLAY_PRODUCTS,
  PRODUCT_IDS,
  getProduct,
  computeEntitlements,
};
