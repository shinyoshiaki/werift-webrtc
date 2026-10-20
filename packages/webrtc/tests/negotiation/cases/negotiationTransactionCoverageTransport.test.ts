import {
  MediaStreamTrack,
  RTCPeerConnection,
  type RTCRtpTransceiver,
} from "../../../src";
import { bundleGroups } from "../../issue/705.helpers";
import { describeCases, negotiationCase } from "../harness/negotiationCase";
import {
  assertTransportsClosed,
  closeDuringNextPreparedGather,
  createConnectedMultiVideoPeers,
  createDuplexSession,
  createRewrittenOffer,
  heldTransports,
  sdpCandidates,
  sectionOf,
  waitForPeersConnected,
} from "../harness/negotiationTransactionUtils";

/** The value of `a=<name>` in the m-section `mid`. */
const attribute = (sdp: string, mid: string, name: string) =>
  new RegExp(`^a=${name}:(\\S+)`, "m").exec(sectionOf(sdp, mid))?.[1];

/** The candidate ports of m-line `mid` in `sdp`. */
const advertised = (sdp: string, mid: string) =>
  new Set(
    sdpCandidates(sdp, mid).map(({ candidate }) => candidate.split(" ")[5]),
  );

/** The ports `transceiver`'s ICE transport gathered. */
const gathered = (transceiver: RTCRtpTransceiver) =>
  new Set(
    transceiver.dtlsTransport.iceTransport.connection.localCandidates.map(
      (candidate) => String(candidate.port),
    ),
  );

/**
 * Spec coverage for the pranswer lifecycle, DTLS, BUNDLE and signaling
 * transitions of TICKET-ticket-0ad06d37 (§2.2, §2.4, §2.5, §2.8, §2.9, §5).
 * The requirement ID leads each test name. Video is MID "0" and the
 * application MID "1" in a duplex or mutation session.
 */
describeCases("negotiation transaction spec coverage: transport", () => {
  negotiationCase(
    "[2.8-18] close() while a local offer stages the transports of a BUNDLE split leaves none running",
    { ref: "2.8-18", exempt: "close() is the operation under test" },
    async (c) => {
      // Arrange: 3 m-line の BUNDLE から 2 つを外す (owner transport を 2 つ stage させる) local offer を用意する。
      const { a } = await c.given(createConnectedMultiVideoPeers(3));
      const first = a.getTransceivers()[0].mid;
      const split = await createRewrittenOffer(a, (sdp) =>
        sdp.replace(/^a=group:BUNDLE [^\r\n]+/m, `a=group:BUNDLE ${first}`),
      );
      const live = [...a.dtlsTransports];
      const hook = closeDuringNextPreparedGather(a);
      c.closing({ close: hook.restore });

      // Act: local offer の stage (最初の gather) の途中で close する。
      await c.setLocal(a, split, { rejects: "InvalidStateError" });
      await hook.closed();
      hook.restore();

      // Assert: stage を始めた transport は止まり、close の後に新しい transport は作られない。
      expect(hook.gathered.length).toEqual(1);
      expect(hook.gathered.filter((t) => t.state !== "closed")).toEqual([]);
      assertTransportsClosed(live);
      expect([a.connectionState, a.signalingState]).toEqual([
        "closed",
        "closed",
      ]);
    },
  );

  negotiationCase.for([
    { bundlePolicy: "max-compat" },
    { bundlePolicy: "balanced" },
  ] as const)(
    "[2.8-41] a $bundlePolicy first offer keeps each m-line on its own transport and candidates until an answer accepts BUNDLE",
    { ref: "2.8-41" },
    async (c, { bundlePolicy }) => {
      // Arrange: audio + video の初回 offerer と、BUNDLE を受理する answerer。
      const a = c.peer(new RTCPeerConnection({ bundlePolicy }), "a");
      const b = c.peer(new RTCPeerConnection(), "b");
      const [audioOut, videoOut] = [
        new MediaStreamTrack({ kind: "audio" }),
        new MediaStreamTrack({ kind: "video" }),
      ];
      const audio = a.addTransceiver(audioOut, { direction: "sendonly" });
      const video = a.addTransceiver(videoOut, { direction: "sendonly" });

      // Act: offer を作って適用する。
      await c.offer(a, { hold: true });

      // Assert: offer は BUNDLE を提案するが、各 m-line は自分の transport を持ち、その transport の候補を広告する。
      const offer = a.localDescription!.sdp;
      const [audioMid, videoMid] = [audio.mid!, video.mid!];
      expect(bundleGroups(offer)).toEqual([[audioMid, videoMid]]);
      expect(audio.dtlsTransport).not.toBe(video.dtlsTransport);
      expect(advertised(offer, audioMid).size).toBeGreaterThan(0);
      expect(advertised(offer, audioMid)).toEqual(gathered(audio));
      expect(advertised(offer, videoMid).size).toBeGreaterThan(0);
      expect(advertised(offer, videoMid)).toEqual(gathered(video));
      expect(
        [...advertised(offer, audioMid)].some((port) =>
          advertised(offer, videoMid).has(port),
        ),
      ).toEqual(false);
      const proposed = heldTransports(a);

      // Act: BUNDLE を受理した answer で確定する。
      await c.setRemote(b, a.localDescription);
      await c.answer(b);

      // Assert: tag の transport に統合され、余った transport は閉じる。
      expect(video.dtlsTransport).toBe(audio.dtlsTransport);
      const dropped = [...proposed].filter((t) => t !== audio.dtlsTransport);
      expect(dropped.length).toEqual(1);
      assertTransportsClosed(dropped);

      // Assert: 統合した transport で audio・video とも届く。
      await waitForPeersConnected(a, b);
      const received = (mid: string) =>
        b.getTransceivers().find((t) => t.mid === mid)!.receiver.track;
      await c.rtp(audioOut, received(audioMid));
      await c.rtp(videoOut, received(videoMid));
    },
  );

  negotiationCase(
    "[2.8-43] a max-bundle first offer shares the tag's transport at the offer",
    { ref: "2.8-43", exempt: "no real remote peer (a local offer only)" },
    async (c) => {
      // Arrange: max-bundle の初回 offerer (audio + video + DataChannel)。
      const a = c.peer(
        new RTCPeerConnection({ bundlePolicy: "max-bundle" }),
        "a",
      );
      const audio = a.addTransceiver("audio", { direction: "sendonly" });
      const video = a.addTransceiver("video", { direction: "sendonly" });
      a.createDataChannel("dc");

      // Act: offer を作って適用する。
      await c.offer(a, { hold: true });

      // Assert: 全 m-line の ufrag が同じで、transport も tag (audio) のものを共有する。
      const offer = a.localDescription!.sdp;
      const mids = offer.match(/^a=mid:\S+/gm)!.map((line) => line.slice(6));
      expect(
        new Set(mids.map((mid) => attribute(offer, mid, "ice-ufrag"))).size,
      ).toEqual(1);
      expect(video.dtlsTransport).toBe(audio.dtlsTransport);
      expect(a.sctpTransport!.dtlsTransport).toBe(audio.dtlsTransport);
      expect(heldTransports(a).size).toEqual(1);
    },
  );

  negotiationCase(
    "[2.8-43] an m-line added to a session whose peer accepted BUNDLE shares the tag's transport at the offer",
    { ref: "2.8-43" },
    async (c) => {
      // Arrange: BUNDLE を受理済みの session に audio を追加する。
      const { a, aVideo } = await c.given(createDuplexSession());
      const audio = a.addTransceiver("audio", { direction: "sendonly" });

      // Act: offer を作って適用する。
      await c.offer(a, { hold: true });

      // Assert: 新しい m-line は tag と同じ ufrag で、tag の transport を共有する。
      const offer = a.localDescription!.sdp;
      expect(attribute(offer, audio.mid!, "ice-ufrag")).toEqual(
        attribute(offer, "0", "ice-ufrag"),
      );
      expect(audio.dtlsTransport).toBe(aVideo.dtlsTransport);
      expect(heldTransports(a)).toEqual(new Set([aVideo.dtlsTransport]));
    },
  );
});

/**
 * Transitions run in both offerer directions (each peer is once the local
 * and once the remote offerer, which also swaps the DTLS roles). `a` is the
 * offerer and `b` the answerer of `createDirectedDuplexSession(from)`.
 */
for (const from of ["a", "b"] as const) {
  describeCases(
    `negotiation transaction spec coverage: transport (offerer=${from})`,
    () => {},
  );
}
