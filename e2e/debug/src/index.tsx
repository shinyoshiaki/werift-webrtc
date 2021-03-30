import { waitVideoPlay } from "../../tests/fixture";
import { WebSocketTransport, Peer } from "protoo-client";

const transport = new WebSocketTransport("ws://localhost:8886");
const peer = new Peer(transport);

(async () => {
  const pc = new RTCPeerConnection({
    iceServers: [{ urls: "stun:stun.l.google.com:19302" }],
  });

  let count = 0;
  const finish = () => {
    if (++count == 2) console.log("done");
  };
  pc.ontrack = ({ track }) => {
    waitVideoPlay(track).then(finish);
  };

  const [track] = (
    await navigator.mediaDevices.getUserMedia({
      video: {
        width: {
          ideal: 4096,
        },
        height: {
          ideal: 2160,
        },
        frameRate: {
          ideal: 60,
          min: 10,
        },
      },
      audio: false,
    })
  ).getTracks();

  pc.addTransceiver(track, {
    direction: "sendonly",
    sendEncodings: [
      {
        rid: "high",
        maxBitrate: 900000,
        scaleResolutionDownBy: 1,
      },
      {
        rid: "low",
        maxBitrate: 100000,
        scaleResolutionDownBy: 4,
      },
    ],
  });
  pc.addTransceiver("video", { direction: "recvonly" });
  pc.addTransceiver("video", { direction: "recvonly" });
  pc.onicecandidate = ({ candidate }) => {
    peer.request("mediachannel_simulcast_offer", {
      type: "candidate",
      payload: candidate,
    });
  };

  await pc.setLocalDescription(await pc.createOffer());
  const answer = await peer.request("mediachannel_simulcast_offer", {
    type: "init",
    payload: pc.localDescription,
  });
  await pc.setRemoteDescription(answer);
})();
