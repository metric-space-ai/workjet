import * as NodeAssert from "node:assert/strict";
import * as NodeCrypto from "node:crypto";
import * as NodeModule from "node:module";
import * as NodeURL from "node:url";
import * as NodeTest from "node:test";
import * as NodePath from "node:path";
const assert = NodeAssert;
const { generateKeyPairSync } = NodeCrypto;
const { createRequire } = NodeModule;
const { fileURLToPath } = NodeURL;
const test = NodeTest.test;
const path = NodePath;

const root = fileURLToPath(new URL("../", import.meta.url));
const mobile = createRequire(path.join(root, "apps/mobile/package.json"));
const expo = createRequire(mobile.resolve("expo/package.json"));
const cli = createRequire(expo.resolve("@expo/cli/package.json"));
const metro = createRequire(expo.resolve("@expo/metro-config/package.json"));
const micromatch = createRequire(metro.resolve("micromatch/package.json"));
const marketing = createRequire(path.join(root, "apps/marketing/package.json"));
const astro = createRequire(marketing.resolve("astro/package.json"));
// Isolated pristine/patched fixtures never mutate another task's installed packages.
const fixtureRoot = process.env.WORKJET_SECURITY_TEST_ROOT;
const load = (name, consumer) => consumer(fixtureRoot ? path.join(fixtureRoot, name) : name);
const forge = load("node-forge", cli);
const CachePolicy = load("http-cache-semantics", astro);
const braces = load("braces", micromatch);

const { privateKey: pem } = generateKeyPairSync("rsa", {
  modulusLength: 1024,
  publicExponent: 3,
  privateKeyEncoding: { type: "pkcs1", format: "pem" },
  publicKeyEncoding: { type: "pkcs1", format: "pem" },
});
const privateKey = forge.pki.privateKeyFromPem(pem);
const publicKey = forge.pki.setRsaPublicKey(privateKey.n, privateKey.e);
const digest = forge.md.sha256.create().update("workjet signature regression").digest().bytes();
const asn1 = forge.asn1;
const universal = asn1.Class.UNIVERSAL;
const digestInfo = (parameters = true) =>
  asn1.create(universal, asn1.Type.SEQUENCE, true, [
    asn1.create(universal, asn1.Type.SEQUENCE, true, [
      asn1.create(universal, asn1.Type.OID, false, asn1.oidToDer(forge.oids.sha256).bytes()),
      ...(parameters ? [asn1.create(universal, asn1.Type.NULL, false, "")] : []),
    ]),
    asn1.create(universal, asn1.Type.OCTETSTRING, false, digest),
  ]);
const signatureFor = (info) => privateKey.sign(asn1.toDer(info).bytes(), "NONE");

test("forge accepts valid signatures and SHA-256 AlgorithmIdentifier with or without NULL", () => {
  for (const parameters of [true, false]) {
    assert.equal(publicKey.verify(digest, signatureFor(digestInfo(parameters))), true);
  }
  for (const algorithm of ["sha1", "sha256", "sha512"]) {
    const md = forge.md[algorithm].create().update("normal Expo certificate signature");
    const signed = privateKey.sign(md);
    assert.equal(publicKey.verify(md.digest().bytes(), signed), true);
  }
});

for (const kind of ["NULL", "OCTETSTRING", "OID"]) {
  test("forge rejects extra nested DigestAlgorithm " + kind, () => {
    const info = digestInfo();
    info.value[0].value.push(
      asn1.create(
        universal,
        asn1.Type[kind],
        false,
        kind === "OID"
          ? asn1.oidToDer(forge.oids.sha256).bytes()
          : kind === "NULL"
            ? ""
            : "attacker padding",
      ),
    );
    assert.throws(() => publicKey.verify(digest, signatureFor(info)), /DigestInfo/);
  });
}

test("forge rejects nonempty NULL parameters and wrong outer element count", () => {
  const info = digestInfo();
  info.value[0].value[1].value = "attacker padding";
  assert.throws(() => publicKey.verify(digest, signatureFor(info)), /DigestInfo/);
  const extra = digestInfo();
  extra.value.push(asn1.create(universal, asn1.Type.NULL, false, ""));
  assert.throws(() => publicKey.verify(digest, signatureFor(extra)), /DigestInfo/);
});

const request = (cacheControl) => ({
  url: "https://cache.test/account",
  method: "GET",
  headers: { host: "cache.test", ...(cacheControl ? { "cache-control": cacheControl } : {}) },
});
const response = (headers) => ({
  status: 200,
  headers: { date: new Date().toUTCString(), age: "60", ...headers },
});
const staleRequest = request("max-stale=999999999");

for (const [name, headers] of [
  ["private", { "cache-control": "private, max-age=1000", "set-cookie": "session=secret" }],
  ["no-store", { "cache-control": "no-store, max-age=1000", "set-cookie": "session=secret" }],
  [
    "proxy-revalidate",
    { "cache-control": "proxy-revalidate, max-age=1000, stale-while-revalidate=1000" },
  ],
  ["no-cache", { "cache-control": "no-cache, stale-while-revalidate=1000" }],
  ["shared cookie", { "set-cookie": "session=secret", "cache-control": "max-age=1000" }],
  ["wildcard Vary", { vary: "*", "cache-control": "max-age=1000" }],
]) {
  test("cache max-stale cannot revive " + name + " entry, including serialized policies", () => {
    const policy = new CachePolicy(request(), response(headers));
    assert.equal(policy.maxAge(), 0);
    for (const restored of [policy, CachePolicy.fromObject(policy.toObject())]) {
      for (const incoming of [staleRequest, request("max-stale")]) {
        const result = restored.evaluateRequest(incoming);
        assert.equal(result.response, undefined);
        assert.equal(result.revalidation.synchronous, true);
        assert.equal(restored.satisfiesWithoutRevalidation(incoming), false);
      }
    }
  });
}

test("shared s-maxage requires revalidation after expiry despite max-stale or stale-while-revalidate", () => {
  const policy = new CachePolicy(
    request(),
    response({
      "cache-control": "public, s-maxage=1, stale-while-revalidate=1000",
    }),
  );
  const result = policy.evaluateRequest(staleRequest);
  assert.equal(result.response, undefined);
  assert.equal(result.revalidation.synchronous, true);
});

test("cache retains normal fresh, public stale, private-cache and explicitly public-cookie behavior", () => {
  for (const [headers, options, incoming] of [
    [{ "cache-control": "public, max-age=1000" }, undefined, request()],
    [{ "cache-control": "public, s-maxage=1000" }, undefined, request()],
    [{ "cache-control": "public, max-age=1" }, undefined, staleRequest],
    [
      { "cache-control": "private, max-age=1000", "set-cookie": "session=private" },
      { shared: false },
      request(),
    ],
    [
      { "cache-control": "public, max-age=1000", "set-cookie": "explicit=public" },
      undefined,
      request(),
    ],
  ]) {
    const policy = new CachePolicy(request(), response(headers), options);
    assert.notEqual(policy.evaluateRequest(incoming).response, undefined);
  }
});

test("braces retains ordinary globs, ranges, escaping, quotes and bounded nesting", () => {
  assert.deepEqual(braces.expand("src/{a,b}/{1..3}.ts"), [
    "src/a/1.ts",
    "src/a/2.ts",
    "src/a/3.ts",
    "src/b/1.ts",
    "src/b/2.ts",
    "src/b/3.ts",
  ]);
  assert.equal(braces.compile("a{b,c}d"), "a(b|c)d");
  assert.deepEqual(braces.expand("a\\{b,c\\}"), ["a{b,c}"]);
  assert.deepEqual(braces.expand('"literal{a,b}"'), ["literal{a,b}"]);
  assert.doesNotThrow(() => braces.compile("{".repeat(100) + "x,y" + "}".repeat(100)));
});

for (const [name, pattern] of [
  ["balanced braces", "{".repeat(3000) + "x,y" + "}".repeat(3000)],
  ["unbalanced braces", "{".repeat(3000) + "x"],
  ["parentheses", "(".repeat(3000) + "x" + ")".repeat(3000)],
  ["mixed nesting", "{(".repeat(1500) + "x" + ")}".repeat(1500)],
]) {
  test("braces rejects excessive " + name + " before recursive consumers", () => {
    for (const action of [braces.parse, braces.compile, braces.expand, braces.stringify]) {
      assert.throws(() => action(pattern), { name: "SyntaxError", message: /max depth/ });
    }
  });
}

const deepAst = () => {
  let child = { type: "text", value: "leaf" };
  for (let n = 0; n < 3000; n++) child = { type: "paren", nodes: [child] };
  const ast = { type: "root", nodes: [child] };
  let parent = ast;
  while (parent.nodes) {
    parent.nodes[0].parent = parent;
    parent = parent.nodes[0];
  }
  return ast;
};
for (const [name, action] of [
  ["compile", braces.compile],
  ["expand", braces.expand],
  ["stringify", braces.stringify],
]) {
  test("braces " + name + " also bounds caller-supplied AST depth", () => {
    assert.throws(() => action(deepAst()), { name: "SyntaxError", message: /max depth/ });
  });
}
