import { RTCPeerConnection } from "../../src";
import { Server } from "ws";
import { OpusEncoder } from "@discordjs/opus";
import { Mixer } from "@shinyoshiaki/audio-mixer";
import { RtpHeader, RtpPacket } from "../../src/vendor/rtp";

const MAX_FRAME_SIZE = (48000 * 60) / 1000;
const PCMLength = MAX_FRAME_SIZE * 2 * 2;

console.log("start");

const server = new Server({ port: 8888 });
const encoder = new OpusEncoder(48000, 2);
const mixer = new Mixer({ sampleRate: 48000, channels: 2, sleep: 20 });

server.on("connection", async (socket) => {
  const pc = new RTCPeerConnection({
    stunServer: ["stun.l.google.com", 19302],
  });
  const transceiver = pc.addTransceiver("audio", "sendonly");

  let header: RtpHeader;

  pc.addTransceiver("audio", "recvonly").onTrack.once((track) => {
    const input = mixer.input({ channels: 2, maxBuffer: PCMLength / 2 });
    track.onRtp.subscribe((packet) => {
      header = packet.header;

      const decoded = encoder.decode(packet.payload);
      input.write(decoded);
    });
  });
  pc.addTransceiver("audio", "recvonly").onTrack.once((track) => {
    const input = mixer.input({ channels: 2, maxBuffer: PCMLength / 2 });
    track.onRtp.subscribe((packet) => {
      const decoded = encoder.decode(packet.payload);
      input.write(decoded);
    });
  });

  mixer.on("data", (data) => {
    if (!header) return;
    const encoded = encoder.encode(data);
    console.log(data.length, encoded.length);
    const rtp = new RtpPacket(header, encoded);
    transceiver.sendRtp(rtp);
  });

  const offer = pc.createOffer();
  await pc.setLocalDescription(offer);
  const sdp = JSON.stringify(pc.localDescription);
  socket.send(sdp);

  socket.on("message", (data: any) => {
    console.log(data);
    pc.setRemoteDescription(JSON.parse(data));
  });
});
