import { RTCPeerConnection } from "../../packages/webrtc/lib/webrtc/src";
const wtf = require("wtfnode");

const pc1 = new RTCPeerConnection();
const pc2 = new RTCPeerConnection();

new Promise<void>(async (done) => {
  pc2.onDataChannel.subscribe((channel) => {
    Promise.all([
      channel.message.watch((v) => v === "1"),
      channel.message.watch((v) => v === "2"),
      channel.message.watch((v) => v === "3"),
    ]).then(() => {
      done();
    });
  });

  const channel = pc1.createDataChannel("dc");
  channel.onopen = () => {
    channel.send("1");
    channel.send("2");
    channel.send("3");
  };

  await pc1.setLocalDescription(await pc1.createOffer());
  await pc2.setRemoteDescription(pc1.localDescription);
  await pc2.setLocalDescription(await pc2.createAnswer());
  await pc1.setRemoteDescription(pc2.localDescription);
}).then(async () => {
  await pc1.close();
  await pc2.close();
  //   setInterval(() => {
  //     wtf.dump();
  //   }, 5000);
});