/**
 * Arrange utilities for packages/rtp Packetizer / Depacketizer Chrome E2E.
 * - Demux committed fixtures with mediabunny (bytes only; no webrtc userMedia packetizer)
 * - Construct packages/rtp *Packetizer instances
 * - Wire DepacketizeCallback for scenario A / C
 */
import { readFile } from "node:fs/promises";
import { join } from "node:path";

import {
  BufferSource,
  EncodedPacketSink,
  Input,
  MP4,
  WEBM,
} from "mediabunny";

import type { DepacketizerCodec, RtpPacket } from ".";
import {
  Av1Packetizer,
  H264Packetizer,
  type MediaStreamTrack,
  OpusPacketizer,
  type RTCPeerConnection,
  type RTCRtpCodecParameters,
  Vp8Packetizer,
  Vp9Packetizer,
  useAV1,
  useH264,
  useOPUS,
  useVP8,
  useVP9,
} from ".";
// DepacketizeCallback lives in rtp/extra (re-exported via webrtc nonstandard)
import { DepacketizeCallback } from "../../packages/webrtc/src/nonstandard";

export type CodecRtpName = "vp8" | "vp9" | "av1" | "h264" | "opus";

export type CodecRtpKind = "video" | "audio";

export type EncodedFrameSample = {
  data: Buffer;
  isKeyframe: boolean;
  /** Media timestamp in seconds (relative to first sample). */
  timestampSec: number;
};

// cwd is e2e/ in CI and local runs (compiled or ts-node)
const FIXTURE_DIR = join(process.cwd(), "fixtures/media");

export const codecFixturePaths: Record<CodecRtpName, string> = {
  vp8: join(FIXTURE_DIR, "vp8.webm"),
  vp9: join(FIXTURE_DIR, "vp9.webm"),
  av1: join(FIXTURE_DIR, "av1.webm"),
  h264: join(FIXTURE_DIR, "h264.mp4"),
  opus: join(FIXTURE_DIR, "opus.webm"),
};

export function codecKind(codec: CodecRtpName): CodecRtpKind {
  return codec === "opus" ? "audio" : "video";
}

export function codecMimeHint(codec: CodecRtpName): string {
  switch (codec) {
    case "vp8":
      return "vp8";
    case "vp9":
      return "vp9";
    case "av1":
      return "av1";
    case "h264":
      return "h264";
    case "opus":
      return "opus";
  }
}

export function depacketizerCodecName(codec: CodecRtpName): DepacketizerCodec {
  switch (codec) {
    case "vp8":
      return "VP8";
    case "vp9":
      return "VP9";
    case "av1":
      return "AV1";
    case "h264":
      return "MPEG4/ISO/AVC";
    case "opus":
      return "OPUS";
  }
}

export function useCodecParameters(codec: CodecRtpName): RTCRtpCodecParameters {
  switch (codec) {
    case "vp8":
      return useVP8();
    case "vp9":
      return useVP9();
    case "av1":
      return useAV1();
    case "h264":
      return useH264();
    case "opus":
      return useOPUS();
  }
}

export function clockRateFor(codec: CodecRtpName): number {
  return codec === "opus" ? 48_000 : 90_000;
}

export type RtpPacketizer = {
  packetize(
    data: Buffer,
    rtpTimestamp: number,
    options?: { isKeyframe?: boolean; frameType?: "key" | "delta" },
  ): RtpPacket[];
};

/**
 * Build a packages/rtp Packetizer (SUT). Never uses GStreamer pay or webrtc userMedia packetizer.
 */
export function createRtpPacketizer(
  codec: CodecRtpName,
  options: {
    payloadType?: number;
    maxPayloadSize?: number;
    parameterSets?: Buffer[];
    naluLengthSize?: number;
  } = {},
): RtpPacketizer {
  const base = {
    payloadType: options.payloadType ?? 96,
    // Small MTU forces multi-packet frames for video fragmentation coverage
    maxPayloadSize: options.maxPayloadSize ?? (codec === "opus" ? 1200 : 400),
  };

  switch (codec) {
    case "vp8":
      return new Vp8Packetizer(base);
    case "vp9":
      return new Vp9Packetizer(base);
    case "av1":
      return new Av1Packetizer(base);
    case "h264":
      return new H264Packetizer({
        ...base,
        parameterSets: options.parameterSets,
        naluLengthSize: options.naluLengthSize,
      });
    case "opus":
      return new OpusPacketizer({ ...base, maxPayloadSize: 1200 });
  }
}

/** Parse avcC decoder config → length size + SPS/PPS NAL units (no length prefix). */
export function parseAvcDecoderConfiguration(
  decoderDescription: ArrayBuffer | ArrayBufferView | null | undefined,
): { naluLengthSize: number; parameterSets: Buffer[] } | null {
  if (!decoderDescription) {
    return null;
  }
  const description = toBuffer(decoderDescription);
  if (description.length < 7) {
    return null;
  }

  const naluLengthSize = (description[4] & 0x03) + 1;
  const spsCount = description[5] & 0x1f;
  let offset = 6;
  const parameterSets: Buffer[] = [];

  for (let i = 0; i < spsCount; i++) {
    if (offset + 2 > description.length) break;
    const length = description.readUInt16BE(offset);
    offset += 2;
    parameterSets.push(Buffer.from(description.subarray(offset, offset + length)));
    offset += length;
  }

  if (offset >= description.length) {
    return { naluLengthSize, parameterSets };
  }
  const ppsCount = description[offset];
  offset++;
  for (let i = 0; i < ppsCount; i++) {
    if (offset + 2 > description.length) break;
    const length = description.readUInt16BE(offset);
    offset += 2;
    parameterSets.push(Buffer.from(description.subarray(offset, offset + length)));
    offset += length;
  }

  return { naluLengthSize, parameterSets };
}

function toBuffer(data: ArrayBuffer | ArrayBufferView): Buffer {
  if (ArrayBuffer.isView(data)) {
    return Buffer.from(data.buffer, data.byteOffset, data.byteLength);
  }
  return Buffer.from(data);
}

export type DemuxedCodecSource = {
  samples: EncodedFrameSample[];
  parameterSets?: Buffer[];
  naluLengthSize?: number;
};

/**
 * Demux a committed fixture into raw encoded frames for packages/rtp Packetizer.
 */
export async function demuxCodecFixture(
  codec: CodecRtpName,
): Promise<DemuxedCodecSource> {
  const path = codecFixturePaths[codec];
  const file = await readFile(path);
  // mediabunny exports ready-made format instances (not constructors)
  const formats = codec === "h264" ? [MP4] : [WEBM, MP4];
  const input = new Input({
    formats,
    source: new BufferSource(file),
  });

  try {
    if (!(await input.canRead())) {
      throw new Error(`cannot read fixture: ${path}`);
    }

    const track =
      codec === "opus"
        ? await input.getPrimaryAudioTrack()
        : await input.getPrimaryVideoTrack();
    if (!track) {
      throw new Error(`no ${codecKind(codec)} track in ${path}`);
    }

    const decoderConfig = await track.getDecoderConfig();
    let parameterSets: Buffer[] | undefined;
    let naluLengthSize: number | undefined;
    if (codec === "h264" && decoderConfig && "description" in decoderConfig) {
      const avc = parseAvcDecoderConfiguration(
        decoderConfig.description ?? null,
      );
      if (avc) {
        parameterSets = avc.parameterSets;
        naluLengthSize = avc.naluLengthSize;
      }
    }

    const sink = new EncodedPacketSink(track);
    const samples: EncodedFrameSample[] = [];
    let firstTs: number | undefined;

    for await (const packet of sink.packets(undefined, undefined, {
      verifyKeyPackets: codec !== "opus",
    })) {
      if (firstTs === undefined) {
        firstTs = packet.timestamp;
      }
      samples.push({
        data: Buffer.from(packet.data),
        isKeyframe: packet.type === "key" || codec === "opus",
        timestampSec: packet.timestamp - firstTs,
      });
    }

    if (samples.length === 0) {
      throw new Error(`no encoded samples in ${path}`);
    }

    return { samples, parameterSets, naluLengthSize };
  } finally {
    input.dispose();
  }
}

export function toRtpTimestamp(
  timestampSec: number,
  clockRate: number,
): number {
  return Math.round(timestampSec * clockRate) >>> 0;
}

/**
 * Stream demuxed samples through packages/rtp Packetizer onto a local track.
 * Loops until aborted so Chrome has time to decode.
 */
export type PacketizeStreamStats = {
  framesSent: number;
  packetsSent: number;
  multiPacketFrames: number;
  firstRtpTimestamp?: number;
  lastRtpTimestamp?: number;
  timestampAdvanced: boolean;
  payloadType?: number;
  negotiatedMime?: string;
  clockRate: number;
};

export async function streamPacketizedFixture(options: {
  codec: CodecRtpName;
  track: MediaStreamTrack;
  signal: AbortSignal;
  /** Loop fixture (default true). */
  loop?: boolean;
  onFrameSent?: (info: {
    frameIndex: number;
    packetCount: number;
    rtpTimestamp: number;
  }) => void;
}): Promise<PacketizeStreamStats> {
  const { codec, track, signal } = options;
  const loop = options.loop ?? true;
  const demuxed = await demuxCodecFixture(codec);
  const clockRate = clockRateFor(codec);
  const packetizer = createRtpPacketizer(codec, {
    parameterSets: demuxed.parameterSets,
    naluLengthSize: demuxed.naluLengthSize,
  });

  let framesSent = 0;
  let packetsSent = 0;
  let multiPacketFrames = 0;
  let firstRtpTimestamp: number | undefined;
  let lastRtpTimestamp: number | undefined;
  let payloadType: number | undefined;
  let loopIndex = 0;

  const sleep = (ms: number) =>
    new Promise<void>((resolve, reject) => {
      if (signal.aborted) {
        reject(new DOMException("aborted", "AbortError"));
        return;
      }
      const timer = setTimeout(resolve, ms);
      const onAbort = () => {
        clearTimeout(timer);
        reject(new DOMException("aborted", "AbortError"));
      };
      signal.addEventListener("abort", onAbort, { once: true });
    });

  try {
    do {
      const startedAt = performance.now();
      for (let i = 0; i < demuxed.samples.length; i++) {
        if (signal.aborted) {
          break;
        }
        const sample = demuxed.samples[i];
        // Pace roughly in real time (first loop); subsequent loops send ASAP with small gap
        if (loopIndex === 0) {
          const due = sample.timestampSec * 1000 - (performance.now() - startedAt);
          if (due > 0) {
            await sleep(due);
          }
        } else {
          await sleep(codec === "opus" ? 20 : 33);
        }

        // Offset timestamp each loop so RTP clock keeps advancing
        const baseOffset = loopIndex * demuxed.samples.length * (clockRate / 30);
        const rtpTimestamp = toRtpTimestamp(
          sample.timestampSec + baseOffset / clockRate,
          clockRate,
        );

        const packets = packetizer.packetize(sample.data, rtpTimestamp, {
          isKeyframe: sample.isKeyframe,
          frameType: sample.isKeyframe ? "key" : "delta",
        });
        if (packets.length > 1) {
          multiPacketFrames++;
        }
        for (const rtp of packets) {
          payloadType = rtp.header.payloadType;
          track.writeRtp(rtp);
        }
        if (firstRtpTimestamp === undefined) {
          firstRtpTimestamp = rtpTimestamp;
        }
        lastRtpTimestamp = rtpTimestamp;
        framesSent++;
        packetsSent += packets.length;
        options.onFrameSent?.({
          frameIndex: framesSent,
          packetCount: packets.length,
          rtpTimestamp,
        });
      }
      loopIndex++;
    } while (loop && !signal.aborted);
  } catch (error) {
    if (
      signal.aborted ||
      (error instanceof DOMException && error.name === "AbortError") ||
      (error as { name?: string })?.name === "AbortError"
    ) {
      return {
        framesSent,
        packetsSent,
        multiPacketFrames,
        firstRtpTimestamp,
        lastRtpTimestamp,
        timestampAdvanced:
          firstRtpTimestamp !== undefined &&
          lastRtpTimestamp !== undefined &&
          lastRtpTimestamp !== firstRtpTimestamp,
        payloadType: track.codec?.payloadType ?? payloadType,
        negotiatedMime: track.codec?.mimeType,
        clockRate,
      };
    }
    throw error;
  }

  return {
    framesSent,
    packetsSent,
    multiPacketFrames,
    firstRtpTimestamp,
    lastRtpTimestamp,
    timestampAdvanced:
      firstRtpTimestamp !== undefined &&
      lastRtpTimestamp !== undefined &&
      lastRtpTimestamp !== firstRtpTimestamp,
    payloadType: track.codec?.payloadType ?? payloadType,
    negotiatedMime: track.codec?.mimeType,
    clockRate,
  };
}

export type DepacketizeStats = {
  frameCount: number;
  keyframeCount: number;
  totalBytes: number;
  negotiatedMime?: string;
  /** Last observed RTP payload type */
  payloadType?: number;
  /** First / last RTP timestamp seen on depacketized frames */
  firstRtpTimestamp?: number;
  lastRtpTimestamp?: number;
  /** True when lastRtpTimestamp advanced past firstRtpTimestamp (uint32 wrap-aware) */
  timestampAdvanced?: boolean;
  usedPackagesRtp: true;
};

/**
 * Attach packages/rtp DepacketizeCallback to a receive track.
 * Sends PLI periodically for video so keyframes arrive.
 */
export function attachDepacketizer(options: {
  codec: CodecRtpName;
  track: MediaStreamTrack;
  pc: RTCPeerConnection;
  /** When true, request PLI every intervalMs (video only). */
  sendPli?: boolean;
  pliIntervalMs?: number;
  onFrame?: (frame: {
    data: Buffer;
    isKeyframe: boolean;
    /** RTP timestamp from the aggregated frame */
    timestamp: number;
  }) => void;
}): {
  stats: DepacketizeStats;
  depacketizer: DepacketizeCallback;
  stop: () => void;
} {
  const { codec, track, pc } = options;
  const depacketizerCodec = depacketizerCodecName(codec);
  const isVideo = codecKind(codec) === "video";

  const depacketizer = new DepacketizeCallback(depacketizerCodec, {
    isFinalPacketInSequence: isVideo ? (h) => h.marker : undefined,
  });

  const stats: DepacketizeStats = {
    frameCount: 0,
    keyframeCount: 0,
    totalBytes: 0,
    usedPackagesRtp: true,
  };

  depacketizer.pipe((output) => {
    if (!output.frame || output.frame.data.length === 0) {
      return;
    }
    stats.frameCount++;
    stats.totalBytes += output.frame.data.length;
    if (output.frame.isKeyframe) {
      stats.keyframeCount++;
    }
    const rtpTimestamp =
      typeof output.frame.timestamp === "number"
        ? output.frame.timestamp
        : 0;
    if (stats.firstRtpTimestamp === undefined) {
      stats.firstRtpTimestamp = rtpTimestamp;
    }
    stats.lastRtpTimestamp = rtpTimestamp;
    if (
      stats.firstRtpTimestamp !== undefined &&
      stats.lastRtpTimestamp !== undefined &&
      stats.lastRtpTimestamp !== stats.firstRtpTimestamp
    ) {
      stats.timestampAdvanced = true;
    }
    options.onFrame?.({
      data: output.frame.data,
      isKeyframe: output.frame.isKeyframe,
      timestamp: rtpTimestamp,
    });
  });

  let lastSsrc: number | undefined = track.ssrc;
  const subscription = track.onReceiveRtp.subscribe((rtp) => {
    lastSsrc = rtp.header.ssrc;
    stats.payloadType = rtp.header.payloadType;
    try {
      depacketizer.input({ rtp });
    } catch (error) {
      // Invalid / empty payloads must not crash the process
      console.warn(`[codecRtp] depacketize error (${codec}):`, error);
    }
  });

  let pliTimer: ReturnType<typeof setInterval> | undefined;
  if (isVideo && options.sendPli !== false) {
    const interval = options.pliIntervalMs ?? 2000;
    pliTimer = setInterval(() => {
      const ssrc = lastSsrc ?? track.ssrc;
      if (!ssrc) {
        return;
      }
      try {
        for (const t of pc.getTransceivers()) {
          if (t.receiver.track === track || t.receiver) {
            void t.receiver.sendRtcpPLI(ssrc);
            break;
          }
        }
      } catch {
        // ignore PLI failures after close
      }
    }, interval);
  }

  return {
    stats,
    depacketizer,
    stop: () => {
      subscription.unSubscribe();
      depacketizer.destroy();
      if (pliTimer) {
        clearInterval(pliTimer);
      }
    },
  };
}

/**
 * Wait until depacketize stats meet success criteria.
 */
export async function waitDepacketizeSuccess(
  stats: DepacketizeStats,
  codec: CodecRtpName,
  timeoutMs = 45_000,
): Promise<DepacketizeStats> {
  const needKeyframe = codecKind(codec) === "video";
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (stats.frameCount >= 1 && (!needKeyframe || stats.keyframeCount >= 1)) {
      return { ...stats };
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(
    `depacketize timeout for ${codec}: frames=${stats.frameCount} keyframes=${stats.keyframeCount}`,
  );
}

export async function waitForTrackCodec(
  track: MediaStreamTrack,
  timeoutMs = 20_000,
): Promise<RTCRtpCodecParameters> {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (track.codec) {
      return track.codec;
    }
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error("track codec not negotiated in time");
}
