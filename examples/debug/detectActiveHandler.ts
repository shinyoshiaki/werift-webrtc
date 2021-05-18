import {
  MediaStreamTrack,
  RTCPeerConnection,
  RtpPacket,
  RtpHeader,
} from "../../packages/webrtc/lib/webrtc/src";
const wtf = require("wtfnode");

const pc1 = new RTCPeerConnection();
const pc2 = new RTCPeerConnection();

new Promise<void>(async (done) => {
  const sendonly = new RTCPeerConnection();
  const track = new MediaStreamTrack({ kind: "video" });
  sendonly.addTransceiver(track, { direction: "sendonly" });
  sendonly.connectionStateChange
    .watch((v) => v === "connected")
    .then(() => {
      const rtpPacket = new RtpPacket(
        new RtpHeader(),
        Buffer.from("test")
      ).serialize();
      track.writeRtp(rtpPacket);
    });

  const recvonly = new RTCPeerConnection();
  recvonly.onTransceiver.subscribe((transceiver) => {
    transceiver.onTrack.subscribe((track) => {
      track.onReceiveRtp.subscribe(async (rtp) => {
        await Promise.all([sendonly.close(), recvonly.close()]);
        done();
      });
    });
  });

  await sendonly.setLocalDescription(await sendonly.createOffer());
  await recvonly.setRemoteDescription(sendonly.localDescription!);
  await recvonly.setLocalDescription(await recvonly.createAnswer());
  await sendonly.setRemoteDescription(recvonly.localDescription!);
}).then(async () => {
  await pc1.close();
  await pc2.close();
  wtf.dump();
  // setInterval(() => {
  //   wtf.dump();
  // }, 5000);
});
