import { Peer, WebSocketTransport } from "protoo-client";
import { waitVideoPlay } from "../fixture";

const transport = new WebSocketTransport("ws://localhost:8886");
const peer = new Peer(transport);
describe("mediachannel_simulcast", () => {
  it("answer", async (done) => {
    const pc = new RTCPeerConnection({
      iceServers: [{ urls: "stun:stun.l.google.com:19302" }],
    });

    let count = 0;
    const finish = () => {
      if (++count == 2) done();
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

    const offer = await peer.request("mediachannel_simulcast_answer", {
      type: "init",
    });
    await pc.setRemoteDescription(offer);
    pc.addTrack(track);
    const transceiver = pc.getTransceivers()[0];
    const params = transceiver.sender.getParameters();
    console.log(params);
    params.encodings = [
      {
        rid: "high",
        maxBitrate: 200000,
        scaleResolutionDownBy: 1,
      },

      {
        rid: "low",
        maxBitrate: 100000 / 4,
        scaleResolutionDownBy: 4,
      },
    ];
    transceiver.sender.setParameters(params);
    await pc.setLocalDescription(await pc.createAnswer());

    pc.onicecandidate = ({ candidate }) => {
      peer.request("mediachannel_simulcast_answer", {
        type: "candidate",
        payload: candidate,
      });
    };

    peer.request("mediachannel_simulcast_answer", {
      type: "answer",
      payload: pc.localDescription,
    });
  });
});
