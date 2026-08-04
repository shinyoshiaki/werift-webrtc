/**
 * RFC-accurate synthetic RTP payload vectors (no GStreamer required).
 * Used when gst-launch-1.0 is unavailable; same file layout as GStreamer capture.
 */

import { mkdirSync, writeFileSync } from "fs";
import { join } from "path";

import {
  AacHbrPacketizer,
  G722Packetizer,
  H265Packetizer,
  PcmaPacketizer,
  PcmuPacketizer,
  TelephoneEventRtpPayload,
  writeH265PayloadHeader,
} from "../../src";

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
| vector_telephone_event.bin | RFC 4733 start + end events |
`,
  );

  console.log("[synthetic] wrote vector_*.bin under tests/data/");
}

if (require.main === module) {
  writeSyntheticVectors();
}
