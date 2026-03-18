/**
 * Integration tests for plugin.ts multi-account while-loop.
 *
 * These tests exercise the REAL production code path in plugin.ts (lines 104-293),
 * including the 401→refresh→429 branch (lines 206-221).
 *
 * We mock only network-dependent modules (project, token, request, notify, debug,
 * oauth-authorize, account-manage, quota tool) and globalThis.fetch.
 * The core loop logic, AccountManager, fetchWithRetry, classifyQuotaResponse,
 * and classifyAccountSwitch all run as REAL code.
 */
import { describe, expect, it, mock, beforeEach, afterEach } from "bun:test";
import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

// ---------------------------------------------------------------------------
// Module mocks — called before static imports so plugin.ts gets mocked deps.
// Bun applies mock.module before resolving static imports.
// ---------------------------------------------------------------------------

let mockRefreshResult: any = null;

// project module is NOT mocked — we embed managedProjectId in refresh tokens
// so ensureProjectContext resolves via fast-path without network calls.

mock.module("./token", () => ({
  refreshAccessToken: async (..._args: any[]) => mockRefreshResult,
}));

mock.module("./request", () => ({
  isGenerativeLanguageRequest: () => true,
  prepareGeminiRequest: (input: any, init: any, access: string, _pid: string, _tc: any) => ({
    request: typeof input === "string" ? input : (input as Request).url ?? input,
    init: {
      ...(init ?? {}),
      method: init?.method ?? "POST",
      headers: { Authorization: `Bearer ${access}` },
      body: init?.body,
    },
    streaming: false,
    requestedModel: "gemini-3-flash-preview",
  }),
  transformGeminiResponse: (response: Response) => response,
}));

mock.module("./debug", () => ({
  isGeminiDebugEnabled: () => false,
  logGeminiDebugMessage: () => {},
  formatDebugBodyPreview: () => undefined,
  startGeminiDebugRequest: () => null,
  logGeminiDebugResponse: () => {},
}));

mock.module("./notify", () => ({
  maybeShowGeminiCapacityToast: async () => {},
  maybeShowGeminiTestToast: async () => {},
}));

// Note: account-manage, quota, cache use real modules — they don't make
// network calls and mocking them would leak to their own test files.


// ---------------------------------------------------------------------------
// Now safe to import — plugin.ts will use mocked deps above
// ---------------------------------------------------------------------------
import type { PluginResult } from "./types";

const FIXED_NOW = Date.parse("2026-03-18T00:00:00.000Z");
const REAL_DATE_NOW = Date.now;
const originalFetch = globalThis.fetch;
const originalSetTimeout = globalThis.setTimeout;

const GEMINI_URL =
  "https://generativelanguage.googleapis.com/v1beta/models/gemini-3-flash-preview:streamGenerateContent";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function createTmpDir(): string {
  const dir = join(tmpdir(), `plugin-int-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

function makeCapacity429(): Response {
  return new Response(
    JSON.stringify({
      error: {
        message: "No capacity available for model gemini-3-flash-preview on the server",
        details: [
          {
            "@type": "type.googleapis.com/google.rpc.ErrorInfo",
            reason: "MODEL_CAPACITY_EXHAUSTED",
            domain: "cloudcode-pa.googleapis.com",
          },
        ],
      },
    }),
    { status: 429, headers: { "content-type": "application/json" } },
  );
}

/**
 * Sets up a real AccountManager with N accounts, creates the plugin via
 * the real GeminiCLIOAuthPlugin factory, and returns the loader's fetch function.
 */
async function setupPluginFetch(
  storePath: string,
  emails: string[],
): Promise<{
  pluginFetch: (input: RequestInfo, init?: RequestInit) => Promise<Response>;
  getManager: () => import("./account-manager").AccountManager;
}> {
  const { AccountManager } = await import("./account-manager");
  const manager = new AccountManager(storePath);
  for (const email of emails) {
    manager.addAccount({
      email,
      refresh: `refresh-${email}||test-project`,
      access: `access-${email}`,
      expires: FIXED_NOW + 3_600_000,
    });
  }

  const { GeminiCLIOAuthPlugin } = await import("../plugin");
  const client = {
    auth: { set: mock(async () => {}) },
    tui: { showToast: mock(async () => {}) },
  };
  const pluginResult: PluginResult = await GeminiCLIOAuthPlugin({ client } as any);

  // Get fetch via the auth loader
  const getAuth = async () => ({
    type: "oauth" as const,
    refresh: `refresh-${emails[0]}||test-project`,
    access: `access-${emails[0]}`,
    expires: FIXED_NOW + 3_600_000,
  });
  const loaderResult = await pluginResult.auth!.loader!(getAuth as any, { models: {} } as any);

  return {
    pluginFetch: loaderResult!.fetch!,
    getManager: () => new AccountManager(storePath),
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("plugin.ts multi-account while-loop (integration)", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = createTmpDir();
    process.env.OPENCODE_GEMINI_ACCOUNTS_PATH = join(tmpDir, "accounts.json");
    Date.now = () => FIXED_NOW;
    (globalThis as any).setTimeout = ((fn: (...a: any[]) => void) => {
      fn();
      return 0 as unknown as ReturnType<typeof setTimeout>;
    }) as typeof setTimeout;
    mockRefreshResult = null;
  });

  afterEach(() => {
    Date.now = REAL_DATE_NOW;
    (globalThis as any).setTimeout = originalSetTimeout;
    (globalThis as any).fetch = originalFetch;
    delete process.env.OPENCODE_GEMINI_ACCOUNTS_PATH;
    try { rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  });

  it("switches to next account when first returns MODEL_CAPACITY_EXHAUSTED", async () => {
    const storePath = process.env.OPENCODE_GEMINI_ACCOUNTS_PATH!;
    const { pluginFetch, getManager } = await setupPluginFetch(storePath, [
      "a@gmail.com",
      "b@gmail.com",
    ]);

    let fetchCallCount = 0;
    (globalThis as any).fetch = mock(async () => {
      fetchCallCount++;
      if (fetchCallCount === 1) return makeCapacity429();
      return new Response("ok from B", { status: 200 });
    });

    const response = await pluginFetch(GEMINI_URL, {
      method: "POST",
      body: JSON.stringify({ contents: [] }),
    });

    expect(response.status).toBe(200);
    expect(fetchCallCount).toBe(2);

    // Neither account marked exhausted
    const mgr = getManager();
    for (const acct of mgr.getAllAccounts()) {
      expect(mgr.isExhausted(acct.id)).toBe(false);
    }
  });

  it("switches account after 401 → refresh → MODEL_CAPACITY_EXHAUSTED (P1)", async () => {
    const storePath = process.env.OPENCODE_GEMINI_ACCOUNTS_PATH!;
    const { pluginFetch, getManager } = await setupPluginFetch(storePath, [
      "a@gmail.com",
      "b@gmail.com",
    ]);

    // refreshAccessToken returns fresh tokens so the 401-retry path executes
    mockRefreshResult = {
      type: "oauth",
      refresh: "refresh-a@gmail.com",
      access: "refreshed-access-a",
      expires: FIXED_NOW + 3_600_000,
    };

    let fetchCallCount = 0;
    (globalThis as any).fetch = mock(async () => {
      fetchCallCount++;
      if (fetchCallCount === 1) return new Response("Unauthorized", { status: 401 });
      if (fetchCallCount === 2) return makeCapacity429(); // post-refresh → capacity 429
      return new Response("ok from B", { status: 200 }); // account B succeeds
    });

    const response = await pluginFetch(GEMINI_URL, {
      method: "POST",
      body: JSON.stringify({ contents: [] }),
    });

    expect(response.status).toBe(200);
    // fetch calls: 1=401(A), 2=capacity429(A after refresh), 3=200(B)
    expect(fetchCallCount).toBe(3);

    // No accounts marked exhausted
    const mgr = getManager();
    for (const acct of mgr.getAllAccounts()) {
      expect(mgr.isExhausted(acct.id)).toBe(false);
    }
  });

  it("returns 429 when all accounts return MODEL_CAPACITY_EXHAUSTED", async () => {
    const storePath = process.env.OPENCODE_GEMINI_ACCOUNTS_PATH!;
    const { pluginFetch, getManager } = await setupPluginFetch(storePath, [
      "a@gmail.com",
      "b@gmail.com",
    ]);

    let fetchCallCount = 0;
    (globalThis as any).fetch = mock(async () => {
      fetchCallCount++;
      return makeCapacity429();
    });

    const response = await pluginFetch(GEMINI_URL, {
      method: "POST",
      body: JSON.stringify({ contents: [] }),
    });

    expect(response.status).toBe(429);
    expect(fetchCallCount).toBe(2); // tried both accounts

    // No accounts marked exhausted
    const mgr = getManager();
    for (const acct of mgr.getAllAccounts()) {
      expect(mgr.isExhausted(acct.id)).toBe(false);
    }
  });

  it("QUOTA_EXHAUSTED triggers account switch (regression)", async () => {
    const storePath = process.env.OPENCODE_GEMINI_ACCOUNTS_PATH!;
    const { pluginFetch } = await setupPluginFetch(storePath, [
      "a@gmail.com",
      "b@gmail.com",
    ]);

    let fetchCallCount = 0;
    (globalThis as any).fetch = mock(async () => {
      fetchCallCount++;
      if (fetchCallCount === 1) {
        return new Response(
          JSON.stringify({
            error: {
              message: "quota exhausted",
              details: [{
                "@type": "type.googleapis.com/google.rpc.ErrorInfo",
                reason: "QUOTA_EXHAUSTED",
                domain: "cloudcode-pa.googleapis.com",
              }],
            },
          }),
          { status: 429, headers: { "content-type": "application/json" } },
        );
      }
      return new Response("ok from B", { status: 200 });
    });

    const response = await pluginFetch(GEMINI_URL, {
      method: "POST",
      body: JSON.stringify({ contents: [] }),
    });

    // Switching works — we got 200 from the second account
    expect(response.status).toBe(200);
    expect(fetchCallCount).toBe(2);
    // Note: markExhausted assertion is covered by account-fetch.test.ts
    // in non-mock.module environment where quotaContextCache works correctly.
  });
});
