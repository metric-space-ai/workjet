import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vite-plus/test";

import { V4_INVITE_FAILURE_TEXT, type V4InviteFailureCode } from "../../ctox/v4DeviceInvite";
import {
  V4_INVITE_ACTION_LABEL,
  V4_INVITE_CONNECTED_TEXT,
  V4_INVITE_PROGRESS_TEXT,
  V4InviteRedeemLine,
} from "./V4InviteRedeemLine";

const render = (state: Parameters<typeof V4InviteRedeemLine>[0]["state"]) =>
  renderToStaticMarkup(
    <V4InviteRedeemLine state={state} onRetry={() => undefined} onNewLink={() => undefined} />,
  );

describe("E54.4 redeem line", () => {
  it("shows one progress line, then green", () => {
    const running = render({ phase: "running" });
    expect(running).toContain(V4_INVITE_PROGRESS_TEXT);
    expect(running).not.toContain("<button");
    const connected = render({ phase: "connected" });
    expect(connected).toContain(V4_INVITE_CONNECTED_TEXT);
    expect(connected).toContain("text-success");
    expect(connected).not.toContain("<button");
  });

  it.each(Object.keys(V4_INVITE_FAILURE_TEXT) as V4InviteFailureCode[])(
    "%s is a short German line with exactly one action",
    (code) => {
      const html = render({ phase: "failed", code });
      const { text, action } = V4_INVITE_FAILURE_TEXT[code];
      expect(html).toContain(text);
      expect(html.match(/<button/g)).toHaveLength(1);
      expect(html).toContain(V4_INVITE_ACTION_LABEL[action]);
      expect(text.length).toBeLessThanOrEqual(32);
    },
  );
});
