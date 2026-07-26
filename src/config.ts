import { z } from "zod";

export const DEFAULT_API_URL = "https://api.aleph-agent.com";
const TRAILING_SLASH_PATTERN = /\/$/u;

const apiUrlSchema = z
  .string()
  .url()
  .transform((value) => value.replace(TRAILING_SLASH_PATTERN, ""));

export const resolveApiUrl = (value?: string): string =>
  apiUrlSchema.parse(value ?? process.env.ALEPH_API_URL ?? DEFAULT_API_URL);

export const globalOptionsSchema = z.object({
  apiKey: z.string().min(1).optional(),
  apiUrl: apiUrlSchema.optional(),
  json: z.boolean().default(false),
});

export type GlobalOptions = z.infer<typeof globalOptionsSchema>;
