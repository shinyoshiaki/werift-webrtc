import { RTCPeerConnection } from "../../src";
import WS from "ws";
import { RTCSessionDescription } from "../../src/rtc/sdp";

const WEBSOCKET_URI = "ws://127.0.0.1:8765";

(async () => {
  const pc = new RTCPeerConnection();
  const dc = pc.createDataChannel("chat", { protocol: "bob" });
  dc.stateChanged.subscribe((v) => {
    console.log("dc.stateChanged", v);
    if (v === "open") {
      console.log("open");
      let index = 0;
      setInterval(() => {
        dc.send(Buffer.from("ping" + index++));
      }, 1000);
    }
  });
  dc.message.subscribe((data) => {
    console.log("message", data.toString());
  });

  const offer = pc.createOffer()!;
  await pc.setLocalDescription(offer);

  const ws = new WS(WEBSOCKET_URI);
  await new Promise((r) => ws.once("open", r));
  ws.send(JSON.stringify(pc.localDescription));

  const msg = await new Promise<string>((r) =>
    ws.once("message", (data) => r(data))
  );
  const answer = JSON.parse(msg);
  console.log(answer);
  await pc.setRemoteDescription(answer);

  ws.close();
})();
