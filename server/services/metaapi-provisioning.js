import crypto from 'node:crypto';

export const METAAPI_FUNDING_USER_MESSAGE = 'We are currently experiencing high demand and cannot provision new trading accounts. Please try again in a few hours or contact support.';

/** Only accounts paid for with the platform token are removed upstream during unlink. */
export function shouldDeleteMetaApiAccountOnUnlink(account) {
  return account?.managed_by_app === true || account?.managedByApp === true;
}

function isFundingOrForbidden(error) {
  const status = Number(error?.metaApiStatus ?? error?.status);
  if (status === 403) return true;
  const details = [error?.message, error?.userMessage, error?.metaApiRawResponse, error?.metaApiErrorType]
    .filter((value) => typeof value === 'string')
    .join(' ');
  return /\b(?:fund(?:ing|s)?|deposit(?:s)?)\b/i.test(details);
}

function logMetaApiFailure(log, error, { userId, operation, apiToken }) {
  const redactToken = (value) => {
    if (typeof value !== 'string') return value ?? null;
    return apiToken && apiToken.length >= 4 ? value.replaceAll(apiToken, '[redacted]') : value;
  };
  log('error', 'MetaAPI account provisioning request failed', {
    userId,
    operation,
    error: redactToken(error?.message || String(error)),
    stack: redactToken(error?.stack),
    status: Number.isInteger(error?.status) ? error.status : null,
    metaApiStatus: Number.isInteger(error?.metaApiStatus) ? error.metaApiStatus : null,
    metaApiErrorCode: typeof error?.metaApiErrorCode === 'string' ? error.metaApiErrorCode : null,
    metaApiErrorType: typeof error?.metaApiErrorType === 'string' ? error.metaApiErrorType : null,
    metaApiRawResponse: redactToken(error?.metaApiRawResponse),
  });
}

function safeProviderMessage(error) {
  return typeof error?.userMessage === 'string' && error.userMessage
    ? error.userMessage
    : typeof error?.message === 'string' && error.message
      ? error.message
      : 'We could not complete MetaAPI account setup. Please try again.';
}

export function respondWithMetaApiError(res, error, log, context) {
  logMetaApiFailure(log, error, context);
  if (isFundingOrForbidden(error)) {
    return res.status(503).json({ error: METAAPI_FUNDING_USER_MESSAGE });
  }
  return res.status(Number(error?.status) || 502).json({ error: safeProviderMessage(error) });
}

/**
 * The account-creation endpoint, with provider, encryption, plan-limit and DB seams injected so
 * funding failures and custom-token ownership can be exercised without a live MetaAPI account.
 * @param {Object} deps
 * @param {Object} deps.pool
 * @param {() => (string|null)} deps.getProvisioningToken
 * @param {(value: string) => string} deps.encryptSecret
 * @param {(userId: string, limitKey: string, sql: string) => Promise<void>} deps.enforcePlanLimit
 * @param {(token: string, endpoint: string, options?: Object) => Promise<any>} deps.metaApiRequest
 * @param {(token: string, accountId: string) => Promise<string>} deps.createConfigurationLink
 * @param {(account: any) => any} deps.toSafeAccount
 * @param {(level: string, message: string, extra?: Object) => void} deps.log
 */
export function createMetaApiProvisionedAccountHandler({
  pool,
  getProvisioningToken,
  encryptSecret,
  enforcePlanLimit,
  metaApiRequest,
  createConfigurationLink,
  toSafeAccount,
  log,
}) {
  return async function provisionMetaApiAccount(req, res) {
    if (Object.hasOwn(req.body || {}, 'login') || Object.hasOwn(req.body || {}, 'password')) {
      return res.status(400).json({ error: 'For your security, enter your trading login and password only on the secure MetaAPI page.' });
    }
    if (req.body?.metaapi_token !== undefined && typeof req.body.metaapi_token !== 'string') {
      return res.status(400).json({ error: 'Enter a valid MetaAPI token.' });
    }

    const customToken = typeof req.body?.metaapi_token === 'string' ? req.body.metaapi_token.trim() : '';
    if (customToken && (customToken.length < 20 || customToken.length > 4096)) {
      return res.status(400).json({ error: 'Enter a valid MetaAPI token.' });
    }
    const apiToken = customToken || getProvisioningToken();
    if (!apiToken) return res.status(503).json({ error: 'Account setup is temporarily unavailable. Please contact the workspace owner.' });

    const name = typeof req.body?.name === 'string' ? req.body.name.trim() : '';
    const server = typeof req.body?.server === 'string' ? req.body.server.trim() : '';
    const platform = typeof req.body?.platform === 'string' ? req.body.platform.trim().toLowerCase() : '';
    if (!name || name.length > 100) return res.status(400).json({ error: 'Enter an account name of 1 to 100 characters.' });
    if (!server || server.length > 160) return res.status(400).json({ error: 'Enter the broker server name shown in your MetaTrader account details.' });
    if (!['mt4', 'mt5'].includes(platform)) return res.status(400).json({ error: 'Choose MetaTrader 4 or MetaTrader 5.' });
    await enforcePlanLimit(req.userId, 'maxTradingAccounts', 'SELECT COUNT(*)::int AS count FROM metaapi_accounts WHERE user_id=$1');
    // Fail before creating a provider account if the server cannot protect a BYO token at rest.
    const encryptedAccountToken = customToken ? encryptSecret(apiToken) : null;

    let accountData;
    try {
      accountData = await metaApiRequest(apiToken, '/users/current/accounts', {
        method: 'POST',
        body: { name, server, platform, magic: 0 },
        transactionId: crypto.randomUUID().replaceAll('-', ''),
        unauthorizedMessage: 'Account setup is temporarily unavailable. Please contact the workspace owner.',
      });
    } catch (error) {
      return respondWithMetaApiError(res, error, log, { userId: req.userId, operation: 'create-account', apiToken });
    }

    const account = toSafeAccount(accountData);
    if (!account) return res.status(502).json({ error: 'The account could not be added. Please try again.' });
    const { rows } = await pool.query(
      `INSERT INTO metaapi_accounts(user_id,metaapi_account_id,login,name,platform,state,server,managed_by_app,encrypted_api_token)
       VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)
       ON CONFLICT(user_id,metaapi_account_id) DO UPDATE SET login=EXCLUDED.login,name=EXCLUDED.name,
         platform=EXCLUDED.platform,state=EXCLUDED.state,server=EXCLUDED.server,managed_by_app=EXCLUDED.managed_by_app,
         encrypted_api_token=EXCLUDED.encrypted_api_token
       RETURNING id,metaapi_account_id AS "metaApiAccountId",login,name,platform,state,server,
         managed_by_app AS "managedByApp",(encrypted_api_token IS NOT NULL) AS "hasCustomMetaApiToken",created_at AS "createdAt"`,
      [req.userId, account.id, account.login, account.name || name, account.platform || platform, account.state || accountData.state || 'DRAFT', server, !customToken, encryptedAccountToken],
    );

    let configurationLink = null;
    let setupError = null;
    try {
      configurationLink = await createConfigurationLink(apiToken, account.id);
    } catch (error) {
      logMetaApiFailure(log, error, { userId: req.userId, operation: 'create-configuration-link', apiToken });
      setupError = {
        message: isFundingOrForbidden(error) ? METAAPI_FUNDING_USER_MESSAGE : safeProviderMessage(error),
        ...(Number.isInteger(error?.metaApiStatus) ? { metaApiStatus: error.metaApiStatus } : {}),
        ...(typeof error?.metaApiErrorCode === 'string' ? { metaApiErrorCode: error.metaApiErrorCode } : {}),
        ...(typeof error?.metaApiErrorType === 'string' ? { metaApiErrorType: error.metaApiErrorType } : {}),
        ...(typeof error?.metaApiNetworkDiagnostic === 'string' ? { metaApiNetworkDiagnostic: error.metaApiNetworkDiagnostic } : {}),
      };
    }
    return res.set('Cache-Control', 'no-store').status(201).json({ account: rows[0], configurationLink, setupError });
  };
}
