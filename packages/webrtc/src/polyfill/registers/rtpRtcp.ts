import type { Readable } from "stream";

import { EncodedPacket } from "mediabunny";

import { RtcpPacketConverter, isRtcp } from "../../imports/rtp";
import { useAV1X, useH264, useOPUS, useVP8, useVP9 } from "../../media/codec";
import type { RTCRtpCodecParameters } from "../../media/parameters";
import { MediaStreamTrack } from "../../media/track";
import {
  type SupportedSourceCodec,
  createPacketizer,
} from "../../nonstandard/userMedia/packetizer";
import type {
  MediaGetUserMediaRequest,
  MediaKind,
  MediaRegister,
  MediaRegisterCommonOptions,
} from "../mediaRegister";
import {
  type UdpOrStreamSource,
  openPacketSource,
  throwIfAborted,
} from "../sourceIo";
import { bindTrackStop } from "../trackStop";

export type CreateRtpRtcpRegisterOptions = MediaRegisterCommonOptions &
  UdpOrStreamSource & {
    mimeType: string;
    clockRate?: number;
    channels?: number;
    payloadType?: number;
  };

export function createRtpRtcpRegister(
  options: CreateRtpRtcpRegisterOptions,
): MediaRegister {
  const kind = kindFromMimeType(options.mimeType);
  const codec = codecFromMimeType(options);
  const sessions = createSessionBag();

  return {
    mimeType: options.mimeType,
    kinds: [kind],
    deviceId: options.deviceId,
    groupId: options.groupId,
    label: options.label,
    async createTracks(request: MediaGetUserMediaRequest) {
      throwIfAborted(request.signal);
      const track = new MediaStreamTrack({ kind, codec });
      return startTrackedAcquisition(
        sessions,
        request.signal,
        track,
        (signal) =>
          openPacketSource(
            options,
            (packet) => {
              if (isMuxedRtcp(packet)) {
                try {
                  for (const rtcp of RtcpPacketConverter.deSerialize(packet)) {
                    track.writeRtcp(rtcp);
                  }
                } catch {
                  // drop unparsable RTCP
                }
                return;
              }
              track.writeRtp(packet);
            },
            () => {
              track.stopMediaSource();
            },
            signal,
          ),
      );
    },
    stop() {
      sessions.stopAll();
    },
  };
}

export type CreateEncodedBinaryRegisterOptions = MediaRegisterCommonOptions &
  UdpOrStreamSource & {
    mimeType: string;
    clockRate?: number;
    channels?: number;
  };

export function createEncodedBinaryRegister(
  options: CreateEncodedBinaryRegisterOptions,
): MediaRegister {
  const kind = kindFromMimeType(options.mimeType);
  const sourceCodec = sourceCodecFromMimeType(options.mimeType);
  const codec = codecFromMimeType(options);
  const clockRate = options.clockRate ?? (kind === "audio" ? 48_000 : 90_000);
  const sessions = createSessionBag();

  return {
    mimeType: options.mimeType,
    kinds: [kind],
    deviceId: options.deviceId,
    groupId: options.groupId,
    label: options.label,
    async createTracks(request: MediaGetUserMediaRequest) {
      throwIfAborted(request.signal);
      const packetizer = createPacketizer({
        codec,
        sourceCodec,
      });
      const track = new MediaStreamTrack({ kind, codec });
      let lastReceivedAt: number | undefined;
      let rtpTimestamp = 0;
      return startTrackedAcquisition(
        sessions,
        request.signal,
        track,
        (signal) =>
          openPacketSource(
            options,
            (accessUnit) => {
              const now = performance.now();
              if (lastReceivedAt != undefined) {
                const elapsedSeconds = Math.max(
                  0,
                  (now - lastReceivedAt) / 1_000,
                );
                rtpTimestamp =
                  (rtpTimestamp + Math.round(elapsedSeconds * clockRate)) >>> 0;
              }
              lastReceivedAt = now;
              const encoded = new EncodedPacket(
                new Uint8Array(accessUnit),
                "key",
                rtpTimestamp / clockRate,
                1 / 30,
              );
              for (const rtp of packetizer.packetize(encoded, rtpTimestamp)) {
                track.writeRtp(rtp);
              }
            },
            () => {
              track.stopMediaSource();
            },
            signal,
          ),
      );
    },
    stop() {
      sessions.stopAll();
    },
  };
}

function createSessionBag() {
  const sessions = new Set<() => void>();
  return {
    add(stop: () => void) {
      sessions.add(stop);
    },
    remove(stop: () => void) {
      sessions.delete(stop);
    },
    stopAll() {
      for (const stop of [...sessions]) {
        stop();
      }
      sessions.clear();
    },
  };
}

async function startTrackedAcquisition(
  sessions: ReturnType<typeof createSessionBag>,
  signal: AbortSignal | undefined,
  track: MediaStreamTrack,
  open: (signal?: AbortSignal) => Promise<() => void>,
) {
  let stopSource = () => undefined as void;
  const stopSession = () => {
    sessions.remove(stopSession);
    stopSource();
  };
  sessions.add(stopSession);
  try {
    stopSource = await open(signal);
    throwIfAborted(signal);
    bindTrackStop(track, stopSession);
    return [track];
  } catch (error) {
    stopSession();
    track.stop();
    throw error;
  }
}

function isMuxedRtcp(packet: Buffer) {
  if (isRtcp(packet)) {
    return true;
  }
  if (packet.length < 2) {
    return false;
  }
  const payloadType = packet[1] & 0x7f;
  return payloadType >= 64 && payloadType <= 95;
}

function kindFromMimeType(mimeType: string): MediaKind {
  return mimeType.toLowerCase().startsWith("audio/") ? "audio" : "video";
}

function sourceCodecFromMimeType(mimeType: string): SupportedSourceCodec {
  const normalized = mimeType.toLowerCase();
  if (normalized.includes("h264") || normalized.includes("avc")) {
    return "avc";
  }
  if (normalized.includes("vp8")) {
    return "vp8";
  }
  if (normalized.includes("vp9")) {
    return "vp9";
  }
  if (normalized.includes("av1")) {
    return "av1";
  }
  if (normalized.includes("opus")) {
    return "opus";
  }
  throw new Error(`Unsupported encoded binary mimeType: ${mimeType}`);
}

function codecFromMimeType(options: {
  mimeType: string;
  clockRate?: number;
  channels?: number;
  payloadType?: number;
}): RTCRtpCodecParameters {
  const sourceCodec = sourceCodecFromMimeType(options.mimeType);
  const extra: Partial<RTCRtpCodecParameters> = {
    ...(options.clockRate != undefined ? { clockRate: options.clockRate } : {}),
    ...(options.channels != undefined ? { channels: options.channels } : {}),
    ...(options.payloadType != undefined
      ? { payloadType: options.payloadType }
      : {}),
  };
  switch (sourceCodec) {
    case "avc":
      return useH264(extra);
    case "vp8":
      return useVP8(extra);
    case "vp9":
      return useVP9(extra);
    case "av1":
      return useAV1X(extra);
    case "opus":
      return useOPUS(extra);
  }
}

export type { Readable };
