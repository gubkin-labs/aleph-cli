import { z } from "zod";

import { CliError } from "../errors.js";

const deviceCodeSchema = z.object({
  device_code: z.string().min(1),
  expires_in: z.number().positive(),
  interval: z.number().positive().default(5),
  user_code: z.string().min(1),
  verification_uri: z.string().url(),
  verification_uri_complete: z.string().url().optional(),
});

const deviceTokenSchema = z.object({
  access_token: z.string().min(1),
  token_type: z.string(),
});

const authErrorSchema = z.object({
  error: z.string().optional(),
  error_description: z.string().optional(),
  message: z.string().optional(),
});

export type DeviceCode = z.infer<typeof deviceCodeSchema>;
export type DeviceToken = z.infer<typeof deviceTokenSchema>;

const authFetch = async (
  apiUrl: string,
  path: string,
  body: Record<string, string>
): Promise<Response> =>
  fetch(`${apiUrl}/api/auth${path}`, {
    body: JSON.stringify(body),
    headers: { "content-type": "application/json" },
    method: "POST",
  });

const errorFrom = async (response: Response): Promise<CliError> => {
  const parsed = authErrorSchema.safeParse(
    await response.json().catch(() => ({}))
  );
  const error = parsed.success ? parsed.data : {};
  const code = error.error ?? "authentication_failed";
  const message =
    error.error_description ??
    error.message ??
    `Authentication failed with HTTP ${response.status}`;
  return new CliError(`${code}: ${message}`, 2);
};

export const requestDeviceCode = async (
  apiUrl: string
): Promise<DeviceCode> => {
  const response = await authFetch(apiUrl, "/device/code", {
    client_id: "aleph-cli",
    scope: "openid profile email",
  });
  if (!response.ok) {
    throw await errorFrom(response);
  }
  return deviceCodeSchema.parse(await response.json());
};

export type PollResult =
  | { readonly status: "pending" }
  | { readonly status: "slow_down" }
  | { readonly status: "complete"; readonly token: DeviceToken };

export const pollDeviceToken = async (
  apiUrl: string,
  deviceCode: string
): Promise<PollResult> => {
  const response = await authFetch(apiUrl, "/device/token", {
    client_id: "aleph-cli",
    device_code: deviceCode,
    grant_type: "urn:ietf:params:oauth:grant-type:device_code",
  });
  if (response.ok) {
    return {
      status: "complete",
      token: deviceTokenSchema.parse(await response.json()),
    };
  }

  const parsed = authErrorSchema.safeParse(
    await response.json().catch(() => ({}))
  );
  const code = parsed.success ? parsed.data.error : undefined;
  if (code === "authorization_pending") {
    return { status: "pending" };
  }
  if (code === "slow_down") {
    return { status: "slow_down" };
  }
  const message = parsed.success
    ? (parsed.data.error_description ?? parsed.data.message ?? code)
    : undefined;
  throw new CliError(
    message ?? `Authentication failed with HTTP ${response.status}`,
    2
  );
};
