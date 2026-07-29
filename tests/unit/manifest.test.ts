import { mkdir, mkdtemp, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { collectBundleFiles } from "../../src/agents/files.js";
import {
  agentManifestSchema,
  resolveSafeChild,
} from "../../src/agents/manifest.js";

describe("agent manifests and bundle files", () => {
  it("validates metadata and rejects traversal", () => {
    expect(
      agentManifestSchema.parse({
        description: "A useful agent",
        labels: ["Trading"],
        name: "Builder",
      }).visibility
    ).toBe("public");

    expect(() =>
      agentManifestSchema.parse({
        description: "Unsafe",
        icon: "../secret.png",
        name: "Unsafe",
      })
    ).toThrow();
    expect(() => resolveSafeChild("/tmp/repo", "../outside")).toThrow();
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
});
