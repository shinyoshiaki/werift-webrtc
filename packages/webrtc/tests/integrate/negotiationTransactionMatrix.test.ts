import { MediaStreamTrack } from "../../src";
import {
  expectSessionAlive,
  negotiate,
  sendAndExpectRtp,
  negotiationTest as test,
  waitForDtlsConnected,
} from "./negotiationTransactionUtils";

const VIDEO = "0";
const APPLICATION = "1";

/**
 * Transition matrix of NEGOTIATION_TRANSACTION.md. Every scenario runs twice so
 * that each peer is once the local offerer and once the remote offerer (which
 * also swaps the committed DTLS and ICE roles). Invariants are checked after
 * every description/candidate operation, and the committed session must carry
 * RTP and DataChannel traffic in both directions.
 */
describe.each([
  ["a", "b"],
  ["b", "a"],
] as const)("negotiation transaction matrix (offerer=%s)", (from, to) => {
  test("transceiver stop rejects its m-line and a later transceiver reuses it", async ({
    session,
  }) => {
    const [offerer, answerer] = [session.peers[from], session.peers[to]];
    // Arrange: audio transceiver を追加して交渉する。
    const firstAudio = offerer.pc.addTransceiver("audio", {
      direction: "sendrecv",
    });
    await negotiate(session, offerer, answerer);
    const audioIndex = firstAudio.mLineIndex!;

    // Act: audio transceiver を停止して交渉する。
    firstAudio.stop();
    await negotiate(session, offerer, answerer);
    // Assert: m-line は port 0 で拒否され、共有 BUNDLE transport は止まらない。
    expect(offerer.pc.currentLocalDescription!.sdp).toMatch(/m=audio 0 /);
    await expectSessionAlive(session, "after-stop");

    // Act: 新しい audio transceiver を追加して交渉する。
    const secondAudio = offerer.pc.addTransceiver("audio", {
      direction: "sendrecv",
    });
    await negotiate(session, offerer, answerer);
    // Assert: 停止済み m-line が再利用され、新しい MID で通信を続ける。
    expect(secondAudio.mLineIndex).toBe(audioIndex);
    expect(secondAudio.mid).not.toBe(firstAudio.mid);
    expect(offerer.pc.currentLocalDescription!.sdp.match(/^m=/gm)!.length).toBe(
      3,
    );
    await expectSessionAlive(session, "after-reuse");
  });

  test("BUNDLE split, tag change and merge route RTP by MID", async ({
    session,
  }) => {
    const [offerer, answerer] = [session.peers[from], session.peers[to]];
    // Arrange: audio を追加し、全 m-line を一つの BUNDLE で交渉する。
    const audioOut = new MediaStreamTrack({ kind: "audio" });
    const audio = offerer.pc.addTransceiver(audioOut, {
      direction: "sendonly",
    });
    await negotiate(session, offerer, answerer);
    const audioMid = audio.mid!;
    const remoteAudio = () =>
      answerer.pc.getTransceivers().find((t) => t.mid === audioMid)!;
    const expectAudio = (label: string) =>
      sendAndExpectRtp(audioOut, remoteAudio().receiver.track, label);
    await expectAudio("audio-bundled");

    // Act: audio を BUNDLE から外して別 transport に分割する。
    await negotiate(session, offerer, answerer, {
      localOffer: (sdp) =>
        sdp.replace(
          /^a=group:BUNDLE [^\r\n]+/m,
          `a=group:BUNDLE ${VIDEO} ${APPLICATION}`,
        ),
    });
    // Assert: audio は独立した transport を持ち、MID ごとの経路で届く。
    expect(audio.dtlsTransport).not.toBe(offerer.video.dtlsTransport);
    expect(remoteAudio().dtlsTransport).not.toBe(answerer.video.dtlsTransport);
    await Promise.all([
      waitForDtlsConnected(audio.dtlsTransport),
      waitForDtlsConnected(remoteAudio().dtlsTransport),
    ]);
    await expectAudio("audio-split");
    await expectSessionAlive(session, "split");

    // Act: 再び一つの BUNDLE にまとめ、tag を application に変える。
    await negotiate(session, offerer, answerer, {
      localOffer: (sdp) =>
        sdp.replace(
          /^a=group:BUNDLE [^\r\n]+/m,
          `a=group:BUNDLE ${APPLICATION} ${VIDEO} ${audioMid}`,
        ),
    });
    // Assert: 全 MID が同じ transport に戻り、分割用 transport は閉じる
    // (orphan transport は step 内の invariant で検査する)。
    expect(audio.dtlsTransport).toBe(offerer.video.dtlsTransport);
    expect(remoteAudio().dtlsTransport).toBe(answerer.video.dtlsTransport);
    await expectAudio("audio-merged");
    await expectSessionAlive(session, "merged");
  });
});
