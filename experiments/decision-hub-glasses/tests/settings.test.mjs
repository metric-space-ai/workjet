import * as NodeTest from "node:test";
import * as NodeAssert from "node:assert/strict";
import {
  parseInvite,
  instanceFrom,
  normalizeBase,
  passesFilter,
  DEFAULTS,
} from "../src/settings.mjs";

NodeTest("a pairing link yields instance and token", () => {
  const invite = parseInvite("https://welsch.ctox.dev/pair?token=abc123&user=michael&role=chef");
  NodeAssert.equal(invite.baseUrl, "https://welsch.ctox.dev");
  NodeAssert.equal(invite.token, "abc123");
  NodeAssert.equal(invite.user, "michael");
});

NodeTest("the ctox:// scheme is accepted too", () => {
  const invite = parseInvite("ctox://welsch.ctox.dev/pair?token=abc123");
  NodeAssert.equal(invite.baseUrl, "https://welsch.ctox.dev");
  NodeAssert.equal(invite.token, "abc123");
});

NodeTest("invite JSON is accepted", () => {
  const invite = parseInvite(
    '{"base_url":"welsch.ctox.dev","capability_token":"t0k","role":"chef"}',
  );
  NodeAssert.equal(invite.baseUrl, "https://welsch.ctox.dev");
  NodeAssert.equal(invite.token, "t0k");
  NodeAssert.equal(invite.role, "chef");
});

NodeTest("a link without a token is refused rather than half-configured", () => {
  NodeAssert.equal(parseInvite("https://welsch.ctox.dev/pair"), null);
  NodeAssert.equal(parseInvite(""), null);
  NodeAssert.equal(parseInvite("nonsense"), null);
});

NodeTest("bare hosts get https, never plain http", () => {
  NodeAssert.equal(normalizeBase("welsch.ctox.dev"), "https://welsch.ctox.dev");
  NodeAssert.equal(normalizeBase("welsch.ctox.dev/"), "https://welsch.ctox.dev");
});

NodeTest("ctox.dev instances are recognised as managed", () => {
  NodeAssert.equal(instanceFrom({ baseUrl: "welsch.ctox.dev", token: "t" }).kind, "managed");
  NodeAssert.equal(
    instanceFrom({ baseUrl: "ctox.intern.example", token: "t" }).kind,
    "self-hosted",
  );
});

NodeTest("type filters decide what reaches the glasses", () => {
  const settings = { ...DEFAULTS, types: ["triage"] };
  NodeAssert.equal(passesFilter({ typ: "triage" }, settings), true);
  NodeAssert.equal(passesFilter({ typ: "zuordnung" }, settings), false);
});

// Die Kopplung darf nur zustande kommen, wenn der Code wirklich eine
// CTOX-Einladung traegt — ein beliebiger QR-Code aus der Umgebung nicht.
NodeTest("a scanned code is only accepted when it carries a CTOX invite", async () => {
  const { parseInvite } = await import("../src/settings.mjs");
  NodeAssert.equal(parseInvite("https://example.com/irgendwas"), null);
  NodeAssert.equal(parseInvite("WIFI:S=Cafe;T=WPA;P=geheim;;"), null);
  const gut = parseInvite("https://welsch.ctox.dev/pair?token=abc&user=michael&role=chef");
  NodeAssert.equal(gut.baseUrl, "https://welsch.ctox.dev");
});
