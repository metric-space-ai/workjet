// Secret requests on V4 before M7: the Core answers `ctox.secret.request.fulfill` with
// `unavailable`, so Workjet offers fill/decline only when hello_ok grants the route. The request
// itself stays visible; no hint text, no disabled button. V3 keeps both actions unchanged.
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it } from "vite-plus/test";
import type { WorkjetSecretRequestRecord } from "@workjet/contracts";
import { bindCtoxClient, type CtoxAppApi } from "../../ctox/ctoxClient";
import {
  bindV4GrantedCapabilities,
  CTOX_SECRET_REQUEST_DECLINE,
  CTOX_SECRET_REQUEST_FULFILL,
  markV4RouteUnavailable,
  resetV4CapabilitiesForTest,
} from "../../ctox/v4Capabilities";
import { SecretRequestCard } from "./SecretRequestCard";

const request = {
  requestId: "sreq_1",
  label: "GitHub-Token",
  reason: "Für den Release",
  status: "pending",
  threadKey: null,
} as unknown as WorkjetSecretRequestRecord;

const fakeApi = (role = "admin") =>
  ({ version: "4.0", app: { id: "workjet" }, actor: { id: "u-1", role } }) as unknown as CtoxAppApi;

const cleanups: (() => void)[] = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
  resetV4CapabilitiesForTest();
});

function v4(instanceId: string, granted: string[] | null) {
  cleanups.push(bindCtoxClient(instanceId, fakeApi()));
  if (granted !== null) cleanups.push(bindV4GrantedCapabilities(instanceId, () => granted));
}

const render = (instanceId: string) =>
  renderToStaticMarkup(
    <SecretRequestCard instanceId={instanceId} request={request} language="de" />,
  );

/** Visible text without markup. */
const text = (html: string) => html.replace(/<[^>]+>/g, "").trim();

describe("SecretRequestCard on V4 without the route", () => {
  it("shows the request, but no field, no action and no hint", () => {
    v4("wj-v4-none", null);
    const html = render("wj-v4-none");
    expect(html).toContain('data-workjet-secret-request="sreq_1"');
    expect(html).not.toContain("<form");
    expect(html).not.toContain("<input");
    expect(html).not.toContain("<button");
    expect(text(html)).toBe("GitHub-TokenFür den Release");
  });

  it("a hello_ok grant without the secret routes offers nothing either", () => {
    v4("wj-v4-other", ["ctox.maintenance.restart"]);
    const html = render("wj-v4-other");
    expect(html).not.toContain("<button");
    expect(text(html)).toBe("GitHub-TokenFür den Release");
  });
});

describe("SecretRequestCard on V4 with the route", () => {
  it("offers fill and decline when both are granted", () => {
    v4("wj-v4-both", [CTOX_SECRET_REQUEST_FULFILL, CTOX_SECRET_REQUEST_DECLINE]);
    const html = render("wj-v4-both");
    expect(html).toContain("<form");
    expect(html).toContain("Speichern</button>");
    expect(html).toContain("Ablehnen</button>");
  });

  it("offers decline only when decline alone is granted", () => {
    v4("wj-v4-decline", [CTOX_SECRET_REQUEST_DECLINE]);
    const html = render("wj-v4-decline");
    expect(html).not.toContain("<form");
    expect(html.match(/<button/g)).toHaveLength(1);
    expect(html).toContain("Ablehnen</button>");
  });

  it("offers fill without decline when decline is not granted", () => {
    v4("wj-v4-fill", [CTOX_SECRET_REQUEST_FULFILL]);
    const html = render("wj-v4-fill");
    expect(html).toContain("Speichern</button>");
    expect(html).not.toContain("Ablehnen");
  });

  it("an `unavailable` answer hides the action for the rest of the session", () => {
    v4("wj-v4-gone", [CTOX_SECRET_REQUEST_FULFILL, CTOX_SECRET_REQUEST_DECLINE]);
    markV4RouteUnavailable("wj-v4-gone", CTOX_SECRET_REQUEST_FULFILL);
    const html = render("wj-v4-gone");
    expect(html).not.toContain("<form");
    expect(html).not.toContain("Speichern");
    expect(html).toContain("Ablehnen</button>");
  });
});

describe("SecretRequestCard on V3", () => {
  it("is unchanged: field, save and decline", () => {
    const html = render("wj-v3");
    expect(html).toContain("<form");
    expect(html).toContain("Speichern</button>");
    expect(html).toContain("Ablehnen</button>");
  });

  it("a V4 `unavailable` mark never touches a V3 instance", () => {
    markV4RouteUnavailable("wj-v3-marked", CTOX_SECRET_REQUEST_FULFILL);
    expect(render("wj-v3-marked")).toContain("Speichern</button>");
  });
});
