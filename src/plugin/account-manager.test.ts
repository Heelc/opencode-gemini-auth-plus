import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { AccountManager } from "./account-manager";
import type { StoredAccount } from "./account-store";
import type { OAuthAuthDetails } from "./types";

const REAL_DATE_NOW = Date.now;
const FIXED_NOW = Date.parse("2026-03-04T00:00:00.000Z");

function createTmpDir(): string {
    const dir = join(tmpdir(), `account-mgr-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    mkdirSync(dir, { recursive: true });
    return dir;
}

let tmpDir: string;
let storePath: string;

beforeEach(() => {
    tmpDir = createTmpDir();
    storePath = join(tmpDir, "accounts.json");
    Date.now = () => FIXED_NOW;
});

afterEach(() => {
    Date.now = REAL_DATE_NOW;
    try {
        rmSync(tmpDir, { recursive: true, force: true });
    } catch { }
});

describe("AccountManager.getActiveAccount", () => {
    it("returns undefined when no accounts exist", () => {
        const manager = new AccountManager(storePath);

        expect(manager.getActiveAccount()).toBeUndefined();
    });

    it("returns the single account when one exists", () => {
        const manager = new AccountManager(storePath);
        manager.addAccount({ email: "a@gmail.com", refresh: "token-a" });

        const active = manager.getActiveAccount();

        expect(active).toBeDefined();
        expect(active!.email).toBe("a@gmail.com");
    });

    it("returns the highest-priority non-exhausted account", () => {
        const manager = new AccountManager(storePath);
        manager.addAccount({ email: "a@gmail.com", refresh: "token-a" });
        manager.addAccount({ email: "b@gmail.com", refresh: "token-b" });

        // Exhaust account A
        const accountA = manager.getAllAccounts().find((a) => a.email === "a@gmail.com")!;
        manager.markExhausted(accountA.id, FIXED_NOW + 3600_000);

        const active = manager.getActiveAccount();

        expect(active).toBeDefined();
        expect(active!.email).toBe("b@gmail.com");
    });

    it("returns undefined when all accounts are exhausted", () => {
        const manager = new AccountManager(storePath);
        manager.addAccount({ email: "a@gmail.com", refresh: "token-a" });
        manager.addAccount({ email: "b@gmail.com", refresh: "token-b" });

        for (const account of manager.getAllAccounts()) {
            manager.markExhausted(account.id, FIXED_NOW + 3600_000);
        }

        expect(manager.getActiveAccount()).toBeUndefined();
    });

    it("recovers an account after exhaustedUntil has passed", () => {
        const manager = new AccountManager(storePath);
        manager.addAccount({ email: "a@gmail.com", refresh: "token-a" });

        const account = manager.getAllAccounts()[0]!;
        // Set exhausted until 1 hour from now
        manager.markExhausted(account.id, FIXED_NOW + 3600_000);
        expect(manager.getActiveAccount()).toBeUndefined();

        // Advance time past the exhausted window
        Date.now = () => FIXED_NOW + 3600_001;
        expect(manager.getActiveAccount()).toBeDefined();
        expect(manager.getActiveAccount()!.email).toBe("a@gmail.com");
    });
});

describe("AccountManager.addAccount", () => {
    it("assigns a unique id and incrementing priority", () => {
        const manager = new AccountManager(storePath);
        const a = manager.addAccount({ email: "a@gmail.com", refresh: "token-a" });
        const b = manager.addAccount({ email: "b@gmail.com", refresh: "token-b" });

        expect(a.id).toBeTruthy();
        expect(b.id).toBeTruthy();
        expect(a.id).not.toBe(b.id);
        expect(a.priority).toBeLessThan(b.priority);
    });

    it("updates credentials for the same email instead of creating a duplicate", () => {
        const manager = new AccountManager(storePath);
        manager.addAccount({ email: "same@gmail.com", refresh: "old-token" });
        manager.addAccount({ email: "same@gmail.com", refresh: "new-token" });

        const accounts = manager.getAllAccounts();
        expect(accounts).toHaveLength(1);
        expect(accounts[0]!.refresh).toBe("new-token");
    });
});

describe("AccountManager.markExhausted / isExhausted", () => {
    it("marks an account as exhausted", () => {
        const manager = new AccountManager(storePath);
        manager.addAccount({ email: "a@gmail.com", refresh: "token-a" });

        const account = manager.getAllAccounts()[0]!;
        expect(manager.isExhausted(account.id)).toBe(false);

        manager.markExhausted(account.id, FIXED_NOW + 3600_000);
        expect(manager.isExhausted(account.id)).toBe(true);
    });

    it("defaults exhaustedUntil to 1 hour when no resetTime is provided", () => {
        const manager = new AccountManager(storePath);
        manager.addAccount({ email: "a@gmail.com", refresh: "token-a" });

        const account = manager.getAllAccounts()[0]!;
        manager.markExhausted(account.id);
        expect(manager.isExhausted(account.id)).toBe(true);

        // After 1 hour it should recover
        Date.now = () => FIXED_NOW + 3600_001;
        expect(manager.isExhausted(account.id)).toBe(false);
    });
});

describe("AccountManager.toAuthDetails", () => {
    it("converts a StoredAccount to OAuthAuthDetails", () => {
        const manager = new AccountManager(storePath);
        const stored = manager.addAccount({
            email: "a@gmail.com",
            refresh: "token-a",
            access: "access-a",
            expires: FIXED_NOW + 3600_000,
        });

        const auth = manager.toAuthDetails(stored);

        expect(auth.type).toBe("oauth");
        expect(auth.refresh).toBe("token-a");
        expect(auth.access).toBe("access-a");
        expect(auth.expires).toBe(FIXED_NOW + 3600_000);
    });
});

describe("AccountManager.updateTokens", () => {
    it("updates access token and expiry for a specific account", () => {
        const manager = new AccountManager(storePath);
        manager.addAccount({ email: "a@gmail.com", refresh: "token-a" });

        const account = manager.getAllAccounts()[0]!;
        manager.updateTokens(account.id, "new-access", FIXED_NOW + 7200_000);

        const updated = manager.getAllAccounts()[0]!;
        expect(updated.access).toBe("new-access");
        expect(updated.expires).toBe(FIXED_NOW + 7200_000);
    });

    it("updates the refresh token when provided", () => {
        const manager = new AccountManager(storePath);
        manager.addAccount({ email: "a@gmail.com", refresh: "token-a" });

        const account = manager.getAllAccounts()[0]!;
        manager.updateTokens(account.id, "new-access", FIXED_NOW + 7200_000, "rotated-refresh");

        const updated = manager.getAllAccounts()[0]!;
        expect(updated.refresh).toBe("rotated-refresh");
    });
});

describe("AccountManager.removeAccount", () => {
    it("removes an account and confirms it is gone", () => {
        const manager = new AccountManager(storePath);
        manager.addAccount({ email: "a@gmail.com", refresh: "token-a" });

        const account = manager.getAllAccounts()[0]!;
        const removed = manager.removeAccount(account.id);

        expect(removed).toBe(true);
        expect(manager.getAllAccounts()).toHaveLength(0);
    });
});

describe("AccountManager.disableAccount / enableAccount", () => {
    it("disables an account and getActiveAccount skips it", () => {
        const manager = new AccountManager(storePath);
        manager.addAccount({ email: "a@gmail.com", refresh: "token-a" });
        manager.addAccount({ email: "b@gmail.com", refresh: "token-b" });

        const accountA = manager.getAllAccounts().find((a) => a.email === "a@gmail.com")!;
        manager.disableAccount(accountA.id);

        const active = manager.getActiveAccount();
        expect(active).toBeDefined();
        expect(active!.email).toBe("b@gmail.com");
    });

    it("re-enables a disabled account", () => {
        const manager = new AccountManager(storePath);
        manager.addAccount({ email: "a@gmail.com", refresh: "token-a" });

        const account = manager.getAllAccounts()[0]!;
        manager.disableAccount(account.id);
        expect(manager.getActiveAccount()).toBeUndefined();

        manager.enableAccount(account.id);
        expect(manager.getActiveAccount()).toBeDefined();
        expect(manager.getActiveAccount()!.email).toBe("a@gmail.com");
    });
});

describe("AccountManager.updatePriority", () => {
    it("changes the priority of an account", () => {
        const manager = new AccountManager(storePath);
        manager.addAccount({ email: "a@gmail.com", refresh: "token-a" });
        manager.addAccount({ email: "b@gmail.com", refresh: "token-b" });

        const accountB = manager.getAllAccounts().find((a) => a.email === "b@gmail.com")!;
        // Make B higher priority (lower number) than A
        manager.updatePriority(accountB.id, -1);

        const active = manager.getActiveAccount();
        expect(active!.email).toBe("b@gmail.com");
    });
});

describe("AccountManager.syncFromFramework", () => {
    it("syncs auth into pool when store file does not exist", () => {
        const manager = new AccountManager(storePath);
        const auth: OAuthAuthDetails = {
            type: "oauth",
            refresh: "refresh-token-1",
            access: "access-token-1",
            expires: FIXED_NOW + 3600_000,
        };

        manager.syncFromFramework(auth, "synced@gmail.com");

        const accounts = manager.getAllAccounts();
        expect(accounts).toHaveLength(1);
        expect(accounts[0]!.email).toBe("synced@gmail.com");
        expect(accounts[0]!.refresh).toBe("refresh-token-1");
    });

    it("skips sync when store file already exists", () => {
        const manager = new AccountManager(storePath);
        // First add creates the store file
        manager.addAccount({ email: "existing@gmail.com", refresh: "existing-token" });

        const auth: OAuthAuthDetails = {
            type: "oauth",
            refresh: "new-refresh-token",
            access: "new-access-token",
            expires: FIXED_NOW + 3600_000,
        };

        manager.syncFromFramework(auth, "new@gmail.com");

        // Should NOT have added the new account
        const accounts = manager.getAllAccounts();
        expect(accounts).toHaveLength(1);
        expect(accounts[0]!.email).toBe("existing@gmail.com");
    });

    it("skips sync when auth has no refresh token", () => {
        const manager = new AccountManager(storePath);
        const auth: OAuthAuthDetails = {
            type: "oauth",
            refresh: "",
            access: "access-token",
        };

        manager.syncFromFramework(auth, "no-refresh@gmail.com");

        expect(manager.getAllAccounts()).toHaveLength(0);
    });
});

describe("AccountManager.getActiveAccount (disabled + exhausted overlap)", () => {
    it("skips both disabled and exhausted accounts", () => {
        const manager = new AccountManager(storePath);
        manager.addAccount({ email: "a@gmail.com", refresh: "token-a" });
        manager.addAccount({ email: "b@gmail.com", refresh: "token-b" });
        manager.addAccount({ email: "c@gmail.com", refresh: "token-c" });

        const accounts = manager.getAllAccounts();
        const accountA = accounts.find((a) => a.email === "a@gmail.com")!;
        const accountB = accounts.find((a) => a.email === "b@gmail.com")!;

        // Disable A, exhaust B → only C should be active
        manager.disableAccount(accountA.id);
        manager.markExhausted(accountB.id, FIXED_NOW + 3600_000);

        const active = manager.getActiveAccount();
        expect(active).toBeDefined();
        expect(active!.email).toBe("c@gmail.com");
    });

    it("returns undefined when all accounts are disabled or exhausted", () => {
        const manager = new AccountManager(storePath);
        manager.addAccount({ email: "a@gmail.com", refresh: "token-a" });
        manager.addAccount({ email: "b@gmail.com", refresh: "token-b" });

        const accounts = manager.getAllAccounts();
        manager.disableAccount(accounts[0]!.id);
        manager.markExhausted(accounts[1]!.id, FIXED_NOW + 3600_000);

        expect(manager.getActiveAccount()).toBeUndefined();
    });
});
