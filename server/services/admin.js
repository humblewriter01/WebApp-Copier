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
