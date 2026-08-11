/**
 * Plain RTP-over-UDP sender using package-local packetizers.
 *
 * Usage:
 *   npx tsx examples/node/rtp_over_udp/send.ts [host] [port] [codec]
 * codec: pcmu | pcma | g722 | aac | h265 | vp8 | vp9 | av1 | opus | h264
 *   (default pcmu)
 *
 * Pair with recv.ts on the same host/port for a round-trip check.
 */

import { createSocket } from "dgram";

import {
  AacHbrPacketizer,
  Av1Packetizer,
  G722Packetizer,
  H264Packetizer,
  H265Packetizer,
  OpusPacketizer,
  PcmaPacketizer,
  PcmuPacketizer,
  Vp8Packetizer,
  Vp9Packetizer,
  writeH265PayloadHeader,
} from "../../../src";

const host = process.argv[2] ?? "127.0.0.1";
const port = Number(process.argv[3] ?? "5004");
const codec = (process.argv[4] ?? "pcmu").toLowerCase();

function makeH265Nal(type: number, body: Buffer): Buffer {
  const hdr = writeH265PayloadHeader({ f: 0, type, layerId: 0, tid: 1 });
  return Buffer.concat([hdr, body]);
}

function makeH264Nal(type: number, body: Buffer): Buffer {
  return Buffer.concat([Buffer.from([0x60 | (type & 0x1f)]), body]);
}

function annexB(...nalus: Buffer[]): Buffer {
  const sc = Buffer.from([0x00, 0x00, 0x00, 0x01]);
  return Buffer.concat(nalus.flatMap((n) => [sc, n]));
}

function buildFrames(codecName: string): { packets: import("../../../src").RtpPacket[]; label: string } {
  switch (codecName) {
    case "pcmu": {
      const data = Buffer.alloc(160, 0x5a);
      const p = new PcmuPacketizer({ sequenceNumber: 1, ssrc: 0x11223344 });
      return { packets: p.packetize(data, 0), label: "PCMU 20ms" };
    }
    case "pcma": {
      const data = Buffer.alloc(160, 0xa5);
      const p = new PcmaPacketizer({ sequenceNumber: 1, ssrc: 0x11223344 });
      return { packets: p.packetize(data, 0), label: "PCMA 20ms" };
    }
    case "g722": {
      // RFC 3551 §4.5.2: 8000 octets/s → 20 ms = 160 octets
      const data = Buffer.alloc(160, 0x3c);
      const p = new G722Packetizer({ sequenceNumber: 1, ssrc: 0x11223344 });
      return { packets: p.packetize(data, 0), label: "G722 20ms" };
    }
    case "aac": {
      const au = Buffer.alloc(200, 0x7e);
      const p = new AacHbrPacketizer({
        sequenceNumber: 1,
        ssrc: 0x11223344,
        maxPayloadSize: 80,
      });
      return { packets: p.packetize(au, 0), label: "AAC-hbr (may fragment)" };
    }
    case "h265": {
      const vps = makeH265Nal(32, Buffer.from([1, 2]));
      const sps = makeH265Nal(33, Buffer.from([3, 4]));
      const pps = makeH265Nal(34, Buffer.from([5]));
      const slice = makeH265Nal(19, Buffer.alloc(300, 0xab));
      const sample = annexB(vps, sps, pps, slice);
      const p = new H265Packetizer({
        sequenceNumber: 1,
        ssrc: 0x11223344,
        maxPayloadSize: 120,
      });
      return { packets: p.packetize(sample, 0), label: "H265 keyframe" };
    }
    case "vp8": {
      // RFC 7741: raw VP8 frame with P=0 keyframe header
      const frame = Buffer.concat([
        Buffer.from([0x00, 0x00, 0x00]),
        Buffer.alloc(400, 0x7b),
      ]);
      const p = new Vp8Packetizer({
        sequenceNumber: 1,
        ssrc: 0x11223344,
        maxPayloadSize: 120,
      });
      return { packets: p.packetize(frame, 0), label: "VP8 keyframe" };
    }
    case "vp9": {
      // RFC 9628: raw VP9 frame, key (P=0)
      const frame = Buffer.alloc(400, 0x7b);
      const p = new Vp9Packetizer({
        sequenceNumber: 1,
        ssrc: 0x11223344,
        maxPayloadSize: 120,
      });
      return {
        packets: p.packetize(frame, 0, { frameType: "key" }),
        label: "VP9 keyframe",
      };
    }
    case "av1": {
      // AV1 RTP: single OBU without size field (header 0x30 = FRAME)
      const frame = Buffer.concat([
        Buffer.from([0x30]),
        Buffer.alloc(400, 0x55),
      ]);
      const p = new Av1Packetizer({
        sequenceNumber: 1,
        ssrc: 0x11223344,
        maxPayloadSize: 120,
      });
      return {
        packets: p.packetize(frame, 0, { frameType: "key" }),
        label: "AV1 keyframe",
      };
    }
    case "opus": {
      const data = Buffer.from([0xfc, 0xaa, 0xbb, 0xcc, 0xdd]);
      const p = new OpusPacketizer({ sequenceNumber: 1, ssrc: 0x11223344 });
      return { packets: p.packetize(data, 0), label: "Opus packet" };
    }
    case "h264": {
      const sps = makeH264Nal(7, Buffer.from([1, 2]));
      const pps = makeH264Nal(8, Buffer.from([3]));
      const idr = makeH264Nal(5, Buffer.alloc(200, 0xab));
      const sample = annexB(idr);
      const p = new H264Packetizer({
        sequenceNumber: 1,
        ssrc: 0x11223344,
        parameterSets: [sps, pps],
        maxPayloadSize: 80,
      });
      return { packets: p.packetize(sample, 0), label: "H264 keyframe (STAP-A+FU)" };
    }
    default:
      throw new Error(`unknown codec ${codecName}`);
  }
}

const { packets, label } = buildFrames(codec);
const sock = createSocket("udp4");

console.log(`Sending ${packets.length} RTP packet(s) [${label}] → ${host}:${port}`);

for (const pkt of packets) {
  const buf = pkt.serialize();
  sock.send(buf, port, host);
}

// Keep process alive briefly so UDP flush completes
setTimeout(() => {
  sock.close();
  console.log("done");
}, 100);
