import { readFileSync } from "fs";

import { BufferSource, Input, MP4 } from "mediabunny";

import { MP4Callback, type Track } from "../src/extra";
import type { Mp4Output } from "../src/extra/processor/mp4";
import type { Transport } from "../src/transport";

export function load(name: string) {
  const base = __dirname;
  const data = readFileSync(`${base}/data/` + name);
  return data;
}

export function createMockTransportPair(): [Transport, Transport] {
  class Mock implements Transport {
    onData!: (buf: Buffer) => void;
    target!: Mock;

    send(buf: Buffer) {
      this.target.onData(buf);
    }
    close() {}
  }

  const a = new Mock();
  const b = new Mock();
  a.target = b;
  b.target = a;

  return [a, b];
}

export async function collectMp4Buffer(
  tracks: Track[],
  act: (mp4: MP4Callback) => void | Promise<void>,
) {
  const outputs = await collectMp4Outputs(tracks, act);
  return mp4OutputsToBuffer(outputs);
}

export function mp4OutputsToBuffer(outputs: Mp4Output[]) {
  const chunks = outputs
    .filter((output): output is Extract<Mp4Output, { data: Uint8Array }> => {
      return "data" in output;
    })
    .map((output) => output.data);

  return Buffer.concat(chunks.map((chunk) => Buffer.from(chunk)));
}

export async function collectMp4Outputs(
  tracks: Track[],
  act: (mp4: MP4Callback) => void | Promise<void>,
  options: {
    callbackDelay?: number;
  } = {},
) {
  const outputs: Mp4Output[] = [];
  const mp4 = new MP4Callback(tracks);

  let resolveDone!: () => void;
  let rejectDone!: (error: Error) => void;
  const done = new Promise<void>((resolve, reject) => {
    resolveDone = resolve;
    rejectDone = reject;
  });

  mp4.pipe(async (output) => {
    if (options.callbackDelay) {
      await sleep(options.callbackDelay);
    }
    outputs.push(output);
    if ("eol" in output && output.eol) {
      resolveDone();
    }
  });

  try {
    await act(mp4);
    await withTimeout(done, 5_000);
  } catch (error) {
    rejectDone(error as Error);
    throw error;
  }

  return outputs;
}

export type Mp4TestFrame = {
  data: Buffer;
  isKeyframe: boolean;
  time: number;
};

export function createFrame(
  data: Buffer,
  isKeyframe: boolean,
  time: number,
): Mp4TestFrame {
  return { data, isKeyframe, time };
}

export function createAudioFrames() {
  return [
    createFrame(Buffer.from([0xf8, 0xff, 0xfe, 0x01]), true, 0),
    createFrame(Buffer.from([0xf8, 0xff, 0xfe, 0x02]), true, 20),
    createFrame(Buffer.from([0xf8, 0xff, 0xfe, 0x03]), true, 40),
  ];
}

/** Baseline H.264 SPS (1920x1080, SAR 1:1) */
export const avcTestSps =
  "000000016742001eda01e0089f970110000003000100000300320f183196";
/** PPS paired with {@link avcTestSps} */
export const avcTestPps = "0000000168ce06e2";
/** IDR slice without parameter sets */
export const avcTestIdrSlice = "0000000165888421a0";

/**
 * SPS/PPS + IDR keyframe followed by two delta frames.
 * `timeOffset` shifts every frame time (ms).
 */
export function createVideoFrames(timeOffset = 0) {
  return [
    createFrame(
      Buffer.from(avcTestSps + avcTestPps + avcTestIdrSlice, "hex"),
      true,
      timeOffset,
    ),
    createFrame(Buffer.from("00000001419a2211", "hex"), false, timeOffset + 33),
    createFrame(Buffer.from("00000001419a3344", "hex"), false, timeOffset + 66),
  ];
}

export function createAvcKeyframeWithoutParameterSets(time: number) {
  return createFrame(Buffer.from(avcTestIdrSlice, "hex"), true, time);
}

export function createAvcKeyframeWithTruncatedSps(time: number) {
  return createFrame(
    Buffer.from("000000016742" + avcTestPps + avcTestIdrSlice, "hex"),
    true,
    time,
  );
}

export function createVideoTrack(
  dimensions: Pick<Track, "width" | "height"> = {},
  trackNumber = 1,
): Track {
  return {
    ...dimensions,
    kind: "video",
    codec: "avc1",
    clockRate: 90_000,
    trackNumber,
  };
}

export function createAudioTrack(trackNumber = 1): Track {
  return {
    kind: "audio",
    codec: "opus",
    clockRate: 48_000,
    trackNumber,
  };
}

export function createMp4Input(buffer: Buffer) {
  return new Input({
    source: new BufferSource(buffer),
    formats: [MP4],
  });
}

async function withTimeout<T>(promise: Promise<T>, timeout: number) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_, reject) => {
        timer = setTimeout(() => {
          reject(new Error(`timed out after ${timeout}ms`));
        }, timeout);
      }),
    ]);
  } finally {
    if (timer) {
      clearTimeout(timer);
    }
  }
}

function sleep(timeout: number) {
  return new Promise<void>((resolve) => {
    setTimeout(resolve, timeout);
  });
}
