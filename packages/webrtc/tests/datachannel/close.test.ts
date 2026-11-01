import { createDataChannelPair } from "../utils";

describe.each([{}, { negotiated: true, id: 0 }])(
  "datachannel/close",
  (options) => {
    const mode = `${options.negotiated ? "negotiated " : ""}datachannel`;

    test(`Close ${mode} causes onclosing and onclose to be called`, async () => {
      const [channel1, channel2] = await createDataChannelPair(options);
      const haveClosed = new Promise<void>((r) => (channel2.onclose = r));
      let closingSeen = false;
      //   channel1.onclosing = t.unreached_func();
      channel2.onclosing = () => {
        expect(channel2.readyState).toBe("closing");
        closingSeen = true;
      };
      //   channel2.addEventListener("error", t.unreached_func());
      channel1.close();
      await haveClosed;
      expect(channel2.readyState).toBe("closed");
      expect(closingSeen).toBeTruthy();
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
