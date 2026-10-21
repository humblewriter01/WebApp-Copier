import { deleteMetaApiAccount } from './metaapi.js';

/**
 * Removes the MetaAPI trading accounts that are billed to this workspace before
 * a Signal Desk account is deleted.
 *
 * Only accounts provisioned by the workspace (`managed_by_app = true`, billed to
 * the server's provisioning token) are removed by default. Accounts a user
 * linked with their own MetaAPI token are billed to that user's own MetaAPI
 * subscription, so they are left untouched.
 *
 * Failures never block deletion: the user can always remove their workspace,
 * and each failure is logged with safe diagnostics so it can be retried.
 */
export function createAccountCleanup({ removeAccount = deleteMetaApiAccount, logger = console } = {}) {
  async function removeProviderAccounts({ accounts = [], resolveToken, includeUserManaged = false } = {}) {
    const summary = {
      total: accounts.length,
      attempted: 0,
      deleted: 0,
      alreadyMissing: 0,
      failed: 0,
      skipped: 0,
      failures: [],
    };

    for (const account of accounts) {
      const accountId = String(account?.metaapi_account_id || account?.metaApiAccountId || '').trim();
      if (!accountId) { summary.skipped += 1; continue; }
      if (account?.managed_by_app !== true && account?.managedByApp !== true && !includeUserManaged) {
        summary.skipped += 1;
        continue;
      }

      let apiToken = null;
      try {
        apiToken = typeof resolveToken === 'function' ? await resolveToken(account) : null;
      } catch (error) {
        apiToken = null;
        logger?.warn?.('MetaAPI token lookup failed during account deletion', { code: error?.code || 'TOKEN_LOOKUP_FAILED' });
      }
      if (!apiToken) {
        summary.skipped += 1;
        logger?.warn?.('MetaAPI account skipped during account deletion: no usable token', { accountId });
        continue;
      }

      summary.attempted += 1;
      try {
        const result = await removeAccount(apiToken, accountId);
        if (result?.alreadyMissing) summary.alreadyMissing += 1;
        else summary.deleted += 1;
      } catch (error) {
        summary.failed += 1;
        summary.failures.push({
          accountId,
          status: Number.isInteger(error?.metaApiStatus) ? error.metaApiStatus : Number.isInteger(error?.status) ? error.status : null,
          code: typeof error?.metaApiErrorCode === 'string' ? error.metaApiErrorCode : null,
        });
        logger?.warn?.('MetaAPI account could not be removed during account deletion', {
          accountId,
          metaApiStatus: error?.metaApiStatus,
          metaApiErrorCode: error?.metaApiErrorCode,
          metaApiErrorType: error?.metaApiErrorType,
        });
      }
    }

    return Object.freeze(summary);
  }

  return Object.freeze({ removeProviderAccounts });
}
