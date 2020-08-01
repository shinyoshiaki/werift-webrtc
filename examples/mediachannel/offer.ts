import { RTCPeerConnection } from "../../src";
import { Server } from "ws";
import { sleep } from "../../src/helper";

const server = new Server({ port: 8888 });
console.log("start");

server.on("connection", async (socket) => {
  await sleep(1000);
  const pc = new RTCPeerConnection({
    stunServer: ["stun.l.google.com", 19302],
  });
  pc.iceConnectionStateChange.subscribe((v) =>
    console.log("pc.iceConnectionStateChange", v)
  );
  pc.addTransceiver("video", "recvonly");
  const offer = pc.createOffer();
  await pc.setLocalDescription(offer);
  const sdp = JSON.stringify(pc.localDescription);
  socket.send(sdp);

  const answer = JSON.parse(
    await new Promise((r) => socket.on("message", (data) => r(data as string)))
  );
  console.log(answer);

  await pc.setRemoteDescription(answer);
});
