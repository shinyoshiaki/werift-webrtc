/// <reference types="vite/client" />

import Bowser from "bowser";
import { Peer, WebSocketTransport } from "protoo-client";

const browser = Bowser.getParser(window.navigator.userAgent);
export const browserName = browser.getBrowserName();
const e2ePort = import.meta.env.VITE_E2E_PORT ?? "8886";
const e2eBaseUrl = `http://127.0.0.1:${e2ePort}`;

console.log({ browserName, version: browser.getBrowserVersion() });

const transport = new WebSocketTransport(`ws://localhost:${e2ePort}`);
export const peer = new Peer(transport);

/**
 * Wait until the video frame pixels change (decoded motion / content).
 * Throws if no change within timeoutMs so E2E does not hang forever.
 */
export async function waitVideoPlay(
  track: MediaStreamTrack,
  timeoutMs = 30_000,
) {
  const video = document.createElement("video");
  const media = new MediaStream([track]);
  video.srcObject = media;
  video.autoplay = true;
  video.muted = true;
  video.load();
  video.width = 100;
  video.height = 100;
  const canvas = document.createElement("canvas");
  document.body.appendChild(canvas);
  const context = canvas.getContext("2d")!;
  canvas.width = video.width;
  canvas.height = video.height;
  context.drawImage(video, 0, 0, canvas.width, canvas.height);
  const snapshot = await digestMessage(
    context.getImageData(0, 0, canvas.width, canvas.height).data,
  );

  const started = performance.now();
  for (;;) {
    if (performance.now() - started > timeoutMs) {
      video.pause();
      video.srcObject = null;
      canvas.remove();
      throw new Error(`waitVideoPlay timed out after ${timeoutMs}ms`);
    }
    await new Promise((r) => setTimeout(r, 100));
    context.drawImage(video, 0, 0, canvas.width, canvas.height);
    const data = await digestMessage(
      context.getImageData(0, 0, canvas.width, canvas.height).data,
    );

    if (snapshot !== data) break;
  }

  video.pause();
  video.srcObject = null;
  canvas.remove();
}

/**
 * Wait until AnalyserNode sees non-trivial audio energy (or timeout).
 * Used for Opus Packetizer E2E (scenario B).
 */
export async function waitAudioPlay(
  track: MediaStreamTrack,
  timeoutMs = 15_000,
) {
  // Remote WebRTC audio needs an element sink in some Chromium builds
  const audio = document.createElement("audio");
  audio.autoplay = true;
  audio.srcObject = new MediaStream([track]);
  document.body.appendChild(audio);
  try {
    await audio.play();
  } catch {
    // autoplay policies may reject; Analyser may still work via MediaStream
  }

  const ctx = new AudioContext();
  try {
    await ctx.resume();
  } catch {}
  const source = ctx.createMediaStreamSource(new MediaStream([track]));
  const analyser = ctx.createAnalyser();
  analyser.fftSize = 512;
  source.connect(analyser);
  const data = new Uint8Array(analyser.frequencyBinCount);
  const timeData = new Uint8Array(analyser.fftSize);
  const started = performance.now();

  try {
    for (;;) {
      if (performance.now() - started > timeoutMs) {
        throw new Error("waitAudioPlay timed out");
      }
      analyser.getByteFrequencyData(data);
      analyser.getByteTimeDomainData(timeData);
      let sum = 0;
      let peak = 0;
      for (let i = 0; i < data.length; i++) sum += data[i];
      for (let i = 0; i < timeData.length; i++) {
        const d = Math.abs(timeData[i] - 128);
        if (d > peak) peak = d;
      }
      if (sum / data.length > 2 || peak > 2) {
        break;
      }
      await sleep(50);
    }
  } finally {
    source.disconnect();
    await ctx.close();
    audio.pause();
    audio.srcObject = null;
    audio.remove();
  }
}

/**
 * Prefer a single codec via setCodecPreferences when the browser supports it.
 * For H.264, prefer packetization-mode=1 entries first (mode=0 is out of scope).
 */
export function preferCodec(
  transceiver: RTCRtpTransceiver,
  mimeIncludes: string,
  kind?: "audio" | "video",
) {
  const resolvedKind =
    kind ??
    transceiver.receiver?.track?.kind ??
    transceiver.sender?.track?.kind;
  if (resolvedKind !== "audio" && resolvedKind !== "video") {
    return;
  }
  const caps = RTCRtpSender.getCapabilities(resolvedKind);
  if (!caps?.codecs?.length) {
    return;
  }
  const lower = mimeIncludes.toLowerCase();
  let preferred = caps.codecs.filter((c) =>
    c.mimeType.toLowerCase().includes(lower),
  );
  if (preferred.length === 0) {
    return;
  }
  if (lower.includes("h264")) {
    const mode1 = preferred.filter((c) =>
      (c.sdpFmtpLine ?? "").includes("packetization-mode=1"),
    );
    if (mode1.length > 0) {
      preferred = mode1;
    }
  }
  const rest = caps.codecs.filter(
    (c) => !c.mimeType.toLowerCase().includes(lower),
  );
  try {
    (transceiver as any).setCodecPreferences([...preferred, ...rest]);
  } catch {
    // ignore if browser rejects
  }
}

/** Inbound RTP stats: packets/bytes received (Chrome getStats). */
export async function getInboundRtpTotals(pc: RTCPeerConnection) {
  const report = await pc.getStats();
  let packetsReceived = 0;
  let bytesReceived = 0;
  report.forEach((stat) => {
    if (stat.type === "inbound-rtp") {
      const s = stat as RTCInboundRtpStreamStats & {
        packetsReceived?: number;
        bytesReceived?: number;
      };
      packetsReceived += s.packetsReceived ?? 0;
      bytesReceived += s.bytesReceived ?? 0;
    }
  });
  return { packetsReceived, bytesReceived };
}

export async function waitInboundRtp(
  pc: RTCPeerConnection,
  minPackets = 5,
  timeoutMs = 30_000,
) {
  const started = performance.now();
  for (;;) {
    const totals = await getInboundRtpTotals(pc);
    if (totals.packetsReceived >= minPackets) {
      return totals;
    }
    if (performance.now() - started > timeoutMs) {
      throw new Error(
        `waitInboundRtp timed out: packets=${totals.packetsReceived}`,
      );
    }
    await sleep(100);
  }
}

/** Inbound video decode stats summed over inbound-rtp video streams (Chrome getStats). */
export type InboundVideoDecodeStats = {
  packetsReceived: number;
  packetsLost: number;
  framesReceived: number;
  framesDecoded: number;
  keyFramesDecoded: number;
  framesDropped: number;
  frameWidth?: number;
  frameHeight?: number;
  pliCount: number;
  firCount: number;
  nackCount: number;
  decoderImplementation?: string;
};

export async function getInboundVideoDecodeStats(
  pc: RTCPeerConnection,
): Promise<InboundVideoDecodeStats> {
  const report = await pc.getStats();
  const totals: InboundVideoDecodeStats = {
    packetsReceived: 0,
    packetsLost: 0,
    framesReceived: 0,
    framesDecoded: 0,
    keyFramesDecoded: 0,
    framesDropped: 0,
    pliCount: 0,
    firCount: 0,
    nackCount: 0,
  };
  report.forEach((stat) => {
    if (stat.type !== "inbound-rtp" || stat.kind !== "video") return;
    totals.packetsReceived += stat.packetsReceived ?? 0;
    totals.packetsLost += stat.packetsLost ?? 0;
    totals.framesReceived += stat.framesReceived ?? 0;
    totals.framesDecoded += stat.framesDecoded ?? 0;
    totals.keyFramesDecoded += stat.keyFramesDecoded ?? 0;
    totals.framesDropped += stat.framesDropped ?? 0;
    totals.pliCount += stat.pliCount ?? 0;
    totals.firCount += stat.firCount ?? 0;
    totals.nackCount += stat.nackCount ?? 0;
    totals.frameWidth ??= stat.frameWidth;
    totals.frameHeight ??= stat.frameHeight;
    totals.decoderImplementation ??= stat.decoderImplementation;
  });
  return totals;
}

/** Wait until Chrome has decoded at least `minFrames` video frames. */
export async function waitFramesDecoded(
  pc: RTCPeerConnection,
  minFrames: number,
  timeoutMs = 30_000,
) {
  const started = performance.now();
  for (;;) {
    const stats = await getInboundVideoDecodeStats(pc);
    if (stats.framesDecoded >= minFrames) {
      return stats;
    }
    if (performance.now() - started > timeoutMs) {
      throw new Error(`waitFramesDecoded timed out: ${JSON.stringify(stats)}`);
    }
    await sleep(200);
  }
}

/**
 * Attach a muted <video> to `track` and wait until playback advances
 * (`currentTime` moves and intrinsic size is known).
 */
export async function waitVideoElementPlayback(
  track: MediaStreamTrack,
  timeoutMs = 30_000,
) {
  const video = document.createElement("video");
  video.muted = true;
  video.autoplay = true;
  video.srcObject = new MediaStream([track]);
  document.body.appendChild(video);
  try {
    await video.play().catch(() => {});
    const started = performance.now();
    let firstTime: number | undefined;
    for (;;) {
      if (video.videoWidth > 0 && video.currentTime > 0) {
        firstTime ??= video.currentTime;
        if (video.currentTime - firstTime >= 1) {
          return {
            videoWidth: video.videoWidth,
            videoHeight: video.videoHeight,
            currentTime: video.currentTime,
          };
        }
      }
      if (performance.now() - started > timeoutMs) {
        throw new Error(
          `waitVideoElementPlayback timed out: size=${video.videoWidth}x${video.videoHeight} currentTime=${video.currentTime}`,
        );
      }
      await sleep(100);
    }
  } finally {
    video.pause();
    video.srcObject = null;
    video.remove();
  }
}

/**
 * Arrange: Node offers a sendonly media section on `label`; Chrome answers
 * (preferring `mimeIncludes`) and resolves with the received track.
 */
export async function connectToServerOffer(
  label: string,
  mimeIncludes: string,
  kind: "audio" | "video",
) {
  await ensurePeerConnected();
  const pc = new RTCPeerConnection({
    iceServers: [{ urls: "stun:stun.l.google.com:19302" }],
  });
  pc.onicecandidate = ({ candidate }) => {
    peer
      .request(label, { type: "candidate", payload: candidate })
      .catch(() => {});
  };
  const received = new Promise<MediaStreamTrack>((resolve) => {
    pc.ontrack = (ev) => resolve(ev.track);
  });

  const offer = await peer.request(label, { type: "init" });
  await pc.setRemoteDescription(offer);
  for (const transceiver of pc.getTransceivers()) {
    preferCodec(transceiver, mimeIncludes, kind);
  }
  await pc.setLocalDescription(await pc.createAnswer());
  await peer.request(label, { type: "answer", payload: pc.localDescription });

  return { pc, track: await received };
}

/** Ask the server handler to release its resources; never throws. */
export async function requestServerDone(label: string) {
  try {
    await peer.request(label, { type: "done" });
  } catch (error) {
    console.warn(`server done cleanup failed for ${label}`, error);
  }
}

async function digestMessage(data: Uint8ClampedArray) {
  const buffer = new ArrayBuffer(data.byteLength);
  new Uint8Array(buffer).set(data);
  const hashBuffer = await crypto.subtle.digest("SHA-1", buffer); // hash the message
  const hashArray = Array.from(new Uint8Array(hashBuffer)); // convert buffer to byte array
  const hashHex = hashArray
    .map((b) => b.toString(16).padStart(2, "0"))
    .join(""); // convert bytes to hex string
  return hashHex;
}

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export type TurnRelayConfig = {
  turn: {
    udpUrl: string;
    tcpUrl: string;
    tlsUrl: string;
    username: string;
    credential: string;
  };
};

export type SelectedRelayCandidatePair = {
  localCandidateType?: string;
  remoteCandidateType?: string;
  localCandidateProtocol?: string;
  remoteCandidateProtocol?: string;
  localCandidateTcpType?: string;
  remoteCandidateTcpType?: string;
  localRelayProtocol?: string;
  remoteRelayProtocol?: string;
};

export type PeerConnectionDiagnostics = {
  connectionState: RTCPeerConnectionState;
  iceConnectionState: RTCIceConnectionState;
  iceGatheringState: RTCIceGatheringState;
  signalingState: RTCSignalingState;
  localCandidateLines: string[];
  remoteCandidateLines: string[];
  selectedCandidatePair?: SelectedRelayCandidatePair;
};

export async function ensurePeerConnected() {
  if (!peer.connected) {
    await new Promise<void>((resolve) => peer.on("open", resolve));
  }
}

export async function getTurnRelayConfig(): Promise<TurnRelayConfig> {
  const response = await fetch(`${e2eBaseUrl}/turn-config`);
  if (!response.ok) {
    throw new Error(`failed to fetch turn relay config: ${response.status}`);
  }
  return response.json() as Promise<TurnRelayConfig>;
}

export function waitForIceGatheringComplete(connection: RTCPeerConnection) {
  if (connection.iceGatheringState === "complete") {
    return Promise.resolve();
  }

  return new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      connection.removeEventListener(
        "icegatheringstatechange",
        handleIceGatheringStateChange,
      );
      reject(new Error("ICE gathering did not complete in time"));
    }, 20_000);

    const handleIceGatheringStateChange = () => {
      if (connection.iceGatheringState !== "complete") {
        return;
      }
      clearTimeout(timer);
      connection.removeEventListener(
        "icegatheringstatechange",
        handleIceGatheringStateChange,
      );
      resolve();
    };

    connection.addEventListener(
      "icegatheringstatechange",
      handleIceGatheringStateChange,
    );
  });
}

export function waitForPeerConnection(connection: RTCPeerConnection) {
  if (connection.connectionState === "connected") {
    return Promise.resolve();
  }

  return new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      connection.removeEventListener(
        "connectionstatechange",
        handleStateChange,
      );
      reject(
        new Error(
          `peer connection did not connect: ${connection.connectionState}`,
        ),
      );
    }, 20_000);

    const handleStateChange = () => {
      if (connection.connectionState !== "connected") {
        return;
      }
      clearTimeout(timer);
      connection.removeEventListener(
        "connectionstatechange",
        handleStateChange,
      );
      resolve();
    };

    connection.addEventListener("connectionstatechange", handleStateChange);
  });
}

export function waitForDataChannelOpen(channel: RTCDataChannel) {
  if (channel.readyState === "open") {
    return Promise.resolve();
  }

  return new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      channel.removeEventListener("open", handleOpen);
      reject(new Error("data channel did not open in time"));
    }, 20_000);

    const handleOpen = () => {
      clearTimeout(timer);
      channel.removeEventListener("open", handleOpen);
      resolve();
    };

    channel.addEventListener("open", handleOpen);
  });
}

export async function expectMessage(
  channel: RTCDataChannel,
  expected: string,
  send: () => void,
) {
  const messagePromise = new Promise<string>((resolve, reject) => {
    const timer = setTimeout(() => {
      channel.removeEventListener("message", handleMessage);
      reject(new Error(`timed out waiting for "${expected}"`));
    }, 20_000);

    const handleMessage = (event: MessageEvent<string>) => {
      clearTimeout(timer);
      channel.removeEventListener("message", handleMessage);
      resolve(event.data);
    };

    channel.addEventListener("message", handleMessage, { once: true });
  });

  send();
  expect(await messagePromise).toBe(expected);
}

export async function getSelectedRelayCandidatePair(
  connection: RTCPeerConnection,
): Promise<SelectedRelayCandidatePair> {
  const stats = await connection.getStats();
  const statsMap = stats as unknown as Map<string, RTCStats>;
  const pair = findSelectedCandidatePair(stats);
  if (!pair) {
    throw new Error("selected ICE candidate pair was not found");
  }
  const selectedPair = pair as RTCStats & {
    localCandidateId?: string;
    remoteCandidateId?: string;
  };

  const localCandidate =
    selectedPair.localCandidateId !== undefined
      ? statsMap.get(selectedPair.localCandidateId)
      : undefined;
  const remoteCandidate =
    selectedPair.remoteCandidateId !== undefined
      ? statsMap.get(selectedPair.remoteCandidateId)
      : undefined;

  return {
    localCandidateType: readStatString(localCandidate, "candidateType"),
    remoteCandidateType: readStatString(remoteCandidate, "candidateType"),
    localCandidateProtocol: readStatString(localCandidate, "protocol"),
    remoteCandidateProtocol: readStatString(remoteCandidate, "protocol"),
    localCandidateTcpType: readStatString(localCandidate, "tcpType"),
    remoteCandidateTcpType: readStatString(remoteCandidate, "tcpType"),
    localRelayProtocol: readStatString(localCandidate, "relayProtocol"),
    remoteRelayProtocol: readStatString(remoteCandidate, "relayProtocol"),
  };
}

export async function getPeerConnectionDiagnostics(
  connection: RTCPeerConnection,
): Promise<PeerConnectionDiagnostics> {
  let selectedCandidatePair: SelectedRelayCandidatePair | undefined;
  try {
    selectedCandidatePair = await getSelectedRelayCandidatePair(connection);
  } catch {}

  return {
    connectionState: connection.connectionState,
    iceConnectionState: connection.iceConnectionState,
    iceGatheringState: connection.iceGatheringState,
    signalingState: connection.signalingState,
    localCandidateLines: getCandidateLines(connection.localDescription?.sdp),
    remoteCandidateLines: getCandidateLines(connection.remoteDescription?.sdp),
    selectedCandidatePair,
  };
}

export class Counter {
  private now = 0;
  constructor(
    private times: number,
    private finished: () => void,
  ) {}

  done() {
    if (++this.now === this.times) {
      this.finished();
    }
  }
}

function findSelectedCandidatePair(report: RTCStatsReport) {
  const reportMap = report as unknown as Map<string, RTCStats>;
  const transport = [...reportMap.values()].find(
    (stat) =>
      stat.type === "transport" &&
      typeof readStatString(stat, "selectedCandidatePairId") === "string",
  );

  if (transport) {
    const selectedCandidatePairId = readStatString(
      transport,
      "selectedCandidatePairId",
    );
    if (selectedCandidatePairId) {
      const pair = reportMap.get(selectedCandidatePairId);
      if (pair) {
        return pair;
      }
    }
  }

  return [...reportMap.values()].find(
    (stat) =>
      stat.type === "candidate-pair" &&
      readStatBoolean(stat, "selected") === true,
  );
}

function readStatBoolean(stat: RTCStats | undefined, key: string) {
  return stat && key in stat
    ? Boolean((stat as unknown as Record<string, unknown>)[key])
    : undefined;
}

function readStatString(stat: RTCStats | undefined, key: string) {
  if (!stat || !(key in stat)) {
    return undefined;
  }
  const value = (stat as unknown as Record<string, unknown>)[key];
  return typeof value === "string" ? value : undefined;
}

function getCandidateLines(sdp?: string) {
  if (!sdp) {
    return [];
  }
  return sdp
    .split(/\r?\n/)
    .filter(
      (line) =>
        line.startsWith("a=candidate:") || line === "a=end-of-candidates",
    );
}

export type RecordPlaybackKinds = "video" | "av";

/**
 * Arrange: Chrome offers fake-camera media (sendonly) plus DataChannel "record"
 * to the werift recorder handler `label`, and waits until both are usable.
 */
export async function connectRecordPlayback(
  label: string,
  kinds: RecordPlaybackKinds,
) {
  await ensurePeerConnected();
  const stream = await navigator.mediaDevices.getUserMedia({
    video: { width: 640, height: 480 },
    audio: kinds === "av",
  });
  const pc = new RTCPeerConnection({
    iceServers: [{ urls: "stun:stun.l.google.com:19302" }],
  });
  pc.onicecandidate = ({ candidate }) => {
    peer
      .request(label, { type: "candidate", payload: candidate })
      .catch(() => {});
  };
  const dc = pc.createDataChannel("record");
  dc.binaryType = "arraybuffer";
  for (const track of stream.getTracks()) {
    const transceiver = pc.addTransceiver(track, { direction: "sendonly" });
    preferCodec(transceiver, track.kind === "video" ? "vp8" : "opus");
  }

  await pc.setLocalDescription(await pc.createOffer());
  const answer = await peer.request(label, {
    type: "init",
    payload: pc.localDescription,
  });
  await pc.setRemoteDescription(answer);
  await waitForPeerConnection(pc);
  await waitForDataChannelOpen(dc);

  const close = () => {
    for (const track of stream.getTracks()) track.stop();
    pc.close();
  };
  return { pc, dc, close };
}

/**
 * Send "stop" on the record DataChannel and collect the WebM file the server
 * returns as header JSON → binary chunks → eof JSON.
 */
export async function receiveRecordedFile(
  dc: RTCDataChannel,
  timeoutMs = 30_000,
) {
  return new Promise<Uint8Array<ArrayBuffer>>((resolve, reject) => {
    const chunks: Uint8Array[] = [];
    let expected: number | undefined;
    let received = 0;
    const timer = setTimeout(() => {
      finish();
      reject(
        new Error(
          `receiveRecordedFile timed out: ${received}/${expected ?? "?"} bytes`,
        ),
      );
    }, timeoutMs);
    const finish = () => {
      clearTimeout(timer);
      dc.removeEventListener("message", onMessage);
    };
    const onMessage = (event: MessageEvent) => {
      if (typeof event.data !== "string") {
        const chunk = new Uint8Array(event.data as ArrayBuffer);
        chunks.push(chunk);
        received += chunk.byteLength;
        return;
      }
      const message = JSON.parse(event.data);
      if (message.type === "header") {
        expected = message.size;
      } else if (message.type === "error") {
        finish();
        reject(new Error(`server failed to record: ${message.message}`));
      } else if (message.type === "eof") {
        finish();
        if (received !== expected) {
          reject(
            new Error(`recorded file size mismatch: ${received}/${expected}`),
          );
          return;
        }
        const file = new Uint8Array(received);
        let offset = 0;
        for (const chunk of chunks) {
          file.set(chunk, offset);
          offset += chunk.byteLength;
        }
        resolve(file);
      }
    };
    dc.addEventListener("message", onMessage);
    dc.send("stop");
  });
}

export type WebmFilePlayback = {
  duration: number;
  videoWidth: number;
  videoHeight: number;
  /** currentTime when `ended` fired. */
  endedAt: number;
  totalVideoFrames: number;
  droppedVideoFrames: number;
  /** Chrome-only `webkitAudioDecodedByteCount`. */
  audioDecodedBytes: number;
  /** Seek to the middle of the file completed and a frame was drawn. */
  seekedTo: number;
  /** Sum of RGB values at the seek target (0 means a black/empty frame). */
  seekedFrameLuma: number;
  error?: string;
};

/**
 * Play `file` as a WebM Blob in a muted <video> from start to `ended`, then
 * seek to the middle (uses Cues) and sample the drawn frame.
 */
export async function playWebmFile(
  file: Uint8Array<ArrayBuffer>,
  timeoutMs = 30_000,
) {
  const url = URL.createObjectURL(new Blob([file], { type: "video/webm" }));
  const video = document.createElement("video");
  video.muted = true;
  video.preload = "auto";
  document.body.appendChild(video);
  const waitEvent = (name: string) =>
    new Promise<void>((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error(`video "${name}" timed out`)),
        timeoutMs,
      );
      video.addEventListener(
        name,
        () => {
          clearTimeout(timer);
          resolve();
        },
        { once: true },
      );
      video.addEventListener(
        "error",
        () => {
          clearTimeout(timer);
          reject(
            new Error(
              `video error ${video.error?.code}: ${video.error?.message}`,
            ),
          );
        },
        { once: true },
      );
    });

  try {
    const loaded = waitEvent("loadedmetadata");
    video.src = url;
    await loaded;

    const ended = waitEvent("ended");
    await video.play();
    await ended;
    const endedAt = video.currentTime;
    const quality = video.getVideoPlaybackQuality();

    const seekedTo = video.duration / 2;
    const seeked = waitEvent("seeked");
    video.currentTime = seekedTo;
    await seeked;
    const canvas = document.createElement("canvas");
    canvas.width = 64;
    canvas.height = 48;
    const context = canvas.getContext("2d")!;
    context.drawImage(video, 0, 0, canvas.width, canvas.height);
    const pixels = context.getImageData(0, 0, canvas.width, canvas.height).data;
    let seekedFrameLuma = 0;
    for (let i = 0; i < pixels.length; i += 4) {
      seekedFrameLuma += pixels[i] + pixels[i + 1] + pixels[i + 2];
    }

    return {
      duration: video.duration,
      videoWidth: video.videoWidth,
      videoHeight: video.videoHeight,
      endedAt,
      totalVideoFrames: quality.totalVideoFrames,
      droppedVideoFrames: quality.droppedVideoFrames,
      audioDecodedBytes:
        (video as unknown as { webkitAudioDecodedByteCount?: number })
          .webkitAudioDecodedByteCount ?? 0,
      seekedTo: video.currentTime,
      seekedFrameLuma,
    } satisfies WebmFilePlayback;
  } finally {
    video.pause();
    video.removeAttribute("src");
    video.load();
    video.remove();
    URL.revokeObjectURL(url);
  }
}

/**
 * Append `file` to a MediaSource SourceBuffer (Chrome's own WebM byte-stream
 * parser, stricter than the <video src> demuxer) and return the buffered range.
 */
export async function appendWebmToMediaSource(
  file: Uint8Array<ArrayBuffer>,
  mimeType: string,
  timeoutMs = 15_000,
) {
  const mediaSource = new MediaSource();
  const video = document.createElement("video");
  const url = URL.createObjectURL(mediaSource);
  video.src = url;
  try {
    await new Promise<void>((resolve) =>
      mediaSource.addEventListener("sourceopen", () => resolve(), {
        once: true,
      }),
    );
    const sourceBuffer = mediaSource.addSourceBuffer(mimeType);
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error("SourceBuffer append timed out")),
        timeoutMs,
      );
      sourceBuffer.addEventListener(
        "updateend",
        () => {
          clearTimeout(timer);
          resolve();
        },
        { once: true },
      );
      sourceBuffer.addEventListener(
        "error",
        () => {
          clearTimeout(timer);
          reject(new Error("SourceBuffer append failed"));
        },
        { once: true },
      );
      sourceBuffer.appendBuffer(file);
    });
    const buffered = sourceBuffer.buffered;
    return {
      readyState: mediaSource.readyState,
      ranges: Array.from({ length: buffered.length }, (_, i) => ({
        start: buffered.start(i),
        end: buffered.end(i),
      })),
    };
  } finally {
    video.removeAttribute("src");
    video.load();
    URL.revokeObjectURL(url);
  }
}
