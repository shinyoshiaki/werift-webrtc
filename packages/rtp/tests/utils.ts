import { readFileSync } from "fs";

import { BufferSource, Input, MP4 } from "mediabunny";

import { MP4Callback, type Track } from "../src/extra";
import type { Mp4Output } from "../src/extra/processor/mp4";
import { RtpHeader, RtpPacket } from "../src/rtp/rtp";
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

export function createRtpPacket(
  sequenceNumber: number,
  timestamp: number,
  {
    ssrc = 0x11111111,
    payloadType = 96,
    marker = false,
    payload = Buffer.from([sequenceNumber & 0xff]),
  }: {
    ssrc?: number;
    payloadType?: number;
    marker?: boolean;
    payload?: Buffer;
  } = {},
) {
  return new RtpPacket(
    new RtpHeader({ sequenceNumber, timestamp, ssrc, payloadType, marker }),
    payload,
  );
}

/**
 * Video-like packets: `frames` frames of `packetsPerFrame` packets that share
 * one timestamp each. Sequence numbers and timestamps wrap at 16/32 bits.
 */
export function createFramePackets({
  startSequenceNumber,
  startTimestamp,
  frames,
  packetsPerFrame = 1,
  timestampStep = 3000,
  ssrc,
}: {
  startSequenceNumber: number;
  startTimestamp: number;
  frames: number;
  packetsPerFrame?: number;
  timestampStep?: number;
  ssrc?: number;
}) {
  const packets: RtpPacket[] = [];
  for (let frame = 0; frame < frames; frame++) {
    const timestamp = (startTimestamp + frame * timestampStep) >>> 0;
    for (let i = 0; i < packetsPerFrame; i++) {
      const sequenceNumber =
        (startSequenceNumber + frame * packetsPerFrame + i) & 0xffff;
      packets.push(
        createRtpPacket(sequenceNumber, timestamp, {
          ssrc,
          marker: i === packetsPerFrame - 1,
        }),
      );
    }
  }
  return packets;
}
