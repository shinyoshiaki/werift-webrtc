import { RTCPeerConnection } from "../../src/index.js";
import { setupPerfectNegotiation } from "./perfectNegotiation.js";

describe("perfect negotiation", () => {
  it("perfect negotiation pattern", async () =>
    new Promise<void>((done) => {
      // Create two peer connections
      const pc1 = new RTCPeerConnection();
      const pc2 = new RTCPeerConnection();

      pc2.onDataChannel.subscribe((channel) => {
        channel.onMessage.subscribe((data) => {
          expect(data.toString()).toBe("hello");
          done();
        });
      });
      const dc = pc1.createDataChannel("chat", { protocol: "bob" });

      dc.stateChanged.subscribe((state) => {
        if (state === "open") {
          dc.send(Buffer.from("hello"));
        }
      });

      const signaling1to2 = {
        send: (data) => {
          setTimeout(() => signaling2to1.onMessageCallback(data), 0);
        },
        onMessage: (callback) => {
          signaling1to2.onMessageCallback = callback;
        },
        onMessageCallback: (data: any) => {},
      };

      const signaling2to1 = {
        send: (data) => {
          setTimeout(() => signaling1to2.onMessageCallback(data), 0);
        },
        onMessage: (callback) => {
          signaling2to1.onMessageCallback = callback;
        },
        onMessageCallback: (data: any) => {},
      };

      setupPerfectNegotiation({
        pc: pc1,
        polite: true,
        signaling: signaling1to2,
      });
      setupPerfectNegotiation({
        pc: pc2,
        polite: false,
        signaling: signaling2to1,
      });
    }));
});
