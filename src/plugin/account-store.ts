import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { homedir } from "node:os";

/**
 * Represents a single stored Google account with its credentials and status.
 */
export interface StoredAccount {
    id: string;
    email?: string;
    refresh: string;
    access?: string;
    expires?: number;
    addedAt: number;
    exhaustedUntil?: number;
    disabled?: boolean;
    priority: number;
}

/**
 * Top-level shape for the persisted account store file.
 */
export interface AccountStoreData {
    version: 1;
    accounts: StoredAccount[];
}

const EMPTY_STORE: AccountStoreData = { version: 1, accounts: [] };

/**
 * Returns the default file path for the account store.
 */
export function getDefaultStorePath(): string {
    return join(homedir(), ".config", "opencode", "gemini-accounts.json");
}

/**
 * Loads accounts from the store file. Returns empty data on missing or invalid files.
 */
export function loadAccounts(filePath?: string): AccountStoreData {
    const resolvedPath = filePath ?? getDefaultStorePath();
    if (!existsSync(resolvedPath)) {
        return { ...EMPTY_STORE, accounts: [] };
    }

    try {
        const raw = readFileSync(resolvedPath, "utf-8");
        const parsed = JSON.parse(raw);
        if (
            !parsed ||
            typeof parsed !== "object" ||
            !Array.isArray(parsed.accounts)
        ) {
            return { ...EMPTY_STORE, accounts: [] };
        }
        return { version: 1, accounts: parsed.accounts };
    } catch {
        return { ...EMPTY_STORE, accounts: [] };
    }
}

/**
 * Saves accounts to the store file, creating parent directories as needed.
 */
export function saveAccounts(
    data: AccountStoreData,
    filePath?: string,
): void {
    const resolvedPath = filePath ?? getDefaultStorePath();
    const dir = dirname(resolvedPath);
    if (!existsSync(dir)) {
        mkdirSync(dir, { recursive: true });
    }
    writeFileSync(resolvedPath, JSON.stringify(data, null, 2), "utf-8");
}

/**
 * Adds or updates an account in the store.
 * If an account with the same email already exists, its credentials are updated in place.
 */
export function addAccount(
    account: StoredAccount,
    filePath?: string,
): void {
    const data = loadAccounts(filePath);

    if (account.email) {
        const existingIndex = data.accounts.findIndex(
            (a) => a.email && a.email === account.email,
        );
        if (existingIndex >= 0) {
            const existing = data.accounts[existingIndex]!;
            data.accounts[existingIndex] = {
                ...account,
                id: existing.id,
                priority: existing.priority,
                addedAt: existing.addedAt,
            };
            saveAccounts(data, filePath);
            return;
        }
    }

    data.accounts.push(account);
    saveAccounts(data, filePath);
}

/**
 * Removes an account by its ID. Returns true if an account was removed.
 */
export function removeAccount(
    id: string,
    filePath?: string,
): boolean {
    const data = loadAccounts(filePath);
    const initialLength = data.accounts.length;
    data.accounts = data.accounts.filter((a) => a.id !== id);

    if (data.accounts.length === initialLength) {
        return false;
    }

    saveAccounts(data, filePath);
    return true;
}
