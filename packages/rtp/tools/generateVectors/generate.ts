/**
 * Generate RTP payload test vectors via GStreamer → UDP → Node dgram.
 *
 * Usage (from packages/rtp):
 *   npx tsx tools/generateVectors/generate.ts
 *
 * Requires gst-launch-1.0 and codec plugins (see README.md).
 * Output: packages/rtp/tests/data/vector_*.bin (raw RTP payloads concatenated
 * with 2-byte length prefixes for multi-packet files).
 */

import { spawn, type ChildProcess } from "child_process";
import { createSocket } from "dgram";
import { mkdirSync, writeFileSync } from "fs";
import { join } from "path";

import { RtpPacket } from "../../src";

const OUT_DIR = join(__dirname, "../../tests/data");
const HOST = "127.0.0.1";
const COLLECT_MS = 2500;
const MAX_PACKETS = 8;

type CodecJob = {
  name: string;
  outFile: string;
  /** gst-launch-1.0 element chain without udpsink (port filled in). */
  pipeline: (port: number) => string[];
};

const jobs: CodecJob[] = [
  {
    name: "PCMU",
    outFile: "vector_pcmu.bin",
    pipeline: (port) => [
      "audiotestsrc",
      "num-buffers=20",
      "!",
      "audioconvert",
      "!",
      "audio/x-raw,rate=8000,channels=1",
      "!",
      "mulawenc",
      "!",
      "rtppcmupay",
      "!",
      `udpsink`,
      `host=${HOST}`,
      `port=${port}`,
    ],
  },
  {
    name: "PCMA",
    outFile: "vector_pcma.bin",
    pipeline: (port) => [
      "audiotestsrc",
      "num-buffers=20",
      "!",
      "audioconvert",
      "!",
      "audio/x-raw,rate=8000,channels=1",
      "!",
      "alawenc",
      "!",
      "rtppcmapay",
      "!",
      `udpsink`,
      `host=${HOST}`,
      `port=${port}`,
    ],
  },
  {
    name: "G722",
    outFile: "vector_g722.bin",
    pipeline: (port) => [
      "audiotestsrc",
      "num-buffers=20",
      "!",
      "audioconvert",
      "!",
      "audio/x-raw,rate=16000,channels=1",
      "!",
      "avenc_g722",
      "!",
      "rtpg722pay",
      "!",
      `udpsink`,
      `host=${HOST}`,
      `port=${port}`,
    ],
  },
  {
    name: "AAC",
    outFile: "vector_aac.bin",
    pipeline: (port) => [
      "audiotestsrc",
      "num-buffers=30",
      "!",
      "audioconvert",
      "!",
      "audio/x-raw,rate=48000,channels=2",
      "!",
      "avenc_aac",
      "!",
      "rtpmp4gpay",
      "!",
      `udpsink`,
      `host=${HOST}`,
      `port=${port}`,
    ],
  },
  {
    name: "H265",
    outFile: "vector_h265.bin",
    pipeline: (port) => [
      "videotestsrc",
      "num-buffers=10",
      "!",
      "video/x-raw,width=320,height=240,format=I420",
      "!",
      "x265enc",
      "tune=zerolatency",
      "!",
      "rtph265pay",
      "config-interval=1",
      "!",
      `udpsink`,
      `host=${HOST}`,
      `port=${port}`,
    ],
  },
];

/** Multi-payload file: [u16be length][payload]... */
function encodePayloadBag(payloads: Buffer[]): Buffer {
  const parts: Buffer[] = [];
  for (const p of payloads) {
    const len = Buffer.alloc(2);
    len.writeUInt16BE(p.length, 0);
    parts.push(len, p);
  }
  return Buffer.concat(parts);
}

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const s = createSocket("udp4");
    s.bind(0, HOST, () => {
      const addr = s.address();
      const port = typeof addr === "string" ? 0 : addr.port;
      s.close(() => resolve(port));
    });
    s.on("error", reject);
  });
}

async function collectCodec(job: CodecJob): Promise<void> {
  const port = await freePort();
  const payloads: Buffer[] = [];

  const udp = createSocket("udp4");
  await new Promise<void>((resolve, reject) => {
    udp.once("error", reject);
    udp.bind(port, HOST, () => resolve());
  });

  udp.on("message", (msg) => {
    if (payloads.length >= MAX_PACKETS) return;
    try {
      const rtp = RtpPacket.deSerialize(msg);
      payloads.push(Buffer.from(rtp.payload));
    } catch {
      // ignore non-RTP
    }
  });

  const args = job.pipeline(port);
  let child: ChildProcess | undefined;
  try {
    child = spawn("gst-launch-1.0", ["-q", ...args], {
      stdio: ["ignore", "pipe", "pipe"],
    });
  } catch (e) {
    udp.close();
    console.warn(`[${job.name}] failed to spawn gst-launch-1.0:`, e);
    return;
  }

  let stderr = "";
  child.stderr?.on("data", (d) => {
    stderr += d.toString();
  });

  await new Promise<void>((resolve) => {
    const timer = setTimeout(() => resolve(), COLLECT_MS);
    child!.on("exit", () => {
      // wait a bit more for late UDP
      setTimeout(() => {
        clearTimeout(timer);
        resolve();
      }, 200);
    });
  });

  try {
    child.kill("SIGTERM");
  } catch {
    /* already exited */
  }
  udp.close();

  if (payloads.length === 0) {
    console.warn(
      `[${job.name}] no RTP payloads received (plugin missing?). stderr:\n${stderr.slice(0, 400)}`,
    );
    return;
  }

  mkdirSync(OUT_DIR, { recursive: true });
  const outPath = join(OUT_DIR, job.outFile);
  writeFileSync(outPath, encodePayloadBag(payloads));
  console.log(
    `[${job.name}] wrote ${payloads.length} payloads → ${job.outFile} (${payloads.reduce((n, p) => n + p.length, 0)} data bytes)`,
  );
}

async function main() {
  console.log("Generating RTP test vectors with GStreamer…");
  for (const job of jobs) {
    await collectCodec(job);
  }
  console.log("Done. Commit tests/data/vector_*.bin if refreshed.");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
