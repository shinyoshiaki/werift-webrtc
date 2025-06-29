import { describe } from "vitest";
import { RTCPeerConnection } from "../../src/index.js";

describe("mix", () => {
  it("should datachannel at first", async () => {
    const server = new RTCPeerConnection();
    server.createDataChannel("test");

    const offer = await server.setLocalDescription(await server.createOffer());

    const client = new RTCPeerConnection();
    await client.setRemoteDescription(offer);
    const answer = await client.setLocalDescription(
      await client.createAnswer(),
    );

    await server.setRemoteDescription(answer);

    {
      server.addTransceiver("audio", { direction: "recvonly" });
      const offer = await server.setLocalDescription(
        await server.createOffer(),
      );
      expect(offer.media[0].kind).toBe("application");
      expect(offer.media[1].kind).toBe("audio");

      await client.setRemoteDescription(offer);
      const answer = await client.setLocalDescription(
        await client.createAnswer(),
      );
      expect(answer.media[0].kind).toBe("application");
      expect(answer.media[1].kind).toBe("audio");
    }
  });
});
