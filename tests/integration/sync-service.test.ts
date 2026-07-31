import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";
import { pullBundle } from "../../src/agents/pull-service.js";
import { syncBundles } from "../../src/agents/sync-service.js";
import { createApiClient } from "../../src/api/client.js";
import { CliError } from "../../src/errors.js";

const servers: ReturnType<typeof createServer>[] = [];
const directories: string[] = [];
const PIN_DRIFT_MESSAGE_PATTERN = /22222222-2222-4222-8222-222222222222/;
const PULL_GUIDANCE_PATTERN =
  /Do not edit versionId by hand\. Run `aleph agents pull .+` to download the live bundle files/;

afterEach(async () => {
  await Promise.all([
    ...servers.splice(0).map(
      (server) =>
        new Promise<void>((resolve, reject) => {
          server.close((error) => (error ? reject(error) : resolve()));
        })
    ),
    ...directories
      .splice(0)
      .map((directory) => rm(directory, { force: true, recursive: true })),
  ]);
});

const startServer = async (
  handler: (request: IncomingMessage, response: ServerResponse) => void
): Promise<string> => {
  const server = createServer(handler);
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("Test server did not expose a TCP address");
  }
  return `http://127.0.0.1:${address.port}`;
};

const silentOutput = {
  data: () => undefined,
  error: () => undefined,
  json: false,
  progress: () => undefined,
};

const writeDemoBundle = async (
  root: string,
  extras: Record<string, unknown> = {}
): Promise<string> => {
  const bundle = join(root, "agents", "demo");
  await mkdir(bundle, { recursive: true });
  await writeFile(
    join(bundle, "aleph.json"),
    JSON.stringify({
      agentId: "45d8ec4c-a713-4d65-a76a-ef099ac57fb1",
      description: "Demo agent",
      name: "Demo",
      ...extras,
    })
  );
  await writeFile(join(bundle, "AGENTS.md"), "# Demo\n");
  return bundle;
};

describe("syncBundles", () => {
  it("removes a saved ID after its deleted bundle is already absent", async () => {
    const root = await mkdtemp(join(tmpdir(), "aleph-cli-sync-"));
    directories.push(root);
    await mkdir(join(root, ".aleph"));

    const requests: string[] = [];
    const apiUrl = await startServer((request, response) => {
      requests.push(`${request.method} ${request.url}`);
      response.setHeader("content-type", "application/json");
      response.statusCode = 404;
      response.end(JSON.stringify({ message: "Not found" }));
    });
    await writeFile(
      join(root, ".aleph", "state.json"),
      JSON.stringify({
        schemaVersion: 1,
        targets: { [apiUrl]: { "agents/removed": "removed-agent" } },
      })
    );
    const errors: string[] = [];

    const result = await syncBundles({
      apiUrl,
      bundles: [],
      client: createApiClient(apiUrl, { kind: "api-key", value: "test-key" }),
      options: {
        concurrency: 1,
        continueOnError: false,
        dryRun: false,
        enable: false,
      },
      output: {
        ...silentOutput,
        error: (message) => errors.push(message),
      },
      stateRoot: root,
    });

    expect(result).toEqual([]);
    expect(requests).toEqual(["POST /agents/removed-agent/archive"]);
    expect(errors).toEqual([
      "Agent for removed bundle agents/removed was already absent from Aleph; continuing.",
    ]);
    expect(
      JSON.parse(await readFile(join(root, ".aleph", "state.json"), "utf8"))
    ).toEqual({ schemaVersion: 1, targets: {} });
  });

  it("recreates an agent when its saved ID is no longer available", async () => {
    const root = await mkdtemp(join(tmpdir(), "aleph-cli-sync-"));
    directories.push(root);
    const bundle = await writeDemoBundle(root);
    await mkdir(join(root, ".aleph"));

    const requests: string[] = [];
    const apiUrl = await startServer((request, response) => {
      requests.push(`${request.method} ${request.url}`);
      response.setHeader("content-type", "application/json");
      if (request.method === "GET") {
        response.statusCode = 404;
        response.end(JSON.stringify({ message: "Not found" }));
        return;
      }
      if (request.url?.endsWith("/versions")) {
        response.statusCode = 201;
        response.end(JSON.stringify({ id: "version-1" }));
        return;
      }
      response.end(
        JSON.stringify({
          id: "45d8ec4c-a713-4d65-a76a-ef099ac57fb1",
          name: "Demo",
        })
      );
    });
    await writeFile(
      join(root, ".aleph", "state.json"),
      JSON.stringify({
        schemaVersion: 1,
        targets: { [apiUrl]: { "agents/demo": "stale-agent" } },
      })
    );
    const progress: string[] = [];

    const result = await syncBundles({
      apiUrl,
      bundles: [bundle],
      client: createApiClient(apiUrl, { kind: "api-key", value: "test-key" }),
      options: {
        concurrency: 1,
        continueOnError: false,
        dryRun: false,
        enable: false,
      },
      output: {
        ...silentOutput,
        progress: (message) => progress.push(message),
      },
      stateRoot: root,
    });

    expect(result).toEqual([
      {
        agentId: "45d8ec4c-a713-4d65-a76a-ef099ac57fb1",
        directory: "agents/demo",
        status: "created",
        versionId: "version-1",
      },
    ]);
    expect(requests).toEqual([
      "GET /agents/45d8ec4c-a713-4d65-a76a-ef099ac57fb1",
      "POST /agents",
      "POST /agents/45d8ec4c-a713-4d65-a76a-ef099ac57fb1/versions",
      "POST /agents/45d8ec4c-a713-4d65-a76a-ef099ac57fb1/disable",
    ]);
    expect(progress).toContain(
      "Agent 45d8ec4c-a713-4d65-a76a-ef099ac57fb1 for demo does not exist; creating it with the manifest ID"
    );
    expect(
      JSON.parse(await readFile(join(bundle, "aleph.json"), "utf8")).versionId
    ).toBe("version-1");
    const state = JSON.parse(
      await readFile(join(root, ".aleph", "state.json"), "utf8")
    );
    expect(state).toEqual({
      schemaVersion: 1,
      targets: {
        [apiUrl]: {
          "agents/demo": "45d8ec4c-a713-4d65-a76a-ef099ac57fb1",
        },
      },
    });
  });

  it("blocks sync when an existing agent has no local versionId", async () => {
    const root = await mkdtemp(join(tmpdir(), "aleph-cli-sync-"));
    directories.push(root);
    const bundle = await writeDemoBundle(root);
    const apiUrl = await startServer((_request, response) => {
      response.setHeader("content-type", "application/json");
      response.end(
        JSON.stringify({
          id: "45d8ec4c-a713-4d65-a76a-ef099ac57fb1",
          mode: "disabled",
          name: "Demo",
          pinnedVersionId: null,
        })
      );
    });

    await expect(
      syncBundles({
        apiUrl,
        bundles: [bundle],
        client: createApiClient(apiUrl, {
          kind: "api-key",
          value: "test-key",
        }),
        options: {
          concurrency: 1,
          continueOnError: false,
          dryRun: true,
          enable: false,
        },
        output: silentOutput,
        stateRoot: root,
      })
    ).rejects.toThrow(PULL_GUIDANCE_PATTERN);
  });

  it("blocks sync when the enabled pin differs from versionId", async () => {
    const root = await mkdtemp(join(tmpdir(), "aleph-cli-sync-"));
    directories.push(root);
    const bundle = await writeDemoBundle(root, {
      versionId: "11111111-1111-4111-8111-111111111111",
    });
    const apiUrl = await startServer((_request, response) => {
      response.setHeader("content-type", "application/json");
      response.end(
        JSON.stringify({
          id: "45d8ec4c-a713-4d65-a76a-ef099ac57fb1",
          mode: "enabled",
          name: "Demo",
          pinnedVersionId: "22222222-2222-4222-8222-222222222222",
        })
      );
    });

    const error = await syncBundles({
      apiUrl,
      bundles: [bundle],
      client: createApiClient(apiUrl, { kind: "api-key", value: "test-key" }),
      options: {
        concurrency: 1,
        continueOnError: false,
        dryRun: true,
        enable: true,
      },
      output: silentOutput,
      stateRoot: root,
    }).catch((value: unknown) => value);

    expect(error).toBeInstanceOf(CliError);
    expect(String(error)).toMatch(PIN_DRIFT_MESSAGE_PATTERN);
    expect(String(error)).toMatch(PULL_GUIDANCE_PATTERN);
  });

  it("allows sync and stamps versionId when pin matches", async () => {
    const root = await mkdtemp(join(tmpdir(), "aleph-cli-sync-"));
    directories.push(root);
    const versionId = "11111111-1111-4111-8111-111111111111";
    const bundle = await writeDemoBundle(root, { versionId });
    const apiUrl = await startServer((request, response) => {
      response.setHeader("content-type", "application/json");
      if (request.url?.endsWith("/versions") && request.method === "POST") {
        response.statusCode = 200;
        response.end(JSON.stringify({ id: versionId }));
        return;
      }
      if (request.method === "PATCH") {
        response.end(
          JSON.stringify({
            id: "45d8ec4c-a713-4d65-a76a-ef099ac57fb1",
            mode: "enabled",
            name: "Demo",
            pinnedVersionId: versionId,
          })
        );
        return;
      }
      response.end(
        JSON.stringify({
          id: "45d8ec4c-a713-4d65-a76a-ef099ac57fb1",
          mode: "enabled",
          name: "Demo",
          pinnedVersionId: versionId,
        })
      );
    });

    const result = await syncBundles({
      apiUrl,
      bundles: [bundle],
      client: createApiClient(apiUrl, { kind: "api-key", value: "test-key" }),
      options: {
        concurrency: 1,
        continueOnError: false,
        dryRun: false,
        enable: true,
      },
      output: silentOutput,
      stateRoot: root,
    });

    expect(result).toEqual([
      {
        agentId: "45d8ec4c-a713-4d65-a76a-ef099ac57fb1",
        directory: "agents/demo",
        status: "unchanged",
        versionId,
      },
    ]);
    expect(
      JSON.parse(await readFile(join(bundle, "aleph.json"), "utf8")).versionId
    ).toBe(versionId);
  });

  it("does not disable an existing agent when syncing with --no-enable", async () => {
    const root = await mkdtemp(join(tmpdir(), "aleph-cli-sync-"));
    directories.push(root);
    const versionId = "11111111-1111-4111-8111-111111111111";
    const nextVersionId = "44444444-4444-4444-8444-444444444444";
    const bundle = await writeDemoBundle(root, { versionId });
    const requests: string[] = [];
    const apiUrl = await startServer((request, response) => {
      requests.push(`${request.method} ${request.url}`);
      response.setHeader("content-type", "application/json");
      if (request.url?.endsWith("/versions") && request.method === "POST") {
        response.statusCode = 201;
        response.end(JSON.stringify({ id: nextVersionId }));
        return;
      }
      if (request.method === "PATCH") {
        response.end(
          JSON.stringify({
            id: "45d8ec4c-a713-4d65-a76a-ef099ac57fb1",
            mode: "disabled",
            name: "Demo",
            pinnedVersionId: null,
          })
        );
        return;
      }
      response.end(
        JSON.stringify({
          id: "45d8ec4c-a713-4d65-a76a-ef099ac57fb1",
          mode: "disabled",
          name: "Demo",
          pinnedVersionId: null,
        })
      );
    });

    const result = await syncBundles({
      apiUrl,
      bundles: [bundle],
      client: createApiClient(apiUrl, { kind: "api-key", value: "test-key" }),
      options: {
        concurrency: 1,
        continueOnError: false,
        dryRun: false,
        enable: false,
      },
      output: silentOutput,
      stateRoot: root,
    });

    expect(result).toEqual([
      {
        agentId: "45d8ec4c-a713-4d65-a76a-ef099ac57fb1",
        directory: "agents/demo",
        status: "updated",
        versionId: nextVersionId,
      },
    ]);
    expect(requests).toEqual([
      "GET /agents/45d8ec4c-a713-4d65-a76a-ef099ac57fb1",
      "PATCH /agents/45d8ec4c-a713-4d65-a76a-ef099ac57fb1",
      "POST /agents/45d8ec4c-a713-4d65-a76a-ef099ac57fb1/versions",
    ]);
    expect(requests.some((entry) => entry.includes("/disable"))).toBe(false);
    expect(requests.some((entry) => entry.includes("/enable"))).toBe(false);
  });

  it("repins an already-enabled agent when syncing with --no-enable", async () => {
    const root = await mkdtemp(join(tmpdir(), "aleph-cli-sync-"));
    directories.push(root);
    const versionId = "11111111-1111-4111-8111-111111111111";
    const nextVersionId = "55555555-5555-4555-8555-555555555555";
    const bundle = await writeDemoBundle(root, { versionId });
    const requests: string[] = [];
    const apiUrl = await startServer((request, response) => {
      requests.push(`${request.method} ${request.url}`);
      response.setHeader("content-type", "application/json");
      if (request.url?.endsWith("/versions") && request.method === "POST") {
        response.statusCode = 201;
        response.end(JSON.stringify({ id: nextVersionId }));
        return;
      }
      if (request.url?.endsWith("/enable")) {
        response.end(
          JSON.stringify({
            id: "45d8ec4c-a713-4d65-a76a-ef099ac57fb1",
            mode: "enabled",
            name: "Demo",
            pinnedVersionId: nextVersionId,
          })
        );
        return;
      }
      if (request.method === "PATCH") {
        response.end(
          JSON.stringify({
            id: "45d8ec4c-a713-4d65-a76a-ef099ac57fb1",
            mode: "enabled",
            name: "Demo",
            pinnedVersionId: versionId,
          })
        );
        return;
      }
      response.end(
        JSON.stringify({
          id: "45d8ec4c-a713-4d65-a76a-ef099ac57fb1",
          mode: "enabled",
          name: "Demo",
          pinnedVersionId: versionId,
        })
      );
    });

    const result = await syncBundles({
      apiUrl,
      bundles: [bundle],
      client: createApiClient(apiUrl, { kind: "api-key", value: "test-key" }),
      options: {
        concurrency: 1,
        continueOnError: false,
        dryRun: false,
        enable: false,
      },
      output: silentOutput,
      stateRoot: root,
    });

    expect(result).toEqual([
      {
        agentId: "45d8ec4c-a713-4d65-a76a-ef099ac57fb1",
        directory: "agents/demo",
        status: "updated",
        versionId: nextVersionId,
      },
    ]);
    expect(requests).toContain(
      "POST /agents/45d8ec4c-a713-4d65-a76a-ef099ac57fb1/enable"
    );
    expect(requests.some((entry) => entry.includes("/disable"))).toBe(false);
  });
});

describe("pullBundle", () => {
  it("writes version files and stamps versionId", async () => {
    const root = await mkdtemp(join(tmpdir(), "aleph-cli-pull-"));
    directories.push(root);
    const bundle = await writeDemoBundle(root);
    await writeFile(join(bundle, "local-extra.md"), "keep me\n");
    const versionId = "33333333-3333-4333-8333-333333333333";
    const boundary = "test-boundary";
    const body = [
      `--${boundary}`,
      'Content-Disposition: form-data; name="files"; filename="AGENTS.md"',
      "Content-Type: text/markdown",
      "",
      "# Pulled",
      `--${boundary}`,
      'Content-Disposition: form-data; name="files"; filename="README.md"',
      "Content-Type: text/markdown",
      "",
      "# Readme",
      `--${boundary}--`,
      "",
    ].join("\r\n");

    const apiUrl = await startServer((request, response) => {
      if (request.url?.endsWith("/files")) {
        response.statusCode = 200;
        response.setHeader(
          "content-type",
          `multipart/form-data; boundary=${boundary}`
        );
        response.end(body);
        return;
      }
      response.setHeader("content-type", "application/json");
      response.end(
        JSON.stringify({
          id: "45d8ec4c-a713-4d65-a76a-ef099ac57fb1",
          mode: "enabled",
          name: "Demo",
          pinnedVersionId: versionId,
        })
      );
    });

    const result = await pullBundle({
      client: createApiClient(apiUrl, { kind: "api-key", value: "test-key" }),
      directory: bundle,
      output: silentOutput,
    });

    expect(result).toEqual({
      agentId: "45d8ec4c-a713-4d65-a76a-ef099ac57fb1",
      directory: bundle,
      fileCount: 2,
      versionId,
    });
    expect(await readFile(join(bundle, "AGENTS.md"), "utf8")).toBe("# Pulled");
    expect(await readFile(join(bundle, "README.md"), "utf8")).toBe("# Readme");
    expect(await readFile(join(bundle, "local-extra.md"), "utf8")).toBe(
      "keep me\n"
    );
    expect(
      JSON.parse(await readFile(join(bundle, "aleph.json"), "utf8")).versionId
    ).toBe(versionId);
  });
});
