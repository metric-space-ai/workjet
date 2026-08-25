import type { BusinessOsLaunchSecrets, BusinessOsInstance } from "../registry/business-os-registry";

function scriptSafeJson(value: unknown): string {
  return JSON.stringify(value)
    .replaceAll("<", "\\u003c")
    .replaceAll(">", "\\u003e")
    .replaceAll("&", "\\u0026")
    .replaceAll("\u2028", "\\u2028")
    .replaceAll("\u2029", "\\u2029");
}

export function buildBusinessOsLaunchContext(
  instance: BusinessOsInstance,
  secrets: BusinessOsLaunchSecrets,
  platform: "ios" | "android",
) {
  if (instance.capabilityExpiresAtMs <= Date.now()) {
    throw new Error("Business OS capability has expired. Pair this backend again.");
  }
  const session = {
    authenticated: true,
    source: "workjet_mobile",
    capability_token: secrets.capabilityToken,
    capability_expires_at_ms: instance.capabilityExpiresAtMs,
    user: {
      id: instance.user.id,
      display_name: instance.user.displayName,
      role: instance.user.role,
      is_admin: instance.user.isAdmin,
    },
  } as const;
  const config = {
    instance_id: instance.instanceId,
    peer_id: `${platform}:${instance.id}`,
    peer_role: "business_os_client",
    native_peer_id: instance.nativePeerId,
    sync_room: instance.syncRoom,
    signaling_urls: instance.signalingUrls,
    signaling_room_password: secrets.roomPassword,
    transport: "webrtc",
    data_plane: "rxdb-webrtc",
    http_bridge_available: false,
    app_hosting: `${platform}_workjet_shell_pack`,
    ctox_instance_required: true,
    session,
  } as const;
  return Object.freeze({
    sessionJson: scriptSafeJson(session),
    configJson: scriptSafeJson(config),
  });
}

export function injectBusinessOsLaunchContext(
  html: string,
  context: ReturnType<typeof buildBusinessOsLaunchContext>,
): string {
  const head = /<head(?:\s[^>]*)?>/iu.exec(html);
  if (!head?.index && head?.index !== 0)
    throw new Error("Business OS shell index has no head element.");
  const insertion = head.index + head[0].length;
  const clipboardLock =
    "try{Object.defineProperty(navigator,'clipboard',{value:{read:()=>Promise.reject(new DOMException('Denied','NotAllowedError')),readText:()=>Promise.reject(new DOMException('Denied','NotAllowedError')),write:()=>Promise.reject(new DOMException('Denied','NotAllowedError')),writeText:()=>Promise.reject(new DOMException('Denied','NotAllowedError'))},configurable:false})}catch(_){}";
  const script = `<script data-workjet-mobile-bootstrap>window.CTOX_BUSINESS_OS_SESSION=${context.sessionJson};window.CTOX_BUSINESS_OS_CONFIG=${context.configJson};window.CTOX_BUSINESS_OS_DESIGN_TEMPLATES=[];${clipboardLock}</script>`;
  return `${html.slice(0, insertion)}${script}${html.slice(insertion)}`;
}
