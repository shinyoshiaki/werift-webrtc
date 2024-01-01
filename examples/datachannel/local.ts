import { RTCPeerConnection, RTCDataChannel } from "../../packages/webrtc/src";

(async () => {
  const pcOffer = new RTCPeerConnection({});
  const pcAnswer = new RTCPeerConnection({});

  const dc = pcOffer.createDataChannel("chat");

  dc.stateChanged.subscribe((state) => {
    if (state === "open") {
      console.log("offer send", Buffer.from("hello"));
      dc.send(Buffer.from("hello"));
      console.log("offer sent");
    }
  });
  dc.onMessage.subscribe((v) => console.log("offer", v.toString()));

  pcAnswer.onDataChannel.subscribe((channel) => {
    channel.onMessage.subscribe((v) => console.log("answer", v.toString()));
    console.log("answer send", Buffer.from("hi"));
    channel.send(Buffer.from("hi"));
    console.log("answer sent");
  });

  const offer = await pcOffer.createOffer()!;
  await pcOffer.setLocalDescription(offer);
  await pcAnswer.setRemoteDescription(pcOffer.localDescription!);

  const answer = await pcAnswer.createAnswer()!;
  await pcAnswer.setLocalDescription(answer);
  await pcOffer.setRemoteDescription(pcAnswer.localDescription!);

  await assertIceCompleted(pcOffer, pcAnswer);
  await assertDataChannelOpen(dc);
})();

async function assertIceCompleted(
  pc1: RTCPeerConnection,
  pc2: RTCPeerConnection,
) {
  const wait = (pc: RTCPeerConnection) =>
    new Promise<void>((r) => {
      pc.iceConnectionStateChange.subscribe((v) => {
        if (v === "completed") {
          r();
        }
      });
    });

  await Promise.all([wait(pc1), wait(pc2)]);
}

async function assertDataChannelOpen(dc: RTCDataChannel) {
  return new Promise<void>((r) => {
    dc.stateChanged.subscribe((v) => {
      if (v === "open") {
        r();
      }
    });
  });
}
