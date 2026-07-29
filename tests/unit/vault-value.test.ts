import { describe, expect, it } from "vitest";

import { CliError } from "../../src/errors.js";
import { resolveVaultValue } from "../../src/vault/vault-value.js";

describe("resolveVaultValue", () => {
  it("accepts an explicit non-empty value", async () => {
    await expect(resolveVaultValue({ value: "secret" })).resolves.toBe(
      "secret"
    );
  });

  it("rejects missing, empty, and conflicting value inputs", async () => {
    await expect(resolveVaultValue({})).rejects.toBeInstanceOf(CliError);
    await expect(resolveVaultValue({ value: "" })).rejects.toBeInstanceOf(
      CliError
    );
    await expect(
      resolveVaultValue({ value: "secret", valueStdin: true })
    ).rejects.toBeInstanceOf(CliError);
  });
});
