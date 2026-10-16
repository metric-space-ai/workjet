import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it } from "vite-plus/test";

import {
  createMemoryV4InstanceDirectoryStorage,
  loadV4InstanceDirectory,
  resetV4InstanceDirectory,
} from "../../ctox/v4InstanceDirectory";
import { getCtoxSelectionDisposition } from "./CtoxModeShell";
import {
  V4_DEVICE_UNPAIRED_ACTION,
  V4_DEVICE_UNPAIRED_TEXT,
  V4DeviceUnpairedLineView,
} from "./V4DeviceUnpairedLine";

afterEach(() => resetV4InstanceDirectory());

describe("E54.5 unpaired device line", () => {
  it("is one line with exactly one action", () => {
    const html = renderToStaticMarkup(<V4DeviceUnpairedLineView onNewLink={() => undefined} />);
    expect(html).toContain(V4_DEVICE_UNPAIRED_TEXT);
    expect(html).toContain(V4_DEVICE_UNPAIRED_ACTION);
    expect(html.match(/<button/g)).toHaveLength(1);
  });

  it("keeps the selection of a paired V4 instance that desktop discovery does not list", async () => {
    const discovery = { _tag: "ready", instances: [] } as unknown as Parameters<
      typeof getCtoxSelectionDisposition
    >[0];
    expect(getCtoxSelectionDisposition(discovery, "inst-paired")).toBe("revoked");
    resetV4InstanceDirectory(
      createMemoryV4InstanceDirectoryStorage([
        {
          instanceId: "inst-paired",
          displayName: "inst-paired",
          userId: "u-1",
          role: "user",
          deviceId: "device-1",
          signaling: {
            urls: ["wss://signal.example/ws"],
            room: "room",
            nativePeerId: "native",
            iceServers: [],
          },
          state: "paired",
          updatedAtMs: 1,
        },
      ]),
    );
    await loadV4InstanceDirectory();
    expect(getCtoxSelectionDisposition(discovery, "inst-paired")).toBe("keep");
  });
});
