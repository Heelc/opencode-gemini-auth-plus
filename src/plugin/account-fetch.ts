import { AccountManager } from "./account-manager";
import type { StoredAccount } from "./account-store";
import { accessTokenExpired } from "./auth";
import { refreshAccessToken } from "./token";
import { classifyQuotaResponse } from "./retry/quota";
import { fetchWithRetry, quotaContextCache } from "./retry";
import { isGeminiDebugEnabled, logGeminiDebugMessage } from "./debug";
import type { PluginClient, OAuthAuthDetails } from "./types";

/**
 * Dependencies injected into the account-fallback fetch wrapper.
 */
export interface AccountFetchDeps {
    accountManager: AccountManager;
    client: PluginClient;
    configuredProjectId?: string;
}

/**
 * Wraps fetchWithRetry with multi-account fallback on quota/capacity errors.
 *
 * Flow:
 * 1. Pick the active account from the pool
 * 2. Ensure its access token is fresh
 * 3. Execute fetch via fetchWithRetry (with terminalOnRateLimit so 429s return here)
 * 4. If 429 + QUOTA_EXHAUSTED → mark account exhausted, pick next account, retry
 * 5. If 429 + RATE_LIMIT_EXCEEDED or MODEL_CAPACITY_EXHAUSTED → pick next account (no mark)
 * 6. If no more accounts → return the 429 response
 */
export async function fetchWithAccountFallback(
    deps: AccountFetchDeps,
    input: RequestInfo,
    init: RequestInit | undefined,
): Promise<Response> {
    const { accountManager, client } = deps;

    // Track which accounts we've already tried to avoid infinite loops
    const triedAccountIds = new Set<string>();
    let lastExhaustedResponse: Response | undefined;

    while (true) {
        const account = accountManager.getNextAccount();
        if (!account) {
            if (lastExhaustedResponse) {
                // All accounts exhausted — return the last 429 response
                return lastExhaustedResponse;
            }
            // No accounts at all, just do a raw fetch
            return fetch(input, init);
        }

        // Don't retry the same account
        if (triedAccountIds.has(account.id)) {
            return lastExhaustedResponse ?? fetch(input, init);
        }
        triedAccountIds.add(account.id);

        // Ensure access token is fresh
        let authDetails = accountManager.toAuthDetails(account);
        if (accessTokenExpired(authDetails)) {
            const refreshed = await refreshAccessToken(authDetails, client);
            if (refreshed) {
                accountManager.updateTokens(
                    account.id,
                    refreshed.access!,
                    refreshed.expires!,
                    refreshed.refresh !== authDetails.refresh ? refreshed.refresh : undefined,
                );
                authDetails = refreshed;
            }
        }

        // Inject the account's auth into the request headers
        const requestInit = injectAuth(init, authDetails.access);
        const response = await fetchWithRetry(input, requestInit, {
            terminalOnRateLimit: true,
        });

        // With terminalOnRateLimit: true, fetchWithRetry returns all 429s that it
        // considers terminal (QUOTA_EXHAUSTED, RATE_LIMIT_EXCEEDED, MODEL_CAPACITY_EXHAUSTED).
        // We switch accounts for all of them; only QUOTA_EXHAUSTED marks the account as exhausted.
        if (response.status === 429) {
            // Use cached quota context from fetchWithRetry (avoids re-reading response body)
            const cachedContext = quotaContextCache.get(response);
            const quotaContext = cachedContext ?? await classifyQuotaResponse(response.clone());

            if (quotaContext?.terminal && quotaContext.reason === "QUOTA_EXHAUSTED") {
                const resetTime = quotaContext.retryDelayMs
                    ? Date.now() + quotaContext.retryDelayMs
                    : undefined;
                if (isGeminiDebugEnabled()) {
                    logGeminiDebugMessage(
                        `Account ${account.email ?? account.id} quota exhausted, switching to next account`,
                    );
                }
                accountManager.markExhausted(account.id, resetTime);
            } else if (isGeminiDebugEnabled()) {
                const reason = quotaContext?.reason ?? "unknown";
                logGeminiDebugMessage(
                    `Account ${account.email ?? account.id} 429 (${reason}), switching to next account`,
                );
            }

            lastExhaustedResponse = response;
            continue;
        }

        return response;
    }
}

/**
 * Injects an Authorization header into request init without mutating the original.
 */
function injectAuth(
    init: RequestInit | undefined,
    accessToken: string | undefined,
): RequestInit {
    if (!accessToken) {
        return init ?? {};
    }
    const headers = new Headers(init?.headers ?? {});
    headers.set("Authorization", `Bearer ${accessToken}`);
    return { ...init, headers };
}
