import { tmpdir } from "os";
import { join } from "path";
import { mkdtemp, rm, writeFile } from "fs/promises";

import {
  BufferTarget,
  EncodedAudioPacketSource,
  EncodedPacket,
  EncodedVideoPacketSource,
  Output,
  WebMOutputFormat,
} from "mediabunny";

import type { RtpPacket } from "../../src/imports/rtp";
import type { MediaStreamTrack } from "../../src/media/track";
import { MP4Callback } from "../../src/nonstandard";

export async function createAvMp4Buffer() {
  const outputs: Uint8Array[] = [];
  const done = createDeferred<void>();
  const mp4 = new MP4Callback([
    {
      kind: "audio",
      codec: "opus",
      clockRate: 48_000,
      trackNumber: 1,
    },
    {
      kind: "video",
      codec: "avc1",
      clockRate: 90_000,
      width: 640,
      height: 360,
      trackNumber: 2,
    },
  ]);

  mp4.pipe(async (output) => {
    if ("data" in output) {
      outputs.push(output.data);
    } else if ("eol" in output && output.eol) {
      done.resolve();
    }
  });

  const audioFrames = createOpusFrames();
  const videoFrames = createH264Frames();
  mp4.inputAudio({ frame: audioFrames[0] });
  mp4.inputVideo({ frame: videoFrames[0] });
  mp4.inputAudio({ frame: audioFrames[1] });
  mp4.inputVideo({ frame: videoFrames[1] });
  mp4.inputAudio({ frame: audioFrames[2] });
  mp4.inputVideo({ frame: videoFrames[2] });
  mp4.inputAudio({ eol: true });
  mp4.inputVideo({ eol: true });

  await done.promise;

  return Buffer.concat(outputs.map((output) => Buffer.from(output)));
}

export async function createAvWebmBuffer() {
  const audioSource = new EncodedAudioPacketSource("opus");
  const videoSource = new EncodedVideoPacketSource("vp8");
  const output = new Output({
    format: new WebMOutputFormat(),
    target: new BufferTarget(),
  });

  output.addAudioTrack(audioSource);
  output.addVideoTrack(videoSource);
  await output.start();

  const audioFrames = createOpusFrames();
  const videoFrames = createVp8Frames();
  for (const frame of audioFrames) {
    await audioSource.add(
      new EncodedPacket(frame.data, "key", frame.time / 1_000, 0.02),
      {
        decoderConfig: {
          codec: "opus",
          numberOfChannels: 2,
          sampleRate: 48_000,
        },
      },
    );
  }
  for (const frame of videoFrames) {
    await videoSource.add(
      new EncodedPacket(
        frame.data,
        frame.isKeyframe ? "key" : "delta",
        frame.time / 1_000,
        0.033,
      ),
      {
        decoderConfig: {
          codec: "vp8",
          codedWidth: 640,
          codedHeight: 360,
        },
      },
    );
  }

  await output.finalize();
  return Buffer.from(output.target.buffer!);
}

export async function createTempMediaFile(buffer: Buffer, extension: string) {
  const directory = await mkdtemp(join(tmpdir(), "werift-user-media-"));
  const path = join(directory, `fixture.${extension}`);
  await writeFile(path, buffer);

  return {
    path,
    cleanup: async () => {
      await rm(directory, { recursive: true, force: true });
    },
  };
}

export function collectFrames(track: MediaStreamTrack, count: number) {
  return new Promise<RtpPacket[][]>((resolve) => {
    const frames: RtpPacket[][] = [];
    let currentFrame: RtpPacket[] = [];

    const { unSubscribe } = track.onReceiveRtp.subscribe((rtp) => {
      currentFrame.push(rtp.clone());
      if (!rtp.header.marker) {
        return;
      }

      frames.push(currentFrame);
      currentFrame = [];
      if (frames.length >= count) {
        unSubscribe();
        resolve(frames);
      }
    });
  });
}

export async function waitUntil(predicate: () => boolean, timeoutMs = 3_000) {
  const startedAt = performance.now();

  while (!predicate()) {
    if (performance.now() - startedAt > timeoutMs) {
      throw new Error("Condition timed out");
    }
    await new Promise<void>((resolve) => {
      setTimeout(resolve, 10);
    });
  }
}

export function createH264Frames() {
  return [
    createFrame(
      Buffer.from(
        "000000016742001eda01e0089f970110000003000100000300320f1831960000000168ce06e20000000165888421a0",
        "hex",
      ),
      true,
      0,
    ),
    createFrame(Buffer.from("00000001419a2211", "hex"), false, 33),
    createFrame(Buffer.from("00000001419a3344", "hex"), false, 66),
  ];
}

export function createOpusFrames() {
  return [
    createFrame(Buffer.from([0xf8, 0xff, 0xfe, 0x01]), true, 0),
    createFrame(Buffer.from([0xf8, 0xff, 0xfe, 0x02]), true, 20),
    createFrame(Buffer.from([0xf8, 0xff, 0xfe, 0x03]), true, 40),
  ];
}

export function createVp8Frames() {
  return [
    createFrame(
      Buffer.from([
        0x10, 0x10, 0x00, 0x00, 0x9d, 0x01, 0x2a, 0x02, 0x00, 0x02, 0x00,
      ]),
      true,
      0,
    ),
    createFrame(Buffer.from([0x10, 0x11, 0x00, 0x00]), false, 33),
    createFrame(Buffer.from([0x10, 0x12, 0x00, 0x00]), false, 66),
  ];
}

function createFrame(data: Buffer, isKeyframe: boolean, time: number) {
  return { data, isKeyframe, time };
}

function createDeferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((innerResolve, innerReject) => {
    resolve = innerResolve;
    reject = innerReject;
  });

  return { promise, resolve, reject };
}
