import {
  RTCPeerConnection,
  MediaStreamTrack,
  useSdesRTPStreamID,
} from "../../../packages/webrtc/src";
import { Server } from "ws";

const server = new Server({ port: 8888 });
console.log("start");

server.on("connection", async (socket) => {
  const send = (type: string, payload: any) => {
    socket.send(JSON.stringify({ type, payload }));
  };

  const pc = new RTCPeerConnection({
    headerExtensions: {
      video: [useSdesRTPStreamID()],
      audio: [],
    },
  });
  // dummy
  pc.addTransceiver("video", "sendonly");
  await pc.setLocalDescription(await pc.createOffer());
  send("offer", { sdp: pc.localDescription });

  const tracks: { [mid: string]: MediaStreamTrack } = {};

  socket.on("message", async (data: any) => {
    const { type, payload } = JSON.parse(data);
    console.log(type);

    switch (type) {
      case "publish":
        {
          const transceiver = pc.addTransceiver("video", "recvonly");
          transceiver.onTrack.subscribe((track) => {
            track.onReceiveRtp.once((rtp) => {
              setInterval(() => {
                transceiver.receiver.sendRtcpPLI(rtp.header.ssrc);
              }, 1000);
            });
            tracks[transceiver.mid] = track;
          });

          await pc.setLocalDescription(await pc.createOffer());
          send("offer", { sdp: pc.localDescription });
          send("onPublish", { media: transceiver.mid });
        }
        break;
      case "unpublish":
        {
          const { media } = payload;
          const transceiver = pc.transceivers.find((t) => t.mid === media);
          pc.removeTrack(transceiver);
          await pc.setLocalDescription(await pc.createOffer());
          send("offer", { sdp: pc.localDescription });
          send("onUnPublish", { media });
        }
        break;
      case "subscribe":
        {
          const { media } = payload;
          const transceiver = pc.addTransceiver("video", "sendonly");
          await pc.setLocalDescription(await pc.createOffer());

          send("offer", { sdp: pc.localDescription });
          send("onSubscribe", { media, mid: transceiver.mid });

          const track = tracks[media];
          await transceiver.sender.replaceTrack(track);
        }
        break;
      case "unsubscribe":
        {
          const { mid } = payload;
          const transceiver = pc.transceivers.find((t) => t.mid === mid);
          pc.removeTrack(transceiver);
          await pc.setLocalDescription(await pc.createOffer());

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
