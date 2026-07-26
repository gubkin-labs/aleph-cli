import { describe, expect, it } from "vitest";
import {
  emptyState,
  getStateAgentId,
  setStateAgentId,
} from "../../src/agents/state.js";
import { pathSerializer } from "../../src/api/client.js";
import { resolveCredential } from "../../src/auth/resolve-credential.js";

describe("state, credentials, and generated client behavior", () => {
  it("scopes agent IDs by API origin", () => {
    const state = setStateAgentId(
      emptyState(),
      "https://api.example.com",
      "agents/demo",
      "agent-1"
    );
    expect(
      getStateAgentId(state, "https://api.example.com", "agents/demo")
    ).toBe("agent-1");
    expect(
      getStateAgentId(state, "https://other.example.com", "agents/demo")
    ).toBeUndefined();
  });

  it("prefers explicit API keys over environment and stored sessions", async () => {
    process.env.ALEPH_API_KEY = "environment-key";
    const store = {
      get: async () => "session-token",
      remove: async () => undefined,
      set: async () => undefined,
    };
    await expect(
      resolveCredential(
        "https://api.example.com",
        { apiKey: "flag-key", json: false },
        store
      )
    ).resolves.toEqual({ kind: "api-key", value: "flag-key" });
    delete process.env.ALEPH_API_KEY;
  });

  it("serializes Hono-style path parameters", () => {
    expect(pathSerializer("/agents/:agentId", { agentId: "agent / one" })).toBe(
      "/agents/agent%20%2F%20one"
    );
  });
});
