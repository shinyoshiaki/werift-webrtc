/**
 * RFC-accurate synthetic RTP payload vectors (no GStreamer required).
 * Used when gst-launch-1.0 is unavailable; same file layout as GStreamer capture.
 */

import { mkdirSync, writeFileSync } from "fs";
import { join } from "path";

import {
  AacHbrPacketizer,
  Av1Packetizer,
  G722Packetizer,
  H264Packetizer,
  H265Packetizer,
  OpusPacketizer,
  PcmaPacketizer,
  PcmuPacketizer,
  TelephoneEventRtpPayload,
  Vp8Packetizer,
  Vp9Packetizer,
  writeH265PayloadHeader,
} from "../../src";
import { leb128encode } from "../../src/codec/leb128";

const OUT_DIR = join(__dirname, "../../tests/data");

function encode(payloads: Buffer[]): Buffer {
  const parts: Buffer[] = [];
  for (const p of payloads) {
    const len = Buffer.alloc(2);
    len.writeUInt16BE(p.length, 0);
    parts.push(len, p);
  }
  return Buffer.concat(parts);
}

/** Non-repeating PRNG (avoids constant fill patterns). */
function prngBytes(len: number, seed: number): Buffer {
  const b = Buffer.alloc(len);
  let s = seed >>> 0;
  for (let i = 0; i < len; i++) {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    b[i] = (s >>> 24) & 0xff;
  }
  return b;
}

function makeNal(
  type: number,
  body: Buffer,
  layerId = 0,
  tid = 1,
  f = 0,
): Buffer {
  const hdr = writeH265PayloadHeader({ f, type, layerId, tid });
  return Buffer.concat([hdr, body]);
}

function annexB(...nalus: Buffer[]): Buffer {
  const sc = Buffer.from([0, 0, 0, 1]);
  return Buffer.concat(nalus.flatMap((n) => [sc, n]));
}

export function writeSyntheticVectors(): void {
  mkdirSync(OUT_DIR, { recursive: true });

  const pcmuData = prngBytes(160, 0x50434d55);
  const pcmaData = prngBytes(160, 0x50434d41);
  writeFileSync(
    join(OUT_DIR, "vector_pcmu.bin"),
    encode(
      new PcmuPacketizer({ sequenceNumber: 1 })
        .packetize(pcmuData, 0)
        .map((p) => p.payload),
    ),
  );
  writeFileSync(
    join(OUT_DIR, "vector_pcma.bin"),
    encode(
      new PcmaPacketizer({ sequenceNumber: 1 })
        .packetize(pcmaData, 0)
        .map((p) => p.payload),
    ),
  );
  writeFileSync(join(OUT_DIR, "vector_pcmu_expected.bin"), pcmuData);

  // RFC 3551 §4.5.2: 8000 octets/s → 20 ms = 160 octets
  const g722Data = prngBytes(160, 0x47373232);
  writeFileSync(
    join(OUT_DIR, "vector_g722.bin"),
    encode(
      new G722Packetizer({ sequenceNumber: 1 })
        .packetize(g722Data, 0)
        .map((p) => p.payload),
    ),
  );
  writeFileSync(join(OUT_DIR, "vector_g722_expected.bin"), g722Data);

  const aacLarge = prngBytes(200, 0xaac0aac0);
  const aacPkts = new AacHbrPacketizer({
    sequenceNumber: 1,
    maxPayloadSize: 64,
  }).packetize(aacLarge, 0);
  const aacSmall = prngBytes(40, 0xaac1aaca);
  const aacPkts2 = new AacHbrPacketizer({
    sequenceNumber: 100,
  }).packetize(aacSmall, 480);
  writeFileSync(
    join(OUT_DIR, "vector_aac.bin"),
    encode([...aacPkts, ...aacPkts2].map((p) => p.payload)),
  );
  writeFileSync(
    join(OUT_DIR, "vector_aac_expected.bin"),
    Buffer.concat([aacLarge, aacSmall]),
  );

  const vps = makeNal(32, prngBytes(8, 1), 0, 2, 0);
  const sps = makeNal(33, prngBytes(12, 2), 1, 1, 0);
  const pps = makeNal(34, prngBytes(6, 3), 0, 3, 1);
  const idr = makeNal(19, prngBytes(350, 4), 0, 1, 0);
  const h265 = new H265Packetizer({
    sequenceNumber: 1,
    maxPayloadSize: 100,
  }).packetize(annexB(vps, sps, pps, idr), 0);
  writeFileSync(
    join(OUT_DIR, "vector_h265.bin"),
    encode(h265.map((p) => p.payload)),
  );

  // --- Existing-codec packetizers (VP8 / VP9 / AV1 / Opus / H.264) ---

  // VP8: keyframe-style header (P=0) + body; force fragmentation
  const vp8Frame = Buffer.concat([
    Buffer.from([0x00, 0x00, 0x00]),
    prngBytes(400, 0x56503800),
  ]);
  const vp8Pkts = new Vp8Packetizer({
    sequenceNumber: 1,
    maxPayloadSize: 120,
  }).packetize(vp8Frame, 0);
  writeFileSync(
    join(OUT_DIR, "vector_vp8.bin"),
    encode(vp8Pkts.map((p) => p.payload)),
  );
  writeFileSync(join(OUT_DIR, "vector_vp8_expected.bin"), vp8Frame);

  // VP9: key frame (P=0), multi-packet
  const vp9Frame = prngBytes(400, 0x56503900);
  const vp9Pkts = new Vp9Packetizer({
    sequenceNumber: 1,
    maxPayloadSize: 120,
  }).packetize(vp9Frame, 0, { frameType: "key" });
  writeFileSync(
    join(OUT_DIR, "vector_vp9.bin"),
    encode(vp9Pkts.map((p) => p.payload)),
  );
  writeFileSync(join(OUT_DIR, "vector_vp9_expected.bin"), vp9Frame);

  // AV1: size-fielded OBU (FRAME) large enough to fragment
  const av1Body = prngBytes(500, 0x41563100);
  const av1Header = Buffer.from([(6 & 0x0f) << 3 | 0x02]); // type=FRAME, S=1
  const av1Frame = Buffer.concat([
    av1Header,
    leb128encode(av1Body.length),
    av1Body,
  ]);
  const av1Pkts = new Av1Packetizer({
    sequenceNumber: 1,
    maxPayloadSize: 80,
  }).packetize(av1Frame, 0, { frameType: "key" });
  writeFileSync(
    join(OUT_DIR, "vector_av1.bin"),
    encode(av1Pkts.map((p) => p.payload)),
  );
  writeFileSync(join(OUT_DIR, "vector_av1_expected.bin"), av1Frame);

  // Opus: single complete packet (RFC 7587)
  const opusPkt = Buffer.concat([Buffer.from([0xfc]), prngBytes(40, 0x4f505553)]);
  const opusRtp = new OpusPacketizer({ sequenceNumber: 1 }).packetize(
    opusPkt,
    0,
  );
  writeFileSync(
    join(OUT_DIR, "vector_opus.bin"),
    encode(opusRtp.map((p) => p.payload)),
  );
  writeFileSync(join(OUT_DIR, "vector_opus_expected.bin"), opusPkt);

  // H.264: SPS+PPS via STAP-A + IDR FU-A (mode=1)
  const h264Sps = Buffer.concat([
    Buffer.from([0x67]), // type 7
    prngBytes(10, 0x68323634),
  ]);
  const h264Pps = Buffer.concat([Buffer.from([0x68]), prngBytes(4, 2)]);
  const h264Idr = Buffer.concat([
    Buffer.from([0x65]), // type 5 IDR
    prngBytes(300, 3),
  ]);
  const h264Sample = annexB(h264Idr);
  const h264Pkts = new H264Packetizer({
    sequenceNumber: 1,
    parameterSets: [h264Sps, h264Pps],
    maxPayloadSize: 80,
  }).packetize(h264Sample, 0);
  writeFileSync(
    join(OUT_DIR, "vector_h264.bin"),
    encode(h264Pkts.map((p) => p.payload)),
  );
  // Expected = Annex-B of parameter sets + IDR after packetize prepend
  writeFileSync(
    join(OUT_DIR, "vector_h264_expected.bin"),
    annexB(h264Sps, h264Pps, h264Idr),
  );

  const start = new TelephoneEventRtpPayload({
    event: 5,
    volume: 10,
    duration: 160,
    end: false,
  }).serialize();
  const end = new TelephoneEventRtpPayload({
    event: 5,
    volume: 10,
    duration: 800,
    end: true,
  }).serialize();
  writeFileSync(
    join(OUT_DIR, "vector_telephone_event.bin"),
    encode([start, end]),
  );

  writeFileSync(
    join(OUT_DIR, "VECTOR_SOURCE.md"),
    `# RTP test vector source

When GStreamer (\`gst-launch-1.0\`) is available, prefer:

\`\`\`bash
npx tsx tools/generateVectors/generate.ts
\`\`\`

Otherwise this file is written by \`writeSyntheticVectors.ts\`: RFC-accurate
wire payloads from package packetizers with non-repeating PRNG media bodies
(not constant fill bytes). Format: \`[u16be length][payload]\` records.

| File | Contents |
|------|----------|
| vector_pcmu.bin / vector_pcma.bin | G.711 20ms frames |
| vector_g722.bin + vector_g722_expected.bin | G.722 + original body |
| vector_aac.bin + vector_aac_expected.bin | AAC-hbr fragments + complete |
| vector_h265.bin | H.265 AP/FU (mixed F/LayerId/TID) |
| vector_h264.bin + expected | H.264 STAP-A + FU-A (mode=1) |
| vector_vp8.bin + expected | VP8 fragmented frame |
| vector_vp9.bin + expected | VP9 keyframe fragments |
| vector_av1.bin + expected | AV1 size-field OBU fragments |
| vector_opus.bin + expected | Opus single packet |
| vector_telephone_event.bin | RFC 4733 start + end events |
`,
  );

  console.log("[synthetic] wrote vector_*.bin under tests/data/");
}

if (require.main === module) {
  writeSyntheticVectors();
}
