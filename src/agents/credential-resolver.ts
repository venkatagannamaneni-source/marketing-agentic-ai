/**
 * Credential resolver for tool integrations.
 *
 * Reads credentials from environment variables referenced by tools.yaml `credentials_env`.
 * Supports OAuth2 (Google APIs), API keys, and service account JSON files.
 *
 * Phase 4a: Google OAuth2 for GA4, Search Console, GTM; API key for PageSpeed Insights.
 */

import type { Logger } from "../observability/logger.ts";
import { NULL_LOGGER } from "../observability/logger.ts";

// ── Credential Types ────────────────────────────────────────────────────────

export type CredentialType = "oauth2" | "api-key" | "service-account";

export interface ResolvedCredential {
  readonly type: CredentialType;
  readonly accessToken?: string;
  readonly apiKey?: string;
  readonly expiresAt?: number;
}

export class CredentialError extends Error {
  constructor(
    message: string,
    public readonly credentialEnv: string,
    public readonly reason: "missing" | "expired" | "refresh_failed" | "invalid",
  ) {
    super(message);
    this.name = "CredentialError";
  }
}

// ── Credential Resolver Interface ───────────────────────────────────────────

export interface CredentialResolver {
  /**
   * Resolve credentials for a given credentials_env reference.
   * Returns the resolved credential with a valid access token or API key.
   * Throws CredentialError if credentials are unavailable.
   */
  resolve(credentialEnvName: string): Promise<ResolvedCredential>;

  /**
   * Check if credentials are available without resolving them.
   */
  isAvailable(credentialEnvName: string): boolean;
}

// ── OAuth2 Token Cache ──────────────────────────────────────────────────────

interface CachedToken {
  accessToken: string;
  expiresAt: number;
}

// ── Environment Credential Resolver ─────────────────────────────────────────

/**
 * Resolves credentials from environment variables.
 *
 * Credential env name conventions:
 * - "GOOGLE_OAUTH_CREDENTIALS" → reads GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, GOOGLE_REFRESH_TOKEN
 * - Env names ending with "_API_KEY" → reads as plain API key
 * - Env names ending with "_SERVICE_ACCOUNT" → reads as path to JSON key file
 */
export class EnvCredentialResolver implements CredentialResolver {
  private readonly logger: Logger;
  private readonly tokenCache = new Map<string, CachedToken>();

  /** Buffer before expiry to refresh proactively (5 minutes). */
  private static readonly REFRESH_BUFFER_MS = 5 * 60 * 1000;

  /** Google OAuth2 token endpoint. */
  private static readonly GOOGLE_TOKEN_URL = "https://oauth2.googleapis.com/token";

  constructor(logger?: Logger) {
    this.logger = (logger ?? NULL_LOGGER).child({ module: "credential-resolver" });
  }

  isAvailable(credentialEnvName: string): boolean {
    if (credentialEnvName === "GOOGLE_OAUTH_CREDENTIALS") {
      return !!(
        process.env.GOOGLE_CLIENT_ID &&
        process.env.GOOGLE_CLIENT_SECRET &&
        process.env.GOOGLE_REFRESH_TOKEN
      );
    }
    if (credentialEnvName.endsWith("_API_KEY")) {
      return !!process.env[credentialEnvName];
    }
    if (credentialEnvName.endsWith("_SERVICE_ACCOUNT")) {
      return !!process.env[credentialEnvName];
    }
    // Generic env var check
    return !!process.env[credentialEnvName];
  }

  async resolve(credentialEnvName: string): Promise<ResolvedCredential> {
    // 1. OAuth2 credentials (Google)
    if (credentialEnvName === "GOOGLE_OAUTH_CREDENTIALS") {
      return this.resolveGoogleOAuth();
    }

    // 2. API key credentials
    if (credentialEnvName.endsWith("_API_KEY")) {
      return this.resolveApiKey(credentialEnvName);
    }

    // 3. Service account credentials
    if (credentialEnvName.endsWith("_SERVICE_ACCOUNT")) {
      return this.resolveServiceAccount(credentialEnvName);
    }

    // 4. Fall back to treating as API key
    return this.resolveApiKey(credentialEnvName);
  }

  // ── OAuth2 ──────────────────────────────────────────────────────────────

  private async resolveGoogleOAuth(): Promise<ResolvedCredential> {
    const clientId = process.env.GOOGLE_CLIENT_ID;
    const clientSecret = process.env.GOOGLE_CLIENT_SECRET;
    const refreshToken = process.env.GOOGLE_REFRESH_TOKEN;

    if (!clientId || !clientSecret || !refreshToken) {
      const missing: string[] = [];
      if (!clientId) missing.push("GOOGLE_CLIENT_ID");
      if (!clientSecret) missing.push("GOOGLE_CLIENT_SECRET");
      if (!refreshToken) missing.push("GOOGLE_REFRESH_TOKEN");
      throw new CredentialError(
        `Missing Google OAuth credentials: ${missing.join(", ")}`,
        "GOOGLE_OAUTH_CREDENTIALS",
        "missing",
      );
    }

    // Check cache
    const cached = this.tokenCache.get("google_oauth");
    if (cached && cached.expiresAt > Date.now() + EnvCredentialResolver.REFRESH_BUFFER_MS) {
      return {
        type: "oauth2",
        accessToken: cached.accessToken,
        expiresAt: cached.expiresAt,
      };
    }

    // Refresh token
    this.logger.debug("credential_oauth_refresh", { provider: "google" });

    try {
      const response = await fetch(EnvCredentialResolver.GOOGLE_TOKEN_URL, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          client_id: clientId,
          client_secret: clientSecret,
          refresh_token: refreshToken,
          grant_type: "refresh_token",
        }),
      });

      if (!response.ok) {
        const body = await response.text();
        throw new CredentialError(
          `Google OAuth token refresh failed (${response.status}): ${body}`,
          "GOOGLE_OAUTH_CREDENTIALS",
          "refresh_failed",
        );
      }

      const data = (await response.json()) as {
        access_token: string;
        expires_in: number;
      };

      const expiresAt = Date.now() + data.expires_in * 1000;
      this.tokenCache.set("google_oauth", {
        accessToken: data.access_token,
        expiresAt,
      });

      this.logger.info("credential_oauth_refreshed", {
        provider: "google",
        expiresInSeconds: data.expires_in,
      });

      return {
        type: "oauth2",
        accessToken: data.access_token,
        expiresAt,
      };
    } catch (err: unknown) {
      if (err instanceof CredentialError) throw err;
      throw new CredentialError(
        `Google OAuth token refresh failed: ${err instanceof Error ? err.message : String(err)}`,
        "GOOGLE_OAUTH_CREDENTIALS",
        "refresh_failed",
      );
    }
  }

  // ── API Key ─────────────────────────────────────────────────────────────

  private resolveApiKey(envName: string): ResolvedCredential {
    const apiKey = process.env[envName];
    if (!apiKey) {
      throw new CredentialError(
        `Missing API key: ${envName} environment variable not set`,
        envName,
        "missing",
      );
    }
    return { type: "api-key", apiKey };
  }

  // ── Service Account ────────────────────────────────────────────────────

  private async resolveServiceAccount(envName: string): Promise<ResolvedCredential> {
    const keyPath = process.env[envName];
    if (!keyPath) {
      throw new CredentialError(
        `Missing service account: ${envName} environment variable not set`,
        envName,
        "missing",
      );
    }

    // Check cache
    const cached = this.tokenCache.get(`sa_${envName}`);
    if (cached && cached.expiresAt > Date.now() + EnvCredentialResolver.REFRESH_BUFFER_MS) {
      return {
        type: "service-account",
        accessToken: cached.accessToken,
        expiresAt: cached.expiresAt,
      };
    }

    // Read and parse service account JSON
    try {
      const { readFile } = await import("node:fs/promises");
      const keyContent = await readFile(keyPath, "utf-8");
      const keyData = JSON.parse(keyContent) as {
        client_email: string;
        private_key: string;
        token_uri?: string;
      };

      if (!keyData.client_email || !keyData.private_key) {
        throw new CredentialError(
          `Invalid service account JSON at ${keyPath}: missing client_email or private_key`,
          envName,
          "invalid",
        );
      }

      // Generate JWT and exchange for access token
      const tokenUri = keyData.token_uri ?? EnvCredentialResolver.GOOGLE_TOKEN_URL;
      const now = Math.floor(Date.now() / 1000);
      const header = btoa(JSON.stringify({ alg: "RS256", typ: "JWT" }));
      const claim = btoa(
        JSON.stringify({
          iss: keyData.client_email,
          scope: "https://www.googleapis.com/auth/analytics.readonly https://www.googleapis.com/auth/webmasters.readonly https://www.googleapis.com/auth/tagmanager.readonly",
          aud: tokenUri,
          exp: now + 3600,
          iat: now,
        }),
      );

      // Sign the JWT using crypto
      const { createSign } = await import("node:crypto");
      const signer = createSign("RSA-SHA256");
      signer.update(`${header}.${claim}`);
      const signature = signer
        .sign(keyData.private_key, "base64")
        .replace(/\+/g, "-")
        .replace(/\//g, "_")
        .replace(/=+$/, "");

      const jwt = `${header}.${claim}.${signature}`;

      const response = await fetch(tokenUri, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
          assertion: jwt,
        }),
      });

      if (!response.ok) {
        const body = await response.text();
        throw new CredentialError(
          `Service account token exchange failed (${response.status}): ${body}`,
          envName,
          "refresh_failed",
        );
      }

      const data = (await response.json()) as {
        access_token: string;
        expires_in: number;
      };

      const expiresAt = Date.now() + data.expires_in * 1000;
      this.tokenCache.set(`sa_${envName}`, {
        accessToken: data.access_token,
        expiresAt,
      });

      return {
        type: "service-account",
        accessToken: data.access_token,
        expiresAt,
      };
    } catch (err: unknown) {
      if (err instanceof CredentialError) throw err;
      throw new CredentialError(
        `Service account resolution failed: ${err instanceof Error ? err.message : String(err)}`,
        envName,
        "refresh_failed",
      );
    }
  }
}
