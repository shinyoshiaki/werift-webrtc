import { mkdtemp, readFile, rm } from "fs/promises";
import { BufferSource, Input, OGG } from "mediabunny";
import { tmpdir } from "os";
import { join } from "path";
import { vi } from "vitest";

import { useOPUS, usePCMU, useVP8 } from "../../src";
import { Event } from "../../src/imports/common";
import { RtpHeader, RtpPacket } from "../../src/imports/rtp";
import { MediaStreamTrack } from "../../src/media/track";
import type { MediaRecorder, OggOutput } from "../../src/nonstandard";
import type { OggFactory } from "../../src/nonstandard/recorder/writer/ogg";

export function createOpusTrack() {
  return new MediaStreamTrack({
    kind: "audio",
    remote: true,
    codec: useOPUS({ payloadType: 111 }),
  });
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

/** Feeds `count` 20 ms Opus RTP packets (CELT FB stereo TOC) into the track. */
export function feedOpusRtp(
  track: MediaStreamTrack,
  countOrOrder: number | number[],
) {
  const order =
    typeof countOrOrder === "number"
      ? [...Array(countOrOrder).keys()]
      : countOrOrder;
  for (const i of order) {
    const header = new RtpHeader({
      payloadType: 111,
      sequenceNumber: i,
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
    cleanup: () => rm(dir, { recursive: true, force: true }),
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
