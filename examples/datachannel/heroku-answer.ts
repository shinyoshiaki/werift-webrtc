import { RTCPeerConnection } from "../../packages/webrtc/src";
import io from "socket.io-client";

const socket = io("https://serene-anchorage-28732.herokuapp.com/");

socket.emit("create", { roomId: "test" });
console.log("create");

socket.on("sdp", async (data: any) => {
  const offer = JSON.parse(data.sdp);
  console.log(offer);

  const pc = new RTCPeerConnection({});
  await pc.setRemoteDescription(offer);
  const answer = pc.createAnswer()!;
  await pc.setLocalDescription(answer);

  socket.emit("sdp", {
    sdp: JSON.stringify(answer),
    roomId: "test",
  });

  pc.onDataChannel.subscribe((channel) => {
    channel.message.subscribe((data) => {
      console.log("answer message", data.toString());
    });
    setInterval(() => channel.send(Buffer.from("ping")), 1000);
  });
});
