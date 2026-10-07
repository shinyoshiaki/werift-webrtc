// Relay two upstream RTP sources (A, then B) to one downstream with a
// continuous sequence number / timestamp timeline.
//
//   upstream A ─┐
//               ├─▶ relay (RtpContinuityRewriter) ─▶ downstream
//   upstream B ─┘
//
// run: npx tsx examples/node/continuity/relay.ts

import { createSocket } from "dgram";
import { setTimeout } from "timers/promises";

import {
  RtpContinuityRewriter,
  RtpHeader,
  RtpPacket,
  timestampStepFromElapsed,
} from "../../../src";

const clockRate = 48000;
const packetsPerSource = 5;
const samplesPerPacket = 960; // 20ms opus

const downstream = createSocket("udp4");
const relay = createSocket("udp4");
const upstream = createSocket("udp4");

const rewriter = new RtpContinuityRewriter({ ssrc: 0x12345678 });
let currentSourceSsrc: number | undefined;
let lastOutputAt = 0;

downstream.on("message", (data) => {
  const { header } = RtpPacket.deSerialize(data);
  console.log(
    "downstream",
    "ssrc",
    header.ssrc.toString(16),
    "seq",
    header.sequenceNumber,
    "ts",
    header.timestamp,
  );
});

relay.on("message", (data) => {
  const input = RtpPacket.deSerialize(data);
  // A new upstream SSRC means the source was replaced.
  if (
    currentSourceSsrc != undefined &&
    currentSourceSsrc !== input.header.ssrc
  ) {
    const timestampStep = timestampStepFromElapsed(
      Date.now() - lastOutputAt,
      clockRate,
    );
    rewriter.switchSource({ timestampStep });
    console.log("relay switchSource", { timestampStep });
  }
  currentSourceSsrc = input.header.ssrc;

  const output = rewriter.rewrite(input);
  lastOutputAt = Date.now();
  console.log(
    "upstream  ",
    "ssrc",
    input.header.ssrc.toString(16),
    "seq",
    input.header.sequenceNumber,
    "ts",
    input.header.timestamp,
  );
  relay.send(output.serialize(), downstreamPort, "127.0.0.1");
});

async function bind(socket: ReturnType<typeof createSocket>) {
  await new Promise<void>((r) => socket.bind(0, "127.0.0.1", r));
  return socket.address().port;
}

async function sendSource(ssrc: number, startSeq: number, startTs: number) {
  for (let i = 0; i < packetsPerSource; i++) {
    const packet = new RtpPacket(
      new RtpHeader({
        ssrc,
        payloadType: 111,
        sequenceNumber: (startSeq + i) & 0xffff,
        timestamp: (startTs + i * samplesPerPacket) >>> 0,
      }),
      Buffer.from([i]),
    );
    upstream.send(packet.serialize(), relayPort, "127.0.0.1");
    await setTimeout(20);
  }
}

let downstreamPort = 0;
let relayPort = 0;

(async () => {
  downstreamPort = await bind(downstream);
  relayPort = await bind(relay);
  await bind(upstream);

  // Upstream A, then A is closed and upstream B (random seq/ts) takes over.
  await sendSource(0xaaaaaaaa, 65533, 0xfffffc00);
  await setTimeout(100);
  await sendSource(0xbbbbbbbb, 1200, 777777);

  await setTimeout(100);
  console.log("relay state", rewriter.toJSON());
  for (const socket of [downstream, relay, upstream]) {
    socket.close();
  }
})();
