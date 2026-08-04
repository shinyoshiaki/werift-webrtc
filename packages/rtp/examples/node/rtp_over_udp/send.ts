/**
 * Plain RTP-over-UDP sender using package-local packetizers.
 *
 * Usage:
 *   npx tsx examples/node/rtp_over_udp/send.ts [host] [port] [codec]
 * codec: pcmu | pcma | g722 | aac | h265  (default pcmu)
 *
 * Pair with recv.ts on the same host/port for a round-trip check.
 */

import { createSocket } from "dgram";

import {
  AacHbrPacketizer,
  G722Packetizer,
  H265Packetizer,
  PcmaPacketizer,
  PcmuPacketizer,
  writeH265PayloadHeader,
} from "../../../src";

const host = process.argv[2] ?? "127.0.0.1";
const port = Number(process.argv[3] ?? "5004");
const codec = (process.argv[4] ?? "pcmu").toLowerCase();

function makeNal(type: number, body: Buffer): Buffer {
  const hdr = writeH265PayloadHeader({ f: 0, type, layerId: 0, tid: 1 });
  return Buffer.concat([hdr, body]);
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
      const vps = makeNal(32, Buffer.from([1, 2]));
      const sps = makeNal(33, Buffer.from([3, 4]));
      const pps = makeNal(34, Buffer.from([5]));
      const slice = makeNal(19, Buffer.alloc(300, 0xab));
      const sample = annexB(vps, sps, pps, slice);
      const p = new H265Packetizer({
        sequenceNumber: 1,
        ssrc: 0x11223344,
        maxPayloadSize: 120,
      });
      return { packets: p.packetize(sample, 0), label: "H265 keyframe" };
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
