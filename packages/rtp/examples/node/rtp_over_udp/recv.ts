/**
 * Plain RTP-over-UDP receiver using package-local depacketizers.
 *
 * Usage:
 *   npx tsx examples/node/rtp_over_udp/recv.ts [port] [codec]
 * codec: pcmu | pcma | g722 | aac | h265 | vp8 | vp9 | av1 | opus | h264
 *   (default pcmu)
 *
 * Listens on 127.0.0.1, depacketizes, and prints frame size / keyframe.
 * When RUN_SELF_TEST=1, binds an ephemeral port, spawns an in-process
 * sender, and verifies payload round-trip without external tools.
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
  RtpPacket,
  Vp8Packetizer,
  Vp9Packetizer,
  dePacketizeRtpPackets,
  type DepacketizerCodec,
  writeH265PayloadHeader,
} from "../../../src";

const portArg = process.argv[2];
const codec = (process.argv[3] ?? "pcmu").toLowerCase();

const codecMap: Record<string, DepacketizerCodec> = {
  pcmu: "PCMU",
  pcma: "PCMA",
  g722: "G722",
  aac: "MPEG4-GENERIC",
  h265: "H265",
  vp8: "VP8",
  vp9: "VP9",
  av1: "AV1",
  opus: "OPUS",
  h264: "MPEG4/ISO/AVC",
};

function registryCodec(name: string): DepacketizerCodec {
  const c = codecMap[name];
  if (!c) throw new Error(`unknown codec ${name}`);
  return c;
}

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

async function selfTest() {
  const name = codec;
  const reg = registryCodec(name);

  let expected: Buffer;
  let packets: RtpPacket[];

  switch (name) {
    case "pcmu": {
      expected = Buffer.alloc(160, 0x5a);
      packets = new PcmuPacketizer({ sequenceNumber: 1 }).packetize(expected, 0);
      break;
    }
    case "pcma": {
      expected = Buffer.alloc(160, 0xa5);
      packets = new PcmaPacketizer({ sequenceNumber: 1 }).packetize(expected, 0);
      break;
    }
    case "g722": {
      // RFC 3551 §4.5.2: 8000 octets/s → 20 ms = 160 octets
      expected = Buffer.alloc(160, 0x3c);
      packets = new G722Packetizer({ sequenceNumber: 1 }).packetize(expected, 0);
      break;
    }
    case "aac": {
      expected = Buffer.alloc(200, 0x7e);
      packets = new AacHbrPacketizer({
        sequenceNumber: 1,
        maxPayloadSize: 80,
      }).packetize(expected, 0);
      break;
    }
    case "h265": {
      const vps = makeH265Nal(32, Buffer.from([1, 2]));
      const sps = makeH265Nal(33, Buffer.from([3, 4]));
      const pps = makeH265Nal(34, Buffer.from([5]));
      const slice = makeH265Nal(19, Buffer.alloc(300, 0xab));
      expected = annexB(vps, sps, pps, slice);
      packets = new H265Packetizer({
        sequenceNumber: 1,
        maxPayloadSize: 120,
      }).packetize(expected, 0);
      break;
    }
    case "vp8": {
      expected = Buffer.concat([
        Buffer.from([0x00, 0x00, 0x00]),
        Buffer.alloc(400, 0x7b),
      ]);
      packets = new Vp8Packetizer({
        sequenceNumber: 1,
        maxPayloadSize: 120,
      }).packetize(expected, 0);
      break;
    }
    case "vp9": {
      expected = Buffer.alloc(400, 0x7b);
      packets = new Vp9Packetizer({
        sequenceNumber: 1,
        maxPayloadSize: 120,
      }).packetize(expected, 0, { frameType: "key" });
      break;
    }
    case "av1": {
      expected = Buffer.concat([
        Buffer.from([0x30]),
        Buffer.alloc(400, 0x55),
      ]);
      packets = new Av1Packetizer({
        sequenceNumber: 1,
        maxPayloadSize: 120,
      }).packetize(expected, 0, { frameType: "key" });
      break;
    }
    case "opus": {
      expected = Buffer.from([0xfc, 0xaa, 0xbb, 0xcc, 0xdd]);
      packets = new OpusPacketizer({ sequenceNumber: 1 }).packetize(expected, 0);
      break;
    }
    case "h264": {
      const sps = makeH264Nal(7, Buffer.from([1, 2]));
      const pps = makeH264Nal(8, Buffer.from([3]));
      const idr = makeH264Nal(5, Buffer.alloc(200, 0xab));
      // Depacketizer returns Annex-B of parameter sets + IDR after STAP-A prepend
      expected = annexB(sps, pps, idr);
      packets = new H264Packetizer({
        sequenceNumber: 1,
        parameterSets: [sps, pps],
        maxPayloadSize: 80,
      }).packetize(annexB(idr), 0);
      break;
    }
    default:
      throw new Error(name);
  }

  const recv = createSocket("udp4");
  await new Promise<void>((resolve, reject) => {
    recv.once("error", reject);
    recv.bind(0, "127.0.0.1", () => resolve());
  });
  const addr = recv.address();
  const port = typeof addr === "string" ? 0 : addr.port;

  const received: RtpPacket[] = [];
  const done = new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("timeout waiting for RTP")), 3000);
    recv.on("message", (msg) => {
      received.push(RtpPacket.deSerialize(msg));
      if (received.length >= packets.length) {
        clearTimeout(timer);
        resolve();
      }
    });
  });

  const send = createSocket("udp4");
  for (const p of packets) {
    send.send(p.serialize(), port, "127.0.0.1");
  }

  await done;
  send.close();
  recv.close();

  const frame = dePacketizeRtpPackets(reg, received);
  if (!frame.data.equals(expected)) {
    console.error("SELF-TEST FAILED: payload mismatch", {
      expected: expected.length,
      got: frame.data.length,
    });
    process.exit(1);
  }
  console.log(
    `SELF-TEST OK codec=${name} packets=${received.length} frameBytes=${frame.data.length} keyframe=${frame.isKeyframe}`,
  );
}

async function listen(port: number) {
  const reg = registryCodec(codec);
  const sock = createSocket("udp4");
  const buffer: RtpPacket[] = [];

  sock.on("message", (msg) => {
    const rtp = RtpPacket.deSerialize(msg);
    buffer.push(rtp);
    console.log(
      `recv seq=${rtp.header.sequenceNumber} pt=${rtp.header.payloadType} mark=${rtp.header.marker} len=${rtp.payload.length}`,
    );
    if (
      rtp.header.marker ||
      codec === "pcmu" ||
      codec === "pcma" ||
      codec === "g722" ||
      codec === "opus"
    ) {
      try {
        const frame = dePacketizeRtpPackets(reg, buffer.splice(0));
        console.log(
          `frame bytes=${frame.data.length} keyframe=${frame.isKeyframe} ts=${frame.timestamp}`,
        );
      } catch (e) {
        console.error("depacketize error", e);
      }
    }
  });

  await new Promise<void>((resolve, reject) => {
    sock.once("error", reject);
    sock.bind(port, "127.0.0.1", () => {
      console.log(`Listening UDP 127.0.0.1:${port} codec=${codec}`);
      resolve();
    });
  });
}

if (process.env.RUN_SELF_TEST === "1") {
  selfTest().catch((e) => {
    console.error(e);
    process.exit(1);
  });
} else {
  const port = Number(portArg ?? "5004");
  listen(port).catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
