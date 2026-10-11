// SPDX-License-Identifier: MIT OR AGPL-3.0-only
// Isolated contract integration: real Workjet issuer, control-plane token SQL,
// gateway policy/session, and published native connector. Never uses userdata.
import * as NodeAssert from "node:assert/strict";
import * as NodeCrypto from "node:crypto";
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeFSP from "node:fs/promises";
import * as NodeHttp from "node:http";
import * as NodeModule from "node:module";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";

const [scratchArg, dependenciesArg, ctoxArg, controlPlaneArg, binaryArg, bundleArg] =
  process.argv.slice(2);
NodeAssert.ok(
  scratchArg && dependenciesArg && ctoxArg && controlPlaneArg && binaryArg,
  "usage: node scripts/check-worker-source-grant-native.mjs SCRATCH DEPS CTOX_SOURCE CONTROL_PLANE_SOURCE NATIVE_BINARY [BUNDLE_ROOT]",
);
const scratch = NodePath.resolve(scratchArg);
NodeAssert.ok(scratch.startsWith("/mnt/sata8t/cache/"), "isolated lane scratch required");
const root = NodePath.join(scratch, "native-root");
const dependencies = NodeModule.createRequire(
  NodePath.join(NodePath.resolve(dependenciesArg), "package.json"),
);
const { build } = dependencies("esbuild");
const { PGlite } = dependencies("@electric-sql/pglite");
const { WebSocketServer } = dependencies("ws");
await NodeFSP.mkdir(scratch, { recursive: true, mode: 0o700 });
NodeAssert.ok(
  (await NodeFSP.readFile(NodePath.join(scratch, "owner.json"), "utf8").catch(() => null)) === null,
  "refuse a reused authority fixture",
);
const tenant = NodeCrypto.randomUUID();
const user = NodeCrypto.randomUUID();
const instance = "worker-grant-" + NodeCrypto.randomUUID();
const actor = "ctox-dev:user:" + user;
await NodeFSP.writeFile(
  NodePath.join(scratch, "owner.json"),
  JSON.stringify({ tenant, user, instance }),
  { mode: 0o600 },
);
const db = new PGlite(NodePath.join(scratch, "control-plane-db"));
globalThis.workerGrantTestDatabase = db;
const cp = NodePath.resolve(controlPlaneArg);
await db.exec(`
  CREATE TABLE users (id uuid PRIMARY KEY);
  CREATE TABLE tenants (id uuid PRIMARY KEY, slug text, domain text, business_name text, target_base_url text);
  CREATE TABLE tenant_members (tenant_id uuid, user_id uuid, role text, access_version integer);
`);
await db.exec(await NodeFSP.readFile(NodePath.join(cp, "migrations/019_managed_mcp.sql"), "utf8"));
await db.exec(`
  ALTER TABLE managed_mcp_client_tokens ADD COLUMN purpose text;
  ALTER TABLE managed_mcp_client_tokens ADD COLUMN subject_user_id uuid;
  ALTER TABLE managed_mcp_client_tokens ADD COLUMN tenant_access_version integer;
`);
await db.query("INSERT INTO users VALUES ($1)", [user]);
await db.query("INSERT INTO tenants VALUES ($1,$2,$2,'Isolated worker grant acceptance',NULL)", [
  tenant,
  instance,
]);
await db.query("INSERT INTO tenant_members VALUES ($1,$2,'owner',1)", [tenant, user]);
const options = {
  bundle: true,
  platform: "node",
  format: "esm",
  logLevel: "silent",
  packages: "bundle",
};
await build({
  ...options,
  entryPoints: [NodePath.join(cp, "lib/managed-mcp.ts")],
  outfile: NodePath.join(scratch, "managed-mcp.mjs"),
  plugins: [
    {
      name: "isolated-postgres-driver",
      setup(builder) {
        builder.onLoad({ filter: /[/\\]lib[/\\]db\.ts$/ }, () => ({
          contents:
            "export async function query(sql,params=[]){return (await globalThis.workerGrantTestDatabase.query(sql,params)).rows;} export async function queryOne(sql,params=[]){return (await query(sql,params))[0]??null;}",
          loader: "ts",
        }));
      },
    },
  ],
});
await build({
  ...options,
  entryPoints: [NodePath.resolve("apps/desktop/src/ctox/CtoxWorkerSourceGrant.ts")],
  outfile: NodePath.join(scratch, "worker-grant.mjs"),
});
const authority = await import(
  NodeURL.pathToFileURL(NodePath.join(scratch, "managed-mcp.mjs")).href
);
const issuer = await import(NodeURL.pathToFileURL(NodePath.join(scratch, "worker-grant.mjs")).href);
const { BusinessOsMcpSession, handleRequest } = await import(
  NodeURL.pathToFileURL(
    NodePath.join(
      NodePath.resolve(ctoxArg),
      "integrations/cloudflare/business-os-mcp-gateway/src/index.js",
    ),
  ).href
);
const policy = {
  allowReads: true,
  allowWrites: true,
  allowApprovals: false,
  allowExternalEffects: false,
  rateLimitPerMinute: 30,
  allowedModules: ["ctox"],
  allowedCollections: ["workjet_luma_configuration"],
  allowedTools: [...issuer.WORKJET_WORKER_SOURCE_TOOLS],
  deniedTools: [],
};
await db.query(
  "INSERT INTO managed_mcp_configs (tenant_id,enabled,policy) VALUES ($1,true,$2::jsonb)",
  [tenant, JSON.stringify(policy)],
);
// Only a newly created native root is bootstrapped, via supported native commands.
const binary = NodePath.resolve(binaryArg);
function native(args) {
  try {
    return NodeChildProcess.execFileSync(binary, [...args, "--root", root], {
      timeout: 30_000,
      encoding: "utf8",
      maxBuffer: 2 * 1024 * 1024,
    });
  } catch {
    throw new Error("Native fixture setup failed: " + args.slice(0, 3).join(" "));
  }
}
// The CLI requires a complete source/binary bundle, with fresh owned state.
NodeAssert.equal(await NodeFSP.lstat(root).catch(() => null), null, "fresh native root required");
await NodeFSP.cp(NodePath.resolve(bundleArg ?? NodePath.dirname(NodePath.dirname(binary))), root, {
  recursive: true,
  force: false,
  errorOnExist: true,
});
native(["business-os", "rxdb", "init"]);
native([
  "business-os",
  "desktop",
  "invite",
  "--user",
  actor,
  "--role",
  "admin",
  "--ttl-hours",
  "1",
  "--output",
  NodePath.join(scratch, "owner-invite.private.json"),
]);
native([
  "business-os",
  "mcp",
  "policy",
  "set",
  "--enabled",
  "true",
  "--allow-reads",
  "true",
  "--allow-writes",
  "true",
  "--allow-actor",
  actor,
  "--allow-workspace",
  "tenant:" + tenant,
]);
const session = new BusinessOsMcpSession({}, { MCP_SESSION_TIMEOUT_MS: "10000" });
const ownerSession = NodeCrypto.randomBytes(32).toString("hex");
let origin;
const server = NodeHttp.createServer(async (incoming, outgoing) => {
  try {
    const chunks = [];
    for await (const chunk of incoming) chunks.push(chunk);
    const request = new Request(origin + incoming.url, {
      method: incoming.method,
      headers: incoming.headers,
      ...(incoming.method === "GET" ? {} : { body: Buffer.concat(chunks) }),
    });
    let response;
    if (new URL(request.url).pathname === "/auth") {
      const raw = (request.headers.get("authorization") || "").replace(/^Bearer /, "");
      const auth = await authority.validateManagedMcpClientToken(
        raw,
        (await request.json()).instanceId,
      );
      response = Response.json(auth ? { ok: true, ...auth } : { ok: false }, {
        status: auth ? 200 : 401,
      });
    } else if (new URL(request.url).pathname === "/api/instances/" + tenant + "/managed-mcp") {
      NodeAssert.equal(request.headers.get("authorization"), "Bearer " + ownerSession);
      const membership = await db.query(
        "SELECT role FROM tenant_members WHERE tenant_id=$1 AND user_id=$2",
        [tenant, user],
      );
      NodeAssert.equal(membership.rows[0].role, "owner");
      const body = await request.json();
      if (body.action === "rotate_token") {
        const token = await authority.issueManagedMcpToken(tenant, user, body);
        response = Response.json({
          ok: true,
          token,
          managedMcp: { mcpUrl: "https://mcp.ctox.dev/mcp/" + instance },
        });
      } else {
        NodeAssert.equal(body.action, "revoke_token");
        NodeAssert.ok(await authority.revokeManagedMcpToken(tenant, user, body.tokenId));
        response = Response.json({ ok: true });
      }
    } else {
      response = await handleRequest(request, {
        MCP_REQUIRE_CLIENT_IDENTITY: "true",
        ALLOWED_INSTANCE_IDS: instance,
        CTOX_MANAGED_MCP_AUTH_URL: origin + "/auth",
        BUSINESS_OS_MCP_SESSIONS: {
          idFromName: (id) => id,
          get: (id) => {
            NodeAssert.equal(id, instance);
            return session;
          },
        },
      });
    }
    outgoing.writeHead(response.status, Object.fromEntries(response.headers));
    outgoing.end(Buffer.from(await response.arrayBuffer()));
  } catch {
    // Never emit a request, bearer, context, or raw exception to the log.
    outgoing.writeHead(500);
    outgoing.end('{"error":"isolated_controller_failed"}');
  }
});
await new Promise((accept) => server.listen(0, "127.0.0.1", accept));
origin = "http://127.0.0.1:" + server.address().port;
const ws = new WebSocketServer({ noServer: true });
let nativeConnected;
const connected = new Promise((accept) => {
  nativeConnected = accept;
});
server.on("upgrade", (request, socket, head) => {
  if (request.url !== "/connect/" + instance) {
    socket.destroy();
    return;
  }
  ws.handleUpgrade(request, socket, head, (peer) => {
    session.bindSocket(peer);
    peer.addEventListener("message", (event) => {
      if (JSON.parse(String(event.data)).type === "ctox_hello") nativeConnected();
    });
  });
});
const connector = NodeChildProcess.spawn(
  binary,
  [
    "business-os",
    "mcp",
    "connect",
    "--url",
    origin.replace("http:", "ws:") + "/connect/" + instance,
    "--once",
    "--root",
    root,
  ],
  { stdio: ["ignore", "pipe", "pipe"] },
);
let grant;
const nativeLog = [];
connector.stdout.on("data", (value) => nativeLog.push(value.toString()));
connector.stderr.on("data", (value) => nativeLog.push(value.toString()));
const fetchAccount = (url, init) => {
  NodeAssert.equal(new URL(url).origin, "https://ctox.dev");
  return fetch(origin + new URL(url).pathname, {
    ...init,
    headers: { ...init.headers, authorization: "Bearer " + ownerSession },
  });
};
const probe = async (token, tool, args = {}) => {
  const response = await fetch(origin + "/mcp/" + instance, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: "Bearer " + token },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: NodeCrypto.randomUUID(),
      method: "tools/call",
      params: { name: tool, arguments: args },
    }),
    signal: AbortSignal.timeout(15_000),
  });
  return { status: response.status, body: await response.json() };
};
const payload = (response) => {
  NodeAssert.equal(response.status, 200);
  NodeAssert.equal(response.body.error, undefined, "native Luma read must succeed");
  NodeAssert.notEqual(response.body.result?.isError, true);
  return JSON.parse(response.body.result.content.find((block) => block.type === "text").text);
};
async function binarySha256(path) {
  const hash = NodeCrypto.createHash("sha256");
  for await (const chunk of NodeFS.createReadStream(path)) hash.update(chunk);
  return hash.digest("hex");
}
let receipt;
try {
  await Promise.race([
    connected,
    new Promise((_, reject) =>
      setTimeout(() => reject(new Error("native connector did not become ready")), 20_000).unref(),
    ),
  ]);
  grant = await issuer.issueWorkjetWorkerSourceGrant(fetchAccount, tenant);
  NodeAssert.equal(grant.instanceId, instance);
  const saved = await db.query("SELECT scopes FROM managed_mcp_client_tokens WHERE id=$1", [
    grant.tokenId,
  ]);
  NodeAssert.deepEqual(
    saved.rows[0].scopes,
    policy,
    "the token itself must retain the exact narrow scope",
  );
  const auth = await authority.validateManagedMcpClientToken(grant.token, instance);
  NodeAssert.deepEqual(auth.policy, policy);
  const before = session.stats.accepted_requests;
  const denied = await probe(grant.token, "business_os.status");
  NodeAssert.equal(denied.status, 403);
  NodeAssert.equal(denied.body.error.code, -32004);
  NodeAssert.equal(denied.body.error.data.code, "permission_denied");
  NodeAssert.equal(denied.body.error.data.field, "allowedTools");
  NodeAssert.equal(
    session.stats.accepted_requests,
    before,
    "denied status must never reach native",
  );
  const readResponse = await probe(grant.token, "business_os.luma_configuration_read");
  const read = readResponse.body.error ? null : payload(readResponse);
  if (read) NodeAssert.equal(read.revision, 0);
  await issuer.revokeWorkjetWorkerSourceGrant(fetchAccount, grant);
  const revoked = await probe(grant.token, "business_os.luma_configuration_read");
  NodeAssert.equal(revoked.status, 401);
  receipt = {
    pass: read !== null,
    timestamp: new Date().toISOString(),
    fixture: { tenant, instance, actor },
    tokenId: grant.tokenId,
    policy,
    luma: read
      ? { status: readResponse.status, revision: read.revision }
      : {
          status: readResponse.status,
          jsonRpcCode: readResponse.body.error.code,
          reason:
            readResponse.body.error.message === "invalid Luma configuration read request"
              ? "invalid-luma-read-request"
              : "native-error",
        },
    negativeStatus: {
      status: denied.status,
      jsonRpcCode: denied.body.error.code,
      reason: denied.body.error.data,
      reachedNative: false,
    },
    revocation: { status: revoked.status },
    native: {
      sha256: await binarySha256(binary),
      session: session.sessionInfo,
      connectorPid: connector.pid,
    },
    boundary:
      "Isolated control-plane SQL driver and Owner session fixture; real issuer, token issuance/introspection, gateway policy/session and native WebSocket connector. No production enrollment or installed UI acceptance.",
  };
} finally {
  if (
    grant &&
    !(
      await db.query("SELECT revoked_at FROM managed_mcp_client_tokens WHERE id=$1", [
        grant.tokenId,
      ])
    ).rows[0].revoked_at
  )
    await issuer.revokeWorkjetWorkerSourceGrant(fetchAccount, grant);
  const exited = new Promise((accept) => connector.once("exit", accept));
  connector.kill("SIGTERM");
  await Promise.race([exited, new Promise((accept) => setTimeout(accept, 5000).unref())]);
  NodeAssert.ok(
    connector.exitCode !== null || connector.signalCode !== null,
    "owned native connector must stop",
  );
  for (const peer of ws.clients) peer.terminate();
  await new Promise((accept) => ws.close(accept));
  await new Promise((accept) => server.close(accept));
  await db.close();
  await NodeFSP.rm(root, { recursive: true, force: true });
  await NodeFSP.rm(NodePath.join(scratch, "owner-invite.private.json"), { force: true });
  await NodeFSP.rm(NodePath.join(scratch, "control-plane-db"), { recursive: true, force: true });
}
receipt.cleanup = { nativeRootRemoved: true, grantRevoked: true, processesStopped: true };
await NodeFSP.writeFile(
  NodePath.join(scratch, "receipt.json"),
  JSON.stringify(receipt, null, 2) + "\n",
);
console.log("WORKER_SOURCE_NATIVE_GRANT_PROBE=" + JSON.stringify(receipt));
process.exitCode = receipt.pass ? 0 : 1;
