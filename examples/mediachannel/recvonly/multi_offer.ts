import { createSocket } from "dgram";
import { Server } from "ws";
import { RTCPeerConnection, uint16Add } from "../../../packages/webrtc/src";

const server = new Server({ port: 8888 });
console.log("start");
const udp = createSocket("udp4");

server.on("connection", async (socket) => {
  const pc = new RTCPeerConnection({});
  pc.iceConnectionStateChange.subscribe((v) =>
    console.log("pc.iceConnectionStateChange", v),
  );
  // Probe padding shares the media RTP sequence space. Skipping it without
  // compacting seq looks like loss to the next jitterbuffer.
  let skippedVideoPadding = 0;
  let skippedAudioPadding = 0;
  pc.addTransceiver("video", {
    direction: "recvonly",
  }).receiver.tracks[0].onReceiveRtp.subscribe((packet, _extensions, info) => {
    // GCC probe padding is padding-only RTP; do not forward hop-local probes.
    if (info?.type === "padding") {
      skippedVideoPadding = uint16Add(skippedVideoPadding, 1);
      return;
    }
    const forwarded = packet.clone();
    forwarded.header.sequenceNumber = uint16Add(
      forwarded.header.sequenceNumber,
      -skippedVideoPadding,
    );
    udp.send(forwarded.serialize(), 4002, "127.0.0.1");
  });
  pc.addTransceiver("audio", {
    direction: "recvonly",
  }).receiver.tracks[0].onReceiveRtp.subscribe((packet, _extensions, info) => {
    // GCC probe padding is padding-only RTP; do not forward hop-local probes.
    if (info?.type === "padding") {
      skippedAudioPadding = uint16Add(skippedAudioPadding, 1);
      return;
    }
    const forwarded = packet.clone();
    forwarded.header.sequenceNumber = uint16Add(
      forwarded.header.sequenceNumber,
      -skippedAudioPadding,
    );
    udp.send(forwarded.serialize(), 4003, "127.0.0.1");
  });

  await pc.setLocalDescription(await pc.createOffer());
  const sdp = JSON.stringify(pc.localDescription);
  socket.send(sdp);

  socket.on("message", (data: any) => {
    pc.setRemoteDescription(JSON.parse(data));
  });
});
