import {
  RTCPeerConnection,
  MediaStreamTrack,
  random16,
  random32,
  uint16Add,
  uint32Add,
  RtpHeader,
  RtpPacket,
} from "../../packages/webrtc/src";
import { Server } from "ws";
import { OpusEncoder } from "@discordjs/opus";
import { Mixer } from "./mixing";

console.log("start");
const server = new Server({ port: 8888 });

server.on("connection", async (socket) => {
  function send(type: string, payload: any) {
    socket.send(JSON.stringify({ type, payload }));
  }
  console.log("onconnect");

  const encoder = new OpusEncoder(48000, 2);
  const mixer = new Mixer();
  const pc = new RTCPeerConnection({});
  const senderTrack = new MediaStreamTrack({ kind: "audio" });
  pc.addTransceiver(senderTrack, { direction: "sendonly" });
  await pc.setLocalDescription(await pc.createOffer());
  send("offer", { sdp: pc.localDescription });

  const tracks: {
    [msid: string]: MediaStreamTrack;
  } = {};
  const disposers: {
    [msid: string]: () => void;
  } = {};

  socket.onmessage = async (ev) => {
    const { type, payload } = JSON.parse(ev.data as string);
    console.log("onmessage", type);
    switch (type) {
      case "answer":
        {
          const { sdp } = payload;
          pc.setRemoteDescription(sdp);
        }
        break;
      case "candidate":
        {
          const { candidate } = payload;
          pc.addIceCandidate(candidate);
        }
        break;
      case "publish":
        {
          const transceiver = pc.addTransceiver("audio", {
            direction: "recvonly",
          });
          transceiver.onTrack.once((track) => {
            tracks[transceiver.msid] = track;
          });
          send("onPublish", { id: transceiver.msid });
          await pc.setLocalDescription(await pc.createOffer());
          send("offer", { sdp: pc.localDescription });
        }
        break;
      case "add":
        {
          const { id } = payload;
          const track = tracks[id];
          const input = mixer.input();
          const { unSubscribe } = track.onReceiveRtp.subscribe((packet) => {
            const decoded = encoder.decode(packet.payload);
            input.write(decoded);
          });
          disposers[id] = () => {
            unSubscribe();
            input.remove();
          };
        }
        break;
      case "remove":
        {
          const { id } = payload;
          disposers[id]();
          delete disposers[id];
        }
        break;
    }
  };

  let sequenceNumber = random16();
  let timestamp = random32();
  mixer.onData = (data) => {
    const encoded = encoder.encode(data);

    sequenceNumber = uint16Add(sequenceNumber, 1);
    timestamp = uint32Add(timestamp, BigInt(960));

    const header = new RtpHeader({
      sequenceNumber,
      timestamp: Number(timestamp),
      payloadType: 96,
      extension: true,
      marker: false,
      padding: false,
    });
    const rtp = new RtpPacket(header, encoded);
    senderTrack.writeRtp(rtp);
  };
});
