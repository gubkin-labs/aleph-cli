import { z } from "zod";

import { AuthenticationError, CliError } from "../errors.js";

const apiErrorSchema = z.object({
  code: z.string().optional(),
  message: z.string().optional(),
});

export const throwApiError = (
  response: Response,
  error: unknown,
  action: string
): never => {
  const parsed = apiErrorSchema.safeParse(error);
  const message = parsed.success
    ? (parsed.data.message ?? parsed.data.code)
    : undefined;
  if (response.status === 401) {
    throw new AuthenticationError(
      message ?? "Authentication expired or was rejected. Run `aleph login`."
    );
  }
  throw new CliError(
    `${action} failed (${response.status}): ${message ?? response.statusText}`
  );
};
