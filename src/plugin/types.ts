import type { GeminiTokenExchangeResult } from "../gemini/oauth";
import type { Config } from "@opencode-ai/sdk";
import type { ToolDefinition } from "@opencode-ai/plugin";

export interface OAuthAuthDetails {
  type: "oauth";
  refresh: string;
  access?: string;
  expires?: number;
}

export interface NonOAuthAuthDetails {
  type: string;
  [key: string]: unknown;
}

export type AuthDetails = OAuthAuthDetails | NonOAuthAuthDetails;

export type GetAuth = () => Promise<AuthDetails>;

export interface ProviderModel {
  cost?: {
    input: number;
    output: number;
  };
  [key: string]: unknown;
}

export interface Provider {
  models?: Record<string, ProviderModel>;
  options?: Record<string, unknown>;
}

export interface LoaderResult {
  apiKey: string;
  fetch(input: RequestInfo, init?: RequestInit): Promise<Response>;
}

export type AuthPrompt =
  | {
    type: "text";
    key: string;
    message: string;
    placeholder?: string;
    validate?: (value: string) => string | undefined;
    condition?: (inputs: Record<string, string>) => boolean;
  }
  | {
    type: "select";
    key: string;
    message: string;
    options: Array<{ label: string; value: string; hint?: string }>;
    condition?: (inputs: Record<string, string>) => boolean;
  };

export interface AuthMethod {
  provider?: string;
  label: string;
  type: "oauth" | "api";
  prompts?: AuthPrompt[];
  authorize?: (inputs?: Record<string, string>) => Promise<{
    url: string;
    instructions: string;
    method: string;
    callback: (() => Promise<GeminiTokenExchangeResult>) | ((callbackUrl: string) => Promise<GeminiTokenExchangeResult>);
  }>;
}

export interface PluginClient {
  auth: {
    set(input: { path: { id: string }; body: OAuthAuthDetails }): Promise<void>;
  };
  tui?: {
    showToast(input: {
      body: {
        title?: string;
        message: string;
        variant: "info" | "success" | "warning" | "error";
        duration?: number;
      };
    }): Promise<unknown>;
  };
}

export interface PluginContext {
  client: PluginClient;
}

export interface PluginResult {
  config?: (config: Config) => Promise<void>;
  tool?: Record<string, ToolDefinition>;
  auth: {
    provider: string;
    loader: (getAuth: GetAuth, provider: Provider) => Promise<LoaderResult | null>;
    methods: AuthMethod[];
  };
}

export interface RefreshParts {
  refreshToken: string;
  projectId?: string;
  managedProjectId?: string;
}

export interface ProjectContextResult {
  auth: OAuthAuthDetails;
  effectiveProjectId: string;
}
