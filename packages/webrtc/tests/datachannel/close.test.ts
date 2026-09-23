import { RTCPeerConnection } from "../../src";
import { createDataChannelPair } from "../utils";

describe.each([{}, { negotiated: true, id: 0 }])(
  "datachannel/close",
  (options) => {
    const mode = `${options.negotiated ? "negotiated " : ""}datachannel`;

    test(`Close ${mode} causes onclosing and onclose to be called`, async () => {
      // Arrange: use an isolated pair so the close lifecycle is not affected by
      // connections left behind by neighboring DataChannel tests.
      const pc1 = new RTCPeerConnection();
      const pc2 = new RTCPeerConnection();
      try {
        const [channel1, channel2] = await createDataChannelPair(
          options,
          pc1,
          pc2,
        );
        const haveClosed = new Promise<void>((r) => (channel2.onclose = r));
        let closingSeen = false;
        //   channel1.onclosing = t.unreached_func();
        channel2.onclosing = () => {
          expect(channel2.readyState).toBe("closing");
          closingSeen = true;
        };
        //   channel2.addEventListener("error", t.unreached_func());

        // Act: close the local channel and wait for the remote lifecycle event.
        channel1.close();
        await haveClosed;

        // Assert: the remote side observed both closing and closed states.
        expect(channel2.readyState).toBe("closed");
        expect(closingSeen).toBeTruthy();
      } finally {
        await Promise.allSettled([pc1.close(), pc2.close()]);
      }
    });
  },
);
