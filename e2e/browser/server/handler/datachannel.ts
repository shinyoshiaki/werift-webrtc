import { Express } from "express";
import { RTCPeerConnection } from "../../../../packages/webrtc/src";

export function datachannel(app: Express) {
  answer(app);
  offer(app);
}

function answer(app: Express) {
  let pc: RTCPeerConnection;
  app.post("/datachannel_answer", async (req, res) => {
    pc = new RTCPeerConnection({
      stunServer: ["stun.l.google.com", 19302],
    });
    const dc = pc.createDataChannel("dc");
    dc.message.subscribe((msg) => {
      dc.send(msg + "pong");
    });
    await pc.setLocalDescription(pc.createOffer());
    res.send(JSON.stringify(pc.localDescription));
  });
  app.post("/datachannel_answer/candidate", async (req, res) => {
    const candidate = req.body;
    await pc.addIceCandidate(candidate);
    res.send();
  });
  app.post("/datachannel_answer/answer", async (req, res) => {
    const answer = req.body;
    await pc.setRemoteDescription(answer);
    res.send();
  });
}

function offer(app: Express) {
  let pc: RTCPeerConnection;
  app.post("/datachannel_offer", async (req, res) => {
    const offer = req.body;
    pc = new RTCPeerConnection({
      stunServer: ["stun.l.google.com", 19302],
    });
    await pc.setRemoteDescription(offer);
    await pc.setLocalDescription(pc.createAnswer());

    pc.onDataChannel.subscribe((dc) => {
      dc.message.subscribe((msg) => {
        dc.send(msg + "pong");
      });
    });

    res.send(JSON.stringify(pc.localDescription));
  });
  app.post("/datachannel_offer/candidate", async (req, res) => {
    const candidate = req.body;
    await pc.addIceCandidate(candidate);
    res.send();
  });
}
