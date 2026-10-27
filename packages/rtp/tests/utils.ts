import { spawn, spawnSync } from "child_process";
import { createSocket } from "dgram";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs";
import { BufferSource, Input, MP4 } from "mediabunny";
import { tmpdir } from "os";
import { join } from "path";

import {
  MP4Callback,
  type Track,
  WebmCallback,
  type WebmOutput,
  type WebmTrack,
  saveToFileSystem,
} from "../src/extra";
import { vintDecode } from "../src/extra/container/webm/ebml/ebml";
import type { Mp4Output } from "../src/extra/processor/mp4";
import {
  RtpMediaClock,
  type RtpMediaClockOptions,
  type RtpMediaClockTick,
  RtpMediaPacer,
  type RtpMediaPacerOptions,
  type RtpMediaPacerTick,
} from "../src/rtp/mediaClock";
import { RtpHeader, RtpPacket } from "../src/rtp/rtp";
import type { Transport } from "../src/transport";

export function load(name: string) {
  const base = __dirname;
  const data = readFileSync(`${base}/data/` + name);
  return data;
}

/**
 * Decode committed RTP payload vectors from tools/generateVectors:
 * repeated [u16be length][payload] records.
 */
export function loadPayloadVector(name: string): Buffer[] {
  const path = join(__dirname, "data", name);
  let buf: Buffer;
  try {
    buf = readFileSync(path);
  } catch {
    return [];
  }
  const out: Buffer[] = [];
  let offset = 0;
  while (offset + 2 <= buf.length) {
    const len = buf.readUInt16BE(offset);
    offset += 2;
    if (offset + len > buf.length) {
      throw new Error(
        `vector ${name}: truncated payload at offset ${offset}, len ${len}`,
      );
    }
    out.push(buf.subarray(offset, offset + len));
    offset += len;
  }
  return out;
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
 * Build an avcC record (ISO/IEC 14496-15 §5.3.3.1) from raw SPS/PPS NAL units
 * (no start code / length prefix).
 */
export function createAvcDecoderConfigurationRecord({
  sps,
  pps,
  naluLengthSize = 4,
}: {
  sps: Buffer[];
  pps: Buffer[];
  naluLengthSize?: 1 | 2 | 4;
}): Buffer {
  const withLength = (nal: Buffer) => {
    const length = Buffer.alloc(2);
    length.writeUInt16BE(nal.length);
    return [length, nal];
  };
  return Buffer.concat([
    Buffer.from([0x01, sps[0][1], sps[0][2], sps[0][3]]),
    Buffer.from([0xfc | (naluLengthSize - 1), 0xe0 | sps.length]),
    ...sps.flatMap(withLength),
    Buffer.from([pps.length]),
    ...pps.flatMap(withLength),
  ]);
}

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

const h264NaluType = { idr: 5, sps: 7, pps: 8, aud: 9 } as const;

/**
 * Loads an H.264 Annex B fixture generated by `tests/data/h264/generate.sh`
 * and splits it into access units (one frame each) at every AUD NAL.
 */
export function loadH264AccessUnits(name: string, fps = 30): Mp4TestFrame[] {
  const accessUnits: Buffer[][] = [];
  for (const nalu of splitAnnexBNalUnits(load(`h264/${name}`))) {
    if ((nalu[0] & 0x1f) === h264NaluType.aud || accessUnits.length === 0) {
      accessUnits.push([]);
    }
    accessUnits.at(-1)!.push(nalu);
  }

  return accessUnits.map((nalUnits, i) =>
    createFrame(
      joinAnnexBNalUnits(nalUnits),
      nalUnits.some((nalu) => (nalu[0] & 0x1f) === h264NaluType.idr),
      (i * 1000) / fps,
    ),
  );
}

/** Returns a copy of the frame without SPS / PPS NAL units. */
export function stripH264ParameterSets(frame: Mp4TestFrame): Mp4TestFrame {
  const nalUnits = splitAnnexBNalUnits(frame.data).filter((nalu) => {
    const type = nalu[0] & 0x1f;
    return type !== h264NaluType.sps && type !== h264NaluType.pps;
  });
  return { ...frame, data: joinAnnexBNalUnits(nalUnits) };
}

/** Returns a copy of the frame whose SPS NAL unit is cut to `length` bytes. */
export function truncateH264Sps(
  frame: Mp4TestFrame,
  length: number,
): Mp4TestFrame {
  const nalUnits = splitAnnexBNalUnits(frame.data).map((nalu) =>
    (nalu[0] & 0x1f) === h264NaluType.sps ? nalu.subarray(0, length) : nalu,
  );
  return { ...frame, data: joinAnnexBNalUnits(nalUnits) };
}

function splitAnnexBNalUnits(data: Buffer) {
  const starts: { codeStart: number; payloadStart: number }[] = [];
  for (let i = 0; i + 2 < data.length; i++) {
    if (data[i] === 0 && data[i + 1] === 0 && data[i + 2] === 1) {
      const codeStart = i > 0 && data[i - 1] === 0 ? i - 1 : i;
      starts.push({ codeStart, payloadStart: i + 3 });
      i += 2;
    }
  }
  return starts.map(({ payloadStart }, i) =>
    data.subarray(payloadStart, starts[i + 1]?.codeStart ?? data.length),
  );
}

function joinAnnexBNalUnits(nalUnits: Buffer[]) {
  const startCode = Buffer.from([0, 0, 0, 1]);
  return Buffer.concat(nalUnits.flatMap((nalu) => [startCode, nalu]));
}

/**
 * Feeds the frames to an MP4Callback (video, then optional audio frames
 * interleaved by index), sends EOL on every track and collects the outputs.
 */
export function muxMp4Frames(
  tracks: Track[],
  videoFrames: Mp4TestFrame[],
  audioFrames: Mp4TestFrame[] = [],
) {
  return collectMp4Outputs(tracks, (mp4) => {
    for (let i = 0; i < Math.max(videoFrames.length, audioFrames.length); i++) {
      if (videoFrames[i]) {
        mp4.inputVideo({ frame: videoFrames[i] });
      }
      if (audioFrames[i]) {
        mp4.inputAudio({ frame: audioFrames[i] });
      }
    }
    if (audioFrames.length > 0) {
      mp4.inputAudio({ eol: true });
    }
    mp4.inputVideo({ eol: true });
  });
}

export type FfprobeVideoResult = {
  profile: string;
  width: number;
  height: number;
  sampleAspectRatio: string;
  displayAspectRatio: string;
  decodedFrames: number;
  /** stderr of ffprobe at `-v error`; empty when decoding had no errors */
  errors: string;
};

export function isFfprobeAvailable() {
  return spawnSync("ffprobe", ["-version"]).status === 0;
}

/**
 * Decodes every frame of the first video stream with ffprobe
 * and returns the stream parameters seen by FFmpeg.
 */
export function probeMp4Video(buffer: Buffer): FfprobeVideoResult {
  const dir = mkdtempSync(join(tmpdir(), "werift-rtp-mp4-"));
  try {
    const path = join(dir, "output.mp4");
    writeFileSync(path, buffer);
    const result = spawnSync(
      "ffprobe",
      [
        "-v",
        "error",
        "-count_frames",
        "-select_streams",
        "v:0",
        "-show_entries",
        "stream=profile,width,height,sample_aspect_ratio,display_aspect_ratio,nb_read_frames",
        "-of",
        "json",
        path,
      ],
      { encoding: "utf8" },
    );
    if (result.status !== 0) {
      throw new Error(`ffprobe failed: ${result.stderr}`);
    }
    const [stream] = JSON.parse(result.stdout).streams;
    return {
      profile: stream.profile,
      width: stream.width,
      height: stream.height,
      sampleAspectRatio: stream.sample_aspect_ratio,
      displayAspectRatio: stream.display_aspect_ratio,
      decodedFrames: Number(stream.nb_read_frames),
      errors: result.stderr,
    };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
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
 * Virtual monotonic clock + scheduler for deterministic `RtpMediaClock` tests.
 *
 * - `advance(ms)`: moves time forward and fires due timers in deadline order.
 * - `block(ms)`: moves time forward without firing timers (stalled event loop).
 * - `callbackLatency`: every timer fires this many ms after its due time.
 */
export function createManualMediaClockHarness(
  options: { startTime?: number; callbackLatency?: number } = {},
) {
  const callbackLatency = options.callbackLatency ?? 0;
  let currentTime = options.startTime ?? 0;
  let nextHandle = 0;
  const timers = new Map<number, { at: number; cb: () => void }>();

  const now = () => currentTime;
  const scheduler = {
    setTimeout(cb: () => void, ms: number) {
      const handle = ++nextHandle;
      timers.set(handle, { at: currentTime + ms + callbackLatency, cb });
      return handle;
    },
    clearTimeout(handle: unknown) {
      timers.delete(handle as number);
    },
  };

  const fireDueTimers = (until: number) => {
    for (;;) {
      let due: [number, { at: number; cb: () => void }] | undefined;
      for (const entry of timers) {
        if (entry[1].at <= until && (!due || entry[1].at < due[1].at)) {
          due = entry;
        }
      }
      if (!due) {
        return;
      }
      timers.delete(due[0]);
      currentTime = Math.max(currentTime, due[1].at);
      due[1].cb();
    }
  };

  const advance = (ms: number) => {
    const target = currentTime + ms;
    fireDueTimers(target);
    currentTime = target;
  };

  const block = (ms: number) => {
    currentTime += ms;
  };

  const createClock = (
    clockOptions: Omit<RtpMediaClockOptions, "now" | "scheduler">,
  ) => new RtpMediaClock({ ...clockOptions, now, scheduler });

  const collectTicks = (clock: RtpMediaClock) => {
    const ticks: RtpMediaClockTick[] = [];
    clock.onTick.subscribe((tick) => {
      ticks.push(tick);
    });
    return ticks;
  };

  const createPacer = <T = Buffer>(
    pacerOptions: Omit<RtpMediaPacerOptions, "now" | "scheduler">,
  ) => new RtpMediaPacer<T>({ ...pacerOptions, now, scheduler });

  const collectPacerTicks = <T>(pacer: RtpMediaPacer<T>) => {
    const ticks: (RtpMediaPacerTick<T> & { firedAt: number })[] = [];
    pacer.onTick.subscribe((tick) => {
      ticks.push({ ...tick, firedAt: currentTime });
    });
    return ticks;
  };

  return {
    now,
    scheduler,
    advance,
    block,
    createClock,
    collectTicks,
    createPacer,
    collectPacerTicks,
    pendingTimerCount: () => timers.size,
  };
}

/** Counts active Node.js `Timeout` resources. */
export function activeTimeoutCount() {
  return process.getActiveResourcesInfo().filter((name) => name === "Timeout")
    .length;
}

/** Real-timer scheduler that records every handle it creates. */
export function createRecordingScheduler() {
  const handles: ReturnType<typeof setTimeout>[] = [];
  return {
    handles,
    scheduler: {
      setTimeout(cb: () => void, ms: number) {
        const handle = setTimeout(cb, ms);
        handles.push(handle);
        return handle;
      },
      clearTimeout(handle: unknown) {
        clearTimeout(handle as ReturnType<typeof setTimeout>);
      },
    },
  };
}

/** Pre-encoded video access units: a keyframe every `keyframeInterval` frames. */
export function createEncodedVideoFrames(
  count: number,
  keyframeInterval: number,
) {
  return Array.from({ length: count }, (_, index) => ({
    index,
    keyframe: index % keyframeInterval === 0,
    payload: Buffer.from([index & 0xff]),
  }));
}

/**
 * Variable-frame-rate frame timings in 90 kHz units. Frame durations cycle
 * through `durations` (default 1500 / 3000 / 4500 samples = 16.7 / 33.3 / 50 ms).
 */
export function createVfrTimings(
  count: number,
  durations: number[] = [1500, 3000, 4500],
) {
  let pts = 0;
  return Array.from({ length: count }, (_, index) => {
    const timing = { index, pts };
    pts += durations[index % durations.length];
    return timing;
  });
}

/**
 * Arrivals of a live (streaming) VFR source in 90 kHz units: frame `i` is
 * captured at `pts / 90` ms and reaches the application `jitterMs[i % n]` ms
 * later. With `burstSize > 1`, frames are delivered in chunks together with the
 * last frame of each chunk (e.g. a pipe flushing several frames at once).
 */
export function createStreamingVfrArrivals(
  count: number,
  options: {
    durations?: number[];
    jitterMs?: number[];
    burstSize?: number;
  } = {},
) {
  const jitterMs = options.jitterMs ?? [0];
  const burstSize = options.burstSize ?? 1;
  const frames = createVfrTimings(count, options.durations).map((timing) => ({
    ...timing,
    arrivalMs: timing.pts / 90 + jitterMs[timing.index % jitterMs.length],
  }));
  return frames.map((frame) => {
    const last = Math.min(
      frames.length - 1,
      Math.floor(frame.index / burstSize) * burstSize + burstSize - 1,
    );
    return {
      ...frame,
      arrivalMs: Math.max(frame.arrivalMs, frames[last].arrivalMs),
    };
  });
}

/** Pushes each arrival into `pacer` at `startMs + arrivalMs` on the harness timer. */
export function deliverStreamingArrivals(
  harness: ReturnType<typeof createManualMediaClockHarness>,
  pacer: RtpMediaPacer<number>,
  arrivals: ReturnType<typeof createStreamingVfrArrivals>,
  startMs = harness.now(),
) {
  for (const arrival of arrivals) {
    harness.scheduler.setTimeout(
      () => pacer.push(arrival.index, { pts: arrival.pts }),
      startMs + arrival.arrivalMs - harness.now(),
    );
  }
}

const PACKAGE_ROOT = join(__dirname, "..");

/**
 * Runs `packages/rtp/<relativePath>` with Node's TypeScript support in a separate process,
 * the same way a user runs an example, and collects its output.
 */
export function runExample(
  relativePath: string,
  options: { env?: Record<string, string>; timeoutMs?: number } = {},
) {
  const child = spawn(
    process.execPath,
    [
      "--experimental-transform-types",
      "--disable-warning=ExperimentalWarning",
      "--disable-warning=MODULE_TYPELESS_PACKAGE_JSON",
      "--import",
      join(PACKAGE_ROOT, "..", "..", "tools/node-ts/register.mjs"),
      join(PACKAGE_ROOT, relativePath),
    ],
    {
      cwd: PACKAGE_ROOT,
      env: { ...process.env, ...options.env },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (data) => {
    stdout += data;
  });
  child.stderr.on("data", (data) => {
    stderr += data;
  });
  return new Promise<{
    code: number | null;
    signal: NodeJS.Signals | null;
    stdout: string;
    stderr: string;
  }>((resolve, reject) => {
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(
        new Error(
          `example ${relativePath} timed out\nstdout:\n${stdout}\nstderr:\n${stderr}`,
        ),
      );
    }, options.timeoutMs ?? 30_000);
    child.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on("close", (code, signal) => {
      clearTimeout(timer);
      resolve({ code, signal, stdout, stderr });
    });
  });
}

/** UDP socket on 127.0.0.1 that records every received RTP packet. */
export async function createRtpUdpCollector() {
  const socket = createSocket("udp4");
  const packets: { rtp: RtpPacket; at: number }[] = [];
  socket.on("message", (data) => {
    packets.push({ rtp: RtpPacket.deSerialize(data), at: performance.now() });
  });
  await new Promise<void>((resolve) => socket.bind(0, "127.0.0.1", resolve));
  return {
    port: socket.address().port,
    packets,
    close: () => new Promise<void>((resolve) => socket.close(() => resolve())),
  };
}

// ---------------------------------------------------------------------------
// H.264 RTP payload builders (RFC 6184)

/** H.264 NAL unit: header (F=0, NRI, type) + body */
export function createH264Nal(type: number, body: Buffer, nri = 3): Buffer {
  return Buffer.concat([Buffer.from([(nri << 5) | (type & 0x1f)]), body]);
}

/** STAP-A payload (RFC 6184 §5.7.1): STAP-A NAL header + [u16be size][NALU]... */
export function createH264StapAPayload(nalus: Buffer[], nri = 3): Buffer {
  const parts: Buffer[] = [Buffer.from([(nri << 5) | 24])];
  for (const nalu of nalus) {
    const size = Buffer.alloc(2);
    size.writeUInt16BE(nalu.length, 0);
    parts.push(size, nalu);
  }
  return Buffer.concat(parts);
}

/**
 * FU-A payloads (RFC 6184 §5.8) splitting `nal` body into `fragmentCount`
 * fragments. Returned in order: start (S=1) ... end (E=1).
 */
export function createH264FuAPayloads(nal: Buffer, fragmentCount: number) {
  const nri = (nal[0] >> 5) & 0x03;
  const type = nal[0] & 0x1f;
  const body = nal.subarray(1);
  const chunkSize = Math.ceil(body.length / fragmentCount);
  const payloads: Buffer[] = [];
  for (let i = 0; i < fragmentCount; i++) {
    const s = i === 0 ? 0x80 : 0;
    const e = i === fragmentCount - 1 ? 0x40 : 0;
    payloads.push(
      Buffer.concat([
        Buffer.from([(nri << 5) | 28, s | e | type]),
        body.subarray(i * chunkSize, (i + 1) * chunkSize),
      ]),
    );
  }
  return payloads;
}

/** Wrap payloads of one frame into RTP packets (marker on the last one). */
export function createH264RtpPackets(payloads: Buffer[], timestamp = 0) {
  return payloads.map(
    (payload, i) =>
      new RtpPacket(
        new RtpHeader({
          payloadType: 96,
          sequenceNumber: i,
          timestamp,
          marker: i === payloads.length - 1,
        }),
        payload,
      ),
  );
}

// ---------------------------------------------------------------------------
// WebM

export function createWebmTracks(): WebmTrack[] {
  return [
    {
      kind: "video",
      codec: "VP8",
      clockRate: 90_000,
      trackNumber: 1,
      width: 640,
      height: 480,
    },
    { kind: "audio", codec: "OPUS", clockRate: 48_000, trackNumber: 2 },
  ];
}

/**
 * Video frames every 33 ms with a keyframe every `keyframeInterval` frames,
 * and audio frames every 20 ms, both covering `durationMs`.
 */
export function createWebmFrames(durationMs: number, keyframeInterval = 30) {
  const video = Array.from({ length: Math.ceil(durationMs / 33) }, (_, i) =>
    createFrame(
      Buffer.alloc(100, i & 0xff),
      i % keyframeInterval === 0,
      i * 33,
    ),
  );
  const audio = Array.from({ length: Math.ceil(durationMs / 20) }, (_, i) =>
    createFrame(Buffer.from([0xf8, 0xff, 0xfe, i & 0xff]), true, i * 20),
  );
  return { video, audio };
}

/** Feeds frames to `webm` in time order, then sends EOL on every track. */
export function feedWebmFrames(
  webm: WebmCallback,
  frames: ReturnType<typeof createWebmFrames>,
) {
  const events = [
    ...frames.video.map((frame) => ({ frame, input: webm.inputVideo })),
    ...frames.audio.map((frame) => ({ frame, input: webm.inputAudio })),
  ].sort((a, b) => a.frame.time - b.frame.time);
  for (const { frame, input } of events) {
    input({ frame });
  }
  webm.inputVideo({});
  webm.inputAudio({});
}

/**
 * Records with `WebmCallback` and either `saveToFileSystem` (`file`) or plain
 * concatenation of `saveToFile` chunks (`stream`), returning the bytes.
 */
export async function recordWebm(
  frames: ReturnType<typeof createWebmFrames>,
  mode: "file" | "stream" = "file",
) {
  const dir = mkdtempSync(join(tmpdir(), "werift-rtp-webm-"));
  const path = join(dir, "output.webm");
  const chunks: Buffer[] = [];
  try {
    const save = saveToFileSystem(path);
    const done = new Promise<void>((resolve) => {
      const webm = new WebmCallback(createWebmTracks(), { duration: 60_000 });
      webm.pipe(async (output: WebmOutput) => {
        if (mode === "file") {
          await save(output);
        } else if (output.saveToFile) {
          chunks.push(output.saveToFile);
        }
        if (output.eol) {
          resolve();
        }
      });
      feedWebmFrames(webm, frames);
    });
    await withTimeout(done, 5_000);
    return mode === "file" ? readFileSync(path) : Buffer.concat(chunks);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

export type EbmlElementHeader = {
  id: number;
  /** offset of the element ID */
  position: number;
  /** offset of the element body */
  dataPosition: number;
  /** undefined for unknown size */
  size?: number;
};

export function readEbmlElementHeader(
  buf: Buffer,
  position: number,
): EbmlElementHeader {
  const idLength = vintDecode(buf, position).length;
  const id = buf.readUIntBE(position, idLength);
  const size = vintDecode(buf, position + idLength);
  return {
    id,
    position,
    dataPosition: position + idLength + size.length,
    size: size.unknown ? undefined : Number(size.value),
  };
}

/** Lists the direct children of the element at `parent` by following sizes. */
export function readEbmlChildren(buf: Buffer, parent: EbmlElementHeader) {
  const end =
    parent.size == undefined ? buf.length : parent.dataPosition + parent.size;
  const children: EbmlElementHeader[] = [];
  for (let position = parent.dataPosition; position < end; ) {
    const child = readEbmlElementHeader(buf, position);
    children.push(child);
    if (child.size == undefined) {
      break;
    }
    position = child.dataPosition + child.size;
  }
  return children;
}

/** Reads every CueClusterPosition (relative to the Segment body) in Cues. */
export function readCueClusterPositions(buf: Buffer, cues: EbmlElementHeader) {
  const ids = {
    cuePoint: 0xbb,
    cueTrackPositions: 0xb7,
    cueClusterPosition: 0xf1,
  };
  return readEbmlChildren(buf, cues)
    .filter((e) => e.id === ids.cuePoint)
    .flatMap((point) => readEbmlChildren(buf, point))
    .filter((e) => e.id === ids.cueTrackPositions)
    .flatMap((track) => readEbmlChildren(buf, track))
    .filter((e) => e.id === ids.cueClusterPosition)
    .map((e) => buf.readUIntBE(e.dataPosition, e.size!));
}

/** Runs ffprobe at `-v warning` over the WebM bytes and returns stderr. */
export function probeWebmWarnings(buffer: Buffer) {
  const dir = mkdtempSync(join(tmpdir(), "werift-rtp-webm-"));
  try {
    const path = join(dir, "output.webm");
    writeFileSync(path, buffer);
    const result = spawnSync(
      "ffprobe",
      ["-v", "warning", "-show_entries", "format=duration", path],
      { encoding: "utf8" },
    );
    return result.stderr;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
