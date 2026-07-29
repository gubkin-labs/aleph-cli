import { mkdir, mkdtemp, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { collectBundleFiles } from "../../src/agents/files.js";
import {
  agentManifestSchema,
  hashAgentManifest,
  readAgentManifest,
  resolveSafeChild,
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

  it("hashes sync metadata but ignores agentId", () => {
    const first = agentManifestSchema.parse({
      agentId: "c53c58d0-a5a4-4f75-b11c-8c9847644af5",
      description: "A useful agent",
      labels: ["Trading"],
      name: "Builder",
    });
    const renamedIdentity = {
      ...first,
      agentId: "0c87f289-6d53-41d7-8d30-27e0cda73d4b",
    };
    const changedMetadata = { ...first, description: "Changed description" };

    expect(hashAgentManifest(renamedIdentity)).toBe(hashAgentManifest(first));
    expect(hashAgentManifest(changedMetadata)).not.toBe(
      hashAgentManifest(first)
    );
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
