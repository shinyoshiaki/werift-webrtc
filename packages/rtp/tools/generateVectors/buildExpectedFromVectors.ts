/**
 * Build vector_*_expected.bin sidecars from committed RTP payload vectors.
 * Run after GStreamer capture (or synthetic write) so tests can equality-check
 * depacketized media.
 *
 * Usage (from packages/rtp):
 *   npx tsx tools/generateVectors/buildExpectedFromVectors.ts
 */

import { existsSync, readFileSync, writeFileSync } from "fs";
import { join } from "path";

import {
  AacHbrRtpPayload,
  G722RtpPayload,
  H265RtpPayload,
  PcmaRtpPayload,
  PcmuRtpPayload,
} from "../../src";

const DATA = join(__dirname, "../../tests/data");

function loadPayloadVector(name: string): Buffer[] {
  const path = join(DATA, name);
  if (!existsSync(path)) return [];
  const buf = readFileSync(path);
  const out: Buffer[] = [];
  let offset = 0;
  while (offset + 2 <= buf.length) {
    const len = buf.readUInt16BE(offset);
    offset += 2;
    out.push(buf.subarray(offset, offset + len));
    offset += len;
  }
  return out;
}

function writeRawExpected(vectorName: string, expectedName: string) {
  const payloads = loadPayloadVector(vectorName);
  if (!payloads.length) return;
  // G.711 / G.722: payload IS the media body
  const body = Buffer.concat(payloads);
  writeFileSync(join(DATA, expectedName), body);
  console.log(`[expected] ${expectedName} (${body.length} bytes from ${payloads.length} payloads)`);
}

function writeAacExpected() {
  const payloads = loadPayloadVector("vector_aac.bin");
  if (!payloads.length) return;
  const frames: Buffer[] = [];
  let fragment: Buffer | undefined;
  for (const p of payloads) {
    try {
      const r = AacHbrRtpPayload.deSerialize(p, fragment);
      if (r.fragment) {
        fragment = r.fragment;
      } else if (r.payload) {
        frames.push(r.payload);
        fragment = undefined;
      }
    } catch {
      // try as standalone AU (GStreamer often puts AU header on every packet)
      fragment = undefined;
      try {
        const r = AacHbrRtpPayload.deSerialize(p);
        if (r.fragment) fragment = r.fragment;
        else if (r.payload) frames.push(r.payload);
      } catch (e) {
        console.warn("[expected] AAC skip payload:", (e as Error).message);
      }
    }
  }
  const body = Buffer.concat(frames);
  writeFileSync(join(DATA, "vector_aac_expected.bin"), body);
  console.log(
    `[expected] vector_aac_expected.bin (${body.length} bytes, ${frames.length} AUs)`,
  );
}

function writeH265Expected() {
  const payloads = loadPayloadVector("vector_h265.bin");
  if (!payloads.length) return;
  const parts: Buffer[] = [];
  let fragment: Buffer | undefined;
  for (const p of payloads) {
    try {
      const r = H265RtpPayload.deSerialize(p, fragment);
      fragment = r.fragment;
      if (r.payload) {
        parts.push(r.payload);
        if (!r.fragment) fragment = undefined;
      }
    } catch (e) {
      console.warn("[expected] H265 skip:", (e as Error).message);
      fragment = undefined;
    }
  }
  const body = Buffer.concat(parts);
  writeFileSync(join(DATA, "vector_h265_expected.bin"), body);
  console.log(
    `[expected] vector_h265_expected.bin (${body.length} bytes, ${parts.length} NAL groups)`,
  );
}

export function buildExpectedFromVectors(): void {
  writeRawExpected("vector_pcmu.bin", "vector_pcmu_expected.bin");
  writeRawExpected("vector_pcma.bin", "vector_pcma_expected.bin");
  writeRawExpected("vector_g722.bin", "vector_g722_expected.bin");
  writeAacExpected();
  writeH265Expected();
}

if (require.main === module || process.argv[1]?.includes("buildExpected")) {
  buildExpectedFromVectors();
}
