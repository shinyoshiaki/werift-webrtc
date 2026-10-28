import { WebSocketServer } from "ws";
import {
  RTCPeerConnection,
  RTCRtpCodecParameters,
  type RTCRtpSender,
  RtpHeader,
  RtpPacket,
} from "../../../packages/webrtc/src";

const signaling = new WebSocketServer({ port: 8888 });
const roomSenders = new Set<RTCRtpSender>();
const roomPackets: Buffer[] = [];
console.log("start");

signaling.on("connection", (socket) => {
  let pc: RTCPeerConnection | undefined;
  let eventSender: RTCRtpSender | undefined;
  let dataChannel:
    | ReturnType<RTCPeerConnection["createDataChannel"]>
    | undefined;
  let generation = 0;
  let role = "publisher";
  let expectedSequence: number | undefined;
  let weriftMissing = 0;
  let weriftRecovered = 0;
  let weriftUnrecovered = 0;
  const pendingLoss = new Map<number, ReturnType<typeof setTimeout>>();
  let sourceTimer: ReturnType<typeof setInterval> | undefined;
  let sourceSequence = 0;
  let sourceTimestamp = 0;

  socket.on("message", async (raw) => {
    const message = JSON.parse(String(raw));
    if (message.type === "init") {
      role = message.role === "subscriber" ? "subscriber" : "publisher";
      const budget = Math.max(0, Number(message.budgetMs) || 0);
      pc = new RTCPeerConnection({
        nackRetryWindowMs: budget,
        nackRetryIntervalMs: 25,
        rtpHistorySize: 300,
        debug: {
          inboundPacketLoss: 12,
          burstLoss: { everyMs: 1800, durationMs: 120 },
        },
        codecs: {
          audio: [
            new RTCRtpCodecParameters({
              mimeType: "audio/opus",
              clockRate: 48000,
              channels: 2,
              rtcpFeedback: [{ type: "nack" }],
            }),
          ],
        },
      });
      dataChannel = pc.createDataChannel("latency-budget");
      dataChannel.onMessage.subscribe((data) => {
        const command = JSON.parse(String(data));
        if (command.type === "interrupt") {
          generation = command.generation;
          roomPackets.length = 0;
        } else if (command.type === "burst") {
          for (const packet of roomPackets) {
            if (command.generation !== generation) break;
            void eventSender?.sendRtp(RtpPacket.deSerialize(packet));
          }
        } else if (command.type === "nack") {
          void eventSender?.retransmit(command.sequenceNumbers ?? []);
        }
      });

      const transceiver = pc.addTransceiver("audio", { direction: "sendrecv" });
      eventSender = transceiver.sender;
      roomSenders.add(eventSender);
      transceiver.onTrack.subscribe((track) => {
        let receivedPackets = 0;
        track.onReceiveRtp.subscribe((packet) => {
          receivedPackets++;
          if (receivedPackets === 1) console.log("received first RTP");
          const sequence = packet.header.sequenceNumber;
          if (expectedSequence != undefined) {
            const delta = (sequence - expectedSequence + 65536) % 65536;
            if (delta > 1 && delta < 32768) {
              for (let step = 1; step < delta; step++) {
                const missing = (expectedSequence + step) % 65536;
                weriftMissing++;
                const timer = setTimeout(() => {
                  if (pendingLoss.delete(missing)) {
                    weriftUnrecovered++;
                    report();
                  }
                }, budget);
                pendingLoss.set(missing, timer);
              }
            } else if (pendingLoss.has(sequence)) {
              clearTimeout(pendingLoss.get(sequence));
              pendingLoss.delete(sequence);
              weriftRecovered++;
            }
          }
          if (
            expectedSequence == undefined ||
            (sequence - expectedSequence + 65536) % 65536 < 32768
          ) {
            expectedSequence = sequence;
          }
          roomPackets.push(packet.serialize());
          if (roomPackets.length > 250) roomPackets.shift();
          for (const sender of roomSenders) {
            void sender
              .sendRtp(packet)
              .catch((error) => console.error("RTP relay failed", error));
          }
          report();
        });
      });

      await pc.setLocalDescription(await pc.createOffer());
      socket.send(
        JSON.stringify({ type: "offer", description: pc.localDescription }),
      );
    } else if (message.type === "answer") {
      await pc?.setRemoteDescription(message.description);
      if (role !== "publisher") return;
      sourceTimer = setInterval(() => {
        const packet = new RtpPacket(
          new RtpHeader({
            sequenceNumber: sourceSequence++ & 0xffff,
            timestamp: sourceTimestamp,
            ssrc: eventSender?.ssrc ?? 0,
            payloadType: eventSender?.codec?.payloadType ?? 111,
          }),
          Buffer.from([0xf8, 0xff, 0xfe]),
        );
        sourceTimestamp = (sourceTimestamp + 960) >>> 0;
        roomPackets.push(packet.serialize());
        if (roomPackets.length > 250) roomPackets.shift();
        for (const sender of roomSenders) {
          void sender
            .sendRtp(packet)
            .catch((error) => console.error("RTP source failed", error));
        }
      }, 20);
    }
  });

  socket.on("close", () => {
    for (const timer of pendingLoss.values()) clearTimeout(timer);
    if (sourceTimer) clearInterval(sourceTimer);
    if (eventSender) roomSenders.delete(eventSender);
    pc?.close();
  });

  function report() {
    if (socket.readyState === socket.OPEN) {
      socket.send(
        JSON.stringify({
          type: "metrics",
          weriftMissing,
          weriftRecovered,
          weriftUnrecovered,
        }),
      );
    }
  }
});
