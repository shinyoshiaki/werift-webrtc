import { negotiationCases } from "./negotiationCaseRunner";

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
  negotiationCases(
    `negotiation transaction matrix (offerer=${from})`,
    [
      `
        case: transceiver stop rejects its m-line and a later transceiver reuses it
        ref: 2.1-T10
        given: createDirectedDuplexSession(from)
        Arrange: audio transceiver を追加して交渉する。
        let firstAudio = a.addTransceiver("audio", { direction: "sendrecv" })
        a negotiate
        let audioIndex = firstAudio.mLineIndex
        Act: audio transceiver を停止して交渉する。
        do firstAudio.stop()
        a negotiate
        Assert: m-line は port 0 で拒否され、共有 BUNDLE transport は止まらない。
        expect a.currentLocalDescription.sdp matches /m=audio 0 /
        alive
        Act: 新しい audio transceiver を追加して交渉する。
        let secondAudio = a.addTransceiver("audio", { direction: "sendrecv" })
        a negotiate
        Assert: 停止済み m-line が再利用され、新しい MID で通信を続ける。
        expect secondAudio.mLineIndex == audioIndex
        expect secondAudio.mid isnt firstAudio.mid
        expect a.currentLocalDescription.sdp.match(/^m=/gm).length == 3
        alive
      `,
      `
        case: BUNDLE split, tag change and merge route RTP by MID
        ref: 2.1-T9 2.5-T1 5-5
        given: createDirectedDuplexSession(from)
        Arrange: audio を追加し、全 m-line を一つの BUNDLE で交渉する。
        let audioOut = new MediaStreamTrack({ kind: "audio" })
        let audio = a.addTransceiver(audioOut, { direction: "sendonly" })
        a negotiate
        let remoteAudio = () => b.getTransceivers().find((t) => t.mid === audio.mid)
        rtp audioOut -> remoteAudio().receiver.track
        Act: audio を BUNDLE から外して別 transport に分割する。
        a setLocal createRewrittenOffer(a, (sdp) => withBundle(sdp, "0 1"))
        b setRemote local(a)
        b answer
        Assert: audio は独立した transport を持ち、MID ごとの経路で届く。
        expect audio.dtlsTransport isnt aVideo.dtlsTransport
        expect remoteAudio().dtlsTransport isnt bVideo.dtlsTransport
        do Promise.all([waitForDtlsConnected(audio.dtlsTransport), waitForDtlsConnected(remoteAudio().dtlsTransport)])
        rtp audioOut -> remoteAudio().receiver.track
        alive
        Act: 再び一つの BUNDLE にまとめ、tag を application に変える。
        a setLocal createRewrittenOffer(a, (sdp) => withBundle(sdp, "1 0 " + audio.mid))
        b setRemote local(a)
        b answer
        Assert: 全 MID が同じ transport に戻り、分割用 transport は閉じる (orphan transport は各操作後の invariant で検査する)。
        expect audio.dtlsTransport is aVideo.dtlsTransport
        expect remoteAudio().dtlsTransport is bVideo.dtlsTransport
        rtp audioOut -> remoteAudio().receiver.track
        alive
      `,
    ],
    { fns: { from, withBundle } },
  );
}
