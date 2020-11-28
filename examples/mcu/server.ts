import { RTCPeerConnection } from "../../src";
import { Server } from "ws";
import { OpusEncoder } from "@discordjs/opus";
import { RtpHeader, RtpPacket } from "../../src/vendor/rtp";
import { Mixer } from "./mixing";

console.log("start");

const server = new Server({ port: 8888 });
const encoder = new OpusEncoder(48000, 2);
const mixer = new Mixer();

server.on("connection", async (socket) => {
  const pc = new RTCPeerConnection({
    stunServer: ["stun.l.google.com", 19302],
  });
  const transceiver = pc.addTransceiver("audio", "sendonly");

  let _header: RtpHeader;
  pc.addTransceiver("audio", "recvonly").onTrack.once((track) => {
    const input = mixer.input();
    track.onRtp.subscribe((packet) => {
      _header = packet.header;
      const decoded = encoder.decode(packet.payload);
      input.write(decoded);
    });
  });
  pc.addTransceiver("audio", "recvonly").onTrack.once((track) => {
    const input = mixer.input();
    track.onRtp.subscribe((packet) => {
      const decoded = encoder.decode(packet.payload);
      input.write(decoded);
    });
  });

  mixer.onData = (data) => {
    if (!_header) return;

    const encoded = encoder.encode(data);

    const rtp = new RtpPacket(_header, encoded);
    transceiver.sendRtp(rtp);
  };

  const offer = pc.createOffer();
  await pc.setLocalDescription(offer);
  const sdp = JSON.stringify(pc.localDescription);
  socket.send(sdp);

  socket.on("message", (data: any) => {
    console.log(data);
    pc.setRemoteDescription(JSON.parse(data));
  });
});
