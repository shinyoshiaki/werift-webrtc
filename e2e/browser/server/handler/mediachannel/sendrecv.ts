import { Express } from "express";
import { RTCPeerConnection } from "../../../../../packages/webrtc/src";

export function mediachannel_sendrecv(app: Express) {
  answer(app);
}

function answer(app: Express) {
  let pc: RTCPeerConnection;

  app.post("/mediachannel_sendrecv_answer", async (req, res) => {
    pc = new RTCPeerConnection({
      stunServer: ["stun.l.google.com", 19302],
    });
    const transceiver = pc.addTransceiver("video", "sendrecv");
    transceiver.onTrack.subscribe((track) => {
      track.onRtp.subscribe((rtp) => {
        transceiver.sendRtp(rtp);
      });
    });

    await pc.setLocalDescription(pc.createOffer());
    res.send(JSON.stringify(pc.localDescription));
  });
  app.post("/mediachannel_sendrecv_answer/candidate", async (req, res) => {
    const candidate = req.body;
    await pc.addIceCandidate(candidate);
    res.send();
  });
  app.post("/mediachannel_sendrecv_answer/answer", async (req, res) => {
    const answer = req.body;
    await pc.setRemoteDescription(answer);
    res.send();
  });
}
