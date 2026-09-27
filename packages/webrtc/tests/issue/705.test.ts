import { vi } from "vitest";

import { MediaStreamTrack, RTCPeerConnection, useOPUS } from "../../src";
import {
  REMOTE_UFRAG,
  answerRemoteOffer,
  audioOnlyConfig,
  buildRemoteSdp,
  bundleGroups,
  closeAll,
  collectLocalCandidates,
  createBundlePairWithOutsideReoffer,
  createUnbundledPairForCalleeReoffer,
  countNegotiationNeeded,
  createAudioOnlyPeer,
  createPeer,
  exchangeIceCandidates,
  flushEvents,
  mLines,
  negotiate,
  parseSdp,
  routedSsrcs,
  waitForConnected,
} from "./705.helpers";

// https://github.com/shinyoshiaki/werift-webrtc/issues/705
describe("issue 705: reject unsupported RTP m-lines in the answer", () => {
  test("unbundled: video without common codec is rejected while audio is accepted", async () => {
    // Arrange: 音声専用 werift と、BUNDLE なしの audio + VP8 video offer
    const pc = createAudioOnlyPeer({ bundlePolicy: "disable" });
    const onTrack = vi.fn();
    pc.ontrack = onTrack;
    const offer = buildRemoteSdp({
      sections: [
        { kind: "audio", mid: "0", codec: "opus", ssrc: 1111 },
        { kind: "video", mid: "1", codec: "VP8", ssrc: 2222 },
      ],
    });

    try {
      // Act: SRD と answer 作成が例外なく完了する
      const answer = await answerRemoteOffer(pc, offer);

      // Assert: 位置・MID・type・proto を保ち、video だけ port 0 と offered fmt を残す
      expect(mLines(answer)).toEqual([
        {
          kind: "audio",
          port: 9,
          profile: "UDP/TLS/RTP/SAVPF",
          fmt: ["111"],
          mid: "0",
        },
        {
          kind: "video",
          port: 0,
          profile: "UDP/TLS/RTP/SAVPF",
          fmt: ["96"],
          mid: "1",
        },
      ]);
      expect(bundleGroups(answer)).toEqual([]);
      expect(pc.signalingState).toBe("stable");

      // Assert: 拒否した video は送受信準備・router 登録・onTrack・TWCC を行わない
      const video = pc.getTransceivers().find((t) => t.mid === "1")!;
      expect(video.rejected).toBe(true);
      expect(video.stopped).toBe(true);
      expect(video.currentDirection).toBe("stopped");
      expect(video.sender.codec).toBeUndefined();
      expect(video.receiver.tracks).toHaveLength(0);
      expect(video.receiver.receiverTWCC).toBeUndefined();
      expect(routedSsrcs(pc)).not.toContain(2222);
      expect(onTrack).toHaveBeenCalledTimes(1);
      expect(onTrack.mock.calls[0][0].transceiver.mid).toBe("0");

      // Assert: audio は通常どおり受信 pipeline を持ち、独立 transport を維持する
      const audio = pc.getTransceivers().find((t) => t.mid === "0")!;
      expect(audio.rejected).toBe(false);
      expect(routedSsrcs(pc)).toContain(1111);
      expect(audio.dtlsTransport).not.toBe(video.dtlsTransport);
      expect(audio.dtlsTransport.state).not.toBe("closed");
      expect(video.dtlsTransport.state).toBe("closed");
    } finally {
      await closeAll(pc);
    }
  });

  test("BUNDLE: rejecting a non-tag member keeps the offerer tag", async () => {
    // Arrange: tag = audio(0)、非 tag の video(1) だけ非対応
    const pc = createAudioOnlyPeer();
    const offer = buildRemoteSdp({
      sections: [
        { kind: "audio", mid: "0", codec: "opus" },
        { kind: "video", mid: "1", codec: "VP8" },
      ],
      bundle: ["0", "1"],
    });

    try {
      // Act
      const answer = await answerRemoteOffer(pc, offer);

      // Assert: 拒否した MID は group に入れず、tag はそのまま
      expect(mLines(answer).map((m) => [m.mid, m.port])).toEqual([
        ["0", 9],
        ["1", 0],
      ]);
      expect(bundleGroups(answer)).toEqual([["0"]]);
    } finally {
      await closeAll(pc);
    }
  });

  test("BUNDLE: rejecting the offerer-tagged member moves the tag in the initial answer", async () => {
    // Arrange: video(0) が offerer-tagged で非対応、audio(1) は対応
    const pc = createAudioOnlyPeer();
    const offer = buildRemoteSdp({
      sections: [
        { kind: "video", mid: "0", codec: "VP8" },
        { kind: "audio", mid: "1", codec: "opus" },
      ],
      bundle: ["0", "1"],
    });

    try {
      // Act
      const answer = await answerRemoteOffer(pc, offer);

      // Assert: 受け入れた audio が answerer-tagged になり、拒否 video は位置を保つ
      expect(mLines(answer).map((m) => [m.kind, m.mid, m.port])).toEqual([
        ["video", "0", 0],
        ["audio", "1", 9],
      ]);
      expect(bundleGroups(answer)).toEqual([["1"]]);
      // Assert: 共有 transport は拒否 tag の remote ICE パラメータで動作する
      const audio = pc.getTransceivers().find((t) => t.mid === "1")!;
      expect(audio.dtlsTransport.iceTransport.connection.remoteUsername).toBe(
        REMOTE_UFRAG,
      );
      expect(audio.dtlsTransport.state).not.toBe("closed");
    } finally {
      await closeAll(pc);
    }
  });

  test("BUNDLE: the group is omitted when every member is rejected", async () => {
    // Arrange: video のみの offer
    const pc = createAudioOnlyPeer();
    const offer = buildRemoteSdp({
      sections: [{ kind: "video", mid: "0", codec: "VP8" }],
      bundle: ["0"],
    });

    try {
      // Act
      const answer = await answerRemoteOffer(pc, offer);

      // Assert: 全拒否では BUNDLE group を出さず、m-line は port 0 で残る
      expect(bundleGroups(answer)).toEqual([]);
      expect(mLines(answer)).toEqual([
        {
          kind: "video",
          port: 0,
          profile: "UDP/TLS/RTP/SAVPF",
          fmt: ["96"],
          mid: "0",
        },
      ]);
    } finally {
      await closeAll(pc);
    }
  });

  test("remote port 0 with no common codec and later m-lines are still applied", async () => {
    // Arrange: 先頭が remote port 0 かつ codec 不一致、後続に audio と SCTP
    const pc = createAudioOnlyPeer();
    const onTrack = vi.fn();
    pc.ontrack = onTrack;
    const offer = buildRemoteSdp({
      sections: [
        { kind: "video", mid: "0", codec: "H264", port: 0 },
        { kind: "audio", mid: "1", codec: "opus", ssrc: 3333 },
        { kind: "application", mid: "2" },
      ],
      bundle: ["1", "2"],
    });

    try {
      // Act: SRD を適用する
      await pc.setRemoteDescription({ type: "offer", sdp: offer });

      // Assert: 後続 m-line (audio / SCTP) と signaling state が更新される
      expect(pc.signalingState).toBe("have-remote-offer");
      expect(pc.sctpRemotePort).toBe(5000);
      expect(onTrack).toHaveBeenCalledTimes(1);
      expect(routedSsrcs(pc)).toContain(3333);

      // Act: answer を作成・適用する
      const answer = await pc.createAnswer();
      await pc.setLocalDescription(answer);

      // Assert: port 0 の m-line は同じ位置に port 0 で残り、他は受け入れる
      expect(
        mLines(answer.sdp).map((m) => [m.kind, m.mid, m.port, m.fmt]),
      ).toEqual([
        ["video", "0", 0, ["102"]],
        ["audio", "1", 9, ["111"]],
        ["application", "2", 9, ["webrtc-datachannel"]],
      ]);
      expect(bundleGroups(answer.sdp)).toEqual([["1", "2"]]);
    } finally {
      await closeAll(pc);
    }
  });

  test("remote candidates resolve MID/index against the full remote media list", async () => {
    // Arrange: 拒否 tag(video 0) + audio(1) の BUNDLE offer を適用済み
    const pc = createAudioOnlyPeer();
    await answerRemoteOffer(
      pc,
      buildRemoteSdp({
        sections: [
          { kind: "video", mid: "0", codec: "VP8" },
          { kind: "audio", mid: "1", codec: "opus" },
        ],
        bundle: ["0", "1"],
      }),
    );
    const candidate = "candidate:1 1 udp 2113937151 127.0.0.1 50000 typ host";

    try {
      // Act: 拒否した tag の MID と、受け入れた audio の index で候補を追加する
      await pc.addIceCandidate({ candidate, sdpMid: "0" });
      await pc.addIceCandidate({ candidate, sdpMLineIndex: 1 });

      // Assert: 拒否 m-line の MID/index を失わず、対応する位置に記録される
      const remote = parseSdp(pc.remoteDescription!.sdp);
      expect(remote.media[0].rtp.muxId).toBe("0");
      expect(remote.media[0].iceCandidates).toHaveLength(1);
      expect(remote.media[1].rtp.muxId).toBe("1");
      expect(remote.media[1].iceCandidates).toHaveLength(1);
      // Assert: BUNDLE の共有 transport には候補が渡る
      const audio = pc.getTransceivers().find((t) => t.mid === "1")!;
      expect(
        audio.dtlsTransport.iceTransport.connection.remoteCandidates.length,
      ).toBeGreaterThan(0);
    } finally {
      await closeAll(pc);
    }
  });

  test("unbundled: candidates for a rejected m-line are recorded without a transport", async () => {
    // Arrange: unbundled の拒否 video を含む offer を適用済み
    const pc = createAudioOnlyPeer({ bundlePolicy: "disable" });
    await answerRemoteOffer(
      pc,
      buildRemoteSdp({
        sections: [
          { kind: "audio", mid: "0", codec: "opus" },
          { kind: "video", mid: "1", codec: "VP8" },
        ],
      }),
    );

    try {
      // Act: 拒否 video 向けの候補を追加する
      await pc.addIceCandidate({
        candidate: "candidate:1 1 udp 2113937151 127.0.0.1 50001 typ host",
        sdpMid: "1",
        sdpMLineIndex: 1,
      });

      // Assert: 例外にせず、拒否 m-line の位置に記録だけする
      const remote = parseSdp(pc.remoteDescription!.sdp);
      expect(remote.media[1].iceCandidates).toHaveLength(1);
      expect(remote.media[0].iceCandidates).toHaveLength(0);
    } finally {
      await closeAll(pc);
    }
  });
});

describe("issue 705: BUNDLE membership, transports and ICE ownership", () => {
  test.each([
    { bundlePolicy: undefined },
    { bundlePolicy: "max-bundle" as const },
  ])(
    "m-lines outside the offered group get an independent transport and ICE credentials (bundlePolicy=$bundlePolicy)",
    async ({ bundlePolicy }) => {
      // Arrange: audio 0/1 は BUNDLE、audio 2 は group 外 (max-bundle でも同じ扱い)
      const pc = createAudioOnlyPeer({ bundlePolicy });
      const offer = buildRemoteSdp({
        sections: [
          { kind: "audio", mid: "0" },
          { kind: "audio", mid: "1" },
          { kind: "audio", mid: "2", ufrag: "otherufrag" },
        ],
        bundle: ["0", "1"],
      });

      try {
        // Act
        const answer = await answerRemoteOffer(pc, offer);

        // Assert: answer の group は offered membership と一致する
        expect(bundleGroups(answer)).toEqual([["0", "1"]]);
        const media = parseSdp(answer).media;
        expect(media[0].iceParams?.usernameFragment).toBe(
          media[1].iceParams?.usernameFragment,
        );
        expect(media[2].iceParams?.usernameFragment).not.toBe(
          media[0].iceParams?.usernameFragment,
        );

        // Assert: group 外は別 transport で、remote の ICE 資格情報も別に適用される
        const [t0, t1, t2] = ["0", "1", "2"].map(
          (mid) => pc.getTransceivers().find((t) => t.mid === mid)!,
        );
        expect(t0.dtlsTransport).toBe(t1.dtlsTransport);
        expect(t2.dtlsTransport).not.toBe(t0.dtlsTransport);
        expect(t2.dtlsTransport.iceTransport.connection.remoteUsername).toBe(
          "otherufrag",
        );
        expect(t0.dtlsTransport.iceTransport.connection.remoteUsername).toBe(
          REMOTE_UFRAG,
        );
      } finally {
        await closeAll(pc);
      }
    },
  );

  test("a new independent transport outside the established BUNDLE gathers its own candidates", async () => {
    // Arrange: 接続済み BUNDLE に、group 外の m-line を追加する re-offer
    const { caller, callee, outsideMid, outsideOffer } =
      await createBundlePairWithOutsideReoffer();
    const bundled = callee.getTransceivers()[0].dtlsTransport;
    const candidates: { sdpMid?: string; sdpMLineIndex?: number }[] = [];
    callee.onIceCandidate.subscribe((candidate) => {
      if (candidate) {
        candidates.push({
          sdpMid: candidate.sdpMid,
          sdpMLineIndex: candidate.sdpMLineIndex,
        });
      }
    });

    try {
      // Act: callee が re-offer に答える
      await answerRemoteOffer(callee, outsideOffer);
      const outside = callee
        .getTransceivers()
        .find((t) => t.mid === outsideMid)!;
      await vi.waitFor(
        () =>
          expect(outside.dtlsTransport.iceTransport.gatheringState).toBe(
            "complete",
          ),
        { timeout: 5000 },
      );

      // Assert: group 外は独立 transport で、候補収集が完了する
      expect(outside.dtlsTransport).not.toBe(bundled);
      expect(bundled.iceTransport.gatheringState).toBe("complete");
      // Assert: 新しい候補は group 外 m-line の MID / index を持ち、既存 BUNDLE transport は再収集されない
      expect(candidates.length).toBeGreaterThan(0);
      expect(candidates).toEqual(
        candidates.map(() => ({ sdpMid: outsideMid, sdpMLineIndex: 2 })),
      );
    } finally {
      await closeAll(caller, callee);
    }
  });

  test("an answerer that was the initial offerer applies the advertised DTLS role to the independent transport", async () => {
    // Arrange: 初回 offerer (DTLS server) の caller が、callee の group 外 re-offer に答える
    const { caller, callee, outsideMid, outsideOffer } =
      await createBundlePairWithOutsideReoffer({ reofferFrom: "callee" });

    try {
      // Act
      const answer = await answerRemoteOffer(caller, outsideOffer);

      // Assert: answer の a=setup と transport の DTLS role が m-line ごとに一致する
      for (const media of parseSdp(answer).media) {
        const transceiver = caller
          .getTransceivers()
          .find((t) => t.mid === media.rtp.muxId)!;
        expect(transceiver.dtlsTransport.role).toBe(media.dtlsParams?.role);
      }
      // Assert: 確立済み BUNDLE は server のまま、group 外の独立 transport は client
      const roles = caller
        .getTransceivers()
        .map((t) => [t.mid, t.dtlsTransport.role]);
      expect(roles).toEqual([
        ["0", "server"],
        ["1", "server"],
        [outsideMid, "client"],
      ]);
    } finally {
      await closeAll(caller, callee);
    }
  });

  test("unbundled: a re-offer from the initial answerer connects the new transport", async () => {
    // Arrange: disable で接続済み、callee (初回 answerer) が audio を追加する
    const { caller, callee } = await createUnbundledPairForCalleeReoffer();
    const added = callee.addTransceiver(
      new MediaStreamTrack({ kind: "audio" }),
    );

    try {
      // Act: callee から re-offer して交渉する
      await negotiate(callee, caller);

      // Assert: 新しい transport の DTLS role は相補的になり、両者とも connected になる
      const remote = caller.getTransceivers().find((t) => t.mid === added.mid)!;
      expect(
        [added.dtlsTransport.role, remote.dtlsTransport.role].sort(),
      ).toEqual(["client", "server"]);
      await vi.waitFor(
        () => {
          expect(added.dtlsTransport.state).toBe("connected");
          expect(remote.dtlsTransport.state).toBe("connected");
        },
        { timeout: 5000 },
      );
      expect(caller.connectionState).toBe("connected");
      expect(callee.connectionState).toBe("connected");
    } finally {
      await closeAll(caller, callee);
    }
  });

  test("an answer that moves a member sharing the offered transport out of the BUNDLE is rejected by the offerer", async () => {
    // Arrange: callee は group 外 (別 ICE credentials) で受け入れた answer を返す
    const { caller, callee, outsideMid, outsideOffer } =
      await createBundlePairWithOutsideReoffer();
    const answer = await answerRemoteOffer(callee, outsideOffer);
    const transportsBefore = caller
      .getTransceivers()
      .map((t) => t.dtlsTransport);
    const localBefore = caller.localDescription!.sdp;

    try {
      // Act: offer で共有 transport に載せた m-line を group 外で受け入れた answer を適用する
      const result = caller.setRemoteDescription({
        type: "answer",
        sdp: answer,
      });

      // Assert: 状態を変える前に InvalidAccessError で拒否する
      await expect(result).rejects.toMatchObject({
        name: "InvalidAccessError",
      });
      expect(caller.signalingState).toBe("have-local-offer");
      expect(caller.localDescription!.sdp).toBe(localBefore);
      expect(caller.currentRemoteDescription!.sdp).not.toBe(answer);
      // Assert: transport は分割も作り直しもされない
      expect(caller.getTransceivers().map((t) => t.dtlsTransport)).toEqual(
        transportsBefore,
      );
      expect(
        caller.getTransceivers().find((t) => t.mid === outsideMid)!
          .dtlsTransport,
      ).toBe(transportsBefore[0]);
    } finally {
      await closeAll(caller, callee);
    }
  });

  test("local trickle candidates use the accepted tag's MID and m-line index", async () => {
    // Arrange: 拒否 tag(video 0) + audio(1) + SCTP(2)
    const pc = createAudioOnlyPeer();
    const candidates = collectLocalCandidates(pc);

    try {
      // Act: answer を適用して候補収集を始める
      await answerRemoteOffer(
        pc,
        buildRemoteSdp({
          sections: [
            { kind: "video", mid: "0", codec: "VP8" },
            { kind: "audio", mid: "1" },
            { kind: "application", mid: "2" },
          ],
          bundle: ["0", "1", "2"],
        }),
      );

      // Assert: m-line 0 固定ではなく、受け入れた tag (audio 1) で通知される
      const gathered = await candidates;
      expect(gathered.length).toBeGreaterThan(0);
      for (const candidate of gathered) {
        expect(candidate).toEqual({ sdpMid: "1", sdpMLineIndex: 1 });
      }
    } finally {
      await closeAll(pc);
    }
  });

  test("SCTP before RTP keeps the original m-line indexes", async () => {
    // Arrange: SCTP(0) → 非対応 video(1) → audio(2)
    const pc = createAudioOnlyPeer();
    const candidates = collectLocalCandidates(pc);

    try {
      // Act
      const answer = await answerRemoteOffer(
        pc,
        buildRemoteSdp({
          sections: [
            { kind: "application", mid: "0" },
            { kind: "video", mid: "1", codec: "VP8" },
            { kind: "audio", mid: "2" },
          ],
          bundle: ["0", "1", "2"],
        }),
      );
      const gathered = await candidates;

      // Assert: SCTP 先行でも位置と BUNDLE membership を保つ
      expect(mLines(answer).map((m) => [m.kind, m.mid, m.port])).toEqual([
        ["application", "0", 9],
        ["video", "1", 0],
        ["audio", "2", 9],
      ]);
      expect(bundleGroups(answer)).toEqual([["0", "2"]]);
      expect(gathered.length).toBeGreaterThan(0);
      for (const candidate of gathered) {
        expect(candidate).toEqual({ sdpMid: "0", sdpMLineIndex: 0 });
      }

      // Assert: 元の index で transceiver を引き、audio に候補・資格情報が載る
      const local = parseSdp(pc.localDescription!.sdp);
      expect(local.media[2].iceParams?.usernameFragment).toBeTruthy();
      expect(local.media[2].iceCandidates.length).toBeGreaterThan(0);
      expect(local.media[1].iceCandidates).toHaveLength(0);
    } finally {
      await closeAll(pc);
    }
  });

  test("an established BUNDLE keeps the negotiated tag and transport", async () => {
    // Arrange: 初回 offer (tag 0) を受け入れて BUNDLE を確立する
    const pc = createAudioOnlyPeer();
    await answerRemoteOffer(
      pc,
      buildRemoteSdp({
        sections: [
          { kind: "audio", mid: "0" },
          { kind: "audio", mid: "1" },
        ],
        bundle: ["0", "1"],
      }),
    );
    const transport = pc.getTransceivers()[0].dtlsTransport;

    try {
      // Act: offerer が group の順序を変えた re-offer を送る
      const answer = await answerRemoteOffer(
        pc,
        buildRemoteSdp({
          sections: [
            { kind: "audio", mid: "0" },
            { kind: "audio", mid: "1" },
          ],
          bundle: ["1", "0"],
        }),
      );

      // Assert: 確立済みの tag (0) を保持し、transport も同じまま
      expect(bundleGroups(answer)).toEqual([["0", "1"]]);
      for (const transceiver of pc.getTransceivers()) {
        expect(transceiver.dtlsTransport).toBe(transport);
      }
    } finally {
      await closeAll(pc);
    }
  });

  test.each([
    { label: "moves a member out of the group", bundles: [["0"]] },
    { label: "splits the members into two groups", bundles: [["0"], ["1"]] },
  ])(
    "a re-offer that $label is rejected without state changes",
    async ({ bundles }) => {
      // Arrange: mid 0/1 を BUNDLE で確立済み
      const pc = createAudioOnlyPeer();
      await answerRemoteOffer(
        pc,
        buildRemoteSdp({
          sections: [
            { kind: "audio", mid: "0" },
            { kind: "audio", mid: "1" },
          ],
          bundle: ["0", "1"],
        }),
      );
      const remoteBefore = pc.remoteDescription!.sdp;

      try {
        // Act: 共有 transport の member を group の外へ出す / 別 group に分割する re-offer を適用する
        const result = pc.setRemoteDescription({
          type: "offer",
          sdp: buildRemoteSdp({
            sections: [
              { kind: "audio", mid: "0" },
              { kind: "audio", mid: "1", ufrag: "otherufrag" },
            ],
            bundles,
          }),
        });

        // Assert: InvalidAccessError で拒否し、signaling state と descriptions を保つ
        await expect(result).rejects.toMatchObject({
          name: "InvalidAccessError",
        });
        expect(pc.signalingState).toBe("stable");
        expect(pc.remoteDescription!.sdp).toBe(remoteBefore);
        expect(pc.pendingRemoteDescription).toBeNull();
        // Assert: 共有 transport と remote ICE 資格情報は変わらない
        const [t0, t1] = pc.getTransceivers();
        expect(t0.dtlsTransport).toBe(t1.dtlsTransport);
        expect(t0.dtlsTransport.iceTransport.connection.remoteUsername).toBe(
          REMOTE_UFRAG,
        );
      } finally {
        await closeAll(pc);
      }
    },
  );
});

describe("issue 705: mLineReuse configuration", () => {
  test("defaults to compatible, validates values and rejects changes", async () => {
    // Arrange / Act: 既定値と明示値で作成する
    const defaultPc = new RTCPeerConnection();
    const aggressivePc = new RTCPeerConnection({ mLineReuse: "aggressive" });

    try {
      // Assert: 既定は compatible で getConfiguration に現れる
      expect(defaultPc.getConfiguration().mLineReuse).toBe("compatible");
      expect(aggressivePc.getConfiguration().mLineReuse).toBe("aggressive");

      // Assert: 無効値は生成時に TypeError
      expect(
        () => new RTCPeerConnection({ mLineReuse: "reuse-all" as never }),
      ).toThrow(TypeError);

      // Assert: 途中変更は拒否し、同じ値の再設定は許可する
      expect(() =>
        defaultPc.setConfiguration({ mLineReuse: "aggressive" }),
      ).toThrow(expect.objectContaining({ name: "InvalidModificationError" }));
      expect(() =>
        defaultPc.setConfiguration({ mLineReuse: "compatible" }),
      ).not.toThrow();
      expect(defaultPc.getConfiguration().mLineReuse).toBe("compatible");
    } finally {
      await closeAll(defaultPc, aggressivePc);
    }
  });

  test.each([
    ["compatible", 9],
    ["aggressive", 0],
  ] as const)(
    "%s: accepted inactive m-line uses port %i",
    async (mode, expectedPort) => {
      // Arrange: inactive transceiver を持つ offerer
      const pc = createPeer({ mLineReuse: mode });
      pc.addTransceiver("audio", { direction: "inactive" });

      try {
        // Act
        const offer = await pc.createOffer();

        // Assert: compatible は非ゼロ、aggressive は従来どおり port 0
        expect(mLines(offer.sdp)[0].port).toBe(expectedPort);
      } finally {
        await closeAll(pc);
      }
    },
  );

  test.each(["compatible", "aggressive"] as const)(
    "%s: codec rejection and BUNDLE consistency hold",
    async (mode) => {
      // Arrange
      const pc = createAudioOnlyPeer({ mLineReuse: mode });
      const offer = buildRemoteSdp({
        sections: [
          { kind: "video", mid: "0", codec: "VP8" },
          { kind: "audio", mid: "1" },
        ],
        bundle: ["0", "1"],
      });

      try {
        // Act
        const answer = await answerRemoteOffer(pc, offer);

        // Assert: どちらのモードでも拒否 section だけ port 0、group は受け入れ MID のみ
        expect(mLines(answer).map((m) => m.port)).toEqual([0, 9]);
        expect(bundleGroups(answer)).toEqual([["1"]]);
      } finally {
        await closeAll(pc);
      }
    },
  );
});

describe("issue 705: answer validation, pending re-offer and rollback", () => {
  test.each(["answer", "pranswer"] as const)(
    "a non-zero %s without a common codec is rejected with InvalidAccessError",
    async (type) => {
      // Arrange: opus だけの audio offer を pending にする
      const pc = createPeer({ codecs: { audio: [useOPUS()], video: [] } });
      pc.addTransceiver("audio");
      await pc.setLocalDescription(await pc.createOffer());
      const pendingLocal = pc.pendingLocalDescription!.sdp;
      const mid = pc.getTransceivers()[0].mid!;

      try {
        // Act: PCMU だけを返す (共通 codec のない) answer を適用する
        const result = pc.setRemoteDescription({
          type,
          sdp: buildRemoteSdp({
            sections: [{ kind: "audio", mid, codec: "PCMU" }],
            bundle: [mid],
            setup: "active",
          }),
        });

        // Assert: signaling state と descriptions は変わらない
        await expect(result).rejects.toMatchObject({
          name: "InvalidAccessError",
        });
        expect(pc.signalingState).toBe("have-local-offer");
        expect(pc.pendingLocalDescription!.sdp).toBe(pendingLocal);
        expect(pc.remoteDescription).toBeNull();
      } finally {
        await closeAll(pc);
      }
    },
  );

  test("rolling back a remote offer keeps a track-less transceiver the app added meanwhile", async () => {
    // Arrange: callee に caller の初回 offer (audio + video) を適用した pending 状態
    const caller = createPeer();
    const callee = createPeer();
    caller.addTransceiver(new MediaStreamTrack({ kind: "audio" }));
    caller.addTransceiver(new MediaStreamTrack({ kind: "video" }));
    await caller.setLocalDescription(await caller.createOffer());
    await callee.setRemoteDescription(caller.localDescription!);
    const remoteCreated = [...callee.getTransceivers()];

    try {
      // Act: offer 適用中にアプリが track なしの video transceiver を追加してから rollback する
      const appVideo = callee.addTransceiver("video");
      await callee.setRemoteDescription({ type: "rollback" });

      // Assert: remote offer が作った transceiver だけが破棄される
      expect(callee.signalingState).toBe("stable");
      expect(remoteCreated.every((t) => t.stopped)).toBe(true);
      expect(callee.getTransceivers()).toEqual([appVideo]);
      // Assert: アプリの transceiver は停止されず、関連付けだけ外れて残る
      expect(appVideo.stopped).toBe(false);
      expect(appVideo.stopping).toBe(false);
      expect(appVideo.mid).toBeNull();
      expect(appVideo.mLineIndex).toBeUndefined();

      // Act: callee から次の offer を作る
      const offer = await callee.createOffer();

      // Assert: アプリの video が m-line として交渉される
      expect(mLines(offer.sdp).map((m) => [m.kind, m.port])).toEqual([
        ["video", 9],
      ]);
    } finally {
      await closeAll(caller, callee);
    }
  });

  test("an unsupported re-offer keeps RTP/track while pending and after rollback, then stops on commit", async () => {
    // Arrange: werift 同士で audio + video を接続済み
    const caller = createPeer();
    const callee = createPeer();
    exchangeIceCandidates(caller, callee);
    caller.addTransceiver(new MediaStreamTrack({ kind: "audio" }));
    caller.addTransceiver(new MediaStreamTrack({ kind: "video" }));
    const onTrack = vi.fn();
    callee.ontrack = onTrack;
    await negotiate(caller, callee);
    await waitForConnected(caller, callee);
    const video = callee.getTransceivers().find((t) => t.kind === "video")!;
    const videoTrack = video.receiver.track;
    const ssrcsBefore = routedSsrcs(callee);
    const negotiationNeeded = countNegotiationNeeded(callee);

    try {
      // Act: video を非対応 codec に書き換えた re-offer を pending にする
      await caller.setLocalDescription(await caller.createOffer());
      const unsupportedOffer = caller.localDescription!.sdp.replace(
        /VP8\/90000/g,
        "H264/90000",
      );
      await callee.setRemoteDescription({
        type: "offer",
        sdp: unsupportedOffer,
      });

      // Assert: pending 中は拒否予定だが、既存 track / RTP pipeline は維持される
      expect(video.pendingRejection).toBe(true);
      expect(video.stopped).toBe(false);
      expect(video.receiver.stopped).toBe(false);
      expect(videoTrack.readyState).toBe("live");
      expect(routedSsrcs(callee)).toEqual(ssrcsBefore);

      // Act: rollback する
      await callee.setRemoteDescription({ type: "rollback" });

      // Assert: 元の transceiver 対応と pipeline に戻る
      expect(callee.signalingState).toBe("stable");
      expect(video.pendingRejection).toBe(false);
      expect(video.receiver.stopped).toBe(false);
      expect(callee.getTransceivers().find((t) => t.kind === "video")).toBe(
        video,
      );
      expect(routedSsrcs(callee)).toEqual(ssrcsBefore);

      // Act: 同じ re-offer を再適用し、port 0 answer を確定させる
      await callee.setRemoteDescription({
        type: "offer",
        sdp: unsupportedOffer,
      });
      const answer = await callee.createAnswer();
      await callee.setLocalDescription(answer);
      await caller.setRemoteDescription(answer);
      await flushEvents();

      // Assert: 確定後だけ停止・解放される
      expect(mLines(answer.sdp).map((m) => [m.kind, m.port])).toEqual([
        ["audio", 9],
        ["video", 0],
      ]);
      expect(video.rejected).toBe(true);
      expect(video.stopped).toBe(true);
      expect(video.receiver.stopped).toBe(true);
      expect(videoTrack.readyState).toBe("ended");
      expect(routedSsrcs(callee).length).toBeLessThan(ssrcsBefore.length);
      // Assert: 両者とも video の停止が確定する
      const callerVideo = caller
        .getTransceivers()
        .find((t) => t.kind === "video")!;
      expect(callerVideo.stopped).toBe(true);

      // Assert: re-offer で onTrack を重複発火せず、remote 起因の停止は negotiationneeded を出さない
      expect(onTrack).toHaveBeenCalledTimes(2);
      expect(negotiationNeeded.count).toBe(0);
      expect(caller.connectionState).toBe("connected");
    } finally {
      await closeAll(caller, callee);
    }
  });

  test("re-offers without SSRC reuse the transceiver placeholder track", async () => {
    // Arrange: SSRC のない audio offer
    const pc = createAudioOnlyPeer();
    const tracks: MediaStreamTrack[] = [];
    pc.ontrack = ({ track }) => tracks.push(track);
    const offer = buildRemoteSdp({
      sections: [{ kind: "audio", mid: "0" }],
      bundle: ["0"],
    });

    try {
      // Act: 同じ内容の offer を 2 回交渉する
      await answerRemoteOffer(pc, offer);
      await answerRemoteOffer(pc, offer);

      // Assert: placeholder track を再利用し、track event は 1 回だけ
      expect(tracks).toHaveLength(1);
      expect(pc.getTransceivers()).toHaveLength(1);
      expect(pc.getTransceivers()[0].receiver.track).toBe(tracks[0]);
    } finally {
      await closeAll(pc);
    }
  });

  test("audio-only werift accepts a browser-like audio + video offer without adding VP8", async () => {
    // Arrange: WorkAdventure 構成 (音声専用 + BUNDLE 内の video)
    const pc = new RTCPeerConnection(audioOnlyConfig());
    pc.addTrack(new MediaStreamTrack({ kind: "audio" }));
    const offer = buildRemoteSdp({
      sections: [
        { kind: "audio", mid: "0" },
        { kind: "video", mid: "1", codec: "VP8" },
      ],
      bundle: ["0", "1"],
    });

    try {
      // Act
      const answer = await answerRemoteOffer(pc, offer);

      // Assert: audio は送信用 transceiver と関連付き、video は拒否される
      expect(pc.getConfiguration().codecs.video).toEqual([]);
      expect(mLines(answer).map((m) => m.port)).toEqual([9, 0]);
      const audio = pc.getTransceivers().find((t) => t.mid === "0")!;
      expect(audio.sender.track).not.toBeNull();
      expect(parseSdp(answer).media[0].direction).toBe("sendrecv");
    } finally {
      await closeAll(pc);
    }
  });
});
