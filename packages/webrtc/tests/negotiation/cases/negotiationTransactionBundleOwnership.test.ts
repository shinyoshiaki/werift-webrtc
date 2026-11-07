import { expect } from "vitest";

import { type RTCDtlsTransport, RTCPeerConnection } from "../../../src";
import { bundleGroups } from "../../issue/705.helpers";
import {
  describeCases,
  type NegotiationCase,
  negotiationCase,
} from "../harness/negotiationCase";
import {
  assertTransportsClosed,
  createRewrittenOffer,
  heldTransports,
} from "../harness/negotiationTransactionUtils";

/**
 * Arrange: max-compat (default) peers where `a` has audio + video (+ a
 * DataChannel), so each m-line of its first offer owns its own transport
 * until a BUNDLE answer merges them.
 */
function maxCompatPeers(c: NegotiationCase, { channel = true } = {}) {
  const a = c.peer(new RTCPeerConnection(), "a");
  const b = c.peer(new RTCPeerConnection(), "b");
  const audio = a.addTransceiver("audio", { direction: "sendrecv" });
  const video = a.addTransceiver("video", { direction: "sendrecv" });
  if (channel) a.createDataChannel("dc");
  return { a, b, audio, video };
}

/** The UDP / TCP / TURN sockets the ICE agent of `transport` still holds. */
const openSockets = (transport: RTCDtlsTransport) =>
  (transport.iceTransport.connection as unknown as { protocols: unknown[] })
    .protocols.length;

/**
 * A remote BUNDLE description that moves max-compat m-lines onto one transport
 * must not orphan the transports it replaced (no UDP socket or ICE agent may
 * outlive the peer connection).
 */
describeCases("negotiation transaction: BUNDLE transport ownership", () => {
  negotiationCase(
    "a BUNDLE answer for max-compat audio, video and a DataChannel stops the replaced transports",
    { ref: "origin: ticket-3812d7fd (SCTP + media)" },
    async (c) => {
      // Arrange: m-line ごとに transport を持つ初回 offer を適用する。
      const { a, b, audio, video } = maxCompatPeers(c);
      await c.offer(a);
      const proposed = heldTransports(a);
      expect(proposed.size).toEqual(3);

      // Act: 全 m-line を 1 つの BUNDLE group にまとめた answer を適用する。
      await c.answer(b);

      // Assert: media と SCTP は tag (audio) の transport を共有し、残りは閉じる。
      expect(bundleGroups(a.currentRemoteDescription!.sdp)).toEqual([
        [audio.mid!, video.mid!, a.sctpTransport!.mid!],
      ]);
      const shared = audio.dtlsTransport;
      expect(video.dtlsTransport).toBe(shared);
      expect(a.sctpTransport!.dtlsTransport).toBe(shared);
      expect(a.dtlsTransports).toEqual([shared]);
      const dropped = [...proposed].filter((t) => t !== shared);
      expect(dropped.length).toEqual(2);
      assertTransportsClosed(dropped);
      expect(dropped.map(openSockets)).toEqual([0, 0]);
      expect(shared.state).not.toEqual("closed");
    },
  );

  negotiationCase(
    "a BUNDLE group that leaves the DataChannel outside keeps its transport running",
    { ref: "origin: ticket-3812d7fd (shared transport kept)" },
    async (c) => {
      // Arrange: audio と video だけを BUNDLE し、application m-line を group 外にした offer を適用する。
      const { a, b, audio, video } = maxCompatPeers(c);
      const offer = await createRewrittenOffer(a, (sdp) =>
        sdp.replace(
          /^a=group:BUNDLE [^\r\n]+/m,
          `a=group:BUNDLE ${audio.mid} ${video.mid}`,
        ),
      );
      await c.setLocal(a, offer);
      await c.setRemote(b, a.localDescription);
      const sctpTransport = a.sctpTransport!.dtlsTransport;

      // Act: group を写した answer を適用する。
      await c.answer(b);

      // Assert: video の transport だけが閉じ、SCTP の transport は使われ続ける。
      expect(bundleGroups(a.currentRemoteDescription!.sdp)).toEqual([
        [audio.mid!, video.mid!],
      ]);
      expect(video.dtlsTransport).toBe(audio.dtlsTransport);
      expect(a.sctpTransport!.dtlsTransport).toBe(sctpTransport);
      expect(sctpTransport).not.toBe(audio.dtlsTransport);
      expect(a.dtlsTransports.length).toEqual(2);
      expect(a.dtlsTransports.map((t) => t.state)).not.toContain("closed");
      const dropped = [...heldTransports(a)].filter(
        (t) => !a.dtlsTransports.includes(t),
      );
      assertTransportsClosed(dropped);
    },
  );

  negotiationCase(
    "an answerer whose transceivers and DataChannel existed before a BUNDLE offer stops their own transports",
    { ref: "origin: ticket-3812d7fd (remote offer)" },
    async (c) => {
      // Arrange: b は remote offer の前に audio・video・DataChannel を作る (m-line ごとの transport)。
      const { a, b } = maxCompatPeers(c);
      const bAudio = b.addTransceiver("audio", { direction: "sendrecv" });
      const bVideo = b.addTransceiver("video", { direction: "sendrecv" });
      b.createDataChannel("early");
      const ownBefore = new Set([
        bAudio.dtlsTransport,
        bVideo.dtlsTransport,
        b.sctpTransport!.dtlsTransport!,
      ]);
      expect(ownBefore.size).toEqual(3);
      await c.offer(a);

      // Act: BUNDLE offer に answer を返して確定する。
      await c.answer(b);

      // Assert: b は 1 つの transport にまとまり、前に作った transport で使われないものは閉じる。
      expect(b.dtlsTransports.length).toEqual(1);
      const [shared] = b.dtlsTransports;
      expect(bAudio.dtlsTransport).toBe(shared);
      expect(bVideo.dtlsTransport).toBe(shared);
      expect(b.sctpTransport!.dtlsTransport).toBe(shared);
      assertTransportsClosed([...ownBefore].filter((t) => t !== shared));
    },
  );

  negotiationCase(
    "a BUNDLE pranswer keeps the replaced transports owned until the final answer stops them",
    { ref: "origin: ticket-3812d7fd (pranswer)" },
    async (c) => {
      // Arrange: m-line ごとの transport を持つ初回 offer。
      const { a, b, audio } = maxCompatPeers(c);
      await c.offer(a);
      const proposed = heldTransports(a);

      // Act: BUNDLE の pranswer を適用する。
      await c.pranswer(b);

      // Assert: pranswer の時点で live な m-line は tag の transport だけを使う。
      expect(a.dtlsTransports).toEqual([audio.dtlsTransport]);

      // Act: final answer で確定する。
      await c.answer(b);

      // Assert: 置き換えられた transport は全て閉じる。
      const dropped = [...proposed].filter((t) => t !== audio.dtlsTransport);
      expect(dropped.length).toEqual(2);
      assertTransportsClosed(dropped);
    },
  );

  negotiationCase(
    "close() after a BUNDLE answer stops every transport a max-compat peer created",
    {
      ref: "origin: ticket-3812d7fd (close)",
      exempt: "close() is the operation under test",
    },
    async (c) => {
      // Arrange: BUNDLE answer で m-line を 1 つの transport に寄せる。
      const { a, b } = maxCompatPeers(c);
      await c.offer(a);
      const created = [...heldTransports(a)];
      await c.answer(b);

      // Act: 両 peer を閉じる。
      await a.close();
      await b.close();

      // Assert: a が作った全 transport の DTLS / ICE が閉じ、socket も残らない。
      assertTransportsClosed(created);
      expect(created.map(openSockets)).toEqual([0, 0, 0]);
    },
  );
});
