/**
 * Streaming variable-frame-rate source -> RtpMediaPacer -> RTP/UDP.
 *
 * ffmpeg encodes a live (`-re`) test pattern to VP8 whose frame rate switches
 * between 30 fps and 10 fps every second, and writes IVF to stdout. Frames
 * reach Node.js through a pipe in bursts and with jitter; RtpMediaPacer sends
 * each frame at its own pts on a monotonic clock with the pts as RTP timestamp.
 *
 * run:  npx tsx packages/rtp/examples/node/pacer/ffmpeg-vfr-stream.ts
 * view: DEST_PORT=5004 npx tsx packages/rtp/examples/node/pacer/ffmpeg-vfr-stream.ts
 *       gst-launch-1.0 udpsrc port=5004 \
 *         caps="application/x-rtp,media=video,encoding-name=VP8,clock-rate=90000,payload=96" \
 *         ! rtpjitterbuffer ! rtpvp8depay ! vp8dec ! autovideosink
 *
 * Without DEST_PORT a local receiver prints, per received frame, the RTP
 * timestamp delta next to the arrival interval, so the VFR pacing is visible.
 * The last line summarizes the run: `done frames=N maxLateness=Xms delay=Yms`.
 * A large maxLateness means ffmpeg could not encode in real time (e.g. a busy
 * CPU), so frames were sent as soon as they arrived.
 *
 * Automated check: packages/rtp/tests/examples/ffmpegVfrStream.test.ts
 */
import { spawn } from "child_process";
import { createSocket } from "dgram";

import { RtpBuilder, RtpMediaPacer, RtpPacket } from "../../../src";

const CLOCK_RATE = 90_000;
const MTU_PAYLOAD = 1200;
const DURATION_SEC = Number(process.env.DURATION_SEC ?? 6);
const destPort = process.env.DEST_PORT
  ? Number(process.env.DEST_PORT)
  : undefined;

const socket = createSocket("udp4");

const main = async () => {
  const port = destPort ?? (await startLocalReceiver());

  const pacer = new RtpMediaPacer<Buffer>({
    clockRate: CLOCK_RATE,
    // headroom for pipe bursts / encoder jitter; later bursts that arrive even
    // later are absorbed by re-anchoring (tick.delay), never by skipping
    latencyMs: 50,
  });
  const builder = new RtpBuilder({ payloadType: 96, ssrc: 0x1234_5678 });
  let sourceEnded = false;
  let maxLateness = 0;

  const finish = () => {
    if (pacer.state === "stopped") return;
    pacer.stop();
    // maxLateness stays near timer jitter while the source is ahead of real
    // time; a large value means frames arrived late and were sent on arrival
    console.log(
      `done frames=${pacer.lastTick ? pacer.lastTick.frameIndex + 1 : 0} maxLateness=${maxLateness.toFixed(1)}ms delay=${pacer.delay.toFixed(1)}ms`,
    );
    // let the receiver drain the last datagrams before closing
    setTimeout(() => socket.close(), 200);
  };

  pacer.start((tick) => {
    maxLateness = Math.max(maxLateness, tick.lateness);
    // one encoded VP8 frame -> RTP packets sharing the tick's timestamp
    const chunks = splitVp8(tick.frame);
    chunks.forEach((payload, i) => {
      const rtp = builder.create(payload, {
        tick,
        marker: i === chunks.length - 1,
      });
      socket.send(rtp.serialize(), port, "127.0.0.1");
    });
    if (tick.frameIndex % 10 === 0) {
      console.log(
        `send frame=${tick.frameIndex} pts=${tick.pts} lateness=${tick.lateness.toFixed(1)}ms delay=${tick.delay.toFixed(1)}ms queue=${pacer.queueLength}`,
      );
    }
    if (sourceEnded && pacer.queueLength === 0) {
      finish();
    }
  });

  const ffmpeg = spawn("ffmpeg", [
    ...["-hide_banner", "-loglevel", "error", "-re"],
    ...["-f", "lavfi", "-i", "testsrc=size=640x480:rate=30"],
    ...["-t", String(DURATION_SEC)],
    // 30 fps for one second, then only every 3rd frame (10 fps) for one second
    ...[
      "-vf",
      "select='lt(mod(n\\,60)\\,30)+not(mod(n\\,3))'",
      "-fps_mode",
      "vfr",
    ],
    ...["-c:v", "libvpx", "-deadline", "realtime", "-b:v", "1M", "-g", "60"],
    ...["-f", "ivf", "pipe:1"],
  ]);
  ffmpeg.stderr.pipe(process.stderr);

  const ivf = new IvfStreamParser((frame, pts, timebase) => {
    // IVF pts is in `timebase` seconds -> RTP clock units
    pacer.push(frame, {
      pts: (pts * CLOCK_RATE * timebase.num) / timebase.den,
    });
  });
  ffmpeg.stdout.on("data", (data: Buffer) => ivf.write(data));
  ffmpeg.on("error", (error) => {
    console.error(`failed to run ffmpeg: ${error.message}`);
    process.exitCode = 1;
  });
  ffmpeg.on("close", (code) => {
    if (code !== 0) {
      process.exitCode = 1;
    }
    sourceEnded = true;
    if (pacer.queueLength === 0) {
      finish();
    }
  });
};

/** VP8 RTP payload (RFC 7741) with a minimal 1-byte payload descriptor. */
function splitVp8(frame: Buffer) {
  const chunks: Buffer[] = [];
  for (let offset = 0; offset < frame.length; offset += MTU_PAYLOAD) {
    const descriptor = Buffer.from([offset === 0 ? 0x10 : 0x00]); // S bit on the first chunk
    chunks.push(
      Buffer.concat([descriptor, frame.subarray(offset, offset + MTU_PAYLOAD)]),
    );
  }
  return chunks;
}

/** Incremental IVF parser: 32-byte file header, then 12-byte frame headers. */
class IvfStreamParser {
  private buffer = Buffer.alloc(0);
  private timebase?: { num: number; den: number };

  constructor(
    private onFrame: (
      frame: Buffer,
      pts: number,
      timebase: { num: number; den: number },
    ) => void,
  ) {}

  write(data: Buffer) {
    this.buffer = Buffer.concat([this.buffer, data]);
    if (!this.timebase) {
      if (this.buffer.length < 32) return;
      // header: rate (denominator) at 16, scale (numerator) at 20
      this.timebase = {
        den: this.buffer.readUInt32LE(16),
        num: this.buffer.readUInt32LE(20),
      };
      this.buffer = this.buffer.subarray(32);
    }
    while (this.buffer.length >= 12) {
      const size = this.buffer.readUInt32LE(0);
      if (this.buffer.length < 12 + size) return;
      const pts = Number(this.buffer.readBigUInt64LE(4));
      this.onFrame(
        Buffer.from(this.buffer.subarray(12, 12 + size)),
        pts,
        this.timebase,
      );
      this.buffer = this.buffer.subarray(12 + size);
    }
  }
}

/** Prints the RTP timestamp delta vs. the arrival interval of each frame. */
function startLocalReceiver() {
  const receiver = createSocket("udp4");
  let last: { timestamp: number; at: number } | undefined;
  receiver.on("message", (data) => {
    const rtp = RtpPacket.deSerialize(data);
    if (!rtp.header.marker) return;
    const at = performance.now();
    if (last) {
      const tsDeltaMs =
        (((rtp.header.timestamp - last.timestamp) >>> 0) * 1000) / CLOCK_RATE;
      console.log(
        `recv seq=${rtp.header.sequenceNumber} tsDelta=${tsDeltaMs.toFixed(1)}ms arrivalDelta=${(at - last.at).toFixed(1)}ms`,
      );
    }
    last = { timestamp: rtp.header.timestamp, at };
  });
  socket.on("close", () => receiver.close());
  return new Promise<number>((resolve) =>
    receiver.bind(0, "127.0.0.1", () => resolve(receiver.address().port)),
  );
}

main();
