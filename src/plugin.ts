import { GEMINI_PROVIDER_ID } from "./constants";
import { createOAuthAuthorizeMethod } from "./plugin/oauth-authorize";
import { accessTokenExpired, isOAuthAuth } from "./plugin/auth";
import { resolveCachedAuth } from "./plugin/cache";
import { ensureProjectContext, retrieveUserQuota } from "./plugin/project";
import {
  createGeminiQuotaTool,
  GEMINI_QUOTA_TOOL_NAME,
} from "./plugin/quota";
import { isGeminiDebugEnabled, logGeminiDebugMessage, startGeminiDebugRequest } from "./plugin/debug";
import { maybeShowGeminiCapacityToast, maybeShowGeminiTestToast } from "./plugin/notify";
import {
  isGenerativeLanguageRequest,
  prepareGeminiRequest,
  type ThinkingConfigDefaults,
  transformGeminiResponse,
} from "./plugin/request";
import { fetchWithRetry } from "./plugin/retry";
import { refreshAccessToken } from "./plugin/token";
import { AccountManager } from "./plugin/account-manager";
import { fetchWithAccountFallback } from "./plugin/account-fetch";
import { createAccountManageMethod } from "./plugin/account-manage";
import type {
  GetAuth,
  LoaderResult,
  OAuthAuthDetails,
  PluginClient,
  PluginContext,
  PluginResult,
  Provider,
} from "./plugin/types";

const GEMINI_QUOTA_COMMAND = "gquota";
const GEMINI_QUOTA_COMMAND_TEMPLATE = `Retrieve Gemini Code Assist quota usage for the current authenticated account.

Immediately call \`${GEMINI_QUOTA_TOOL_NAME}\` with no arguments and return its output verbatim.
Do not call other tools.
`;
const GEMINI_ACCOUNT_COMMAND = "gaccount";
const GEMINI_ACCOUNT_COMMAND_TEMPLATE = `List all registered Gemini accounts and their status.

Immediately call \`gemini_accounts\` with no arguments and return its output verbatim.
Do not call other tools.
`;
let latestGeminiAuthResolver: GetAuth | undefined;
let latestGeminiConfiguredProjectId: string | undefined;
let latestAccountManager: AccountManager | undefined;

/**
 * Registers the Gemini OAuth provider for Opencode, handling auth, request rewriting,
 * debug logging, and response normalization for Gemini Code Assist endpoints.
 */
export const GeminiCLIOAuthPlugin = async (
  { client }: PluginContext,
): Promise<PluginResult> => {
  const accountManager = new AccountManager();
  latestAccountManager = accountManager;

  return {
    config: async (config) => {
      config.command = config.command || {};
      config.command[GEMINI_QUOTA_COMMAND] = {
        description: "Show Gemini Code Assist quota usage",
        template: GEMINI_QUOTA_COMMAND_TEMPLATE,
      };
      config.command[GEMINI_ACCOUNT_COMMAND] = {
        description: "List registered Gemini accounts and status",
        template: GEMINI_ACCOUNT_COMMAND_TEMPLATE,
      };
    },
    tool: {
      [GEMINI_QUOTA_TOOL_NAME]: createGeminiQuotaTool({
        client,
        getAuthResolver: () => latestGeminiAuthResolver,
        getConfiguredProjectId: () => latestGeminiConfiguredProjectId,
        accountManager,
      }),
      gemini_accounts: createGeminiAccountsTool({ accountManager }),
    },
    auth: {
      provider: GEMINI_PROVIDER_ID,
      loader: async (getAuth: GetAuth, provider: Provider): Promise<LoaderResult | null> => {
        latestGeminiAuthResolver = getAuth;
        const auth = await getAuth();
        if (!isOAuthAuth(auth)) {
          return null;
        }

        // Sync the framework-provided auth into the account pool
        accountManager.syncFromFramework(auth);

        const configuredProjectId = resolveConfiguredProjectId(provider);
        latestGeminiConfiguredProjectId = configuredProjectId;
        normalizeProviderModelCosts(provider);
        const thinkingConfigDefaults = resolveThinkingConfigDefaults(provider);

        return {
          apiKey: "",
          async fetch(input, init) {
            if (!isGenerativeLanguageRequest(input)) {
              return fetch(input, init);
            }

            // Check if we have multiple accounts in the pool
            const poolAccounts = accountManager.getAllAccounts();
            if (poolAccounts.length >= 1) {
              // Multi-account mode: full pipeline with per-request round-robin load balancing
              const triedAccountIds = new Set<string>();
              let lastExhaustedResponse: Response | undefined;
              let hadAuthFailure = false;

              while (true) {
                const account = accountManager.getNextAccount();
                if (!account || triedAccountIds.has(account.id)) {
                  if (lastExhaustedResponse) {
                    return lastExhaustedResponse;
                  }
                  // Pool exists but no accounts are usable — do NOT fall through
                  // to framework auth (which may hold tokens from a removed account)
                  return new Response(
                    JSON.stringify({
                      error: {
                        code: 429,
                        message: "All Gemini accounts in the pool are exhausted or disabled. Use `opencode auth login` → Manage Gemini accounts to check status, or add a new account.",
                        status: "RESOURCE_EXHAUSTED",
                      },
                    }),
                    { status: 429, headers: { "Content-Type": "application/json" } },
                  );
                }
                triedAccountIds.add(account.id);

                // Build auth details and refresh if needed
                let authDetails = accountManager.toAuthDetails(account);
                if (accessTokenExpired(authDetails)) {
                  const refreshed = await refreshAccessToken(authDetails, client);
                  if (!refreshed) {
                    hadAuthFailure = true;
                    continue; // skip this account
                  }
                  accountManager.updateTokens(
                    account.id,
                    refreshed.access!,
                    refreshed.expires!,
                    refreshed.refresh !== authDetails.refresh ? refreshed.refresh : undefined,
                  );
                  authDetails = refreshed;
                }

                if (!authDetails.access) {
                  continue;
                }

                // Full pipeline: project context → request preparation → fetch
                const projectContext = await ensureProjectContextOrThrow(
                  authDetails,
                  client,
                  configuredProjectId,
                );
                const transformed = prepareGeminiRequest(
                  input,
                  init,
                  authDetails.access,
                  projectContext.effectiveProjectId,
                  thinkingConfigDefaults,
                );
                const debugContext = startGeminiDebugRequest({
                  originalUrl: toUrlString(input),
                  resolvedUrl: toUrlString(transformed.request),
                  method: transformed.init.method,
                  headers: transformed.init.headers,
                  body: transformed.init.body,
                  streaming: transformed.streaming,
                  projectId: projectContext.effectiveProjectId,
                });

                const response = await fetchWithRetry(transformed.request, transformed.init, {
                    terminalOnRateLimit: true,
                });

                // Handle 401: refresh access token and retry once, then try next account
                if (response.status === 401) {
                  if (isGeminiDebugEnabled()) {
                    logGeminiDebugMessage(
                      `Account ${account.email ?? account.id} got 401, attempting token refresh`,
                    );
                  }
                  const refreshed = await refreshAccessToken(authDetails, client);
                  if (refreshed?.access) {
                    accountManager.updateTokens(
                      account.id,
                      refreshed.access,
                      refreshed.expires ?? Date.now() + 3600_000,
                      refreshed.refresh !== authDetails.refresh ? refreshed.refresh : undefined,
                    );
                    const retryTransformed = prepareGeminiRequest(
                      input,
                      init,
                      refreshed.access,
                      projectContext.effectiveProjectId,
                      thinkingConfigDefaults,
                    );
                    const retryResponse = await fetchWithRetry(retryTransformed.request, retryTransformed.init, {
                        terminalOnRateLimit: true,
                    });
                    if (retryResponse.status !== 401) {
                      // Check if the post-refresh response is a switchable 429
                      const retrySwitchResult = await classifyAccountSwitch(retryResponse);
                      if (retrySwitchResult) {
                        if (retrySwitchResult.reason === "switch-quota") {
                          const resetTime = retrySwitchResult.retryDelayMs
                            ? Date.now() + retrySwitchResult.retryDelayMs : undefined;
                          accountManager.markExhausted(account.id, resetTime);
                        }
                        if (isGeminiDebugEnabled()) {
                          logGeminiDebugMessage(
                            `Account ${account.email ?? account.id} post-refresh ${retrySwitchResult.reason}, switching to next account`,
                          );
                        }
                        lastExhaustedResponse = retryResponse;
                        continue;
                      }
                      // Sync refreshed auth to framework (ensures auth.json is not stale/empty)
                      try {
                        await client.auth.set({ path: { id: GEMINI_PROVIDER_ID }, body: refreshed });
                      } catch { }
                      await maybeShowGeminiCapacityToast(
                        client,
                        retryResponse,
                        projectContext.effectiveProjectId,
                        retryTransformed.requestedModel,
                      );
                      return transformGeminiResponse(
                        retryResponse,
                        retryTransformed.streaming,
                        debugContext,
                        retryTransformed.requestedModel,
                      );
                    }
                  }
                  // Refresh failed or retry still 401 → try next account
                  hadAuthFailure = true;
                  continue;
                }

                // Check for switchable 429 → try next account
                const switchResult = await classifyAccountSwitch(response);
                if (switchResult) {
                  if (switchResult.reason === "switch-quota") {
                    const resetTime = switchResult.retryDelayMs
                      ? Date.now() + switchResult.retryDelayMs : undefined;
                    if (isGeminiDebugEnabled()) {
                      logGeminiDebugMessage(
                        `Account ${account.email ?? account.id} quota exhausted, switching to next account`,
                      );
                    }
                    accountManager.markExhausted(account.id, resetTime);
                  } else if (isGeminiDebugEnabled()) {
                    logGeminiDebugMessage(
                      `Account ${account.email ?? account.id} ${switchResult.reason === "switch-rate" ? "rate-limited" : "model capacity exhausted"}, switching to next account`,
                    );
                  }
                  lastExhaustedResponse = response;
                  continue;
                }

                // Sync working auth to framework if a previous account had auth failure
                // (prevents invalid_grant from leaving auth.json empty after restart)
                if (hadAuthFailure) {
                  try {
                    await client.auth.set({ path: { id: GEMINI_PROVIDER_ID }, body: authDetails });
                  } catch { }
                }

                await maybeShowGeminiCapacityToast(
                  client,
                  response,
                  projectContext.effectiveProjectId,
                  transformed.requestedModel,
                );
                return transformGeminiResponse(
                  response,
                  transformed.streaming,
                  debugContext,
                  transformed.requestedModel,
                );
              }
            }

            // Single-account fallback (also used when multi-account loop breaks)
            const latestAuth = await getAuth();
            if (!isOAuthAuth(latestAuth)) {
              return fetch(input, init);
            }

            let authRecord = resolveCachedAuth(latestAuth);
            if (accessTokenExpired(authRecord)) {
              const refreshed = await refreshAccessToken(authRecord, client);
              if (!refreshed) {
                return fetch(input, init);
              }
              authRecord = refreshed;
            }

            if (!authRecord.access) {
              return fetch(input, init);
            }

            const projectContext = await ensureProjectContextOrThrow(
              authRecord,
              client,
              configuredProjectId,
            );
            await maybeShowGeminiTestToast(client, projectContext.effectiveProjectId);
            await maybeLogAvailableQuotaModels(
              authRecord.access,
              projectContext.effectiveProjectId,
            );
            const transformed = prepareGeminiRequest(
              input,
              init,
              authRecord.access,
              projectContext.effectiveProjectId,
              thinkingConfigDefaults,
            );
            const debugContext = startGeminiDebugRequest({
              originalUrl: toUrlString(input),
              resolvedUrl: toUrlString(transformed.request),
              method: transformed.init.method,
              headers: transformed.init.headers,
              body: transformed.init.body,
              streaming: transformed.streaming,
              projectId: projectContext.effectiveProjectId,
            });

            const response = await fetchWithRetry(transformed.request, transformed.init);

            // Handle 401: refresh access token and retry once
            if (response.status === 401) {
              const refreshed = await refreshAccessToken(authRecord, client);
              if (refreshed?.access) {
                authRecord = refreshed;
                const retryTransformed = prepareGeminiRequest(
                  input,
                  init,
                  refreshed.access,
                  projectContext.effectiveProjectId,
                  thinkingConfigDefaults,
                );
                const retryDebugContext = startGeminiDebugRequest({
                  originalUrl: toUrlString(input),
                  resolvedUrl: toUrlString(retryTransformed.request),
                  method: retryTransformed.init.method,
                  headers: retryTransformed.init.headers,
                  body: retryTransformed.init.body,
                  streaming: retryTransformed.streaming,
                  projectId: projectContext.effectiveProjectId,
                });
                const retryResponse = await fetchWithRetry(retryTransformed.request, retryTransformed.init);
                await maybeShowGeminiCapacityToast(
                  client,
                  retryResponse,
                  projectContext.effectiveProjectId,
                  retryTransformed.requestedModel,
                );
                return transformGeminiResponse(
                  retryResponse,
                  retryTransformed.streaming,
                  retryDebugContext,
                  retryTransformed.requestedModel,
                );
              }
            }

            await maybeShowGeminiCapacityToast(
              client,
              response,
              projectContext.effectiveProjectId,
              transformed.requestedModel,
            );
            return transformGeminiResponse(
              response,
              transformed.streaming,
              debugContext,
              transformed.requestedModel,
            );
          },
        };
      },
      methods: [
        {
          label: "OAuth with Google (Gemini CLI)",
          type: "oauth",
          authorize: createOAuthAuthorizeMethod(accountManager),
        },
        createAccountManageMethod(accountManager),
        {
          provider: GEMINI_PROVIDER_ID,
          label: "Manually enter API Key",
          type: "api",
        },
      ],
    },
  };
};

export const GoogleOAuthPlugin = GeminiCLIOAuthPlugin;
const loggedQuotaModelsByProject = new Set<string>();

import { tool } from "@opencode-ai/plugin";

function createGeminiAccountsTool({ accountManager }: { accountManager: AccountManager }) {
  return tool({
    description: "List all registered Gemini accounts and their current status.",
    args: {},
    async execute() {
      const accounts = accountManager.getAllAccounts();
      if (accounts.length === 0) {
        return "No Gemini accounts registered. Run `opencode auth login` and choose `OAuth with Google (Gemini CLI)` to add an account.";
      }

      const lines: string[] = [`Gemini accounts (${accounts.length} total)`, ""];
      for (const account of accounts) {
        const label = account.email ?? account.id;
        const exhausted = accountManager.isExhausted(account.id);
        const status = exhausted ? "⚠️  EXHAUSTED" : "✅ ACTIVE";
        const priority = `priority=${account.priority}`;
        const hasToken = account.access ? "token=yes" : "token=no";
        lines.push(`${status}  ${label}  (${priority}, ${hasToken})`);
      }
      return lines.join("\n");
    },
  });
}

function resolveConfiguredProjectId(provider: Provider): string | undefined {
  const providerOptions =
    provider && typeof provider === "object"
      ? ((provider as { options?: Record<string, unknown> }).options ?? undefined)
      : undefined;
  const projectIdFromConfig =
    providerOptions && typeof providerOptions.projectId === "string"
      ? providerOptions.projectId.trim()
      : "";
  const projectIdFromEnv = process.env.OPENCODE_GEMINI_PROJECT_ID?.trim() ?? "";
  const googleProjectIdFromEnv =
    process.env.GOOGLE_CLOUD_PROJECT?.trim() ??
    process.env.GOOGLE_CLOUD_PROJECT_ID?.trim() ??
    "";

  return projectIdFromEnv || projectIdFromConfig || googleProjectIdFromEnv || undefined;
}

function normalizeProviderModelCosts(provider: Provider): void {
  if (!provider.models) {
    return;
  }
  for (const model of Object.values(provider.models)) {
    if (model) {
      model.cost = { input: 0, output: 0 };
    }
  }
}

function resolveThinkingConfigDefaults(provider: Provider): ThinkingConfigDefaults | undefined {
  const providerOptions =
    provider && typeof provider === "object"
      ? ((provider as { options?: Record<string, unknown> }).options ?? undefined)
      : undefined;
  const providerThinkingConfig = providerOptions?.thinkingConfig;

  const modelThinkingConfigByModel: Record<string, unknown> = {};
  for (const [modelId, model] of Object.entries(provider.models ?? {})) {
    if (!model || typeof model !== "object") {
      continue;
    }
    const modelOptions = (model as { options?: Record<string, unknown> }).options;
    if (modelOptions && typeof modelOptions === "object" && "thinkingConfig" in modelOptions) {
      modelThinkingConfigByModel[modelId] = modelOptions.thinkingConfig;
    }
  }

  if (providerThinkingConfig === undefined && Object.keys(modelThinkingConfigByModel).length === 0) {
    return undefined;
  }

  return {
    provider: providerThinkingConfig,
    models: modelThinkingConfigByModel,
  };
}

async function ensureProjectContextOrThrow(
  authRecord: OAuthAuthDetails,
  client: PluginClient,
  configuredProjectId?: string,
) {
  try {
    return await ensureProjectContext(authRecord, client, configuredProjectId);
  } catch (error) {
    if (error instanceof Error) {
      console.error(error.message);
    }
    throw error;
  }
}

function toUrlString(value: RequestInfo): string {
  if (typeof value === "string") {
    return value;
  }
  const candidate = (value as Request).url;
  if (candidate) {
    return candidate;
  }
  return value.toString();
}

/**
 * Debug-only, best-effort model visibility log from Code Assist quota buckets.
 *
 * Why: it gives a concrete backend-side list of model IDs currently visible to the
 * current account/project, which helps explain 404/notFound model failures quickly.
 */
async function maybeLogAvailableQuotaModels(
  accessToken: string,
  projectId: string,
): Promise<void> {
  if (!isGeminiDebugEnabled() || !projectId) {
    return;
  }

  if (loggedQuotaModelsByProject.has(projectId)) {
    return;
  }
  loggedQuotaModelsByProject.add(projectId);

  const quota = await retrieveUserQuota(accessToken, projectId);
  if (!quota?.buckets) {
    logGeminiDebugMessage(`Code Assist quota model lookup returned no buckets for project: ${projectId}`);
    return;
  }

  const modelIds = [...new Set(quota.buckets.map((bucket) => bucket.modelId).filter(Boolean))];
  if (modelIds.length === 0) {
    logGeminiDebugMessage(`Code Assist quota buckets contained no model IDs for project: ${projectId}`);
    return;
  }

  logGeminiDebugMessage(
    `Code Assist models visible via quota buckets (${projectId}): ${modelIds.join(", ")}`,
  );
}

/**
 * Classifies a 429 response and determines whether the multi-account loop
 * should switch to the next account.
 *
 * Returns:
 * - "switch-quota": QUOTA_EXHAUSTED → mark exhausted + continue
 * - "switch-rate": RATE_LIMIT_EXCEEDED → continue (no mark)
 * - "switch-capacity": MODEL_CAPACITY_EXHAUSTED → continue (no mark)
 * - null: not a switchable 429, let caller handle normally
 */
type SwitchReason = "switch-quota" | "switch-rate" | "switch-capacity";

export async function classifyAccountSwitch(response: Response): Promise<{
  reason: SwitchReason;
  retryDelayMs?: number;
} | null> {
  if (response.status !== 429) return null;

  // Prefer cached result from fetchWithRetry to avoid re-reading the response body
  // (Bun v1.3.10 has issues with chained Response.clone() calls).
  const { quotaContextCache } = await import("./plugin/retry");
  let quotaContext = quotaContextCache.get(response) ?? null;

  if (!quotaContext) {
    const { classifyQuotaResponse } = await import("./plugin/retry/quota");
    quotaContext = await classifyQuotaResponse(response.clone());
  }

  const isQuotaExhausted = quotaContext?.terminal && quotaContext.reason === "QUOTA_EXHAUSTED";

  // Fallback: body-based quota detection
  let isBodyQuotaExhausted = false;
  if (!isQuotaExhausted) {
    try {
      const bodyText = await response.clone().text();
      const lower = bodyText.toLowerCase();
      isBodyQuotaExhausted = lower.includes("quota exceeded") && lower.includes("per day");
    } catch { }
  }

  if (isQuotaExhausted || isBodyQuotaExhausted) {
    return { reason: "switch-quota", retryDelayMs: quotaContext?.retryDelayMs };
  }
  if (quotaContext?.reason === "RATE_LIMIT_EXCEEDED") {
    return { reason: "switch-rate" };
  }
  if (quotaContext?.reason === "MODEL_CAPACITY_EXHAUSTED") {
    return { reason: "switch-capacity" };
  }
  return null;
}

export type { SwitchReason };

