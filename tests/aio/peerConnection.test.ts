import { RTCPeerConnection } from "../../src";
import WS from "ws";
import { PythonShell } from "python-shell";
import { sleep } from "../../src/helper";
const WEBSOCKET_URI = "ws://127.0.0.1:8765";

describe("aio_peerConnection", () => {
  test(
    "aio_datachannel",
    async (done) => {
      const server = PythonShell.run(
        "tests/python/signaling-server.py",
        undefined,
        (err) => {
          if (err) console.log(err);
        }
      );
      const client = PythonShell.run(
        "tests/python/peerConnection/answer.py",
        undefined,
        (err) => {
          if (err) console.log(err);
        }
      );

      const pc = new RTCPeerConnection({
        stunServer: ["stun.l.google.com", 19302],
      });
      const dc = pc.createDataChannel("chat", { protocol: "bob" });

      dc.message.subscribe((msg) => {
        expect(msg.toString()).toBe("ping");
        server.kill();
        client.kill();
        ws.close();
        done();
      });

      await sleep(5000);
      const ws = new WS(WEBSOCKET_URI);
      await new Promise((r) => ws.once("open", r));

      const offer = pc.createOffer()!;
      await pc.setLocalDescription(offer);

      ws.send(JSON.stringify(pc.localDescription));

      const msg = await new Promise<string>((r) =>
        ws.once("message", (data) => r(data))
      );
      const answer = JSON.parse(msg);
      await pc.setRemoteDescription(answer);
    },
    15 * 1000
  );
});