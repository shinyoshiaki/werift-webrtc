import {
  type EncodedAudioFrameMessage,
  forwardEncodedFrames,
} from "./encodedFrames";
import {
  SendGate,
  type SendGateMessage,
  type SendGateOptions,
} from "./sendGate";

const signalingUrl = `ws://${location.hostname || "localhost"}:8888`;

/** RTCRtpScriptTransform when available, else legacy createEncodedStreams() */
export const transformApi =
  "RTCRtpScriptTransform" in window
    ? "RTCRtpScriptTransform"
    : "createEncodedStreams";

export type Session = {
  pc: RTCPeerConnection;
  ws: WebSocket;
  send: (message: object) => void;
  /** Resolves with the next message of `type` */
  next: <T = any>(type: string) => Promise<T>;
  onMessage: (type: string, handler: (message: any) => void) => void;
  close: () => void;
};

export async function connect(
  join: object,
  options: {
    setup?: (pc: RTCPeerConnection) => Promise<void> | void;
    mungeAnswer?: (sdp: string) => string;
  } = {},
): Promise<Session> {
  const ws = new WebSocket(signalingUrl);
  await new Promise((resolve, reject) => {
    ws.onopen = resolve;
    ws.onerror = reject;
  });
  const handlers = new Map<string, ((message: any) => void)[]>();
  ws.onmessage = ({ data }) => {
    const message = JSON.parse(data);
    for (const handler of handlers.get(message.type) ?? []) handler(message);
  };
  const onMessage = (type: string, handler: (message: any) => void) =>
    handlers.set(type, [...(handlers.get(type) ?? []), handler]);
  const next = <T>(type: string) =>
    new Promise<T>((resolve) => {
      const once = (message: T) => {
        handlers.set(
          type,
          (handlers.get(type) ?? []).filter((h) => h !== once),
        );
        resolve(message);
      };
      onMessage(type, once);
    });
  const send = (message: object) => {
    if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(message));
  };

  const offerPromise = next<{ sdp: RTCSessionDescriptionInit }>("offer");
  send(join);
  const { sdp: offer } = await offerPromise;

  const pc = new RTCPeerConnection(
    transformApi === "createEncodedStreams"
      ? ({ encodedInsertableStreams: true } as RTCConfiguration)
      : {},
  );
  await options.setup?.(pc);
  await pc.setRemoteDescription(offer);
  const answer = await pc.createAnswer();
  if (options.mungeAnswer && answer.sdp) {
    answer.sdp = options.mungeAnswer(answer.sdp);
  }
  await pc.setLocalDescription(answer);
  await waitIceGathering(pc);
  send({ type: "answer", sdp: pc.localDescription });
  await waitConnected(pc);

  return {
    pc,
    ws,
    send,
    next,
    onMessage,
    close: () => {
      pc.close();
      ws.close();
    },
  };
}

function waitIceGathering(pc: RTCPeerConnection) {
  if (pc.iceGatheringState === "complete") return Promise.resolve();
  return new Promise<void>((resolve) => {
    pc.addEventListener("icegatheringstatechange", () => {
      if (pc.iceGatheringState === "complete") resolve();
    });
  });
}

function waitConnected(pc: RTCPeerConnection) {
  return new Promise<void>((resolve, reject) => {
    const check = () => {
      if (pc.connectionState === "connected") resolve();
      if (pc.connectionState === "failed") reject(new Error("pc failed"));
    };
    pc.addEventListener("connectionstatechange", check);
    check();
  });
}

/**
 * Article claim #2: Chrome leaves audio NACK out of its SDP. Adding
 * `a=rtcp-fb:<opus> nack` (SDP munging) lets it answer NACKs for audio.
 */
export function enableOpusNack(sdp: string) {
  const rtpmap = sdp.match(/a=rtpmap:(\d+) opus\/48000[^\r\n]*\r\n/i);
  if (!rtpmap) return sdp;
  const fb = `a=rtcp-fb:${rtpmap[1]} nack\r\n`;
  if (sdp.includes(fb)) return sdp;
  return sdp.replace(rtpmap[0], rtpmap[0] + fb);
}

/** Take encoded frames out of the receiver before NetEQ. */
export function tapReceiver(
  receiver: RTCRtpReceiver,
  onFrame: (frame: EncodedAudioFrameMessage) => void,
) {
  if (transformApi === "RTCRtpScriptTransform") {
    const worker = new Worker(
      new URL("./transform-worker.ts", import.meta.url),
      {
        type: "module",
      },
    );
    worker.onmessage = ({ data }) => onFrame(data);
    (receiver as any).transform = new (window as any).RTCRtpScriptTransform(
      worker,
      {},
    );
    return () => worker.terminate();
  }
  const { readable, writable } = (receiver as any).createEncodedStreams();
  void forwardEncodedFrames(readable, writable, onFrame);
  return () => {};
}

/**
 * Put a SendGate on the sender: `onStart` gets the first RTP timestamp as soon
 * as it is sent, and `close()` stops sending and resolves with the send range.
 */
export function gateSender(
  sender: RTCRtpSender,
  options: SendGateOptions & {
    onStart: (firstRtpTimestamp: number) => void;
  },
) {
  let resolveRange: (range: SendGateMessage & { type: "range" }) => void;
  const range = new Promise<SendGateMessage & { type: "range" }>((r) => {
    resolveRange = r;
  });
  const onMessage = (message: SendGateMessage) => {
    if (message.type === "start") options.onStart(message.firstRtpTimestamp);
    else resolveRange(message);
  };
  const gateOptions: SendGateOptions = { holdFrames: options.holdFrames };
  if (transformApi === "RTCRtpScriptTransform") {
    const worker = new Worker(
      new URL("./transform-worker.ts", import.meta.url),
      { type: "module" },
    );
    worker.onmessage = ({ data }) => onMessage(data);
    (sender as any).transform = new (window as any).RTCRtpScriptTransform(
      worker,
      { side: "sender", ...gateOptions },
    );
    return {
      close: (releaseHeldAfterMs = 0) => {
        worker.postMessage({ type: "close", releaseHeldAfterMs });
        return range;
      },
    };
  }
  const gate = new SendGate(onMessage, gateOptions);
  const { readable, writable } = (sender as any).createEncodedStreams();
  void gate.pipe(readable, writable);
  return {
    close: (releaseHeldAfterMs = 0) => {
      gate.close(releaseHeldAfterMs);
      return range;
    },
  };
}
