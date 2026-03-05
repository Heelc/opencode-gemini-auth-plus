import { tool } from "@opencode-ai/plugin";
import { accessTokenExpired, isOAuthAuth } from "./auth";
import { resolveCachedAuth } from "./cache";
import { ensureProjectContext, retrieveUserQuota } from "./project";
import type { RetrieveUserQuotaBucket } from "./project/types";
import { refreshAccessToken } from "./token";
import type { GetAuth, PluginClient } from "./types";
import type { AccountManager } from "./account-manager";

export const GEMINI_QUOTA_TOOL_NAME = "gemini_quota";

interface GeminiQuotaToolDependencies {
  client: PluginClient;
  getAuthResolver: () => GetAuth | undefined;
  getConfiguredProjectId: () => string | undefined;
  accountManager?: AccountManager;
}

export function createGeminiQuotaTool({
  client,
  getAuthResolver,
  getConfiguredProjectId,
  accountManager,
}: GeminiQuotaToolDependencies) {
  return tool({
    description:
      "Retrieve current Gemini Code Assist quota usage for the authenticated user and project. Shows quota for all accounts in the managed pool.",
    args: {},
    async execute() {
      // Multi-account mode: query each account in the pool
      if (accountManager) {
        const poolAccounts = accountManager.getAllAccounts();
        if (poolAccounts.length >= 1) {
          return queryMultiAccountQuota(poolAccounts, accountManager, client, getConfiguredProjectId());
        }
      }

      // Single-account fallback: use framework auth
      const getAuth = getAuthResolver();
      if (!getAuth) {
        return "Gemini quota is unavailable before Google auth is initialized. Authenticate with the Google provider and retry.";
      }

      const auth = await getAuth();
      if (!isOAuthAuth(auth)) {
        return "Gemini quota requires OAuth with Google. Run `opencode auth login` and choose `OAuth with Google (Gemini CLI)`.";
      }

      return querySingleAccountQuota(auth, client, getConfiguredProjectId());
    },
  });
}

async function querySingleAccountQuota(
  auth: ReturnType<typeof resolveCachedAuth> extends infer T ? T : never,
  client: PluginClient,
  configuredProjectId?: string,
): Promise<string> {
  let authRecord = resolveCachedAuth(auth);
  if (accessTokenExpired(authRecord)) {
    const refreshed = await refreshAccessToken(authRecord, client);
    if (!refreshed?.access) {
      return "Gemini quota lookup failed because the access token could not be refreshed. Re-authenticate and retry.";
    }
    authRecord = refreshed;
  }

  if (!authRecord.access) {
    return "Gemini quota lookup failed because no access token is available. Re-authenticate and retry.";
  }

  try {
    const projectContext = await ensureProjectContext(
      authRecord,
      client,
      configuredProjectId,
    );
    if (!projectContext.effectiveProjectId) {
      return "Gemini quota lookup failed because no Google Cloud project could be resolved.";
    }

    const quota = await retrieveUserQuota(
      authRecord.access,
      projectContext.effectiveProjectId,
    );
    if (!quota?.buckets?.length) {
      return `No Gemini quota buckets were returned for project \`${projectContext.effectiveProjectId}\`.`;
    }

    return formatGeminiQuotaOutput(
      projectContext.effectiveProjectId,
      quota.buckets,
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : "unknown error";
    return `Gemini quota lookup failed: ${message}`;
  }
}

import type { StoredAccount } from "./account-store";

async function queryMultiAccountQuota(
  accounts: StoredAccount[],
  accountManager: AccountManager,
  client: PluginClient,
  configuredProjectId?: string,
): Promise<string> {
  const sections: string[] = [
    `Gemini Accounts Quota (${accounts.length} account${accounts.length > 1 ? "s" : ""})`,
    "",
  ];

  for (const account of accounts) {
    const label = account.email ?? account.id;
    const isExhausted = accountManager.isExhausted(account.id);
    const isDisabled = account.disabled === true;
    const isActive = !isExhausted && !isDisabled;
    const activeAccount = accountManager.getActiveAccount();
    const isCurrent = activeAccount?.id === account.id;

    let statusIcon = "✅";
    if (isExhausted) statusIcon = "⚠️";
    if (isDisabled) statusIcon = "🚫";
    const prefix = isCurrent ? "▶" : " ";
    sections.push(`${prefix} ${statusIcon} ${label} (priority=${account.priority})`);

    if (isDisabled) {
      sections.push("  ↳ Account is disabled — skipping quota lookup");
      sections.push("");
      continue;
    }

    // Build auth details and refresh token if needed
    const authDetails = accountManager.toAuthDetails(account);
    let authRecord = resolveCachedAuth(authDetails);
    if (accessTokenExpired(authRecord)) {
      try {
        const refreshed = await refreshAccessToken(authRecord, client);
        if (refreshed?.access) {
          authRecord = refreshed;
          accountManager.updateTokens(
            account.id,
            refreshed.access,
            refreshed.expires ?? Date.now() + 3600_000,
            refreshed.refresh !== authDetails.refresh ? refreshed.refresh : undefined,
          );
        } else {
          sections.push("  ↳ ❌ Token refresh failed");
          sections.push("");
          continue;
        }
      } catch {
        sections.push("  ↳ ❌ Token refresh failed");
        sections.push("");
        continue;
      }
    }

    if (!authRecord.access) {
      sections.push("  ↳ ❌ No access token available");
      sections.push("");
      continue;
    }

    try {
      const projectContext = await ensureProjectContext(
        authRecord,
        client,
        configuredProjectId,
      );
      if (!projectContext.effectiveProjectId) {
        sections.push("  ↳ ❌ No project could be resolved");
        sections.push("");
        continue;
      }

      const quota = await retrieveUserQuota(
        authRecord.access,
        projectContext.effectiveProjectId,
      );
      if (!quota?.buckets?.length) {
        sections.push(`  ↳ No quota buckets returned for project \`${projectContext.effectiveProjectId}\``);
        sections.push("");
        continue;
      }

      // Auto-clear exhausted state if all buckets show remaining quota
      if (isExhausted) {
        const allRecovered = quota.buckets.every(
          (b) => b.remainingFraction === undefined || b.remainingFraction > 0,
        );
        if (allRecovered) {
          accountManager.clearExhausted(account.id);
          // Update the status icon in-place for this output
          const lastHeaderIndex = sections.length - 1;
          for (let i = lastHeaderIndex; i >= 0; i--) {
            const line = sections[i];
            if (line && line.includes("⚠️") && line.includes(label)) {
              sections[i] = line.replace("⚠️", "✅");
              break;
            }
          }
        }
      }

      // Indent the quota output under this account
      const quotaOutput = formatGeminiQuotaOutput(
        projectContext.effectiveProjectId,
        quota.buckets,
      );
      const indentedLines = quotaOutput
        .split("\n")
        .map((line) => `  ${line}`);
      sections.push(...indentedLines);
    } catch (error) {
      const message = error instanceof Error ? error.message : "unknown error";
      sections.push(`  ↳ ❌ Quota lookup failed: ${message}`);
    }
    sections.push("");
  }

  return sections.join("\n");
}

export function formatGeminiQuotaOutput(
  projectId: string,
  buckets: RetrieveUserQuotaBucket[],
): string {
  const sortedBuckets = [...buckets].sort(compareQuotaBuckets);
  const groupedRows = groupQuotaRows(sortedBuckets);
  const versionGroups = groupByVersion(groupedRows);
  const variantWidth = Math.max(
    "Variant".length,
    ...versionGroups.flatMap((group) =>
      group.models.flatMap((model) => model.rows.map((row) => row.variant.length))
    ),
  );
  const tokenTypeValues = [...new Set(versionGroups.flatMap((group) =>
    group.models.flatMap((model) => model.rows.map((row) => row.tokenType))
  ))];
  const showTokenType = tokenTypeValues.length > 1 || tokenTypeValues[0] !== "REQUESTS";
  const lines = [
    `Gemini quota usage for project \`${projectId}\``,
    "",
    showTokenType
      ? `  ↳ ${pad("Variant", variantWidth)}  Remaining                   Reset      Type`
      : `  ↳ ${pad("Variant", variantWidth)}  Remaining                   Reset`,
  ];

  for (let index = 0; index < versionGroups.length; index += 1) {
    const versionGroup = versionGroups[index];
    if (!versionGroup) {
      continue;
    }
    if (index > 0) {
      lines.push("");
    }
    lines.push(formatVersionGroupTitle(versionGroup));
    for (const model of versionGroup.models) {
      lines.push(model.baseModel);
      for (const row of model.rows) {
        lines.push(
          showTokenType
            ? `  ↳ ${pad(row.variant, variantWidth)}  ${pad(row.usageRemaining, 27)} ${pad(row.resetValue, 8)} ${row.tokenType}`
            : `  ↳ ${pad(row.variant, variantWidth)}  ${pad(row.usageRemaining, 27)} ${row.resetValue}`,
        );
      }
    }
  }

  return lines.join("\n");
}

function compareQuotaBuckets(
  left: RetrieveUserQuotaBucket,
  right: RetrieveUserQuotaBucket,
): number {
  const leftModel = left.modelId ?? "";
  const rightModel = right.modelId ?? "";
  if (leftModel !== rightModel) {
    return leftModel.localeCompare(rightModel);
  }

  const leftTokenType = left.tokenType ?? "";
  const rightTokenType = right.tokenType ?? "";
  if (leftTokenType !== rightTokenType) {
    return leftTokenType.localeCompare(rightTokenType);
  }

  return (left.resetTime ?? "").localeCompare(right.resetTime ?? "");
}

function formatUsageRemaining(bucket: RetrieveUserQuotaBucket): string {
  const remainingAmount = formatRemainingAmount(bucket.remainingAmount);
  const remainingFraction = bucket.remainingFraction;
  const hasFraction =
    typeof remainingFraction === "number" && Number.isFinite(remainingFraction);

  if (hasFraction) {
    const clamped = clamp(remainingFraction, 0, 1);
    const percent = (clamped * 100).toFixed(1);
    const bar = buildProgressBar(clamped);
    return remainingAmount
      ? `${bar} ${percent}% (${remainingAmount} left)`
      : `${bar} ${percent}%`;
  }

  if (remainingAmount) {
    return remainingAmount;
  }

  return "unknown";
}

function formatRemainingAmount(value: string | undefined): string | undefined {
  if (!value) {
    return undefined;
  }
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed)) {
    return value;
  }
  return parsed.toLocaleString("en-US");
}

export function formatRelativeResetTime(resetTime: string | undefined): string | undefined {
  if (!resetTime) {
    return undefined;
  }

  const resetAt = new Date(resetTime).getTime();
  if (Number.isNaN(resetAt)) {
    return undefined;
  }

  const diffMs = resetAt - Date.now();
  if (diffMs <= 0) {
    return "reset pending";
  }

  const totalMinutes = Math.ceil(diffMs / (1000 * 60));
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;

  if (hours > 0 && minutes > 0) {
    return `resets in ${hours}h ${minutes}m`;
  }
  if (hours > 0) {
    return `resets in ${hours}h`;
  }
  return `resets in ${minutes}m`;
}

function buildProgressBar(fraction: number, width = 20): string {
  const clamped = clamp(fraction, 0, 1);
  const filled = clamped >= 1
    ? width
    : Math.max(0, Math.min(width, Math.max(clamped > 0 ? 1 : 0, Math.floor(clamped * width))));
  const empty = width - filled;
  return `${"▓".repeat(filled)}${"░".repeat(empty)}`;
}

function pad(value: string, width: number): string {
  if (value.length >= width) {
    return value;
  }
  return value.padEnd(width, " ");
}

function clamp(value: number, min: number, max: number): number {
  if (value < min) {
    return min;
  }
  if (value > max) {
    return max;
  }
  return value;
}

function normalizeTokenType(bucket: RetrieveUserQuotaBucket): string {
  const value = bucket.tokenType?.trim();
  return value ? value.toUpperCase() : "REQUESTS";
}

interface GroupedQuotaRow {
  variant: string;
  usageRemaining: string;
  resetValue: string;
  tokenType: string;
}

interface GroupedQuotaModel {
  baseModel: string;
  version: string | undefined;
  rows: GroupedQuotaRow[];
}

function groupQuotaRows(sortedBuckets: RetrieveUserQuotaBucket[]): GroupedQuotaModel[] {
  const groups = new Map<string, GroupedQuotaModel>();

  for (const bucket of sortedBuckets) {
    const modelId = bucket.modelId?.trim() || "unknown-model";
    const { baseModel, variant } = splitModelVariant(modelId);
    const usageRemaining = formatUsageRemaining(bucket);
    const resetLabel = formatRelativeResetTime(bucket.resetTime);
    const resetValue = resetLabel?.replace("resets in ", "") ?? "-";
    const tokenType = normalizeTokenType(bucket);

    const existing = groups.get(baseModel);
    if (existing) {
      existing.rows.push({
        variant,
        usageRemaining,
        resetValue,
        tokenType,
      });
      continue;
    }

    groups.set(baseModel, {
      baseModel,
      version: extractModelVersion(baseModel),
      rows: [{
        variant,
        usageRemaining,
        resetValue,
        tokenType,
      }],
    });
  }

  return [...groups.values()];
}

interface VersionQuotaGroup {
  title: string;
  version: string | undefined;
  models: GroupedQuotaModel[];
}

function groupByVersion(models: GroupedQuotaModel[]): VersionQuotaGroup[] {
  const groups = new Map<string, VersionQuotaGroup>();

  for (const model of models) {
    const key = model.version ?? "__unknown__";
    const existing = groups.get(key);
    if (existing) {
      existing.models.push(model);
      continue;
    }

    groups.set(key, {
      title: model.version ? `Gemini ${model.version}` : "Other",
      version: model.version,
      models: [model],
    });
  }

  const ordered = [...groups.values()].sort((left, right) =>
    compareVersionDesc(left.version, right.version),
  );

  for (const group of ordered) {
    group.models.sort((left, right) => left.baseModel.localeCompare(right.baseModel));
  }

  return ordered;
}

function extractModelVersion(modelId: string): string | undefined {
  const match = modelId.match(/^gemini-([0-9]+(?:\.[0-9]+)*)-/i);
  return match?.[1];
}

function compareVersionDesc(left: string | undefined, right: string | undefined): number {
  if (!left && !right) {
    return 0;
  }
  if (!left) {
    return 1;
  }
  if (!right) {
    return -1;
  }

  const leftSegments = left.split(".").map((part) => Number.parseInt(part, 10));
  const rightSegments = right.split(".").map((part) => Number.parseInt(part, 10));
  const max = Math.max(leftSegments.length, rightSegments.length);

  for (let index = 0; index < max; index += 1) {
    const l = leftSegments[index] ?? 0;
    const r = rightSegments[index] ?? 0;
    if (Number.isNaN(l) || Number.isNaN(r)) {
      break;
    }
    if (l > r) {
      return -1;
    }
    if (l < r) {
      return 1;
    }
  }

  return right.localeCompare(left);
}

function formatVersionGroupTitle(group: VersionQuotaGroup): string {
  const modelCount = group.models.length;
  const bucketCount = group.models.reduce((count, model) => count + model.rows.length, 0);
  const modelLabel = modelCount === 1 ? "model" : "models";
  const bucketLabel = bucketCount === 1 ? "bucket" : "buckets";
  return `${group.title} (${modelCount} ${modelLabel}, ${bucketCount} ${bucketLabel})`;
}

function splitModelVariant(modelId: string): { baseModel: string; variant: string } {
  const vertexSuffix = "_vertex";
  if (modelId.endsWith(vertexSuffix)) {
    return {
      baseModel: modelId.slice(0, -vertexSuffix.length),
      variant: "vertex",
    };
  }
  return {
    baseModel: modelId,
    variant: "default",
  };
}
