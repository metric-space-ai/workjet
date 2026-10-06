import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { createRequire } from "node:module";
import { PassThrough } from "node:stream";
import test from "node:test";
import { pathToFileURL } from "node:url";
import zlib from "node:zlib";

const web = createRequire(new URL("../apps/web/package.json", import.meta.url));
const reactRouter = createRequire(web.resolve("@tanstack/react-router"));
const router = createRequire(reactRouter.resolve("@tanstack/router-core"));
const seroval = router("seroval");
const marketing = createRequire(new URL("../apps/marketing/package.json", import.meta.url));
const astro = createRequire(marketing.resolve("astro/package.json"));
const magicast = createRequire(astro.resolve("magicast"));
const { SourceMapConsumer } = magicast("source-map-js");
const server = createRequire(new URL("../apps/server/package.json", import.meta.url));
const claude = createRequire(server.resolve("@anthropic-ai/claude-agent-sdk"));
const mcp = createRequire(claude.resolve("@modelcontextprotocol/sdk/server/index.js"));
const express = createRequire(mcp.resolve("express"));
const proxyaddr = express("proxy-addr");
const mobile = createRequire(new URL("../apps/mobile/package.json", import.meta.url));
const expo = createRequire(mobile.resolve("expo/package.json"));
const cli = createRequire(expo.resolve("@expo/cli/package.json"));
const compression = cli("compression");

// Exercise the real consumer routes, including normal values beside malformed input.
const serovalDistribution = new URL("./", pathToFileURL(router.resolve("seroval")));
for (const [name, load] of [
  ["production CJS", () => seroval],
  ["development CJS", () => router(new URL("dev/index.cjs", serovalDistribution).pathname)],
  ["production ESM", () => import(new URL("index.js", serovalDistribution))],
  ["development ESM", () => import(new URL("dev/index.js", serovalDistribution))],
]) {
  test(`${name} Seroval retains binary round trips and rejects non-buffer typed-array sources`, async () => {
    const api = await load();
    for (const original of [
      new Uint8Array([17, 29, 41]),
      new Uint8Array(new Uint8Array([7, 17, 29, 41, 9]).buffer, 1, 3),
    ]) {
      assert.deepEqual(api.fromJSON(api.toJSON(original)), original);
      for (const source of [42, "invalid buffer", { length: 3 }]) {
        const wire = api.toJSON(original);
        const replacement = api.toJSON(source).t;
        replacement.i = wire.t.f.i;
        wire.t.f = replacement;
        assert.throws(() => api.fromJSON(wire));
      }
    }
  });
  test(`${name} Seroval retains DataView offsets and rejects non-buffer sources`, async () => {
    const api = await load();
    const original = new DataView(new Uint8Array([7, 17, 29, 41, 9]).buffer, 1, 3);
    const restored = api.fromJSON(api.toJSON(original));
    assert.deepEqual(restored, original);
    assert.equal(restored.byteOffset, 1);
    assert.equal(restored.byteLength, 3);
    for (const source of [42, "invalid buffer", { length: 3 }]) {
      const wire = api.toJSON(original);
      const replacement = api.toJSON(source).t;
      replacement.i = wire.t.f.i;
      wire.t.f = replacement;
      assert.throws(() => api.fromJSON(wire));
    }
  });
}

test("router Seroval rejects a forged oversized typed-array node without allocating its claim", () => {
  const wire = seroval.toJSON(new Uint8Array([1]));
  const replacement = seroval.toJSON({ length: 1 }).t;
  replacement.i = wire.t.f.i;
  wire.t.f = replacement;
  wire.t.l = 1_000_001;
  assert.throws(() => seroval.fromJSON(wire));
});

test(
  "router Seroval blocks plugin thenables in fulfilled Promises before invocation",
  { timeout: 1_000 },
  async () => {
    const ordinary = { ok: true };
    assert.deepEqual(
      await seroval.fromJSON(await seroval.toJSONAsync(Promise.resolve(ordinary))),
      ordinary,
    );
    const marker = Object.freeze({ fixture: "plugin value without a then method" });
    let invocations = 0;
    const options = {
      plugins: [
        {
          tag: "workjet-security-thenable-fixture",
          test: (value) => value === marker,
          parse: { sync: () => ({}), async: async () => ({}) },
          serialize: () => "undefined",
          deserialize: () => ({
            then(resolve) {
              invocations++;
              resolve("unexpected assimilation");
            },
          }),
        },
      ],
    };
    const wire = await seroval.toJSONAsync(Promise.resolve(marker), options);
    assert.throws(() => seroval.fromJSON(wire, options));
    await Promise.resolve();
    assert.equal(invocations, 0, "deserialization must not invoke the plugin's then callable");
  },
);

const flatMap = { version: 3, sources: ["input.js"], names: [], mappings: "AAAA" };
const sectionMap = (line, map = flatMap, column = 0) => ({
  version: 3,
  sections: [{ offset: { line, column }, map }],
});

test("Astro source maps reject oversized and cumulative indexed offsets", () => {
  assert.throws(() => new SourceMapConsumer(sectionMap(10_000_001)));
  assert.throws(() => new SourceMapConsumer(sectionMap(6_000_000, sectionMap(6_000_000))));
  for (const offset of [-1, 0.5, Infinity, "1"]) {
    assert.throws(() => new SourceMapConsumer(sectionMap(offset)));
    assert.throws(() => new SourceMapConsumer(sectionMap(0, flatMap, offset)));
  }
  const consumer = new SourceMapConsumer(sectionMap(2));
  assert.deepEqual(consumer.originalPositionFor({ line: 3, column: 0 }), {
    source: "input.js",
    line: 1,
    column: 0,
    name: null,
  });
});

test("Astro indexed source-map section boundaries retain zero-based columns", () => {
  const consumer = new SourceMapConsumer({
    version: 3,
    sections: [
      { offset: { line: 2, column: 4 }, map: flatMap },
      { offset: { line: 2, column: 9 }, map: { ...flatMap, sources: ["second.js"] } },
    ],
  });
  const missing = { source: null, line: null, column: null, name: null };
  const first = { source: "input.js", line: 1, column: 0, name: null };
  const second = { ...first, source: "second.js" };
  assert.deepEqual(consumer.originalPositionFor({ line: 3, column: 3 }), missing);
  assert.deepEqual(consumer.originalPositionFor({ line: 3, column: 4 }), first);
  assert.deepEqual(consumer.originalPositionFor({ line: 3, column: 5 }), first);
  assert.deepEqual(consumer.originalPositionFor({ line: 3, column: 8 }), first);
  assert.deepEqual(consumer.originalPositionFor({ line: 3, column: 9 }), second);
  assert.deepEqual(consumer.originalPositionFor({ line: 3, column: 10 }), second);
});

test("MCP Express proxy trust cannot accept arbitrary IPv4 through a malformed mapped subnet", () => {
  for (const subnet of ["::ffff:10.0.0.0/8", "::/1"]) {
    let trust;
    try {
      trust = proxyaddr.compile(subnet);
    } catch (error) {
      assert.ok(error instanceof Error);
      continue;
    }
    assert.equal(trust("203.0.113.91"), false);
  }
  const trust = proxyaddr.compile("::ffff:10.0.0.0/104");
  assert.equal(trust("10.7.8.9"), true);
  assert.equal(trust("203.0.113.91"), false);
});

class ResponseFixture extends EventEmitter {
  statusCode = 200;
  _header = undefined;
  headers = new Map();
  setHeader(name, value) {
    this.headers.set(name.toLowerCase(), value);
  }
  getHeader(name) {
    return this.headers.get(name.toLowerCase());
  }
  removeHeader(name) {
    this.headers.delete(name.toLowerCase());
  }
  writeHead() {
    this._header = "sent";
  }
  _implicitHeader() {
    this.writeHead(this.statusCode);
  }
  write() {
    return true;
  }
  end() {
    return this;
  }
}

for (const [encoding, factory] of [
  ["gzip", "createGzip"],
  ["deflate", "createDeflate"],
  ["br", "createBrotliCompress"],
]) {
  for (const closeFirst of [false, true]) {
    test(`Expo compression frees ${encoding} streams when close is ${closeFirst ? "before" : "after"} headers`, (t) => {
      const descriptor = Object.getOwnPropertyDescriptor(zlib, factory);
      let stream;
      Object.defineProperty(zlib, factory, {
        configurable: true,
        value: () => {
          stream = new PassThrough();
          return stream;
        },
      });
      t.after(() => {
        stream?.destroy();
        Object.defineProperty(zlib, factory, descriptor);
      });
      const response = new ResponseFixture();
      response.setHeader("Content-Type", "text/plain");
      compression({ threshold: 0 })(
        { method: "GET", headers: { "accept-encoding": encoding } },
        response,
        () => {},
      );
      if (closeFirst) response.emit("close");
      response.write("bounded response fixture");
      if (!closeFirst) response.emit("close");
      assert.ok(stream, "eligible response must create a compression stream");
      assert.equal(stream.destroyed, true);
    });
  }
}
