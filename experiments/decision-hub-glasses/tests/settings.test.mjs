import test from "node:test";
import assert from "node:assert/strict";
import {
  parseInvite,
  instanceFrom,
  normalizeBase,
  passesFilter,
  DEFAULTS,
} from "../src/settings.mjs";

test("a pairing link yields instance and token", () => {
  const invite = parseInvite("https://welsch.ctox.dev/pair?token=abc123&user=michael&role=chef");
  assert.equal(invite.baseUrl, "https://welsch.ctox.dev");
  assert.equal(invite.token, "abc123");
  assert.equal(invite.user, "michael");
});

test("the ctox:// scheme is accepted too", () => {
  const invite = parseInvite("ctox://welsch.ctox.dev/pair?token=abc123");
  assert.equal(invite.baseUrl, "https://welsch.ctox.dev");
  assert.equal(invite.token, "abc123");
});

test("invite JSON is accepted", () => {
  const invite = parseInvite(
    '{"base_url":"welsch.ctox.dev","capability_token":"t0k","role":"chef"}',
  );
  assert.equal(invite.baseUrl, "https://welsch.ctox.dev");
  assert.equal(invite.token, "t0k");
  assert.equal(invite.role, "chef");
});

test("a link without a token is refused rather than half-configured", () => {
  assert.equal(parseInvite("https://welsch.ctox.dev/pair"), null);
  assert.equal(parseInvite(""), null);
  assert.equal(parseInvite("nonsense"), null);
});

test("bare hosts get https, never plain http", () => {
  assert.equal(normalizeBase("welsch.ctox.dev"), "https://welsch.ctox.dev");
  assert.equal(normalizeBase("welsch.ctox.dev/"), "https://welsch.ctox.dev");
});

test("ctox.dev instances are recognised as managed", () => {
  assert.equal(instanceFrom({ baseUrl: "welsch.ctox.dev", token: "t" }).kind, "managed");
  assert.equal(instanceFrom({ baseUrl: "ctox.intern.example", token: "t" }).kind, "self-hosted");
});

test("type filters decide what reaches the glasses", () => {
  const settings = { ...DEFAULTS, types: ["triage"] };
  assert.equal(passesFilter({ typ: "triage" }, settings), true);
  assert.equal(passesFilter({ typ: "zuordnung" }, settings), false);
});

// Die Kopplung darf nur zustande kommen, wenn der Code wirklich eine
// CTOX-Einladung traegt — ein beliebiger QR-Code aus der Umgebung nicht.
test("a scanned code is only accepted when it carries a CTOX invite", async () => {
  const { parseInvite } = await import("../src/settings.mjs");
  assert.equal(parseInvite("https://example.com/irgendwas"), null);
  assert.equal(parseInvite("WIFI:S=Cafe;T=WPA;P=geheim;;"), null);
  const gut = parseInvite("https://welsch.ctox.dev/pair?token=abc&user=michael&role=chef");
  assert.equal(gut.baseUrl, "https://welsch.ctox.dev");
});
