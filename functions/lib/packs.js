// functions/lib/packs.js
//
// THE single place that defines CVcase Tokens (CT) top-up packs and the
// starter gift. Every backend file that needs a price, a token amount, or a
// pack name reads it from here — so if you ever change a price or add a
// pack, you change it in THIS file only (plus the matching display list in
// app.html's TOPUP_PACKS, which is what users see).
//
// 1 CT = 1 real B.AI token (whatever B.AI itself billed this app for a
// call — see lib/ai-billing.js's costFromUsage, which now charges exactly
// that figure with no per-model multiplier). See lib/ai-billing.js for how
// tokens are counted and deducted.
//
// Pricing set 2026-10-27 (ETB):
//   Individual: 250,000 CT = 99, 500,000 CT = 195, 1,000,000 CT = 380
//   Agency:    2,000,000 CT = 779, 5,000,000 CT = 1899
const PACKS = {
  ind_250k: { id: 'ind_250k', tier: 'individual', tokens:  250000, price:   99, label: '250,000 CT',    recommended: false },
  ind_500k: { id: 'ind_500k', tier: 'individual', tokens:  500000, price:  195, label: '500,000 CT',    recommended: true  },
  ind_1m:   { id: 'ind_1m',   tier: 'individual', tokens: 1000000, price:  380, label: '1,000,000 CT',  recommended: false },
  agy_2m:   { id: 'agy_2m',   tier: 'agency',     tokens: 2000000, price:  779, label: '2,000,000 CT',  recommended: true  },
  agy_5m:   { id: 'agy_5m',   tier: 'agency',     tokens: 5000000, price: 1899, label: '5,000,000 CT',  recommended: false }
};

// Pending payments made just before the switch to tokens still carry the old
// plan names. Map them to the closest pack so they can still be resolved.
const LEGACY_ALIASES = { basic: 'ind_500k', pro: 'ind_1m' };

function resolvePack(packId) {
  if (!packId) return null;
  const id = PACKS[packId] ? packId : LEGACY_ALIASES[packId];
  return id ? PACKS[id] : null;
}

// Cheapest pack — anything below this can never buy tokens.
const MIN_PACK_PRICE = Math.min(...Object.values(PACKS).map(p => p.price));

// There is NO free gift: a new account starts with 0 CT and cannot use any AI
// feature until it tops up. (Kept as a setting only so the migration script
// has one obvious place to read it from.)
const STARTER_TOKENS = 0;

// What existing paid subscribers receive ONE time when you run
// migrate-to-tokens.js, so nobody who paid for a plan is left with nothing.
const MIGRATION_PLAN_TOKENS = { basic: 500000, pro: 1000000 };

function formatCT(n) {
  return Number(n || 0).toLocaleString('en-US') + ' CT';
}

// Decides whether a payment amount can buy the pack the user chose, and how
// much (if any) is left over. Mirrors the old plan logic: we never silently
// give a different pack than the one chosen. Any excess is handled by the
// existing Refund / Tip system.
function computeVerifyOutcome(chosenPackId, amount) {
  const pack = resolvePack(chosenPackId);
  if (!pack) return { canVerify: false, pack: null };
  if (amount < pack.price) return { canVerify: false, pack };
  const excess = Math.round((amount - pack.price) * 100) / 100;
  return { canVerify: true, pack, tierPrice: pack.price, tokens: pack.tokens, excess };
}

// Adds tokens to a user (atomic $inc) and stamps planActivatedAt so the
// admin dashboard's "Super Active" figure (bought in last 30 days) still works.
async function creditTokens(usersCol, userId, tokens) {
  const now = new Date();
  await usersCol.updateOne(
    { phoneNumber: userId },
    { $inc: { tokens: tokens }, $set: { planActivatedAt: now, lastTopUpAt: now } }
  );
  return now;
}

module.exports = {
  PACKS, LEGACY_ALIASES, resolvePack, MIN_PACK_PRICE,
  STARTER_TOKENS, MIGRATION_PLAN_TOKENS,
  formatCT, computeVerifyOutcome, creditTokens
};