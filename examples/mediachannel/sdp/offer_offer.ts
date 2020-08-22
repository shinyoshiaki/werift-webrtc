import { RTCPeerConnection } from "../../../src";
import { Server } from "ws";
import { RTCRtpTransceiver } from "../../../src/rtc/media/rtpTransceiver";

const server = new Server({ port: 8888 });
console.log("start");

server.on("connection", async (socket) => {
  const pc = new RTCPeerConnection({
    stunServer: ["stun.l.google.com", 19302],
  });

  let mIndex = 0;
  const onTransceiver = async (transceiver: RTCRtpTransceiver) => {
    const id = mIndex++;
    console.log("on transceiver", transceiver.sender.ssrc, id);
    const track = await transceiver.onTrack.asPromise();
    console.log("ontrack", transceiver.sender.ssrc, track.ssrc, id);
    track.onRtp.subscribe((rtp) => {
      transceiver.sendRtp(rtp);
    });
  };

  onTransceiver(pc.addTransceiver("video", "sendrecv"));
  pc.onTransceiver.subscribe(onTransceiver);

  const offer = pc.createOffer();
  await pc.setLocalDescription(offer);
  const sdp = JSON.stringify(pc.localDescription);
  socket.send(sdp);

  socket.onmessage = async ({ data }) => {
    const answer = JSON.parse(data.toString());
    await pc.setRemoteDescription(answer);
  };

  let i = 0;
  setInterval(async () => {
    if (i++ >= 5) return;
    onTransceiver(pc.addTransceiver("video", "sendrecv"));
    const offer = pc.createOffer();
    await pc.setLocalDescription(offer);
    const sdp = JSON.stringify(pc.localDescription);
    socket.send(sdp);
  }, 1000);
});
