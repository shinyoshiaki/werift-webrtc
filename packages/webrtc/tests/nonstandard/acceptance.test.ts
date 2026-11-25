import { RtpHeader, RtpPacket } from "../../src/imports/rtp";
import { MediaStreamTrack } from "../../src/polyfill/dom";
import {
  arrangePolyfilledProducer,
  compilePolyfillFixture,
  TYPESCRIPT_COMPILE_TEST_TIMEOUT_MS,
} from "./polyfillTestUtils";

/**
 * Acceptance test of ticket 36345b67: with `werift/polyfill/dom` (lib.dom), a
 * werift `MediaStreamTrack` goes to a DOM-typed API such as
 * `mediasoup-client`'s `produce({ track })` without
 * `as unknown as ProducerOptions["track"]`, and at runtime the polyfilled
 * `RTCPeerConnection` sends that same track and its `"ended"` reaches the
 * listener the library registered. Uses tsc on a fixture and two real
 * polyfilled peers on loopback.
 */
describe("acceptance: a werift track goes to a DOM-typed producer without a cast", () => {
  test(
    "1章・5章: チケットのコードがキャストなしで lib.dom の型検査を通り、型は any にならない",
    () => {
      // Act: lib.dom + skipLibCheck=false で、キャストを外したチケットのコードをコンパイルする。
      const result = compilePolyfillFixture("acceptanceDomCompile");

      // Assert: 型エラーがない（@ts-expect-error も満たされ、DOM 型のまま検査されている）。
      expect(result.status, result.stdout + result.stderr).toBe(0);
    },
    TYPESCRIPT_COMPILE_TEST_TIMEOUT_MS,
  );

  test("1章・2章: キャストせず渡した track が送られ、ライブラリの ended listener に停止が届く", async () => {
    const { produce, remoteTrack, ended, close } =
      await arrangePolyfilledProducer();
    try {
      // Act: mediasoup-client と同じ使い方で、DOM 型の constructor から作った track を渡す。
      const track = new MediaStreamTrack({ kind: "audio" });
      const { closeProducer } = await produce(track);

      // Assert: ライブラリが見る readyState / enabled は送信中の値になっている。
      expect([track.readyState, track.enabled]).toEqual(["live", true]);

      // Act: アプリが同じ track に RTP を書く。
      const received = await remoteTrack;
      const payload = Buffer.from("acceptance");
      const arrived = new Promise<Buffer>((resolve) =>
        received.onReceiveRtp.subscribe((rtp) => resolve(rtp.payload)),
      );
      const timer = setInterval(
        () => track.writeRtp(new RtpPacket(new RtpHeader(), payload)),
        20,
      );
      const delivered = await arrived.finally(() => clearInterval(timer));

      // Assert: 受信側にその RTP が届く（polyfill の RTCPeerConnection が werift の track を送っている）。
      expect(delivered).toEqual(payload);

      // Act: track を止める（2 回呼んでも通知は 1 回）。
      track.stop();
      track.stop();

      // Assert: ライブラリの "ended" listener が ended の状態で 1 回だけ呼ばれる。
      expect(ended).toEqual(["ended"]);
      closeProducer();
    } finally {
      await close();
    }
  });
});
