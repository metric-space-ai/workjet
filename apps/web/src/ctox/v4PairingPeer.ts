// E54.4 pairing peer: joins the invitation's signaling room as an unpaired peer, opens exactly one
// data channel (the V4 control lane, `ctox-v4-control`), sends one plain JSON control request and
// waits for the matching response. No other lane, no hello, no data; the connection is closed as
// soon as the response arrived. The launch context it returns opens a separate E50 connection.
import type {
  V4InviteSignalingTarget,
  V4PairingControlExchange,
  V4PairingControlRequest,
} from "./v4DeviceInvite";

export const V4_PAIRING_CONTROL_CHANNEL = "ctox-v4-control";
export const V4_PAIRING_SIGNALING_ROLE = "pairing";
export const V4_PAIRING_SIGNALING_PROTOCOL = "ctox-v4-pairing";
const MAX_CONTROL_BYTES = 16_384;

type WebSocketLike = {
  readyState: number;
  onopen: ((event: unknown) => void) | null;
  onerror: ((event: unknown) => void) | null;
  onclose: ((event: unknown) => void) | null;
  onmessage: ((event: { data: unknown }) => void) | null;
  send(data: string): void;
  close(): void;
};
type DataChannelLike = {
  readyState: string;
  addEventListener(name: "open" | "close" | "error", listener: () => void): void;
  addEventListener(name: "message", listener: (event: { data: unknown }) => void): void;
  send(data: string): void;
};
type PeerConnectionLike = {
  onicecandidate: ((event: { candidate: unknown }) => void) | null;
  createDataChannel(label: string, options: { ordered: boolean }): DataChannelLike;
  createOffer(): Promise<{ type: string; sdp?: string }>;
  setLocalDescription(description: { type: string; sdp?: string }): Promise<void>;
  setRemoteDescription(description: { type: "answer"; sdp: string }): Promise<void>;
  addIceCandidate(candidate: unknown): Promise<void>;
  close(): void;
};

export interface V4PairingPeerOptions {
  readonly WebSocketImpl?: new (url: string) => WebSocketLike;
  readonly RTCPeerConnectionImpl?: new (config: {
    iceServers: RTCIceServer[];
  }) => PeerConnectionLike;
  readonly timeoutMs?: number;
  readonly peerId?: () => string;
}

class PairingTransportError extends Error {
  constructor(
    message: string,
    /** True once the request left this device: never resend it on another signaling URL. */
    readonly sent: boolean,
  ) {
    super(message);
    this.name = "PairingTransportError";
  }
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);

export function createV4PairingControlExchange(
  options: V4PairingPeerOptions = {},
): V4PairingControlExchange {
  const WebSocketImpl =
    options.WebSocketImpl ??
    (globalThis.WebSocket as unknown as V4PairingPeerOptions["WebSocketImpl"]);
  const RTCPeerConnectionImpl =
    options.RTCPeerConnectionImpl ??
    (globalThis.RTCPeerConnection as unknown as V4PairingPeerOptions["RTCPeerConnectionImpl"]);
  const timeoutMs = options.timeoutMs ?? 20_000;
  const peerId = options.peerId ?? (() => `pairing-${globalThis.crypto.randomUUID()}`);
  return async (target, request) => {
    if (typeof WebSocketImpl !== "function" || typeof RTCPeerConnectionImpl !== "function")
      throw new PairingTransportError("webrtc_unavailable", false);
    const encoded = JSON.stringify(request);
    if (new TextEncoder().encode(encoded).length > MAX_CONTROL_BYTES)
      throw new PairingTransportError("request_too_large", false);
    let last: unknown = new PairingTransportError("no_signaling_url", false);
    for (const url of target.urls) {
      try {
        return await exchangeOnce(url, target, request, encoded, {
          WebSocketImpl,
          RTCPeerConnectionImpl,
          timeoutMs,
          peerId: peerId(),
        });
      } catch (error) {
        last = error;
        // A request that already left may have spent the invitation: never send it twice.
        if (error instanceof PairingTransportError && error.sent) break;
      }
    }
    throw last;
  };
}

function exchangeOnce(
  base: string,
  target: V4InviteSignalingTarget,
  request: V4PairingControlRequest,
  encoded: string,
  context: {
    readonly WebSocketImpl: NonNullable<V4PairingPeerOptions["WebSocketImpl"]>;
    readonly RTCPeerConnectionImpl: NonNullable<V4PairingPeerOptions["RTCPeerConnectionImpl"]>;
    readonly timeoutMs: number;
    readonly peerId: string;
  },
): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const url = new URL(base);
    const params: Record<string, string> = {
      room: target.room,
      peerId: context.peerId,
      client: context.peerId,
      role: V4_PAIRING_SIGNALING_ROLE,
      protocol: V4_PAIRING_SIGNALING_PROTOCOL,
      ...(target.token === undefined ? {} : { token: target.token }),
    };
    for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);
    const ws = new context.WebSocketImpl(url.href);
    const peer = new context.RTCPeerConnectionImpl({ iceServers: [...target.iceServers] });
    // Lane 0 only. No commands/live/initial/transfer channel is ever created on a pairing peer.
    const control = peer.createDataChannel(V4_PAIRING_CONTROL_CHANNEL, { ordered: true });
    const pending: unknown[] = [];
    let offered = false;
    let remote = false;
    let sent = false;
    let settled = false;
    const close = () => {
      try {
        ws.close();
      } catch {}
      try {
        peer.close();
      } catch {}
    };
    const done = (error: Error | null, value?: unknown) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      close();
      if (error) reject(error);
      else resolve(value);
    };
    const failure = (message: string) => new PairingTransportError(message, sent);
    const timer = setTimeout(() => done(failure("pairing_deadline")), context.timeoutMs);
    const signal = (data: unknown) => {
      if (ws.readyState === 1)
        ws.send(
          JSON.stringify({
            type: "signal",
            room: target.room,
            senderPeerId: context.peerId,
            receiverPeerId: target.nativePeerId,
            data,
          }),
        );
    };
    peer.onicecandidate = (event) => {
      const candidate = event.candidate as { toJSON?: () => unknown } | null;
      if (candidate) signal({ type: "candidate", candidate: candidate.toJSON?.() ?? candidate });
    };
    control.addEventListener("open", () => {
      if (settled || sent) return;
      try {
        control.send(encoded);
        sent = true;
      } catch {
        done(failure("control_send_failed"));
      }
    });
    control.addEventListener("message", (event) => {
      if (typeof event.data !== "string" || event.data.length > MAX_CONTROL_BYTES) return;
      let message: unknown;
      try {
        message = JSON.parse(event.data);
      } catch {
        return;
      }
      if (isRecord(message) && message.type === "pairing_response" && message.id === request.id)
        done(null, message);
    });
    control.addEventListener("close", () => done(failure("control_closed")));
    control.addEventListener("error", () => done(failure("control_error")));
    ws.onopen = () => ws.send(JSON.stringify({ type: "join", room: target.room }));
    ws.onerror = () => done(failure("signaling_error"));
    ws.onclose = () => {
      // Signaling may close once the peers are connected; only a failure before that counts.
      if (!sent) done(failure("signaling_closed"));
    };
    ws.onmessage = (event) => {
      void (async () => {
        let message: unknown;
        try {
          message = JSON.parse(
            typeof event.data === "string"
              ? event.data
              : new TextDecoder().decode(event.data as ArrayBuffer),
          );
        } catch {
          return;
        }
        if (!isRecord(message)) return;
        if (message.type === "ctoxError") return done(failure("signaling_rejected"));
        if (message.type === "joined" && !offered) {
          offered = true;
          const offer = await peer.createOffer();
          await peer.setLocalDescription(offer);
          signal({ type: offer.type, sdp: offer.sdp });
          return;
        }
        if (message.type !== "signal") return;
        if (String(message.senderPeerId ?? message.sender ?? "") !== target.nativePeerId) return;
        const data = (message.data ?? message.signal) as Record<string, unknown> | undefined;
        if (data?.type === "answer" && typeof data.sdp === "string") {
          await peer.setRemoteDescription({ type: "answer", sdp: data.sdp });
          remote = true;
          for (const candidate of pending.splice(0)) await peer.addIceCandidate(candidate);
        } else if (data?.type === "candidate" && data.candidate) {
          if (remote) await peer.addIceCandidate(data.candidate);
          else pending.push(data.candidate);
        }
      })().catch(() => done(failure("signaling_failure")));
    };
  });
}
