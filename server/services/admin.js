const PROMO_CODE_PATTERN = /^[A-Z0-9][A-Z0-9_-]{2,49}$/;
const ROLE_VALUES = new Set(['user', 'admin']);
const DEFAULT_ADMIN_EMAILS = ['ameenujaafar432@gmail.com'];

export function validationError(message) {
  const error = new Error(message);
  error.status = 400;
  error.code = 'VALIDATION_ERROR';
  return error;
}

function normalizeEmail(value) {
  return String(value || '').trim().toLowerCase();
}

/**
 * Builds the workspace admin allow-list. The list comes from ADMIN_EMAILS (comma
 * separated) plus the original owner address, so promoting an admin only ever
 * requires configuration, not a code change.
 */
export function createAdminAccess({ env = process.env, fallbackEmails = DEFAULT_ADMIN_EMAILS } = {}) {
  const emails = [...fallbackEmails, ...String(env.ADMIN_EMAILS || '').split(',')]
    .map(normalizeEmail)
    .filter(Boolean);
  const uniqueEmails = Object.freeze([...new Set(emails)]);
  return Object.freeze({
    emails: uniqueEmails,
    isAdminEmail: (email) => uniqueEmails.includes(normalizeEmail(email)),
    isAdminRole: (role) => String(role || '').trim().toLowerCase() === 'admin',
  });
}

function roundCurrency(value) {
  return Math.round(value * 100) / 100;
}

function normalizeMaxUses(raw) {
  if (raw === undefined || raw === null || String(raw).trim() === '') return null;
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > 1_000_000) {
    throw validationError('Maximum uses must be a whole number between 1 and 1000000, or left empty for unlimited use.');
  }
  return parsed;
}

function normalizeExpiry(raw) {
  if (raw === undefined || raw === null || String(raw).trim() === '') return null;
  const parsed = new Date(raw);
  if (Number.isNaN(parsed.getTime())) throw validationError('Enter a valid expiry date and time.');
  if (parsed.getTime() <= Date.now()) throw validationError('Choose an expiry date in the future.');
  return parsed.toISOString();
}

/** Validates and normalizes a new promo code before it reaches PostgreSQL. */
export function normalizePromoCodeInput(input = {}) {
  const code = String(input.code || '').trim().toUpperCase().replace(/\s+/g, '');
  if (!PROMO_CODE_PATTERN.test(code)) {
    throw validationError('Promo codes must be 3 to 50 characters using letters, numbers, hyphens, or underscores, and must start with a letter or number.');
  }

  const discountType = String(input.discountType || '').trim().toLowerCase();
  if (!['percentage', 'fixed'].includes(discountType)) {
    throw validationError('Choose a percentage or fixed discount type.');
  }

  const discountValue = Number(input.discountValue);
  if (!Number.isFinite(discountValue) || discountValue <= 0) {
    throw validationError('Enter a discount value greater than zero.');
  }
  if (discountType === 'percentage' && discountValue > 100) {
    throw validationError('A percentage discount cannot be greater than 100.');
  }
  if (discountType === 'fixed' && discountValue > 100_000) {
    throw validationError('A fixed discount cannot be greater than 100000.');
  }

  return Object.freeze({
    code,
    discountType,
    discountValue: discountType === 'fixed' ? roundCurrency(discountValue) : discountValue,
    maxUses: normalizeMaxUses(input.maxUses),
    expiresAt: normalizeExpiry(input.expiresAt),
  });
}

/** Validates a partial admin edit of a promo code. */
export function normalizePromoCodeUpdate(input = {}) {
  const update = {};
  if (Object.hasOwn(input, 'active')) {
    if (typeof input.active !== 'boolean') throw validationError('Active must be true or false.');
    update.active = input.active;
  }
  if (Object.hasOwn(input, 'maxUses')) update.maxUses = normalizeMaxUses(input.maxUses);
  if (Object.hasOwn(input, 'expiresAt')) update.expiresAt = normalizeExpiry(input.expiresAt);
  if (!Object.keys(update).length) throw validationError('Choose at least one change to save.');
  return Object.freeze(update);
}

/** Validates a partial admin edit of a user record. */
export function normalizeUserUpdate(input = {}) {
  const update = {};

  if (Object.hasOwn(input, 'role')) {
    const role = String(input.role || '').trim().toLowerCase();
    if (!ROLE_VALUES.has(role)) throw validationError('Choose either the user or admin role.');
    update.role = role;
  }

  if (Object.hasOwn(input, 'isSuspended')) {
    if (typeof input.isSuspended !== 'boolean') throw validationError('Suspension must be true or false.');
    update.isSuspended = input.isSuspended;
  }

  if (Object.hasOwn(input, 'suspensionReason')) {
    update.suspensionReason = input.suspensionReason == null ? '' : String(input.suspensionReason).trim().slice(0, 200);
  }

  if (!Object.keys(update).length) throw validationError('Choose at least one change to save.');

  if (update.isSuspended === true && !update.suspensionReason) {
    throw validationError('Add a short reason so the user understands the suspension.');
  }
  if (update.isSuspended === false) update.suspensionReason = '';

  return Object.freeze(update);
}

/** Guards destructive admin edits so an admin cannot lock themselves out. */
export function assertAllowedSelfUpdate({ actorId, targetId, update }) {
  if (String(actorId) !== String(targetId)) return;
  if (update.role === 'user') {
    const error = new Error('You cannot remove your own admin access.');
    error.status = 409;
    throw error;
  }
  if (update.isSuspended === true) {
    const error = new Error('You cannot suspend your own account.');
    error.status = 409;
    throw error;
  }
}

/**
 * Validates a manual subscription adjustment: grant a plan, add days, or both. The reason is
 * mandatory because it is what makes the audit row readable months later - "why does this
 * account have Premium for free" should never depend on remembering who asked.
 *
 * `endsAt` is offered for the case where support promised a specific date ("until the 30th");
 * it is validated as a future timestamp and takes precedence over `days`.
 */
export function normalizeSubscriptionAdjustment(input = {}, { plans = [] } = {}) {
  const planKeys = ['free', ...plans.map((plan) => String(plan.key).toLowerCase())];
  const adjustment = { planKey: null, days: null, endsAt: null, reason: '' };

  if (input.plan !== undefined && input.plan !== null && String(input.plan).trim() !== '') {
    const planKey = String(input.plan).trim().toLowerCase();
    if (!planKeys.includes(planKey)) {
      throw validationError(`Choose a plan the workspace sells: ${planKeys.join(', ')}.`);
    }
    adjustment.planKey = planKey;
  }

  if (input.days !== undefined && input.days !== null && String(input.days).trim() !== '') {
    const days = Number(input.days);
    if (!Number.isInteger(days) || days < 1 || days > 365) {
      throw validationError('Extend the subscription by 1 to 365 whole days.');
    }
    adjustment.days = days;
  }

  if (input.endsAt !== undefined && input.endsAt !== null && String(input.endsAt).trim() !== '') {
    const endsAt = new Date(input.endsAt);
    if (Number.isNaN(endsAt.getTime())) throw validationError('That expiry date is not readable.');
    if (endsAt.getTime() <= Date.now()) throw validationError('Set an expiry date in the future.');
    adjustment.endsAt = endsAt.toISOString();
  }

  const reason = String(input.reason ?? '').replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 200);
  if (reason.length < 5) throw validationError('Add a short reason for this adjustment (at least 5 characters).');
  adjustment.reason = reason;

  if (!adjustment.planKey && adjustment.days === null && !adjustment.endsAt) {
    throw validationError('Choose a plan to grant, days to add, or an expiry date.');
  }
  if (adjustment.planKey === 'free' && (adjustment.days !== null || adjustment.endsAt)) {
    throw validationError('Moving an account to Free already ends its paid period - remove the extra days.');
  }
  if (adjustment.days !== null && adjustment.endsAt) {
    throw validationError('Use either a number of days or an expiry date, not both.');
  }
  return Object.freeze(adjustment);
}

/**
 * Support access rules. A suspended account cannot sign in, so viewing its dashboard would show a
 * locked screen rather than what the customer sees, and an admin looking at their own workspace
 * gains nothing but an unauditable blur between two sessions.
 */
export function assertAllowedImpersonation({ actorId, target }) {
  if (!target) {
    const error = new Error('That account could not be found.');
    error.status = 404;
    throw error;
  }
  if (String(actorId) === String(target.id)) {
    const error = new Error('You cannot open a support session on your own account.');
    error.status = 409;
    throw error;
  }
  if (target.isSuspended === true) {
    const error = new Error('That account is suspended, so its dashboard is locked. Lift the suspension first.');
    error.status = 409;
    throw error;
  }
}
