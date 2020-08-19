import { RTCPeerConnection } from "../../../src";
import io from "socket.io-client";

const socket = io("https://serene-anchorage-28732.herokuapp.com/");

(async () => {
  const pc = new RTCPeerConnection({
    stunServer: ["stun.l.google.com", 19302],
  });
  const transceiver = pc.addTransceiver("video", "sendrecv");
  transceiver.onTrack.subscribe((track) =>
    track.onRtp.subscribe(transceiver.sendRtp)
  );

  const offer = pc.createOffer()!;
  await pc.setLocalDescription(offer);

  socket.emit("join", { roomId: "test" });
  socket.on("join", () => {
    console.log("start browser first");
    socket.emit("sdp", {
      sdp: JSON.stringify(pc.localDescription),
      roomId: "test",
    });
  });
  socket.on("sdp", (data: any) => {
    pc.setRemoteDescription(JSON.parse(data.sdp));
  });
})();
