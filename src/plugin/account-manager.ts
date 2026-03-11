import {
    loadAccounts,
    saveAccounts,
    addAccount as storeAddAccount,
    removeAccount as storeRemoveAccount,
    getDefaultStorePath,
    type StoredAccount,
} from "./account-store";
import type { OAuthAuthDetails } from "./types";

const DEFAULT_EXHAUSTED_DURATION_MS = 86_400_000; // 24 hours (matches daily quota reset)

/**
 * Manages multiple Google accounts for quota fallback.
 *
 * Accounts are persisted via AccountStore and selected at runtime
 * based on priority and exhaustion state.
 */
export class AccountManager {
    private readonly storePath: string;
    /** Round-robin pointer for distributing requests across accounts. */
    private roundRobinIndex = 0;

    constructor(storePath?: string) {
        this.storePath = storePath ?? getDefaultStorePath();
    }

    /**
     * Returns the highest-priority account that is not currently exhausted.
     */
    getActiveAccount(): StoredAccount | undefined {
        const accounts = this.getAllAccounts();
        return accounts.find((a) => !a.disabled && !this.isExhausted(a.id));
    }

    /**
     * Returns the next available account via round-robin rotation.
     *
     * Each call advances the pointer so consecutive requests are distributed
     * evenly across all non-exhausted, non-disabled accounts.
     */
    getNextAccount(): StoredAccount | undefined {
        const available = this.getAllAccounts().filter(
            (a) => !a.disabled && !this.isExhausted(a.id),
        );
        if (available.length === 0) {
            return undefined;
        }

        const account = available[this.roundRobinIndex % available.length]!;
        this.roundRobinIndex = (this.roundRobinIndex + 1) % Number.MAX_SAFE_INTEGER;
        return account;
    }

    /**
     * Returns all stored accounts sorted by priority (lowest first).
     */
    getAllAccounts(): StoredAccount[] {
        const data = loadAccounts(this.storePath);
        return [...data.accounts].sort((a, b) => a.priority - b.priority);
    }

    /**
     * Marks an account as quota-exhausted until the given timestamp.
     * Defaults to 1 hour from now if no resetTime is provided.
     */
    markExhausted(accountId: string, resetTime?: number): void {
        const data = loadAccounts(this.storePath);
        const account = data.accounts.find((a) => a.id === accountId);
        if (!account) {
            return;
        }
        account.exhaustedUntil = resetTime ?? Date.now() + DEFAULT_EXHAUSTED_DURATION_MS;
        saveAccounts(data, this.storePath);
    }

    /**
     * Checks if an account is currently exhausted.
     */
    isExhausted(accountId: string): boolean {
        const data = loadAccounts(this.storePath);
        const account = data.accounts.find((a) => a.id === accountId);
        if (!account?.exhaustedUntil) {
            return false;
        }
        return account.exhaustedUntil > Date.now();
    }

    /**
     * Clears the exhausted state for an account.
     * Called when the actual quota (from API) shows the account has recovered.
     */
    clearExhausted(accountId: string): void {
        const data = loadAccounts(this.storePath);
        const account = data.accounts.find((a) => a.id === accountId);
        if (!account?.exhaustedUntil) {
            return;
        }
        delete account.exhaustedUntil;
        saveAccounts(data, this.storePath);
    }

    /**
     * Adds or updates a Google account in the pool.
     * Returns the stored account (with assigned id and priority).
     */
    addAccount(params: {
        email?: string;
        refresh: string;
        access?: string;
        expires?: number;
    }): StoredAccount {
        const existing = loadAccounts(this.storePath);
        const nextPriority =
            existing.accounts.length > 0
                ? Math.max(...existing.accounts.map((a) => a.priority)) + 1
                : 0;
        const nextId = `account-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

        const account: StoredAccount = {
            id: nextId,
            email: params.email,
            refresh: params.refresh,
            access: params.access,
            expires: params.expires,
            addedAt: Date.now(),
            priority: nextPriority,
        };

        storeAddAccount(account, this.storePath);
        // Return the effective stored state (may have been deduped by email)
        const saved = loadAccounts(this.storePath);
        return saved.accounts.find(
            (a) => a.email === params.email || a.refresh === params.refresh,
        ) ?? account;
    }

    /**
     * Removes an account from the pool.
     */
    removeAccount(accountId: string): boolean {
        return storeRemoveAccount(accountId, this.storePath);
    }

    /**
     * Converts a StoredAccount to the OAuthAuthDetails expected by the plugin.
     */
    toAuthDetails(account: StoredAccount): OAuthAuthDetails {
        return {
            type: "oauth",
            refresh: account.refresh,
            access: account.access,
            expires: account.expires,
        };
    }

    /**
     * Updates access/refresh tokens for a specific account after a successful refresh.
     */
    updateTokens(
        accountId: string,
        access: string,
        expires: number,
        refresh?: string,
    ): void {
        const data = loadAccounts(this.storePath);
        const account = data.accounts.find((a) => a.id === accountId);
        if (!account) {
            return;
        }
        account.access = access;
        account.expires = expires;
        if (refresh !== undefined) {
            account.refresh = refresh;
        }
        saveAccounts(data, this.storePath);
    }

    /**
     * Syncs the framework-provided auth into the account pool if not already present.
     */
    syncFromFramework(auth: OAuthAuthDetails, email?: string): void {
        if (!auth.refresh) {
            return;
        }
        // Deduplicate by refresh token or email rather than file existence,
        // so new accounts are synced even when the store file already exists.
        const existing = this.getAllAccounts();
        const alreadySynced = existing.some(
            (a) => a.refresh === auth.refresh || (email && a.email === email),
        );
        if (alreadySynced) {
            return;
        }
        this.addAccount({
            email,
            refresh: auth.refresh,
            access: auth.access,
            expires: auth.expires,
        });
    }

    /**
     * Disables an account so it won't be selected by getActiveAccount.
     */
    disableAccount(accountId: string): boolean {
        const data = loadAccounts(this.storePath);
        const account = data.accounts.find((a) => a.id === accountId);
        if (!account) {
            return false;
        }
        account.disabled = true;
        saveAccounts(data, this.storePath);
        return true;
    }

    /**
     * Re-enables a previously disabled account.
     */
    enableAccount(accountId: string): boolean {
        const data = loadAccounts(this.storePath);
        const account = data.accounts.find((a) => a.id === accountId);
        if (!account) {
            return false;
        }
        account.disabled = undefined;
        saveAccounts(data, this.storePath);
        return true;
    }

    /**
     * Updates the priority of a specific account.
     */
    updatePriority(accountId: string, newPriority: number): boolean {
        const data = loadAccounts(this.storePath);
        const account = data.accounts.find((a) => a.id === accountId);
        if (!account) {
            return false;
        }
        account.priority = newPriority;
        saveAccounts(data, this.storePath);
        return true;
    }
}
