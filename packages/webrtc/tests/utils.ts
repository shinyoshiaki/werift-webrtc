import { readFileSync } from "fs";
import { setTimeout } from "timers/promises";
import { SCTP_STATE } from "../../sctp/src";
import {
  type ConnectionState,
  type PeerConfig,
  type RTCDataChannel,
  type RTCDtlsTransport,
  type RTCIceTransport,
  RTCPeerConnection,
} from "../src";
import type { RTCTransportStats } from "../src/media/stats";

export function load(name: string) {
  return readFileSync("./tests/data/" + name);
}

/**
 * Create a PeerConnection with one data channel so that its first
 * RTCIceTransport exists, and return both.
 */
export function createPeerConnectionWithIceTransport(
  config: Partial<PeerConfig> = {},
) {
  const pc = new RTCPeerConnection({ iceServers: [], ...config });
  pc.createDataChannel("ice-transport");
  const ice = (pc as any).secureManager.iceTransports[0] as RTCIceTransport;
  return { pc, ice };
}

export async function createDataChannelPair(
  options:
    | Partial<{
        maxPacketLifeTime?: number | undefined;
        protocol: string;
        maxRetransmits?: number | undefined;
        ordered: boolean;
        negotiated: boolean;
        id?: number | undefined;
      }>
    | undefined,
  pc1 = new RTCPeerConnection(),
  pc2 = new RTCPeerConnection(),
) {
  let pair: RTCDataChannel[] = [],
    bothOpen: Promise<void[]>;
  try {
    if (options?.negotiated) {
      pair = [pc1, pc2].map((pc) => pc.createDataChannel("", options));
      bothOpen = Promise.all(
        pair.map(
          (dc) =>
            new Promise<void>((r, e) => {
              dc.onopen = r;
              dc.onerror = ({ error }) => e(error);
            }),
        ),
      );
    } else {
      pair = [pc1.createDataChannel("", options)];
      bothOpen = Promise.all([
        new Promise<void>((r, e) => {
          pair[0].onopen = () => {
            r();
          };
          pair[0].onerror = ({ error }) => e(error);
        }),
        new Promise<void>(
          (r, e) =>
            (pc2.ondatachannel = ({ channel }) => {
              pair[1] = channel;
              channel.onopen = () => {
                r();
              };
              channel.onerror = ({ error }) => e(error);
            }),
        ),
      ]);
    }
    exchangeIceCandidates(pc1, pc2);
    await exchangeOfferAnswer(pc1, pc2);
    await bothOpen;
    return pair;
  } finally {
    for (const dc of pair) {
      dc.onopen = dc.onerror = null;
    }
  }
}

export function exchangeIceCandidates(
  pc1: RTCPeerConnection,
  pc2: RTCPeerConnection,
) {
  // private function
  function doExchange(localPc: RTCPeerConnection, remotePc: RTCPeerConnection) {
    localPc.onIceCandidate.subscribe((candidate) => {
      if (!candidate) {
        return;
      }
      if (remotePc.signalingState !== "closed") {
        remotePc.addIceCandidate(candidate).catch((error) => {
          const message = (error as Error).message;
          if (
            message === "The remote description was null" ||
            message.includes("usernameFragment")
          ) {
            return;
          }
          throw error;
        });
      }
    });
  }

  doExchange(pc1, pc2);
  doExchange(pc2, pc1);
}

export async function exchangeOfferAnswer(
  caller: RTCPeerConnection,
  callee: RTCPeerConnection,
) {
  await exchangeOffer(caller, callee);
  await exchangeAnswer(caller, callee);
}

async function exchangeOffer(
  caller: RTCPeerConnection,
  callee: RTCPeerConnection,
) {
  await caller.setLocalDescription(await caller.createOffer());
  await callee.setRemoteDescription(caller.localDescription!);
}
// Performs an answer exchange caller -> callee.
async function exchangeAnswer(
  caller: RTCPeerConnection,
  callee: RTCPeerConnection,
) {
  // Note that caller's remote description must be set first; if not,
  // there's a chance that candidates from callee arrive at caller before
  // it has a remote description to apply them to.
  const answer = await callee.createAnswer();
  await caller.setRemoteDescription(answer);
  await callee.setLocalDescription(answer);
}

export function awaitMessage(channel: RTCDataChannel) {
  return new Promise<string | Buffer>((resolve, reject) => {
    Promise.all([
      new Promise<any>((r) =>
        channel.addEventListener("message", (e) => {
          r(e.data);
        }),
      ),
      channel.onMessage.asPromise(),
    ]).then(([msg]) => resolve(msg));

    channel.error.once(reject);
  });
}

export async function generateAudioReceiveOnlyOffer(pc: RTCPeerConnection) {
  pc.addTransceiver("audio", { direction: "recvonly" });
  return pc.createOffer();
}

function waitUntilEvent(obj, name) {
  return new Promise((r) => obj.addEventListener(name, r, { once: true }));
}

export function addEventListenerPromise(
  obj,
  type,
  listener?: (...args: any[]) => any,
) {
  if (!listener) {
    return waitUntilEvent(obj, type);
  }
  return new Promise((r) =>
    obj.addEventListener(
      type,
      (e) => {
        r(listener(e));
      },
      { once: true },
    ),
  );
}

export function assert_equals(a, b, msg: string) {
  expect(a).toEqual(b);
}

export function assert_true(a, msg: string) {
  expect(a).toBeTruthy();
}

export async function waitForConnectionState(
  pc: RTCPeerConnection,
  state: ConnectionState,
  timeoutMs = 5_000,
) {
  if (pc.connectionState === state) {
    return;
  }
  await Promise.race([
    pc.connectionStateChange.watch((current) => current === state),
    setTimeout(timeoutMs).then(() => {
      throw new Error(
        `timed out waiting for connectionState ${state}, got ${pc.connectionState}`,
      );
    }),
  ]);
}

/** Arrange: wait until the peer's SCTP association reaches ESTABLISHED. */
export async function waitForSctpEstablished(
  pc: RTCPeerConnection,
  timeoutMs = 10_000,
) {
  const deadline = Date.now() + timeoutMs;
  while (pc.sctpTransport?.sctp.associationState !== SCTP_STATE.ESTABLISHED) {
    if (Date.now() > deadline) {
      throw new Error("timed out waiting for the SCTP association");
    }
    await setTimeout(10);
  }
}

export async function waitForDtlsState(
  transport: RTCDtlsTransport,
  state: RTCDtlsTransport["state"],
  timeoutMs = 5_000,
) {
  if (transport.state === state) {
    return;
  }
  await Promise.race([
    transport.onStateChange.watch((current) => current === state),
    setTimeout(timeoutMs).then(() => {
      throw new Error(
        `timed out waiting for dtls state ${state}, got ${transport.state}`,
      );
    }),
  ]);
}

export async function waitForIceNominated(
  pc: RTCPeerConnection,
  timeoutMs = 10_000,
) {
  const started = Date.now();
  for (;;) {
    const ice = pc.dtlsTransports[0]?.iceTransport;
    const iceUp = ice?.state === "connected" || ice?.state === "completed";
    if (ice?.connection.nominated && iceUp) {
      return;
    }
    if (Date.now() - started > timeoutMs) {
      throw new Error(
        `timed out waiting for ICE nominated pair (state=${ice?.state} nominated=${!!ice?.connection.nominated})`,
      );
    }
    await setTimeout(50);
  }
}

export async function getTransportStats(pc: RTCPeerConnection) {
  const stats = await pc.getStats();
  return [...stats.values()].find(
    (stat): stat is RTCTransportStats => stat.type === "transport",
  );
}

export function mutateSdpFingerprint(sdp: string) {
  return sdp.replace(
    /a=fingerprint:(\S+)\s+([0-9A-Fa-f:]+)/g,
    (_match, algorithm: string, value: string) => {
      const flipped = `${value[0] === "A" || value[0] === "a" ? "B" : "A"}${value.slice(1)}`;
      return `a=fingerprint:${algorithm} ${flipped}`;
    },
  );
}

export function isProtocolVersionFailure(error?: Error) {
  if (!error) {
    return false;
  }
  return (
    error.name === "ProtocolVersionError" ||
    (error as { code?: string }).code === "protocol_version" ||
    /protocol_version/i.test(error.message)
  );
}

/**
 * Measures how long the event loop is blocked: a heartbeat interval records
 * the maximum delay between its expected and actual firing.
 */
export function startEventLoopLagMonitor(intervalMs = 10) {
  let maxLagMs = 0;
  let last = performance.now();
  const timer = setInterval(() => {
    const now = performance.now();
    maxLagMs = Math.max(maxLagMs, now - last - intervalMs);
    last = now;
  }, intervalMs);
  return {
    stop: () => {
      clearInterval(timer);
      return maxLagMs;
    },
  };
}

/** Deterministic binary messages; message i carries its index in the first 4 bytes. */
export function createIndexedMessages(count: number, size: number) {
  return [...Array(count)].map((_, i) => {
    const buf = Buffer.alloc(Math.max(4, size), i % 251);
    buf.writeUInt32BE(i, 0);
    return buf;
  });
}

/** Resolves with the first `count` messages the channel receives. */
export function collectChannelMessages(channel: RTCDataChannel, count: number) {
  return new Promise<(string | Buffer)[]>((resolve) => {
    const received: (string | Buffer)[] = [];
    const { unSubscribe } = channel.onMessage.subscribe((data) => {
      received.push(data);
      if (received.length === count) {
        unSubscribe();
        resolve(received);
      }
    });
  });
}
