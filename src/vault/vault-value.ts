import { CliError } from "../errors.js";

const trailingNewline = /\r?\n$/;

const readStdin = async (): Promise<string> =>
  new Promise((resolve, reject) => {
    let value = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (chunk: string) => {
      value += chunk;
    });
    process.stdin.on("end", () => resolve(value));
    process.stdin.on("error", reject);
  });

export const resolveVaultValue = async (input: {
  readonly value?: string | undefined;
  readonly valueStdin?: boolean | undefined;
}): Promise<string> => {
  if (input.value !== undefined && input.valueStdin) {
    throw new CliError("Use either --value or --value-stdin, not both.");
  }
  if (input.value === undefined && !input.valueStdin) {
    throw new CliError("Provide a value with --value or --value-stdin.");
  }

  const value = input.valueStdin
    ? (await readStdin()).replace(trailingNewline, "")
    : input.value;
  if (!value) {
    throw new CliError("Vault values must not be empty.");
  }
  return value;
};
