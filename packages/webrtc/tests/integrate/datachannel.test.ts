import { RTCPeerConnection } from "../../src";

jest.setTimeout(10_000);

describe("datachannel", () => {
  test("send some messages at same time", async () =>
    new Promise<void>(async (done) => {
      const pc1 = new RTCPeerConnection();
      const pc2 = new RTCPeerConnection();

      pc2.onDataChannel.subscribe((channel) => {
        Promise.all([
          channel.onMessage.watch((v) => v === "1"),
          channel.onMessage.watch((v) => v === "2"),
          channel.onMessage.watch((v) => v === "3"),
        ]).then(async () => {
          await pc1.close();
          await pc2.close();
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

      await pc2.setRemoteDescription(pc1.localDescription!);
      await pc2.setLocalDescription(await pc2.createAnswer());
      await pc1.setRemoteDescription(pc2.localDescription!);
    }));
});
