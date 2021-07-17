import { setTimeout } from "timers/promises";

import { RTCRtpReceiver } from "../../src/media/rtpReceiver";
import { createDtlsTransport } from "../fixture";

describe("packages/webrtc/src/media/rtpReceiver.ts", () => {
  test("abort runRtcp", async () =>
    new Promise<void>(async (done) => {
      const dtls = createDtlsTransport();
      const receiver = new RTCRtpReceiver("audio", dtls, 1234);
      jest.spyOn(dtls, "sendRtcp");

      Promise.any([
        setTimeout(200).then(() => false),
        receiver.runRtcp().then(() => true),
      ]).then((res) => {
        expect(res).toBeTruthy();
        done();
      });

      await setTimeout(10);
      receiver.stop();
    }));
});
