import { MediaStreamTrack } from "../../../src";
import { describeCases, negotiationCase } from "../harness/negotiationCase";
import {
  createDirectedDuplexSession,
  createRewrittenOffer,
  waitForDtlsConnected,
} from "../harness/negotiationTransactionUtils";

/** The offer `sdp` with one BUNDLE group of `mids` (space separated). */
const withBundle = (sdp: string, mids: string) =>
  sdp.replace(/^a=group:BUNDLE [^\r\n]+/m, `a=group:BUNDLE ${mids}`);

/**
 * Transition matrix of NEGOTIATION_TRANSACTION.md. Every scenario runs twice so
 * that each peer is once the local offerer and once the remote offerer (which
 * also swaps the committed DTLS and ICE roles): `a` is the offerer and `b` the
 * answerer of `createDirectedDuplexSession(from)`. Invariants are checked after
 * every description/candidate operation, and the committed session must carry
 * RTP and DataChannel traffic in both directions. Video is MID "0" and the
 * application MID "1".
 */
for (const from of ["a", "b"] as const) {
  describeCases(`negotiation transaction matrix (offerer=${from})`, () => {
    negotiationCase(
      "transceiver stop rejects its m-line and a later transceiver reuses it",
      { ref: "2.1-T10" },
      async (c) => {
        // Arrange: audio transceiver を追加して交渉する。
        const { a } = await c.given(createDirectedDuplexSession(from));
        const firstAudio = a.addTransceiver("audio", { direction: "sendrecv" });
        await c.negotiate(a);
        const audioIndex = firstAudio.mLineIndex;

        // Act: audio transceiver を停止して交渉する。
        firstAudio.stop();
        await c.negotiate(a);

        // Assert: m-line は port 0 で拒否され、共有 BUNDLE transport は止まらない。
        expect(a.currentLocalDescription!.sdp).toMatch(/m=audio 0 /);
        await c.alive();

        // Act: 新しい audio transceiver を追加して交渉する。
        const secondAudio = a.addTransceiver("audio", {
          direction: "sendrecv",
        });
        await c.negotiate(a);

        // Assert: 停止済み m-line が再利用され、新しい MID で通信を続ける。
        expect(secondAudio.mLineIndex).toEqual(audioIndex);
        expect(secondAudio.mid).not.toBe(firstAudio.mid);
        expect(a.currentLocalDescription!.sdp.match(/^m=/gm)!.length).toEqual(
          3,
        );
        await c.alive();
      },
    );

    negotiationCase(
      "BUNDLE split, tag change and merge route RTP by MID",
      { ref: "2.1-T9 2.5-T1 5-5" },
      async (c) => {
        // Arrange: audio を追加し、全 m-line を一つの BUNDLE で交渉する。
        const { a, b, aVideo, bVideo } = await c.given(
          createDirectedDuplexSession(from),
        );
        const audioOut = new MediaStreamTrack({ kind: "audio" });
        const audio = a.addTransceiver(audioOut, { direction: "sendonly" });
        await c.negotiate(a);
        const remoteAudio = () =>
          b.getTransceivers().find((t) => t.mid === audio.mid)!;
        await c.rtp(audioOut, remoteAudio().receiver.track);

        // Act: audio を BUNDLE から外して別 transport に分割する。
        await c.setLocal(
          a,
          await createRewrittenOffer(a, (sdp) => withBundle(sdp, "0 1")),
        );
        await c.setRemote(b, a.localDescription);
        await c.answer(b);

        // Assert: audio は独立した transport を持ち、MID ごとの経路で届く。
        expect(audio.dtlsTransport).not.toBe(aVideo.dtlsTransport);
        expect(remoteAudio().dtlsTransport).not.toBe(bVideo.dtlsTransport);
        await Promise.all([
          waitForDtlsConnected(audio.dtlsTransport),
          waitForDtlsConnected(remoteAudio().dtlsTransport),
        ]);
        await c.rtp(audioOut, remoteAudio().receiver.track);
        await c.alive();

        // Act: 再び一つの BUNDLE にまとめ、tag を application に変える。
        await c.setLocal(
          a,
          await createRewrittenOffer(a, (sdp) =>
            withBundle(sdp, `1 0 ${audio.mid}`),
          ),
        );
        await c.setRemote(b, a.localDescription);
        await c.answer(b);

        // Assert: 全 MID が同じ transport に戻り、分割用 transport は閉じる (orphan transport は各操作後の invariant で検査する)。
        expect(audio.dtlsTransport).toBe(aVideo.dtlsTransport);
        expect(remoteAudio().dtlsTransport).toBe(bVideo.dtlsTransport);
        await c.rtp(audioOut, remoteAudio().receiver.track);
        await c.alive();
      },
    );
  });
}
