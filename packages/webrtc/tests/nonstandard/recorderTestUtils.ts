import { chmod, mkdtemp, readFile, rm, writeFile } from "fs/promises";
import { BufferSource, Input, OGG } from "mediabunny";
import { tmpdir } from "os";
import { join } from "path";
import { vi } from "vitest";

import { useOPUS, usePCMU, useVP8 } from "../../src";
import { Event } from "../../src/imports/common";
import {
  RtcpSenderInfo,
  RtcpSrPacket,
  RtpHeader,
  RtpPacket,
} from "../../src/imports/rtp";
import { MediaStreamTrack } from "../../src/media/track";
import type {
  MediaRecorder,
  OggOutput,
  WebmOutput,
} from "../../src/nonstandard";
import type { OggFactory } from "../../src/nonstandard/recorder/writer/ogg";
import type { WebmFactory } from "../../src/nonstandard/recorder/writer/webm";

export function createOpusTrack() {
  return new MediaStreamTrack({
    kind: "audio",
    remote: true,
    codec: useOPUS({ payloadType: 111 }),
  });
}

/** remote audio track whose codec has not been negotiated yet */
export function createCodeclessAudioTrack() {
  return new MediaStreamTrack({ kind: "audio", remote: true });
}

/** ms that `recorder.stop()` takes */
export async function measureStop(recorder: MediaRecorder) {
  const started = Date.now();
  await recorder.stop();
  return Date.now() - started;
}

export function createPcmuTrack() {
  return new MediaStreamTrack({
    kind: "audio",
    remote: true,
    codec: usePCMU(),
  });
}

export function createVp8Track() {
  return new MediaStreamTrack({
    kind: "video",
    remote: true,
    codec: useVP8({ payloadType: 96 }),
  });
}

/**
 * Feeds `count` 20 ms Opus RTP packets (CELT FB stereo TOC) into the track.
 * Packet `i` has sequence number `startSeq + i` (uint16) and payload byte `i`.
 */
export function feedOpusRtp(
  track: MediaStreamTrack,
  countOrOrder: number | number[],
  startSeq = 0,
) {
  const order =
    typeof countOrOrder === "number"
      ? [...Array(countOrOrder).keys()]
      : countOrOrder;
  for (const i of order) {
    const header = new RtpHeader({
      payloadType: 111,
      sequenceNumber: (startSeq + i) & 0xffff,
      timestamp: i * 960,
      ssrc: 1234,
      marker: true,
    });
    track.onReceiveRtp.execute(
      new RtpPacket(header, Buffer.from([0xfc, i & 0xff, 0x00])),
    );
  }
}

/** Temporary directory removed by the returned `cleanup`. */
export async function createRecordingDir() {
  const dir = await mkdtemp(join(tmpdir(), "werift-recorder-"));
  return {
    path: (name: string) => join(dir, name),
    read: (name: string) => readFile(join(dir, name)),
    write: (name: string, data: string, mode = 0o644) =>
      writeFile(join(dir, name), data, { mode }),
    /** forbid creating / deleting entries in the directory */
    lock: () => chmod(dir, 0o555),
    cleanup: async () => {
      await chmod(dir, 0o755);
      await rm(dir, { recursive: true, force: true });
    },
  };
}

export function createOggStream() {
  const stream = new Event<[OggOutput]>();
  const outputs: OggOutput[] = [];
  stream.subscribe((o) => {
    outputs.push(o);
  });
  return {
    stream,
    outputs,
    buffer: () =>
      Buffer.concat(
        outputs.flatMap((o) => (o.saveToFile ? [o.saveToFile] : [])),
      ),
  };
}

export function createOggInput(buffer: Buffer) {
  return new Input({ source: new BufferSource(buffer), formats: [OGG] });
}

/** header_type of every Ogg page in order */
export function oggHeaderTypes(buffer: Buffer) {
  const types: number[] = [];
  for (let offset = 0; offset < buffer.length; ) {
    types.push(buffer.readUInt8(offset + 5));
    const segments = buffer.readUInt8(offset + 26);
    let size = 27 + segments;
    for (let i = 0; i < segments; i++) {
      size += buffer.readUInt8(offset + 27 + i);
    }
    offset += size;
  }
  return types;
}

/** Waits until the asynchronous writer start has subscribed to the track. */
export async function waitForOggRecorderStarted(recorder: MediaRecorder) {
  await vi.waitFor(() => {
    if ((recorder.writer as OggFactory).rtpSources.length === 0) {
      throw new Error("not started");
    }
  });
}

/**
 * Delivers an RTCP SR to the track: RTP `rtpTimestamp` is NTP `ntpSeconds`.
 */
export function sendSenderReport(
  track: MediaStreamTrack,
  ntpSeconds: number,
  rtpTimestamp: number,
) {
  track.onReceiveRtcp.execute(
    new RtcpSrPacket({
      ssrc: 1234,
      senderInfo: new RtcpSenderInfo({
        ntpTimestamp: BigInt(ntpSeconds) << 32n,
        rtpTimestamp,
        packetCount: 0,
        octetCount: 0,
      }),
    }),
  );
}

/**
 * Feeds VP8 key frames (one RTP packet each) every 33 ms (2970 ticks)
 * for frames `from` to `to - 1`.
 */
export function feedVp8Rtp(track: MediaStreamTrack, from: number, to: number) {
  for (let i = from; i < to; i++) {
    const header = new RtpHeader({
      payloadType: 96,
      sequenceNumber: i & 0xffff,
      timestamp: i * 2970,
      ssrc: 1234,
      marker: true,
    });
    // payload descriptor (S=1) + VP8 key frame header
    const payload = Buffer.from([
      0x10,
      0x10,
      0x02,
      0x00,
      0x9d,
      0x01,
      0x2a,
      0x80,
      0x02,
      0xe0,
      0x01,
      i & 0xff,
    ]);
    track.onReceiveRtp.execute(new RtpPacket(header, payload));
  }
}

export function createWebmStream() {
  const stream = new Event<[WebmOutput]>();
  const outputs: WebmOutput[] = [];
  stream.subscribe((o) => {
    outputs.push(o);
  });
  return {
    stream,
    outputs,
    blockCount: () => outputs.filter((o) => o.kind === "block").length,
  };
}

/** Waits until the asynchronous WebM writer start has subscribed. */
export async function waitForWebmRecorderStarted(recorder: MediaRecorder) {
  await vi.waitFor(() => {
    if ((recorder.writer as WebmFactory).rtpSources.length === 0) {
      throw new Error("not started");
    }
  });
}
