import { describe, expect, it } from "bun:test";
import { classifyAccountSwitch } from "../plugin";

/**
 * Tests for classifyAccountSwitch — the shared function used by plugin.ts's
 * multi-account loop (both normal and post-401-refresh paths) to decide
 * whether a 429 response should trigger an account switch.
 *
 * This function is the single decision point for all account-switching behavior,
 * so testing it directly validates the core logic of the main production path.
 */

function make429Response(
  reason: "QUOTA_EXHAUSTED" | "RATE_LIMIT_EXCEEDED" | "MODEL_CAPACITY_EXHAUSTED",
  opts?: { retryDelay?: string; message?: string; domain?: string },
): Response {
  const details: Record<string, unknown>[] = [
    {
      "@type": "type.googleapis.com/google.rpc.ErrorInfo",
      reason,
      domain: opts?.domain ?? "cloudcode-pa.googleapis.com",
    },
  ];
  if (opts?.retryDelay) {
    details.push({
      "@type": "type.googleapis.com/google.rpc.RetryInfo",
      retryDelay: opts.retryDelay,
    });
  }
  return new Response(
    JSON.stringify({
      error: {
        message: opts?.message ?? `${reason} error`,
        details,
      },
    }),
    { status: 429, headers: { "content-type": "application/json" } },
  );
}

describe("classifyAccountSwitch (plugin.ts main-loop decision function)", () => {
  // --- MODEL_CAPACITY_EXHAUSTED: the core fix ---

  it("returns switch-capacity for MODEL_CAPACITY_EXHAUSTED without RetryInfo", async () => {
    const response = make429Response("MODEL_CAPACITY_EXHAUSTED", {
      message: "No capacity available for model gemini-3-flash-preview on the server",
    });
    const result = await classifyAccountSwitch(response);
    expect(result).not.toBeNull();
    expect(result!.reason).toBe("switch-capacity");
  });

  it("returns switch-capacity for MODEL_CAPACITY_EXHAUSTED with RetryInfo", async () => {
    const response = make429Response("MODEL_CAPACITY_EXHAUSTED", {
      retryDelay: "500ms",
    });
    const result = await classifyAccountSwitch(response);
    expect(result).not.toBeNull();
    expect(result!.reason).toBe("switch-capacity");
  });

  it("does not include retryDelayMs for switch-capacity (cooldown handled by retry layer)", async () => {
    const response = make429Response("MODEL_CAPACITY_EXHAUSTED", {
      retryDelay: "2s",
    });
    const result = await classifyAccountSwitch(response);
    expect(result).not.toBeNull();
    expect(result!.reason).toBe("switch-capacity");
    // retryDelayMs not propagated for capacity — cooldown is set at retry layer
    expect(result!.retryDelayMs).toBeUndefined();
  });

  // --- QUOTA_EXHAUSTED: existing behavior preserved ---

  it("returns switch-quota for QUOTA_EXHAUSTED", async () => {
    const response = make429Response("QUOTA_EXHAUSTED");
    const result = await classifyAccountSwitch(response);
    expect(result).not.toBeNull();
    expect(result!.reason).toBe("switch-quota");
  });

  it("returns switch-quota with retryDelayMs when QUOTA_EXHAUSTED has RetryInfo", async () => {
    const response = make429Response("QUOTA_EXHAUSTED", { retryDelay: "3600s" });
    const result = await classifyAccountSwitch(response);
    expect(result).not.toBeNull();
    expect(result!.reason).toBe("switch-quota");
    expect(result!.retryDelayMs).toBe(3600_000);
  });

  // --- RATE_LIMIT_EXCEEDED: existing behavior preserved ---

  it("returns switch-rate for RATE_LIMIT_EXCEEDED", async () => {
    const response = make429Response("RATE_LIMIT_EXCEEDED");
    const result = await classifyAccountSwitch(response);
    expect(result).not.toBeNull();
    expect(result!.reason).toBe("switch-rate");
  });

  // --- Non-429 and unknown reasons ---

  it("returns null for non-429 responses", async () => {
    const response = new Response("ok", { status: 200 });
    const result = await classifyAccountSwitch(response);
    expect(result).toBeNull();
  });

  it("returns null for 500 responses", async () => {
    const response = new Response("server error", { status: 500 });
    const result = await classifyAccountSwitch(response);
    expect(result).toBeNull();
  });

  it("returns null for 429 from unknown domain", async () => {
    const response = make429Response("QUOTA_EXHAUSTED", {
      domain: "unknown-service.googleapis.com",
    });
    const result = await classifyAccountSwitch(response);
    // Unknown domain → classifyQuotaResponse returns null → body fallback check
    // Body doesn't contain "quota exceeded" + "per day" keywords → null
    expect(result).toBeNull();
  });

  // --- Body-based quota detection fallback ---

  it("returns switch-quota for body-based quota detection", async () => {
    const response = new Response(
      JSON.stringify({
        error: {
          message: "Quota exceeded for quota metric. Per day limit reached.",
          details: [],
        },
      }),
      { status: 429, headers: { "content-type": "application/json" } },
    );
    const result = await classifyAccountSwitch(response);
    expect(result).not.toBeNull();
    expect(result!.reason).toBe("switch-quota");
  });
});
