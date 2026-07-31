import { render } from "ink";
import open from "open";

import type { Output } from "../output.js";
import type { CredentialStore } from "./credential-store.js";
import { credentialStore } from "./credential-store.js";
import { pollDeviceToken, requestDeviceCode } from "./device-client.js";
import { LoginView } from "./login-view.js";
import {
  formatScopeResult,
  type OrganizationScopeSelection,
  selectAndApplyOrganizationScope,
} from "./org-scope.js";

const sleep = async (milliseconds: number): Promise<void> => {
  await new Promise<void>((resolve) => {
    setTimeout(resolve, milliseconds);
  });
};

export const login = async (
  apiUrl: string,
  output: Output,
  store: CredentialStore = credentialStore,
  selection: OrganizationScopeSelection = {}
): Promise<void> => {
  const device = await requestDeviceCode(apiUrl);
  const verificationUrl =
    device.verification_uri_complete ?? device.verification_uri;
  const view =
    process.stderr.isTTY && !output.json
      ? render(
          <LoginView
            code={device.user_code}
            verificationUrl={verificationUrl}
          />,
          { stdout: process.stderr }
        )
      : null;

  if (!view) {
    output.progress(
      `Open ${verificationUrl} and enter code ${device.user_code}`
    );
  }

  await open(verificationUrl).catch(() => undefined);

  let intervalSeconds = device.interval;
  const deadline = Date.now() + device.expires_in * 1000;
  while (Date.now() < deadline) {
    await sleep(intervalSeconds * 1000);
    const result = await pollDeviceToken(apiUrl, device.device_code);
    if (result.status === "complete") {
      await store.set(apiUrl, result.token.access_token);
      view?.unmount();
      const scope = await selectAndApplyOrganizationScope({
        apiUrl,
        output,
        selection,
        token: result.token.access_token,
      });
      output.data(
        output.json
          ? {
              apiUrl,
              authenticated: true,
              organizationId: scope.organizationId,
              organizationName: scope.organizationName,
              scope: scope.scope,
            }
          : formatScopeResult(apiUrl, scope)
      );
      return;
    }
    if (result.status === "slow_down") {
      intervalSeconds += 5;
    }
  }

  view?.unmount();
  throw new Error("The device authorization request expired.");
};
