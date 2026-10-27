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

    test(`A closed ${mode} keeps no listener of the SCTP manager`, async () => {
      // Arrange: 開いた channel の組（negotiated でなければ片方は相手が通知したもの）。
      const [channel1, channel2] = await createDataChannelPair(options);
      expect(channel1.stateChange.length).toBe(1);
      expect(channel2.stateChange.length).toBe(1);
      const haveClosed = Promise.all(
        [channel1, channel2].map(
          (channel) => new Promise<void>((r) => (channel.onclose = r)),
        ),
      );

      // Act: 片側から閉じ、両端が closed になるのを待つ。
      channel1.close();
      await haveClosed;

      // Assert: アプリが閉じた channel を持ち続けても、manager の購読は残らない。
      expect(channel1.stateChange.length).toBe(0);
      expect(channel2.stateChange.length).toBe(0);
    });
  },
);
