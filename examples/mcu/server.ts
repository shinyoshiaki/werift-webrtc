import { RTCPeerConnection } from "../../src";
import { Server } from "ws";
import { OpusEncoder } from "@discordjs/opus";
import { Mixer } from "audio-mixer";
import { RtpHeader, RtpPacket } from "../../src/vendor/rtp";
import { ntpTime } from "../../src/utils";

console.log("start");

const server = new Server({ port: 8888 });
const encoder = new OpusEncoder(48000, 1);
const mixer = new Mixer({ sampleRate: 48000, channels: 1 });

server.on("connection", async (socket) => {
  const pc = new RTCPeerConnection({
    stunServer: ["stun.l.google.com", 19302],
  });
  pc.iceConnectionStateChange.subscribe((v) =>
    console.log("pc.iceConnectionStateChange", v)
  );
  const transceiver = pc.addTransceiver("audio", "sendonly");
  let sequenceNumber = 0;
  let timestamp = 0;

  //   pc.addTransceiver("audio", "recvonly").onTrack.once((track) => {
  //     const input = mixer.input({ channels: 1 });
  //     track.onRtp.subscribe((packet) => {
  //       const decoded = encoder.decode(packet.payload);
  //       input.write(decoded);
  //     });
  //   });

  pc.addTransceiver("audio", "recvonly").onTrack.once((track) => {
    track.onRtp.subscribe((packet) => {
      //   sequenceNumber++;
      //   timestamp += 960;
      //   //   const decoded = encoder.decode(packet.payload);
      //   //   const encoded = encoder.encode(decoded);

      //   const header = new RtpHeader({
      //     sequenceNumber,
      //     payloadType: 96,
      //     timestamp: packet.header.timestamp,
      //   });
      //   const rtp = new RtpPacket(packet.header, packet.payload);
      transceiver.sendRtp(packet);
    });
  });

  //   mixer.on("data", (data) => {
  //     sequenceNumber++;
  //     const encoded = encoder.encode(data);

  //     const header = new RtpHeader({
  //       sequenceNumber,
  //       payloadType: 96,
  //       marker: true,
  //     });
  //     const rtp = new RtpPacket(header, encoded);
  //     transceiver.sendRtp(rtp);
  //   });

  const offer = pc.createOffer();
  await pc.setLocalDescription(offer);
  const sdp = JSON.stringify(pc.localDescription);
  socket.send(sdp);

  socket.on("message", (data: any) => {
    console.log(data);
    pc.setRemoteDescription(JSON.parse(data));
  });
});
