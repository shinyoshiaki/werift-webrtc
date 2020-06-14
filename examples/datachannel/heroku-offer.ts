import { RTCPeerConnection } from "../../src";
import io from "socket.io-client";

const socket = io("https://serene-anchorage-28732.herokuapp.com/");

(async () => {
  const pc = new RTCPeerConnection({
    stunServer: ["stun.l.google.com", 19302],
  });
  const dc = pc.createDataChannel("chat", { protocol: "bob" });
  dc.state.subscribe((v) => {
    if (v === "open") {
      console.log("open");
      setInterval(() => {
        dc.send(Buffer.from("ping"));
      }, 1000);
    }
  });
  dc.message.subscribe((data) => {
    console.log("message", data.toString());
  });

  const offer = pc.createOffer()!;
  await pc.setLocalDescription(offer);

  socket.emit("join", { roomId: "test" });
  socket.on("join", () => {
    socket.emit("sdp", {
      sdp: JSON.stringify(pc.localDescription),
      roomId: "test",
    });
  });
  socket.on("sdp", (data: any) => {
    pc.setRemoteDescription(JSON.parse(data.sdp));
  });
})();
