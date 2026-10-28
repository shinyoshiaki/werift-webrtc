import { WebSocketServer } from "ws";
import {
  RTCPeerConnection,
  RTCRtpCodecParameters,
  type RTCRtpSender,
  RtpPacket,
} from "../../../packages/webrtc/src";

const signaling = new WebSocketServer({ port: 8888 });
console.log("start");

signaling.on("connection", (socket) => {
  let pc: RTCPeerConnection | undefined;
  let generation = 0;
  let latestPackets: Buffer[] = [];

  socket.on("message", async (raw) => {
    const message = JSON.parse(String(raw));
    if (message.type === "offer") {
      const budget = Math.max(0, Number(message.budgetMs) || 0);
      pc = new RTCPeerConnection({
        nackRetryWindowMs: budget,
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
      pc.onDataChannel.subscribe((channel) => {
        channel.onMessage.subscribe((data) => {
          const command = JSON.parse(String(data));
          if (command.type === "interrupt") {
            generation = command.generation;
            latestPackets = [];
          } else if (command.type === "burst") {
            for (const packet of latestPackets) {
              if (command.generation !== generation) break;
              const rtp = RtpPacket.deSerialize(packet);
              void eventSender?.sendRtp(rtp);
            }
          } else if (command.type === "nack") {
            void eventSender?.retransmit(command.sequenceNumbers ?? []);
          }
        });
      });

      let eventSender: RTCRtpSender | undefined;
      pc.addTransceiver("audio", { direction: "sendrecv" }).onTrack.subscribe(
        (track) => {
          eventSender = pc
            ?.getTransceivers()
            .find(
              (transceiver) => transceiver.receiver.track === track,
            )?.sender;
          track.onReceiveRtp.subscribe((packet) => {
            latestPackets.push(packet.serialize());
            if (latestPackets.length > 250) latestPackets.shift();
            if (eventSender) void eventSender.sendRtp(packet);
          });
        },
      );
      await pc.setRemoteDescription(message.description);
      await pc.setLocalDescription(await pc.createAnswer());
      socket.send(
        JSON.stringify({ type: "answer", description: pc.localDescription }),
      );
      pc.onPacketLost.subscribe((nack) => {
        socket.send(
          JSON.stringify({
            type: "nack",
            sequenceNumbers: nack.lost,
            sentAt: Date.now(),
          }),
        );
      });
    }
  });
  socket.on("close", () => pc?.close());
});
