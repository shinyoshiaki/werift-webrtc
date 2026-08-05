/**
 * Generate RTP payload test vectors via GStreamer → UDP → Node dgram.
 *
 * Usage (from packages/rtp):
 *   npx tsx tools/generateVectors/generate.ts
 *
 * Requires gst-launch-1.0 and codec plugins (see README.md).
 * If GStreamer is missing or yields no packets, falls back to
 * writeSyntheticVectors() (RFC wire-format packetizer payloads).
 *
 * Output: packages/rtp/tests/data/vector_*.bin
 * Format: [u16be length][payload] repeated.
 */

import { spawn, type ChildProcess } from "child_process";
import { createSocket } from "dgram";
import { mkdirSync, writeFileSync } from "fs";
import { join } from "path";

import { RtpPacket } from "../../src";
import { buildExpectedFromVectors } from "./buildExpectedFromVectors";
import { writeSyntheticVectors } from "./writeSyntheticVectors";

const OUT_DIR = join(__dirname, "../../tests/data");
const HOST = "127.0.0.1";
const COLLECT_MS = 2500;
const MAX_PACKETS = 8;

type CodecJob = {
  name: string;
  outFile: string;
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
      "udpsink",
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
      "udpsink",
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
      "udpsink",
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
      "udpsink",
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
      "udpsink",
      `host=${HOST}`,
      `port=${port}`,
    ],
  },
  // Existing-codec packetizers (RFC 7741 / 9628 / 6184 / 7587; AV1 RTP)
  {
    name: "VP8",
    outFile: "vector_vp8.bin",
    pipeline: (port) => [
      "videotestsrc",
      "num-buffers=8",
      "!",
      "video/x-raw,width=160,height=120,format=I420,framerate=15/1",
      "!",
      "vp8enc",
      "deadline=1",
      "!",
      "rtpvp8pay",
      "!",
      "udpsink",
      `host=${HOST}`,
      `port=${port}`,
    ],
  },
  {
    name: "VP9",
    outFile: "vector_vp9.bin",
    pipeline: (port) => [
      "videotestsrc",
      "num-buffers=6",
      "!",
      "video/x-raw,width=160,height=120,format=I420,framerate=15/1",
      "!",
      "vp9enc",
      "deadline=1",
      "!",
      "rtpvp9pay",
      "!",
      "udpsink",
      `host=${HOST}`,
      `port=${port}`,
    ],
  },
  {
    name: "H264",
    outFile: "vector_h264.bin",
    pipeline: (port) => [
      "videotestsrc",
      "num-buffers=8",
      "!",
      "video/x-raw,width=160,height=120,format=I420,framerate=15/1",
      "!",
      "x264enc",
      "tune=zerolatency",
      "!",
      "rtph264pay",
      "config-interval=1",
      "aggregate-mode=zero-latency",
      "!",
      "udpsink",
      `host=${HOST}`,
      `port=${port}`,
    ],
  },
  {
    name: "Opus",
    outFile: "vector_opus.bin",
    pipeline: (port) => [
      "audiotestsrc",
      "num-buffers=20",
      "!",
      "audioconvert",
      "!",
      "audio/x-raw,rate=48000,channels=2",
      "!",
      "opusenc",
      "!",
      "rtpopuspay",
      "!",
      "udpsink",
      `host=${HOST}`,
      `port=${port}`,
    ],
  },
  // AV1 RTP payloader is not always available (no rtpav1pay on many distros).
  // When missing, collectCodec returns false and synthetic Av1Packetizer fills in.
];

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

/** @returns true if vectors were written */
async function collectCodec(job: CodecJob): Promise<boolean> {
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
    return false;
  }

  let stderr = "";
  let spawnError: Error | undefined;
  child.stderr?.on("data", (d) => {
    stderr += d.toString();
  });
  child.on("error", (err) => {
    spawnError = err;
    console.warn(
      `[${job.name}] gst-launch-1.0 process error: ${err.message}. ` +
        `Install GStreamer and codec plugins, or use synthetic vector fallback.`,
    );
  });

  await new Promise<void>((resolve) => {
    const timer = setTimeout(() => resolve(), COLLECT_MS);
    child!.on("exit", () => {
      setTimeout(() => {
        clearTimeout(timer);
        resolve();
      }, 200);
    });
    child!.on("error", () => {
      clearTimeout(timer);
      resolve();
    });
  });

  try {
    child.kill("SIGTERM");
  } catch {
    /* already exited */
  }
  udp.close();

  if (spawnError) {
    console.warn(`[${job.name}] skipped (spawn error: ${spawnError.message})`);
    return false;
  }

  if (payloads.length === 0) {
    console.warn(
      `[${job.name}] no RTP payloads received (plugin missing or pipeline failed). stderr:\n${stderr.slice(0, 400)}`,
    );
    return false;
  }

  mkdirSync(OUT_DIR, { recursive: true });
  const outPath = join(OUT_DIR, job.outFile);
  writeFileSync(outPath, encodePayloadBag(payloads));
  // Keep *_expected.bin in sync for codecs whose payload is the media body
  // (G.711 / G.722). AAC/H.265 need depacketization; synthetic fallback writes those.
  const expectedName = expectedBodyFile(job.name);
  if (expectedName) {
    writeFileSync(join(OUT_DIR, expectedName), Buffer.concat(payloads));
    console.log(`[${job.name}] also wrote ${expectedName}`);
  }
  console.log(
    `[${job.name}] wrote ${payloads.length} payloads → ${job.outFile} (${payloads.reduce((n, p) => n + p.length, 0)} data bytes)`,
  );
  return true;
}

/** Sidecar expected media body for round-trip tests (raw payload codecs). */
function expectedBodyFile(codecName: string): string | null {
  switch (codecName) {
    case "PCMU":
      return "vector_pcmu_expected.bin";
    case "PCMA":
      return "vector_pcma_expected.bin";
    case "G722":
      return "vector_g722_expected.bin";
    case "Opus":
      // RFC 7587: RTP payload is the Opus packet itself
      return "vector_opus_expected.bin";
    default:
      return null;
  }
}

async function main() {
  // Synthetic baseline first so every codec has a committed-shape file even
  // when a GStreamer plugin is missing (e.g. no rtpav1pay). GST overwrites.
  console.log("Writing synthetic baseline vectors (package packetizers)…");
  writeSyntheticVectors();

  console.log("Capturing GStreamer vectors (overwrites synthetic when OK)…");
  let wrote = 0;
  const ok: string[] = [];
  for (const job of jobs) {
    if (await collectCodec(job)) {
      wrote++;
      ok.push(job.name);
    }
  }

  writeFileSync(
    join(OUT_DIR, "VECTOR_SOURCE.md"),
    `# RTP test vector source

**Mixed**: GStreamer where plugins succeeded (${wrote}: ${ok.join(", ") || "none"});
package packetizer synthetic for the rest (including telephone-event / AV1 without payloader).

Regenerate:

\`\`\`bash
cd packages/rtp
npx tsx tools/generateVectors/generate.ts
\`\`\`

Docker (if host has no GStreamer):

\`\`\`bash
docker run --rm --network host -v "$(pwd)/../..":/workspace -w /workspace/packages/rtp \\
  node:20-bookworm bash -c \\
  "apt-get update -qq && DEBIAN_FRONTEND=noninteractive apt-get install -y -qq \\
   gstreamer1.0-tools gstreamer1.0-plugins-base gstreamer1.0-plugins-good \\
   gstreamer1.0-plugins-ugly gstreamer1.0-libav gstreamer1.0-plugins-bad && \\
   npx tsx tools/generateVectors/generate.ts"
\`\`\`

| File | Source (when GST available) |
|------|------------------------------|
| vector_pcmu / pcma | mulawenc/alawenc + rtppay |
| vector_g722 | avenc_g722 + rtpg722pay |
| vector_aac | avenc_aac + rtpmp4gpay |
| vector_h265 | x265enc + rtph265pay |
| vector_h264 | x264enc + rtph264pay |
| vector_vp8 | vp8enc + rtpvp8pay |
| vector_vp9 | vp9enc + rtpvp9pay |
| vector_opus | opusenc + rtpopuspay |
| vector_av1 | synthetic Av1Packetizer (no rtpav1pay on most distros) |
| vector_telephone_event | synthetic RFC 4733 |
| vector_*_expected.bin | depacketized / concatenated media for tests |
`,
  );

  // Depacketize / concat payloads → *_expected.bin for test equality
  buildExpectedFromVectors();
  console.log("Done. Commit tests/data/vector_*.bin if refreshed.");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
