// @effect-diagnostics nodeBuiltinImport:off - the wiring invariant is proved by reading the mailbox's own source.
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import { fileURLToPath } from "node:url";

import { assert, describe, it } from "@effect/vitest";

/**
 * THE REMOTE-DISPATCH AUTHENTICATION WIRING GATE
 * (docs/workjet-plan.md → "Security invariants": "Authenticate remote worker
 * dispatch and prevent cross-environment authority escalation").
 *
 * WHY A SOURCE SCAN AND NOT ONLY A BEHAVIOURAL TEST.
 *
 * `WorkjetMailboxTransport.test.ts` proves that the ingest path REFUSES a
 * tampered signature, a misaddressed envelope, and a payload whose claimed
 * addresses disagree with the signed ones. What no behavioural test can prove
 * is that ingest is the ONLY way in: a second writer of the inbound tables —
 * a new sync route, a repair job, a debug import — would satisfy every existing
 * assertion while handing an unauthenticated envelope straight to a thread.
 *
 * `recordInboundEnvelope` is that chokepoint. It is the single durable write
 * that turns wire bytes into a locally accepted envelope, and both thread-
 * visible effects (`applyDeliveredDelegation`, `upsertReceivedHandoff`) run only
 * after it reports `accepted-new`. So this test holds two properties:
 *
 *   1. every call site of `recordInboundEnvelope` sits in a declaration that
 *      also verifies the routing envelope's signature, and
 *   2. the call-site inventories for the chokepoint and for the two effects are
 *      exactly the declared ones, so a NEW writer fails here rather than
 *      inheriting the guarantee by proximity.
 *
 * Mutation-verified: deleting the `verifyRoutingEnvelope` call from any of the
 * three declarations, or adding a fourth unguarded `recordInboundEnvelope`
 * call, fails this test.
 */

const mailboxDir = fileURLToPath(new URL(".", import.meta.url));

const read = (file: string): string => NodeFS.readFileSync(NodePath.join(mailboxDir, file), "utf8");

/** The signature check that authenticates an envelope's routing addresses. */
const SIGNATURE_CHECK = "verifyRoutingEnvelope(";

/**
 * The durable inbound write. The leading dot excludes the store's own
 * definition and its re-export, leaving only genuine call sites.
 */
const INBOUND_WRITE = ".recordInboundEnvelope(";

/**
 * Every call site of the chokepoint, with the declaration that must contain the
 * signature check. Adding a call site without adding it here fails the
 * inventory assertion; adding it here without a signature check fails the
 * wiring assertion.
 */
const DECLARED_INBOUND_WRITES: ReadonlyArray<{
  readonly file: string;
  readonly declaration: string;
  readonly why: string;
}> = [
  {
    file: "WorkjetMailboxDelivery.ts",
    declaration: "deliverLocally",
    why: "the same-environment fast path for a message or a delegation",
  },
  {
    file: "WorkjetMailboxDelivery.ts",
    declaration: "sendHandoff",
    why: "the same-environment fast path for a thread handoff",
  },
  {
    file: "WorkjetMailboxTransport.ts",
    declaration: "ingest",
    why: "the remote path: one envelope pulled from the CTOX daemon",
  },
];

/**
 * The two thread-visible effects an accepted envelope may produce. They are
 * inventoried but NOT required to carry their own signature check: each runs
 * inside, or immediately after, a declaration that already did. A new call site
 * fails this inventory, which is the point.
 */
const DECLARED_EFFECT_CALLS: ReadonlyArray<{
  readonly token: string;
  readonly sites: ReadonlyArray<{ readonly file: string; readonly declaration: string }>;
}> = [
  {
    token: "applyDeliveredDelegation({",
    sites: [
      { file: "WorkjetMailboxDelivery.ts", declaration: "delegateTask" },
      { file: "WorkjetMailboxTransport.ts", declaration: "ingest" },
    ],
  },
  {
    token: ".upsertReceivedHandoff(",
    sites: [
      { file: "WorkjetMailboxDelivery.ts", declaration: "sendHandoff" },
      { file: "WorkjetMailboxTransport.ts", declaration: "ingest" },
    ],
  },
];

/** Every production module of the mailbox slice. */
const productionFiles = (): ReadonlyArray<string> =>
  NodeFS.readdirSync(mailboxDir)
    .filter((name) => name.endsWith(".ts") && !name.endsWith(".test.ts"))
    .sort();

/**
 * The top-level or once-indented `const` declaration a source offset falls in.
 *
 * Nested helpers inside a declaration are indented further, so this returns the
 * enclosing unit of logic — which is exactly the scope a signature check has to
 * share with the write it guards. A verification in a DIFFERENT declaration
 * does not count, which is what makes deleting one observable here.
 */
const enclosingDeclaration = (
  source: string,
  offset: number,
): { readonly name: string; readonly body: string } => {
  const boundary = /^ {0,2}(?:export )?const ([A-Za-z_$][\w$]*)\b/gm;
  let name = "<file>";
  let start = 0;
  let end = source.length;
  for (let match = boundary.exec(source); match !== null; match = boundary.exec(source)) {
    if (match.index <= offset) {
      name = match[1] ?? name;
      start = match.index;
    } else {
      end = match.index;
      break;
    }
  }
  return { name, body: source.slice(start, end) };
};

const callSites = (source: string, token: string): ReadonlyArray<string> => {
  const found: Array<string> = [];
  for (let at = source.indexOf(token); at !== -1; at = source.indexOf(token, at + 1)) {
    found.push(enclosingDeclaration(source, at).name);
  }
  return found;
};

describe("Workjet remote dispatch authentication wiring", () => {
  it("verifies the routing envelope in every declaration that records an inbound envelope", () => {
    const observed: Array<{ readonly file: string; readonly declaration: string }> = [];

    for (const file of productionFiles()) {
      const source = read(file);
      for (
        let at = source.indexOf(INBOUND_WRITE);
        at !== -1;
        at = source.indexOf(INBOUND_WRITE, at + 1)
      ) {
        const enclosing = enclosingDeclaration(source, at);
        observed.push({ file, declaration: enclosing.name });
        assert.include(
          enclosing.body,
          SIGNATURE_CHECK,
          `${file} → ${enclosing.name} writes an inbound envelope without verifying its signature`,
        );
      }
    }

    assert.deepEqual(
      observed,
      DECLARED_INBOUND_WRITES.map(({ file, declaration }) => ({ file, declaration })),
      "the inbound-write inventory changed: a new writer must be declared and guarded here",
    );
  });

  it("holds the thread-visible effect call sites to the declared inventory", () => {
    for (const declared of DECLARED_EFFECT_CALLS) {
      const observed: Array<{ readonly file: string; readonly declaration: string }> = [];
      for (const file of productionFiles()) {
        for (const declaration of callSites(read(file), declared.token)) {
          observed.push({ file, declaration });
        }
      }
      assert.deepEqual(
        observed,
        [...declared.sites],
        `${declared.token} gained or lost a call site`,
      );
    }
  });

  it("keeps the payload/envelope address binding on the remote ingest path", () => {
    // The signature covers the routing envelope and the AES-GCM seal binds the
    // ciphertext to the envelope id — neither constrains the addresses the
    // payload claims for ITSELF. `payloadMatchesEnvelope` is that comparison,
    // and it has to run on the remote path before anything durable happens.
    const source = read("WorkjetMailboxTransport.ts");
    const at = source.indexOf("payloadMatchesEnvelope(openedPayload");
    assert.notStrictEqual(at, -1, "the remote ingest path no longer binds payload to envelope");
    const enclosing = enclosingDeclaration(source, at);
    assert.strictEqual(enclosing.name, "ingest");
    // Before the snapshot store write, which is the first durable effect an
    // opened payload can reach.
    assert.isBelow(
      at,
      source.indexOf("snapshots.put(openedPayload.snapshotBytes)"),
      "the address binding must run before the first durable write",
    );
  });
});
