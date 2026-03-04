import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { AccountManager } from "./account-manager";
import {
    buildManagePrompts,
    handleManageAction,
    createAccountManageMethod,
} from "./account-manage";

const FIXED_NOW = Date.parse("2026-03-04T00:00:00.000Z");
const REAL_DATE_NOW = Date.now;

function createTmpDir(): string {
    const dir = join(tmpdir(), `account-manage-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
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

describe("buildManagePrompts", () => {
    it("includes all action options even when no accounts exist", () => {
        const manager = new AccountManager(storePath);
        const prompts = buildManagePrompts(manager);

        const actionPrompt = prompts.find((p) => p.key === "action");
        expect(actionPrompt).toBeDefined();
        expect(actionPrompt!.type).toBe("select");
        if (actionPrompt!.type === "select") {
            const values = actionPrompt!.options.map((o) => o.value);
            expect(values).toContain("list");
            expect(values).toContain("remove");
            expect(values).toContain("disable");
            expect(values).toContain("enable");
        }
    });

    it("includes account options when accounts exist", () => {
        const manager = new AccountManager(storePath);
        manager.addAccount({ email: "a@gmail.com", refresh: "token-a" });
        manager.addAccount({ email: "b@gmail.com", refresh: "token-b" });

        const prompts = buildManagePrompts(manager);
        const accountPrompt = prompts.find((p) => p.key === "accountId");
        expect(accountPrompt).toBeDefined();
        if (accountPrompt!.type === "select") {
            expect(accountPrompt!.options).toHaveLength(2);
        }
    });

    it("condition hides accountId select for list action", () => {
        const manager = new AccountManager(storePath);
        manager.addAccount({ email: "a@gmail.com", refresh: "token-a" });

        const prompts = buildManagePrompts(manager);
        const accountPrompt = prompts.find((p) => p.key === "accountId");
        expect(accountPrompt).toBeDefined();
        // list should NOT show accountId
        expect(accountPrompt!.condition!({ action: "list" })).toBe(false);
        // remove should show accountId
        expect(accountPrompt!.condition!({ action: "remove" })).toBe(true);
        // disable should show accountId
        expect(accountPrompt!.condition!({ action: "disable" })).toBe(true);
    });
});

describe("handleManageAction", () => {
    it("action=list returns instructions with account status info", async () => {
        const manager = new AccountManager(storePath);
        manager.addAccount({ email: "a@gmail.com", refresh: "token-a" });
        manager.addAccount({ email: "b@gmail.com", refresh: "token-b" });
        // Exhaust account B
        const accountB = manager.getAllAccounts().find((a) => a.email === "b@gmail.com")!;
        manager.markExhausted(accountB.id, FIXED_NOW + 3600_000);

        const result = await handleManageAction(manager, { action: "list" });

        expect(result.instructions).toContain("a@gmail.com");
        expect(result.instructions).toContain("b@gmail.com");
        expect(result.instructions).toContain("ACTIVE");
        expect(result.instructions).toContain("EXHAUSTED");
        // Account A should be marked as current
        expect(result.instructions).toContain("▶");
    });

    it("action=remove successfully removes an account", async () => {
        const manager = new AccountManager(storePath);
        manager.addAccount({ email: "a@gmail.com", refresh: "token-a" });
        const account = manager.getAllAccounts()[0]!;

        const result = await handleManageAction(manager, { action: "remove", accountId: account.id });

        expect(result.instructions).toContain("Removed");
        expect(manager.getAllAccounts()).toHaveLength(0);
    });

    it("action=remove returns error for non-existent account", async () => {
        const manager = new AccountManager(storePath);

        const result = await handleManageAction(manager, { action: "remove", accountId: "nonexistent" });

        expect(result.instructions).toContain("not found");
    });

    it("action=disable marks an account as disabled", async () => {
        const manager = new AccountManager(storePath);
        manager.addAccount({ email: "a@gmail.com", refresh: "token-a" });
        const account = manager.getAllAccounts()[0]!;

        const result = await handleManageAction(manager, { action: "disable", accountId: account.id });

        expect(result.instructions).toContain("Disabled");
        const updated = manager.getAllAccounts()[0]!;
        expect(updated.disabled).toBe(true);
    });

    it("action=enable re-enables a disabled account", async () => {
        const manager = new AccountManager(storePath);
        manager.addAccount({ email: "a@gmail.com", refresh: "token-a" });
        const account = manager.getAllAccounts()[0]!;
        manager.disableAccount(account.id);

        const result = await handleManageAction(manager, { action: "enable", accountId: account.id });

        expect(result.instructions).toContain("Enabled");
        const updated = manager.getAllAccounts()[0]!;
        expect(updated.disabled).toBeUndefined();
    });
});

describe("createAccountManageMethod", () => {
    it("returns a valid oauth auth method with prompts", () => {
        const manager = new AccountManager(storePath);
        const method = createAccountManageMethod(manager);

        expect(method.type).toBe("oauth");
        expect(method.label).toContain("Manage");
        expect(method.prompts).toBeDefined();
        expect(method.prompts!.length).toBeGreaterThan(0);
        expect(method.authorize).toBeDefined();
    });
});

describe("buildManagePrompts (enable condition)", () => {
    it("condition shows accountId select for enable action", () => {
        const manager = new AccountManager(storePath);
        manager.addAccount({ email: "a@gmail.com", refresh: "token-a" });

        const prompts = buildManagePrompts(manager);
        const accountPrompt = prompts.find((p) => p.key === "accountId");
        expect(accountPrompt).toBeDefined();
        expect(accountPrompt!.condition!({ action: "enable" })).toBe(true);
    });
});

describe("handleManageAction (error handling)", () => {
    it("action=disable returns error for non-existent account", async () => {
        const manager = new AccountManager(storePath);

        const result = await handleManageAction(manager, { action: "disable", accountId: "nonexistent" });

        expect(result.instructions).toContain("not found");
    });

    it("action=enable returns error for non-existent account", async () => {
        const manager = new AccountManager(storePath);

        const result = await handleManageAction(manager, { action: "enable", accountId: "nonexistent" });

        expect(result.instructions).toContain("not found");
    });

    it("action=list shows DISABLED status for disabled accounts", async () => {
        const manager = new AccountManager(storePath);
        manager.addAccount({ email: "disabled@gmail.com", refresh: "token-d" });
        const account = manager.getAllAccounts()[0]!;
        manager.disableAccount(account.id);

        const result = await handleManageAction(manager, { action: "list" });

        expect(result.instructions).toContain("DISABLED");
        expect(result.instructions).toContain("disabled@gmail.com");
    });
});
