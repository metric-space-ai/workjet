import { describe, expect, it } from "vite-plus/test";

import { BUILT_IN_BUSINESS_OS_MOBILE_CATALOG } from "./business-os-app-catalog";
import {
  BUSINESS_OS_SHELL_PROTOCOL,
  decodeBusinessOsShellMessage,
  encodeBusinessOsHostCommand,
} from "./business-os-shell-protocol";

describe("Business OS native shell protocol", () => {
  it("accepts lifecycle and bounded catalog messages", () => {
    const wireCatalog = {
      ...BUILT_IN_BUSINESS_OS_MOBILE_CATALOG,
      apps: BUILT_IN_BUSINESS_OS_MOBILE_CATALOG.apps.map(({ icon: _icon, ...app }) => app),
    };
    expect(
      decodeBusinessOsShellMessage(
        JSON.stringify({
          protocol: BUSINESS_OS_SHELL_PROTOCOL,
          type: "catalog.replace",
          catalog: wireCatalog,
        }),
      ),
    ).toMatchObject({ type: "catalog.replace" });
    expect(
      decodeBusinessOsShellMessage(
        JSON.stringify({
          protocol: BUSINESS_OS_SHELL_PROTOCOL,
          type: "app.state",
          appId: "threads",
          title: "Threads",
          canGoBack: true,
          state: "active",
          actions: [],
        }),
      ),
    ).toMatchObject({ type: "app.state", appId: "threads" });
  });

  it("rejects records, secrets, URLs, HTML, and unknown message types", () => {
    for (const value of [
      { type: "record.update", record: { id: "1" } },
      { type: "app.state", appId: "threads", title: "<script>x</script>", secret: "x" },
      { type: "shell.ready", revision: "x", capabilityToken: "secret" },
    ]) {
      expect(() =>
        decodeBusinessOsShellMessage(
          JSON.stringify({ protocol: BUSINESS_OS_SHELL_PROTOCOL, ...value }),
        ),
      ).toThrow();
    }
  });

  it("encodes only the versioned native command envelope", () => {
    expect(
      JSON.parse(
        encodeBusinessOsHostCommand({
          protocol: BUSINESS_OS_SHELL_PROTOCOL,
          type: "app.open",
          appId: "threads",
        }),
      ),
    ).toEqual({ protocol: BUSINESS_OS_SHELL_PROTOCOL, type: "app.open", appId: "threads" });
    expect(() =>
      encodeBusinessOsHostCommand({
        protocol: BUSINESS_OS_SHELL_PROTOCOL,
        type: "app.open",
        appId: "desktop",
      }),
    ).toThrowError("native Business OS home route");
  });
});
