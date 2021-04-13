import { createDataChannelPair } from "../utils";

xdescribe.each([{}, { negotiated: true, id: 0 }])(
  "datachannel/close",
  (options) => {
    const mode = `${options.negotiated ? "negotiated " : ""}datachannel`;

    test(`Close ${mode} causes onclosing and onclose to be called`, async () => {
      const [channel1, channel2] = await createDataChannelPair(options);
      const haveClosed = new Promise<void>((r) => (channel2.onclose = r));
      let closingSeen = false;
      channel1.onclosing = () => {
        throw new Error();
      };
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
  }
);
