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
  const transceiver = pc.addTransceiver("video", { direction: "recvonly" });
  transceiver.onTrack.subscribe((track) => {
    // Probe padding shares the media RTP sequence space. Skipping it without
    // compacting seq looks like loss to the next jitterbuffer.
    let skippedPadding = 0;
    track.onReceiveRtp.subscribe((packet, _extensions, info) => {
      // GCC probe padding is padding-only RTP; do not forward hop-local probes.
      if (info?.type === "padding") {
        skippedPadding = uint16Add(skippedPadding, 1);
        return;
      }
      const forwarded = packet.clone();
      forwarded.header.sequenceNumber = uint16Add(
        forwarded.header.sequenceNumber,
        -skippedPadding,
      );
      udp.send(forwarded.serialize(), 1234, "127.0.0.1");
    });

    setInterval(() => {
      if (track.ssrc) {
        transceiver.receiver.sendRtcpPLI(track.ssrc);
      }
    }, 1000);
  });

  await pc.setLocalDescription(await pc.createOffer());
  const sdp = JSON.stringify(pc.localDescription);
  socket.send(sdp);

  socket.on("message", (data: any) => {
    pc.setRemoteDescription(JSON.parse(data));
  });
});
