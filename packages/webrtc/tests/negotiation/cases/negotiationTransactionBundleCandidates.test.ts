import { expect } from "vitest";

import { MediaStreamTrack, type RTCPeerConnection } from "../../../src";
import { describeCases, negotiationCase } from "../harness/negotiationCase";
import {
  candidateLayout,
  createConnectedMultiVideoPeers,
  createConnectedVideoPeers,
  createSplitOffer,
  recordIceCandidates,
  waitForCommittedNomination,
  waitForEndOfCandidates,
  waitForGatheringComplete,
} from "../harness/negotiationTransactionUtils";

const compatible = { bundleCandidates: "compatible" } as const;

/** The local SDP of `pc` as a candidate layout. */
const localLayout = (pc: RTCPeerConnection) =>
  candidateLayout(pc.localDescription!.sdp);

/**
 * `bundleCandidates` (issue #269, RFC 8843 §7.1.3 / RFC 8859 TRANSPORT
 * category): with `"compatible"` (Chrome's shape), every description writes
 * the candidates and end-of-candidates of a transport once, on the tag
 * m-line of its BUNDLE group; every other m-line on the tag's transport
 * keeps its ICE / DTLS parameters. `"legacy"` (default) repeats them.
 */
describeCases("negotiation: bundleCandidates (issue #269)", () => {
  negotiationCase(
    "[#269-1] compatible: renegotiation without ICE restart keeps the candidate count of the transport",
    { ref: "issue #269 Phase A 1-5" },
    async (c) => {
      // Arrange: video + audio の BUNDLE で接続し、収集を終えた tag (MID 0) の候補を控える。
      const { a, b } = await c.given(
        createConnectedVideoPeers(compatible, { withAudio: true }),
      );
      await Promise.all([
        waitForGatheringComplete(a),
        waitForGatheringComplete(b),
      ]);
      const aCandidates = localLayout(a).media["0"].candidates;
      const bCandidates = localLayout(b).media["0"].candidates;
      expect(aCandidates.length).toBeGreaterThan(0);
      const trickled = [recordIceCandidates(a), recordIceCandidates(b)];

      // Act: restart なしで video の追加、DataChannel の追加、track の取り外しを順に交渉する。
      a.addTransceiver(new MediaStreamTrack({ kind: "video" }), {
        direction: "sendonly",
      });
      await c.negotiate(a);
      const afterAddTrack = [localLayout(a), localLayout(b)];
      a.createDataChannel("issue-269");
      await c.negotiate(a);
      a.removeTrack(a.getTransceivers()[2].sender);
      await c.negotiate(a);

      // Assert: 各再交渉の後も候補は tag の m-line にだけあり、総数は transport の候補数のまま。
      for (const [layout, candidates] of [
        [afterAddTrack[0], aCandidates],
        [afterAddTrack[1], bCandidates],
        [localLayout(a), aCandidates],
        [localLayout(b), bCandidates],
      ] as const) {
        expect(layout.bundle).toEqual([
          Object.keys(layout.media).filter((mid) => layout.media[mid].port),
        ]);
        expect(layout.media["0"]).toMatchObject({ candidates, end: true });
        for (const mid of layout.bundle[0].slice(1)) {
          // 非tag の m-line は候補と eoc を持たず、ICE / DTLS の識別子は残す。
          expect(layout.media[mid]).toEqual({
            port: 9,
            candidates: [],
            end: false,
            ufrag: layout.media["0"].ufrag,
            pwd: layout.media["0"].pwd,
            fingerprint: true,
            setup: true,
          });
        }
      }
      expect(Object.keys(localLayout(a).media)).toEqual(["0", "1", "2", "3"]);
      // Assert: 同じ generation の再交渉では icecandidate が再発火しない。
      expect(trickled).toEqual([[], []]);
    },
  );

  negotiationCase(
    "[#269-2] legacy (default): every bundled m-line repeats the transport's candidates",
    { ref: "issue #269 Phase A 7" },
    async (c) => {
      // Arrange: 既定設定の video + audio の BUNDLE で接続し、tag の候補を控える。
      const { a, b } = await c.given(
        createConnectedVideoPeers({}, { withAudio: true }),
      );
      await waitForGatheringComplete(a);
      const candidates = localLayout(a).media["0"].candidates;

      // Act: video を足して再交渉する。
      a.addTransceiver(new MediaStreamTrack({ kind: "video" }), {
        direction: "sendonly",
      });
      await c.negotiate(a);

      // Assert: 従来どおり全 m-line が同じ候補と eoc を持つ。
      const layout = localLayout(a);
      expect(layout.bundle).toEqual([["0", "1", "2"]]);
      for (const mid of ["0", "1", "2"]) {
        expect(layout.media[mid]).toMatchObject({ candidates, end: true });
      }
      expect(b.getConfiguration().bundleCandidates).toBe("legacy");
    },
  );

  negotiationCase(
    "[#269-3] compatible: the first max-compat offer keeps each transport's candidates and the first answer writes them on the tag only",
    { ref: "issue #269 (Chrome shape, RFC 8843 §7.3.1)" },
    async (c) => {
      // Arrange / Act: compatible の video + audio で初回交渉し、収集を終える。
      const { a, b } = await c.given(
        createConnectedVideoPeers(compatible, { withAudio: true }),
      );
      await Promise.all([
        waitForGatheringComplete(a),
        waitForGatheringComplete(b),
      ]);

      // Assert: max-compat の初回 offer は m-line ごとの transport の候補と eoc をそれぞれ持つ。
      const offer = localLayout(a);
      for (const mid of ["0", "1"]) {
        expect(offer.media[mid].candidates.length).toBeGreaterThan(0);
        expect(offer.media[mid].end).toBe(true);
      }
      expect(offer.media["1"].candidates).not.toEqual(
        offer.media["0"].candidates,
      );
      // Assert: BUNDLE を受け入れた初回 answer は tag にだけ候補と eoc を書き、非tag は識別子だけ残す。
      const answer = localLayout(b);
      expect(answer.bundle).toEqual([["0", "1"]]);
      expect(answer.media["0"].candidates.length).toBeGreaterThan(0);
      expect(answer.media["0"].end).toBe(true);
      expect(answer.media["1"]).toEqual({
        port: 9,
        candidates: [],
        end: false,
        ufrag: answer.media["0"].ufrag,
        pwd: answer.media["0"].pwd,
        fingerprint: true,
        setup: true,
      });
    },
  );

  negotiationCase(
    "[#269-3b] compatible with max-bundle: the first offer writes the shared transport's candidates on the tag only",
    { ref: "issue #269 (Chrome shape, max-bundle)" },
    async (c) => {
      // Arrange / Act: max-bundle + compatible の video + audio で初回交渉し、収集を終える。
      const { a, outgoing, incoming } = await c.given(
        createConnectedVideoPeers(
          { ...compatible, bundlePolicy: "max-bundle" },
          { withAudio: true },
        ),
      );
      await waitForGatheringComplete(a);

      // Assert: 1 つの transport を共有する初回 offer は tag にだけ候補と eoc を持つ。
      const offer = localLayout(a);
      expect(offer.bundle).toEqual([["0", "1"]]);
      expect(offer.media["0"].candidates.length).toBeGreaterThan(0);
      expect(offer.media["0"].end).toBe(true);
      expect(offer.media["1"]).toMatchObject({
        candidates: [],
        end: false,
        ufrag: offer.media["0"].ufrag,
      });
      // Assert: その offer で接続し、RTP が届く。
      await c.rtp(outgoing, incoming);
    },
  );

  negotiationCase(
    "[#269-4] compatible: an ICE restart puts the new generation's candidates on the tag and trickles them",
    { ref: "issue #269 Phase A 6" },
    async (c) => {
      // Arrange: compatible の video + audio で接続し、一度再交渉して非tag の候補を省いた状態にする。
      const { a, b, outgoing, incoming } = await c.given(
        createConnectedVideoPeers(compatible, { withAudio: true }),
      );
      await c.negotiate(a);
      const before = localLayout(a).media["0"];
      const trickled = recordIceCandidates(a);

      // Act: ICE restart を交渉し、新しい generation の収集を終える。
      await c.negotiate(a, { iceRestart: true });
      await waitForEndOfCandidates(trickled);
      await Promise.all([
        waitForCommittedNomination(a),
        waitForCommittedNomination(b),
      ]);

      // Assert: tag は新しい ufrag と新しい候補を持ち、非tag は同じ ufrag で候補を持たない。
      const layout = localLayout(a);
      expect(layout.media["0"].ufrag).not.toBe(before.ufrag);
      expect(layout.media["0"].end).toBe(true);
      expect(layout.media["1"]).toMatchObject({
        ufrag: layout.media["0"].ufrag,
        candidates: [],
        end: false,
      });
      // Assert: トリクルした候補はすべて tag の m-line にあり、tag 宛てに通知される。
      const candidates = trickled.filter((x) => x !== undefined);
      expect(candidates.length).toBeGreaterThan(0);
      expect(candidates.map((x) => x.sdpMid)).toEqual(
        candidates.map(() => "0"),
      );
      expect(layout.media["0"].candidates).toEqual(
        expect.arrayContaining(candidates.map((x) => x.candidate)),
      );
      // Assert: restart 後も RTP が届く。
      await c.rtp(outgoing, incoming);
    },
  );

  negotiationCase(
    "[#269-5] compatible: stopping the tag m-line moves the candidates to the new tag",
    { ref: "issue #269 5 (BUNDLE tag change)" },
    async (c) => {
      // Arrange: compatible で video 3 本 (MID 0 1 2) の BUNDLE を接続する。
      const { a, outgoing, incoming } = await c.given(
        createConnectedMultiVideoPeers(3, compatible),
      );
      await waitForGatheringComplete(a);
      const candidates = localLayout(a).media["0"].candidates;

      // Act: tag の transceiver を停止して再交渉し、もう一度再交渉する。
      a.getTransceivers()[0].stop();
      await c.negotiate(a);
      const afterStop = localLayout(a);
      await c.negotiate(a);

      // Assert: 新しい tag (MID 1) が全候補を持ち、残りの非tag は持たない。
      for (const layout of [afterStop, localLayout(a)]) {
        expect(layout.bundle).toEqual([["1", "2"]]);
        expect(layout.media["0"]).toMatchObject({ port: 0, candidates: [] });
        expect(layout.media["1"]).toMatchObject({ candidates, end: true });
        expect(layout.media["2"]).toMatchObject({ candidates: [], end: false });
      }
      // Assert: 残った m-line で RTP が届く。
      await c.rtp(outgoing[2], incoming[2]);
    },
  );

  negotiationCase(
    "[#269-6] compatible with bundlePolicy disable keeps the candidates on every m-line",
    { ref: "issue #269 Phase A 1 (bundlePolicy disable)" },
    async (c) => {
      // Arrange: bundlePolicy disable + compatible で video + audio を接続する。
      const { a } = await c.given(
        createConnectedVideoPeers(
          { ...compatible, bundlePolicy: "disable" },
          { withAudio: true },
        ),
      );

      // Act: 再交渉する。
      await c.negotiate(a);
      await waitForGatheringComplete(a);

      // Assert: BUNDLE group はなく、どちらの m-line も自分の transport の候補を持つ。
      const layout = localLayout(a);
      expect(layout.bundle).toEqual([]);
      expect(layout.media["0"].candidates).not.toEqual(
        layout.media["1"].candidates,
      );
      for (const mid of ["0", "1"]) {
        expect(layout.media[mid].candidates.length).toBeGreaterThan(0);
        expect(layout.media[mid].end).toBe(true);
      }
    },
  );

  negotiationCase(
    "[#269-7] compatible: a local pranswer and the final answer write the candidates on the tag only",
    { ref: "issue #269 (pranswer, Chrome shape)" },
    async (c) => {
      // Arrange: compatible の video + audio で接続し、収集を終えた tag の候補を控える。
      const { a, b } = await c.given(
        createConnectedVideoPeers(compatible, { withAudio: true }),
      );
      await waitForGatheringComplete(b);
      const candidates = localLayout(b).media["0"].candidates;

      // Act: a の再 offer に b が pranswer を返す。
      await c.offer(a);
      await c.pranswer(b);
      const pranswer = localLayout(b);
      // Act: 同じ交渉を final answer で終える。
      await c.answer(b);

      // Assert: pranswer も final answer も tag にだけ候補と eoc を持つ。
      for (const layout of [pranswer, localLayout(b)]) {
        expect(layout.media["0"]).toMatchObject({ candidates, end: true });
        expect(layout.media["1"]).toMatchObject({
          candidates: [],
          end: false,
        });
      }
    },
  );

  negotiationCase(
    "[#269-8] compatible: a rollback restores the current description and the next offer has the same shape",
    { ref: "issue #269 5 (rollback)" },
    async (c) => {
      // Arrange: compatible の video + audio で接続し、収集後の current local を控える。
      const { a } = await c.given(
        createConnectedVideoPeers(compatible, { withAudio: true }),
      );
      await waitForGatheringComplete(a);
      const current = a.localDescription!.sdp;

      // Act: 再 offer を保留して rollback し、改めて交渉する。
      const pending = candidateLayout((await c.offer(a, { hold: true })).sdp);
      await c.rollback(a);
      const restored = a.localDescription!.sdp;
      await c.negotiate(a);

      // Assert: 保留した offer と次の offer は非tag の候補を持たず、rollback 後は元の current のまま。
      expect(pending.media["1"]).toMatchObject({ candidates: [], end: false });
      expect(restored).toBe(current);
      expect(localLayout(a).media["1"]).toMatchObject({
        candidates: [],
        end: false,
      });
    },
  );

  negotiationCase(
    "[#269-9] compatible: an m-line split out of BUNDLE onto its own transport keeps its candidates",
    { ref: "issue #269 5 (transport split)" },
    async (c) => {
      // Arrange: compatible の video + audio で接続する。
      const { a, b } = await c.given(
        createConnectedVideoPeers(compatible, { withAudio: true }),
      );

      // Act: audio (MID 1) を BUNDLE から外した offer を交渉し、別 transport の収集を終える。
      await c.setLocal(a, {
        type: "offer",
        sdp: await createSplitOffer(a, "1"),
      });
      await c.setRemote(b, a.localDescription);
      await c.answer(b);
      await c.waitFor(() => a.dtlsTransports.length === 2);
      await c.waitFor(() => localLayout(a).media["1"].end, 10000);
      // Act: 分かれた後に次の offer を作る (状態は変えない)。
      const next = candidateLayout((await a.createOffer()).sdp);

      // Assert: 分かれた m-line は自分の transport の候補と eoc を持ち、tag も候補を持つ。
      for (const layout of [localLayout(a), next]) {
        expect(layout.media["1"].candidates.length).toBeGreaterThan(0);
        expect(layout.media["1"].end).toBe(true);
        expect(layout.media["0"].candidates.length).toBeGreaterThan(0);
        expect(layout.media["1"].candidates).not.toEqual(
          layout.media["0"].candidates,
        );
      }
      expect(localLayout(a).bundle).toEqual([["0"]]);
    },
  );
});
