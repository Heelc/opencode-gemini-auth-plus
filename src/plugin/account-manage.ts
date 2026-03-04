import { AccountManager } from "./account-manager";
import type { AuthMethod, AuthPrompt } from "./types";

/**
 * Builds interactive prompts for the "Manage Gemini accounts" auth method.
 */
export function buildManagePrompts(accountManager: AccountManager): AuthPrompt[] {
    const prompts: AuthPrompt[] = [];

    // Action selection
    prompts.push({
        type: "select",
        key: "action",
        message: "Choose an action",
        options: [
            { label: "📋 List all accounts", value: "list" },
            { label: "🗑️  Remove an account", value: "remove" },
            { label: "🚫 Disable an account", value: "disable" },
            { label: "✅ Enable an account", value: "enable" },
            { label: "🔄 Set account priority", value: "priority" },
        ],
    });

    // Account selection (shown for actions that target a specific account)
    const accounts = accountManager.getAllAccounts();
    if (accounts.length > 0) {
        prompts.push({
            type: "select",
            key: "accountId",
            message: "Select an account",
            options: accounts.map((a) => {
                const label = a.email ?? a.id;
                const status = a.disabled
                    ? "DISABLED"
                    : accountManager.isExhausted(a.id)
                        ? "EXHAUSTED"
                        : "ACTIVE";
                return {
                    label: `${status === "ACTIVE" ? "✅" : status === "EXHAUSTED" ? "⚠️" : "🚫"} ${label} (priority=${a.priority})`,
                    value: a.id,
                    hint: status,
                };
            }),
            condition: (inputs) => {
                const action = inputs.action;
                return action === "remove" || action === "disable" || action === "enable" || action === "priority";
            },
        });
    }

    return prompts;
}

/**
 * Handles the selected management action and returns an AuthOAuthResult.
 * Uses `instructions` to display results and `callback` returns `{ type: "failed" }`
 * so the framework knows no new login occurred.
 */
export async function handleManageAction(
    accountManager: AccountManager,
    inputs: Record<string, string>,
) {
    const baseResult = {
        url: "",
        method: "auto" as const,
        callback: async () => ({ type: "failed" as const, error: "Management action completed" }),
    };

    const action = inputs.action;

    if (action === "list") {
        const accounts = accountManager.getAllAccounts();
        if (accounts.length === 0) {
            return { ...baseResult, instructions: "No Gemini accounts registered.\nRun `opencode auth login` and choose `OAuth with Google (Gemini CLI)` to add an account." };
        }

        const activeAccount = accountManager.getActiveAccount();
        const lines: string[] = [`Gemini Accounts (${accounts.length} total)`, ""];
        for (const account of accounts) {
            const label = account.email ?? account.id;
            const isActive = activeAccount?.id === account.id;
            const prefix = isActive ? "▶ " : "  ";

            let status: string;
            if (account.disabled) {
                status = "🚫 DISABLED";
            } else if (accountManager.isExhausted(account.id)) {
                const remaining = (account.exhaustedUntil ?? 0) - Date.now();
                const hours = Math.ceil(remaining / 3600_000);
                status = `⚠️  EXHAUSTED (${hours}h until reset)`;
            } else {
                status = "✅ ACTIVE";
            }

            lines.push(`${prefix}${status}  ${label}  priority=${account.priority}`);
        }

        return { ...baseResult, instructions: lines.join("\n") };
    }

    const accountId = inputs.accountId ?? "";

    if (action === "remove") {
        const removed = accountManager.removeAccount(accountId);
        if (removed) {
            return { ...baseResult, instructions: `Removed account ${accountId} successfully.` };
        }
        return { ...baseResult, instructions: `Account ${accountId} not found.` };
    }

    if (action === "disable") {
        const disabled = accountManager.disableAccount(accountId);
        if (disabled) {
            return { ...baseResult, instructions: `Disabled account ${accountId}. It will not be used for requests.` };
        }
        return { ...baseResult, instructions: `Account ${accountId} not found.` };
    }

    if (action === "enable") {
        const enabled = accountManager.enableAccount(accountId);
        if (enabled) {
            return { ...baseResult, instructions: `Enabled account ${accountId}. It is now available for requests.` };
        }
        return { ...baseResult, instructions: `Account ${accountId} not found.` };
    }

    return { ...baseResult, instructions: `Unknown action: ${action}` };
}

/**
 * Creates the "Manage Gemini accounts" auth method for the plugin.
 */
export function createAccountManageMethod(accountManager: AccountManager): AuthMethod {
    return {
        type: "oauth",
        label: "📋 Manage Gemini accounts",
        prompts: buildManagePrompts(accountManager),
        authorize: async (inputs) => handleManageAction(accountManager, inputs ?? {}),
    };
}
