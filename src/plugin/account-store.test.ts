import { afterEach, describe, expect, it } from "bun:test";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import {
    loadAccounts,
    saveAccounts,
    addAccount,
    removeAccount,
    type StoredAccount,
    type AccountStoreData,
} from "./account-store";

function createTmpDir(): string {
    const dir = join(tmpdir(), `account-store-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    mkdirSync(dir, { recursive: true });
    return dir;
}

function makeAccount(overrides: Partial<StoredAccount> = {}): StoredAccount {
    return {
        id: overrides.id ?? "account-1",
        email: overrides.email ?? "test@gmail.com",
        refresh: overrides.refresh ?? "refresh-token-1",
        access: overrides.access ?? "access-token-1",
        expires: overrides.expires ?? Date.now() + 3600_000,
        addedAt: overrides.addedAt ?? Date.now(),
        priority: overrides.priority ?? 0,
        ...overrides,
    };
}

const tmpDirs: string[] = [];

afterEach(() => {
    for (const dir of tmpDirs) {
        try {
            rmSync(dir, { recursive: true, force: true });
        } catch { }
    }
    tmpDirs.length = 0;
});

describe("loadAccounts", () => {
    it("returns empty accounts when file does not exist", () => {
        const dir = createTmpDir();
        tmpDirs.push(dir);
        const filePath = join(dir, "nonexistent.json");

        const data = loadAccounts(filePath);

        expect(data.version).toBe(1);
        expect(data.accounts).toEqual([]);
    });

    it("loads previously saved accounts", () => {
        const dir = createTmpDir();
        tmpDirs.push(dir);
        const filePath = join(dir, "accounts.json");
        const account = makeAccount();
        const storeData: AccountStoreData = { version: 1, accounts: [account] };

        saveAccounts(storeData, filePath);
        const loaded = loadAccounts(filePath);

        expect(loaded.version).toBe(1);
        expect(loaded.accounts).toHaveLength(1);
        expect(loaded.accounts[0]!.id).toBe(account.id);
        expect(loaded.accounts[0]!.email).toBe(account.email);
        expect(loaded.accounts[0]!.refresh).toBe(account.refresh);
    });

    it("returns empty accounts when file contains invalid JSON", () => {
        const dir = createTmpDir();
        tmpDirs.push(dir);
        const filePath = join(dir, "corrupted.json");
        writeFileSync(filePath, "this is not json{{{");

        const data = loadAccounts(filePath);

        expect(data.version).toBe(1);
        expect(data.accounts).toEqual([]);
    });

    it("returns empty accounts when file contains valid JSON but wrong structure", () => {
        const dir = createTmpDir();
        tmpDirs.push(dir);
        const filePath = join(dir, "wrong-structure.json");
        writeFileSync(filePath, JSON.stringify({ foo: "bar" }));

        const data = loadAccounts(filePath);

        expect(data.version).toBe(1);
        expect(data.accounts).toEqual([]);
    });
});

describe("saveAccounts", () => {
    it("creates parent directories if they do not exist", () => {
        const dir = createTmpDir();
        tmpDirs.push(dir);
        const filePath = join(dir, "nested", "deep", "accounts.json");
        const storeData: AccountStoreData = { version: 1, accounts: [makeAccount()] };

        saveAccounts(storeData, filePath);

        expect(existsSync(filePath)).toBe(true);
        const loaded = loadAccounts(filePath);
        expect(loaded.accounts).toHaveLength(1);
    });
});

describe("addAccount", () => {
    it("appends a new account without overwriting existing ones", () => {
        const dir = createTmpDir();
        tmpDirs.push(dir);
        const filePath = join(dir, "accounts.json");
        const account1 = makeAccount({ id: "account-1", email: "a@gmail.com" });
        const account2 = makeAccount({ id: "account-2", email: "b@gmail.com" });

        addAccount(account1, filePath);
        addAccount(account2, filePath);

        const loaded = loadAccounts(filePath);
        expect(loaded.accounts).toHaveLength(2);
        expect(loaded.accounts[0]!.email).toBe("a@gmail.com");
        expect(loaded.accounts[1]!.email).toBe("b@gmail.com");
    });

    it("updates existing account when email matches", () => {
        const dir = createTmpDir();
        tmpDirs.push(dir);
        const filePath = join(dir, "accounts.json");
        const account1 = makeAccount({ id: "account-1", email: "same@gmail.com", refresh: "old-token" });
        const account2 = makeAccount({ id: "account-2", email: "same@gmail.com", refresh: "new-token" });

        addAccount(account1, filePath);
        addAccount(account2, filePath);

        const loaded = loadAccounts(filePath);
        expect(loaded.accounts).toHaveLength(1);
        expect(loaded.accounts[0]!.refresh).toBe("new-token");
        // Should keep the original ID
        expect(loaded.accounts[0]!.id).toBe("account-1");
    });
});

describe("removeAccount", () => {
    it("removes an account by id", () => {
        const dir = createTmpDir();
        tmpDirs.push(dir);
        const filePath = join(dir, "accounts.json");
        const account1 = makeAccount({ id: "account-1" });
        const account2 = makeAccount({ id: "account-2", email: "b@gmail.com" });

        addAccount(account1, filePath);
        addAccount(account2, filePath);
        const removed = removeAccount("account-1", filePath);

        expect(removed).toBe(true);
        const loaded = loadAccounts(filePath);
        expect(loaded.accounts).toHaveLength(1);
        expect(loaded.accounts[0]!.id).toBe("account-2");
    });

    it("returns false when removing a non-existent account", () => {
        const dir = createTmpDir();
        tmpDirs.push(dir);
        const filePath = join(dir, "accounts.json");

        const removed = removeAccount("nonexistent", filePath);

        expect(removed).toBe(false);
    });
});

describe("getDefaultStorePath", () => {
    const originalEnv = process.env.OPENCODE_GEMINI_ACCOUNTS_PATH;

    afterEach(() => {
        if (originalEnv !== undefined) {
            process.env.OPENCODE_GEMINI_ACCOUNTS_PATH = originalEnv;
        } else {
            delete process.env.OPENCODE_GEMINI_ACCOUNTS_PATH;
        }
    });

    it("respects OPENCODE_GEMINI_ACCOUNTS_PATH env var", () => {
        const customPath = "/custom/path/to/gemini-accounts.json";
        process.env.OPENCODE_GEMINI_ACCOUNTS_PATH = customPath;

        const { getDefaultStorePath } = require("./account-store");
        expect(getDefaultStorePath()).toBe(customPath);
    });

    it("ignores blank OPENCODE_GEMINI_ACCOUNTS_PATH", () => {
        process.env.OPENCODE_GEMINI_ACCOUNTS_PATH = "   ";

        const { getDefaultStorePath } = require("./account-store");
        // Should fall back to default path containing "gemini-accounts.json"
        expect(getDefaultStorePath()).toContain("gemini-accounts.json");
        expect(getDefaultStorePath()).not.toBe("   ");
    });
});
