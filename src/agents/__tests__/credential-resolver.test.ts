import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import {
  EnvCredentialResolver,
  CredentialError,
} from "../credential-resolver.ts";

// ── Test Helpers ────────────────────────────────────────────────────────────

function withEnv(
  vars: Record<string, string | undefined>,
  fn: () => void | Promise<void>,
): () => Promise<void> {
  return async () => {
    const saved: Record<string, string | undefined> = {};
    for (const key of Object.keys(vars)) {
      saved[key] = process.env[key];
      if (vars[key] === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = vars[key];
      }
    }
    try {
      await fn();
    } finally {
      for (const key of Object.keys(saved)) {
        if (saved[key] === undefined) {
          delete process.env[key];
        } else {
          process.env[key] = saved[key];
        }
      }
    }
  };
}

// ── Tests ───────────────────────────────────────────────────────────────────

describe("EnvCredentialResolver", () => {
  let resolver: EnvCredentialResolver;

  beforeEach(() => {
    resolver = new EnvCredentialResolver();
  });

  describe("isAvailable", () => {
    it(
      "returns true when Google OAuth env vars are set",
      withEnv(
        {
          GOOGLE_CLIENT_ID: "test-id",
          GOOGLE_CLIENT_SECRET: "test-secret",
          GOOGLE_REFRESH_TOKEN: "test-token",
        },
        () => {
          expect(resolver.isAvailable("GOOGLE_OAUTH_CREDENTIALS")).toBe(true);
        },
      ),
    );

    it(
      "returns false when Google OAuth env vars are missing",
      withEnv(
        {
          GOOGLE_CLIENT_ID: undefined,
          GOOGLE_CLIENT_SECRET: undefined,
          GOOGLE_REFRESH_TOKEN: undefined,
        },
        () => {
          expect(resolver.isAvailable("GOOGLE_OAUTH_CREDENTIALS")).toBe(false);
        },
      ),
    );

    it(
      "returns true when API key env var is set",
      withEnv({ PAGESPEED_API_KEY: "test-key" }, () => {
        expect(resolver.isAvailable("PAGESPEED_API_KEY")).toBe(true);
      }),
    );

    it(
      "returns false when API key env var is missing",
      withEnv({ PAGESPEED_API_KEY: undefined }, () => {
        expect(resolver.isAvailable("PAGESPEED_API_KEY")).toBe(false);
      }),
    );
  });

  describe("resolve — API key", () => {
    it(
      "resolves API key from env",
      withEnv({ PAGESPEED_API_KEY: "my-key-123" }, async () => {
        const cred = await resolver.resolve("PAGESPEED_API_KEY");
        expect(cred.type).toBe("api-key");
        expect(cred.apiKey).toBe("my-key-123");
      }),
    );

    it(
      "throws CredentialError for missing API key",
      withEnv({ PAGESPEED_API_KEY: undefined }, async () => {
        try {
          await resolver.resolve("PAGESPEED_API_KEY");
          throw new Error("Should have thrown");
        } catch (err) {
          expect(err).toBeInstanceOf(CredentialError);
          const credErr = err as CredentialError;
          expect(credErr.reason).toBe("missing");
          expect(credErr.credentialEnv).toBe("PAGESPEED_API_KEY");
        }
      }),
    );
  });

  describe("resolve — Google OAuth", () => {
    it(
      "throws CredentialError when OAuth vars are missing",
      withEnv(
        {
          GOOGLE_CLIENT_ID: undefined,
          GOOGLE_CLIENT_SECRET: undefined,
          GOOGLE_REFRESH_TOKEN: undefined,
        },
        async () => {
          try {
            await resolver.resolve("GOOGLE_OAUTH_CREDENTIALS");
            throw new Error("Should have thrown");
          } catch (err) {
            expect(err).toBeInstanceOf(CredentialError);
            const credErr = err as CredentialError;
            expect(credErr.reason).toBe("missing");
            expect(credErr.message).toContain("GOOGLE_CLIENT_ID");
          }
        },
      ),
    );

    it(
      "throws CredentialError with partial OAuth vars (lists missing ones)",
      withEnv(
        {
          GOOGLE_CLIENT_ID: "id",
          GOOGLE_CLIENT_SECRET: undefined,
          GOOGLE_REFRESH_TOKEN: "token",
        },
        async () => {
          try {
            await resolver.resolve("GOOGLE_OAUTH_CREDENTIALS");
            throw new Error("Should have thrown");
          } catch (err) {
            expect(err).toBeInstanceOf(CredentialError);
            const credErr = err as CredentialError;
            expect(credErr.message).toContain("GOOGLE_CLIENT_SECRET");
            expect(credErr.message).not.toContain("GOOGLE_CLIENT_ID");
          }
        },
      ),
    );
  });

  describe("resolve — service account", () => {
    it(
      "throws CredentialError for missing service account env var",
      withEnv({ GOOGLE_SERVICE_ACCOUNT: undefined }, async () => {
        try {
          await resolver.resolve("GOOGLE_SERVICE_ACCOUNT");
          throw new Error("Should have thrown");
        } catch (err) {
          expect(err).toBeInstanceOf(CredentialError);
          expect((err as CredentialError).reason).toBe("missing");
        }
      }),
    );
  });
});

// ── Exports ─────────────────────────────────────────────────────────────────

describe("CredentialResolver exports", () => {
  it("exports from agents/index.ts", async () => {
    const mod = await import("../index.ts");
    expect(mod.EnvCredentialResolver).toBeDefined();
    expect(mod.CredentialError).toBeDefined();
  });
});
