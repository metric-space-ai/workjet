// SPDX-License-Identifier: MIT OR AGPL-3.0-only
// @effect-diagnostics globalFetch:off globalDate:off - self-contained OAuth window helper invoked via Effect.promise from the IPC method; no Effect services needed.
/**
 * In-app "Hinzufügen" for CTOX Toolhub connectors (Cursor/Claude-style).
 *
 * Opens the provider's own hosted consent page in an in-app window, using the
 * MCP authorization flow: RFC 9728/8414 discovery, RFC 7591 dynamic client
 * registration (public client, no secret), PKCE S256 and RFC 8707 resource.
 * The redirect to the CTOX loopback callback is intercepted inside the window;
 * the authorization result (code + verifier) is handed to the CTOX instance,
 * which performs the token exchange and keeps tokens in its secret store.
 * The renderer never sees codes or tokens.
 */
import { createHash, randomBytes } from "node:crypto";
import { BrowserWindow } from "electron";

export const TOOLHUB_REDIRECT_URI = "http://127.0.0.1:8765/toolhub/oauth/callback";

export type ToolhubConnectResult =
  | { readonly _tag: "authorized"; readonly server: string }
  | { readonly _tag: "cancelled"; readonly server: string }
  | { readonly _tag: "failed"; readonly server: string; readonly message: string };

interface PendingAuthorization {
  readonly server: string;
  readonly code: string;
  readonly verifier: string;
  readonly clientId: string;
  readonly tokenEndpoint: string;
  readonly resource: string;
  readonly createdAt: number;
}

/** Results waiting for handover to the CTOX instance (in memory only). */
const pendingHandover = new Map<string, PendingAuthorization>();
export const takePendingHandover = (server: string): PendingAuthorization | undefined => {
  const value = pendingHandover.get(server);
  pendingHandover.delete(server);
  return value;
};

const b64url = (buf: Buffer) => buf.toString("base64url");

async function getJson(url: string): Promise<Record<string, unknown> | null> {
  try {
    const response = await fetch(url, { headers: { accept: "application/json" } });
    if (!response.ok) return null;
    return (await response.json()) as Record<string, unknown>;
  } catch {
    return null;
  }
}

async function discover(serverUrl: string) {
  const u = new URL(serverUrl);
  const path = u.pathname.replace(/\/+$/, "");
  let resource = serverUrl;
  let authBase = u.origin;
  let scopes: string[] = [];
  for (const candidate of [
    ...(path ? [`${u.origin}/.well-known/oauth-protected-resource${path}`] : []),
    `${u.origin}/.well-known/oauth-protected-resource`,
  ]) {
    const prm = await getJson(candidate);
    if (prm === null) continue;
    if (typeof prm.resource === "string") resource = prm.resource;
    const servers = prm.authorization_servers;
    if (Array.isArray(servers) && typeof servers[0] === "string") authBase = servers[0];
    if (Array.isArray(prm.scopes_supported)) scopes = prm.scopes_supported.map(String);
    break;
  }
  const a = new URL(authBase);
  const aPath = a.pathname.replace(/\/+$/, "");
  for (const candidate of [
    `${a.origin}/.well-known/oauth-authorization-server${aPath}`,
    `${a.origin}/.well-known/openid-configuration${aPath}`,
  ]) {
    const meta = await getJson(candidate);
    if (meta && typeof meta.authorization_endpoint === "string") {
      return { resource, scopes, meta };
    }
  }
  throw new Error("Keine OAuth-Metadaten gefunden / no OAuth metadata found");
}

export async function toolhubConnect(input: {
  readonly server: string;
  readonly serverUrl: string;
  readonly scopes?: ReadonlyArray<string> | undefined;
}): Promise<ToolhubConnectResult> {
  const { server } = input;
  try {
    const { resource, scopes: announced, meta } = await discover(input.serverUrl);
    const registration = meta.registration_endpoint;
    if (typeof registration !== "string") {
      return {
        _tag: "failed",
        server,
        message:
          "Der Anbieter bietet keine automatische Client-Registrierung an. / Provider offers no dynamic client registration.",
      };
    }
    const reg = await fetch(registration, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        client_name: "CTOX Toolhub",
        redirect_uris: [TOOLHUB_REDIRECT_URI],
        grant_types: ["authorization_code", "refresh_token"],
        response_types: ["code"],
        token_endpoint_auth_method: "none",
      }),
    });
    const client = (await reg.json()) as { client_id?: string };
    if (!client.client_id) {
      return { _tag: "failed", server, message: `DCR HTTP ${reg.status}` };
    }
    const verifier = b64url(randomBytes(48));
    const challenge = b64url(createHash("sha256").update(verifier).digest());
    const state = b64url(randomBytes(24));
    const authorize = new URL(String(meta.authorization_endpoint));
    authorize.searchParams.set("response_type", "code");
    authorize.searchParams.set("client_id", client.client_id);
    authorize.searchParams.set("redirect_uri", TOOLHUB_REDIRECT_URI);
    authorize.searchParams.set("state", state);
    authorize.searchParams.set("code_challenge", challenge);
    authorize.searchParams.set("code_challenge_method", "S256");
    authorize.searchParams.set("resource", resource);
    const scopes = input.scopes && input.scopes.length > 0 ? input.scopes : announced;
    if (scopes.length > 0) authorize.searchParams.set("scope", scopes.join(" "));

    const callback = await openAuthorizeWindow(authorize.toString());
    if (callback === null) return { _tag: "cancelled", server };
    const cb = new URL(callback);
    if (cb.searchParams.get("state") !== state) {
      return { _tag: "failed", server, message: "state mismatch" };
    }
    const error = cb.searchParams.get("error");
    if (error !== null) return { _tag: "failed", server, message: error };
    const code = cb.searchParams.get("code");
    if (code === null) return { _tag: "failed", server, message: "no code" };
    pendingHandover.set(server, {
      server,
      code,
      verifier,
      clientId: client.client_id,
      tokenEndpoint: String(meta.token_endpoint),
      resource,
      createdAt: Date.now(),
    });
    return { _tag: "authorized", server };
  } catch (cause) {
    return {
      _tag: "failed",
      server,
      message: cause instanceof Error ? cause.message : String(cause),
    };
  }
}

function openAuthorizeWindow(url: string): Promise<string | null> {
  return new Promise((resolve) => {
    const parent = BrowserWindow.getFocusedWindow() ?? undefined;
    const win = new BrowserWindow({
      width: 560,
      height: 760,
      ...(parent ? { parent, modal: true } : {}),
      title: "Schnittstelle verbinden",
      autoHideMenuBar: true,
      webPreferences: {
        partition: "persist:workjet-toolhub-auth",
        sandbox: true,
        contextIsolation: true,
        nodeIntegration: false,
      },
    });
    let done = false;
    const finish = (value: string | null) => {
      if (done) return;
      done = true;
      resolve(value);
      if (!win.isDestroyed()) win.close();
    };
    const intercept = (event: { preventDefault: () => void }, target: string) => {
      if (target.startsWith(TOOLHUB_REDIRECT_URI)) {
        event.preventDefault();
        finish(target);
      }
    };
    win.webContents.on("will-redirect", (e, target) => intercept(e, target));
    win.webContents.on("will-navigate", (e, target) => intercept(e, target));
    win.webContents.setWindowOpenHandler(({ url: popup }) => {
      void win.loadURL(popup);
      return { action: "deny" };
    });
    win.on("closed", () => finish(null));
    void win.loadURL(url).catch(() => undefined);
  });
}
