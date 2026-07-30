import { mkdir, mkdtemp, readFile, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { collectBundleFiles } from "../../src/agents/files.js";
import {
  agentManifestSchema,
  hashAgentManifest,
  readAgentManifest,
  resolveSafeChild,
  writeAgentManifest,
} from "../../src/agents/manifest.js";

const GENERATED_AGENT_ID_MESSAGE_PATTERN =
  /Add "agentId": "[0-9a-f-]{36}" to aleph\.json/;

describe("agent manifests and bundle files", () => {
  it("validates metadata and rejects traversal", () => {
    expect(
      agentManifestSchema.parse({
        agentId: "c53c58d0-a5a4-4f75-b11c-8c9847644af5",
        description: "A useful agent",
        labels: ["Trading"],
        name: "Builder",
        versionId: "0c87f289-6d53-41d7-8d30-27e0cda73d4b",
      }).visibility
    ).toBe("public");

    expect(() =>
      agentManifestSchema.parse({
        agentId: "0c87f289-6d53-41d7-8d30-27e0cda73d4b",
        description: "Unsafe",
        icon: "../secret.png",
        name: "Unsafe",
      })
    ).toThrow();
    expect(() => resolveSafeChild("/tmp/repo", "../outside")).toThrow();
  });

  it("hashes sync metadata but ignores agentId and versionId", () => {
    const first = agentManifestSchema.parse({
      agentId: "c53c58d0-a5a4-4f75-b11c-8c9847644af5",
      description: "A useful agent",
      labels: ["Trading"],
      name: "Builder",
      versionId: "11111111-1111-4111-8111-111111111111",
    });
    const renamedIdentity = {
      ...first,
      agentId: "0c87f289-6d53-41d7-8d30-27e0cda73d4b",
      versionId: "22222222-2222-4222-8222-222222222222",
    };
    const changedMetadata = { ...first, description: "Changed description" };

    expect(hashAgentManifest(renamedIdentity)).toBe(hashAgentManifest(first));
    expect(hashAgentManifest(changedMetadata)).not.toBe(
      hashAgentManifest(first)
    );
  });

  it("writes and re-reads manifests with versionId", async () => {
    const root = await mkdtemp(join(tmpdir(), "aleph-manifest-write-"));
    const manifest = agentManifestSchema.parse({
      agentId: "c53c58d0-a5a4-4f75-b11c-8c9847644af5",
      description: "A useful agent",
      icon: "cover.jpg",
      labels: ["Trading"],
      name: "Builder",
      versionId: "0c87f289-6d53-41d7-8d30-27e0cda73d4b",
      visibility: "private",
    });

    await writeAgentManifest(root, manifest);
    const written = await readFile(join(root, "aleph.json"), "utf8");
    expect(written).toContain(
      '"versionId": "0c87f289-6d53-41d7-8d30-27e0cda73d4b"'
    );
    expect(await readAgentManifest(root)).toEqual(manifest);
  });

  it("excludes sync metadata, icons, dependencies, and symlinks", async () => {
    const root = await mkdtemp(join(tmpdir(), "aleph-files-"));
    await mkdir(join(root, "node_modules"));
    await writeFile(join(root, "AGENTS.md"), "# Agent");
    await writeFile(join(root, "aleph.json"), "{}");
    await writeFile(join(root, "cover.jpg"), "image");
    await writeFile(join(root, "node_modules", "ignored.js"), "ignored");
    await symlink(join(root, "AGENTS.md"), join(root, "linked.md"));

    const files = await collectBundleFiles(root, "cover.jpg");
    expect(files.map((file) => file.path)).toEqual(["AGENTS.md"]);
  });

  it("suggests a permanent UUID when agentId is missing", async () => {
    const root = await mkdtemp(join(tmpdir(), "aleph-manifest-"));
    await writeFile(
      join(root, "aleph.json"),
      JSON.stringify({ description: "Missing identity", name: "Missing" })
    );

    await expect(readAgentManifest(root)).rejects.toThrow(
      GENERATED_AGENT_ID_MESSAGE_PATTERN
    );
  });
});
