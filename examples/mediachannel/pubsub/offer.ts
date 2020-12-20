import { RTCPeerConnection, RtpTrack } from "../../../src";
import { Server } from "ws";
import { useSdesRTPStreamID } from "../../../src/rtc/extension/rtpExtension";

const server = new Server({ port: 8888 });
console.log("start");

server.on("connection", async (socket) => {
  const send = (type: string, payload: any) => {
    socket.send(JSON.stringify({ type, payload }));
  };

  const pc = new RTCPeerConnection({
    stunServer: ["stun.l.google.com", 19302],
    headerExtensions: {
      video: [useSdesRTPStreamID()],
      audio: [],
    },
  });
  // dummy
  pc.addTransceiver("video", "sendonly");
  await pc.setLocalDescription(pc.createOffer());
  send("offer", { sdp: pc.localDescription });

  const tracks: { [mid: string]: RtpTrack } = {};

  socket.on("message", async (data: any) => {
    const { type, payload } = JSON.parse(data);
    console.log(type);

    switch (type) {
      case "publish":
        {
          const transceiver = pc.addTransceiver("video", "recvonly");
          transceiver.onTrack.subscribe((track) => {
            track.onRtp.once((rtp) => {
              setInterval(() => {
                transceiver.receiver.sendRtcpPLI(rtp.header.ssrc);
              }, 1000);
            });
            tracks[transceiver.mid] = track;
          });

          await pc.setLocalDescription(pc.createOffer());
          send("offer", { sdp: pc.localDescription });
          send("onPublish", { mid: transceiver.mid });
        }
        break;
      case "unpublish":
        {
          const { mid } = payload;
          const transceiver = pc.transceivers.find((t) => t.mid === mid);
          pc.removeTrack(transceiver);
          await pc.setLocalDescription(pc.createOffer());
          send("offer", { sdp: pc.localDescription });
          send("onUnPublish", { mid });
        }
        break;
      case "subscribe":
        {
          const { mid } = payload;
          const transceiver = pc.addTransceiver("video", "sendonly");
          await pc.setLocalDescription(pc.createOffer());

          send("onSubscribe", { media: mid, mid: transceiver.mid });
          send("offer", { sdp: pc.localDescription });

          tracks[mid].onRtp.subscribe((rtp) => {
            transceiver.sendRtp(rtp);
          });
        }
        break;
      case "unsubscribe":
        {
          const { mid } = payload;
          const transceiver = pc.transceivers.find((t) => t.mid === mid);
          pc.removeTrack(transceiver);
          await pc.setLocalDescription(pc.createOffer());

          send("offer", { sdp: pc.localDescription });
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
