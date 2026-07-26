#!/usr/bin/env node

import { ZodError } from "zod";

import { CliError } from "./errors.js";
import { createProgram } from "./program.js";

const main = async (): Promise<void> => {
  const program = createProgram();
  await program.parseAsync(process.argv);
};

main().catch((error: unknown) => {
  if (error instanceof ZodError) {
    process.stderr.write(
      `${error.issues.map((issue) => issue.message).join("\n")}\n`
    );
    process.exitCode = 1;
    return;
  }
  if (error instanceof CliError) {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = error.exitCode;
    return;
  }
  process.stderr.write(
    `${error instanceof Error ? error.message : "Unexpected CLI failure"}\n`
  );
  process.exitCode = 1;
});
