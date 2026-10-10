import { readFileSync } from "fs";

import { BufferSource, Input, MP4 } from "mediabunny";

import { MP4Callback, type Track } from "../src/extra";
import type { Mp4Output } from "../src/extra/processor/mp4";
import { RtcpRrPacket } from "../src/rtcp/rr";
import { RtpHeader } from "../src/rtp/rtp";
import { type SrtpProfile, keyLength, saltLength } from "../src/srtp/const";
import { SrtcpContext } from "../src/srtp/context/srtcp";
import { SrtpContext } from "../src/srtp/context/srtp";
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

/**
 * Arrange: sender/receiver SRTP and SRTCP contexts sharing one master key,
 * plus helpers that protect an RTP packet (by sequence number) or an RTCP RR.
 */
export function createSrtpContextPair(profile: SrtpProfile) {
  const masterKey = Buffer.alloc(keyLength(profile), 0x11);
  const masterSalt = Buffer.alloc(saltLength(profile), 0x22);
  const sender = new SrtpContext(masterKey, masterSalt, profile);
  const receiver = new SrtpContext(masterKey, masterSalt, profile);
  const rtcpSender = new SrtcpContext(masterKey, masterSalt, profile);
  const rtcpReceiver = new SrtcpContext(masterKey, masterSalt, profile);
  const ssrc = 0x1234;
  return {
    receiver,
    rtcpReceiver,
    protectRtp: (sequenceNumber: number) =>
      sender.encryptRtp(
        Buffer.from([sequenceNumber & 0xff]),
        new RtpHeader({ ssrc, sequenceNumber, payloadType: 96 }),
      ),
    protectRtcp: () =>
      rtcpSender.encryptRTCP(
        new RtcpRrPacket({ ssrc, reports: [] }).serialize(),
      ),
  };
}
