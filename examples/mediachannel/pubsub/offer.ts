import { RTCPeerConnection, RtpTrack } from "../../../src";
import { Server } from "ws";
import { useSdesRTPStreamID } from "../../../src/rtc/extension/rtpExtension";

const server = new Server({ port: 8888 });
console.log("start");

server.on("connection", async (socket) => {
  const pc = new RTCPeerConnection({
    stunServer: ["stun.l.google.com", 19302],
    headerExtensions: {
      video: [useSdesRTPStreamID()],
      audio: [],
    },
  });

  const send = (type: string, payload: any) => {
    socket.send(JSON.stringify({ type, payload }));
  };

  const tracks: { [mid: string]: RtpTrack } = {};

  socket.on("message", async (data: any) => {
    const { type, payload } = JSON.parse(data);
    console.log(type);

    switch (type) {
      case "publish":
        {
          const transceiver = pc.addTransceiver("video", "recvonly");
          transceiver.onTrack.subscribe((track) => {
            tracks[transceiver.mid] = track;
            track.onRtp.once((rtp) => {
              setInterval(() => {
                transceiver.receiver.sendRtcpPLI(rtp.header.ssrc);
              }, 2000);
            });
          });

          await pc.setLocalDescription(pc.createOffer());
          send("offer", { sdp: pc.localDescription });

          send("onPublish", { mid: transceiver.mid });
        }
        break;
      case "subscribe":
        {
          const { mid } = payload;
          const transceiver = pc.addTransceiver("video", "sendonly");
          await pc.setLocalDescription(pc.createOffer());

          send("offer", { sdp: pc.localDescription });

          tracks[mid].onRtp.subscribe((rtp) => {
            transceiver.sendRtp(rtp);
          });
        }
        break;
      case "answer":
        {
          const { sdp } = payload;
          await pc.setRemoteDescription(sdp);
        }
        break;
    }
  });
});
