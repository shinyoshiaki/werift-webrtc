import { MediaStreamTrack } from "../../src";
import {
  assertNegotiationInvariants,
  createConnectedVideoPeers,
  createConnectedVideoPeersWithRtx,
  createDuplexSession,
  expectSessionAlive,
  negotiate,
  sectionOf,
  sendAndExpectRtp,
  waitForCommittedNomination,
} from "./negotiationTransactionUtils";

/**
 * Deterministic regressions for what the negotiation property test found
 * (see negotiationTransactionProperty.test.ts for the seeds).
 */
describe("negotiation transaction regressions", () => {
  test("a replacement local offer keeps a new transceiver associated with its m-line", async () => {
    const session = await createDuplexSession();
    const { a, b } = session;
    try {
      // Arrange: a が audio を足した offer を適用し、b にも渡す。
      const out = new MediaStreamTrack({ kind: "audio" });
      const audio = a.pc.addTransceiver(out, { direction: "sendonly" });
      await a.pc.setLocalDescription(await a.pc.createOffer());
      await b.pc.setRemoteDescription(a.pc.localDescription!);
      const mid = audio.mid!;

      // Act: 同じ内容の replacement offer を適用する。
      await a.pc.setLocalDescription(await a.pc.createOffer());

      // Assert: pending 中も transceiver は自分の m-line (MID・index) に結び付いたまま。
      expect(audio.mid).toBe(mid);
      expect(sectionOf(a.pc.pendingLocalDescription!.sdp, mid)).toContain(
        "m=audio",
      );
      assertNegotiationInvariants(a.pc);

      // Act: replacement offer に answer を返す。
      await b.pc.setRemoteDescription(a.pc.localDescription!);
      await b.pc.setLocalDescription(await b.pc.createAnswer());
      await a.pc.setRemoteDescription(b.pc.localDescription!);

      // Assert: audio が届き、既存の video・DataChannel も継続する。
      const remote = b.pc.getTransceivers().find((t) => t.mid === mid)!;
      await sendAndExpectRtp(out, remote.receiver.track, "replacement-audio");
      await expectSessionAlive(session, "replacement-audio");
    } finally {
      await session.close();
    }
  });

  test("an answer does not give a direction to a transceiver without an m-line", async () => {
    const { offerer, answerer } = await createConnectedVideoPeers();
    try {
      // Arrange: re-offer を受けた後に answerer が audio transceiver を足す。
      await offerer.setLocalDescription(await offerer.createOffer());
      await answerer.setRemoteDescription(offerer.localDescription!);
      const late = answerer.addTransceiver("audio", { direction: "sendonly" });

      // Act: その transceiver の m-line を含まない answer を適用する。
      await answerer.setLocalDescription(await answerer.createAnswer());

      // Assert: 交渉されていない transceiver は current direction を持たない。
      expect(late.mid).toBeNull();
      expect(late.currentDirection).toBeFalsy();
      assertNegotiationInvariants(answerer);
    } finally {
      await Promise.allSettled([offerer.close(), answerer.close()]);
    }
  });

  test("MIDs from unapplied createOffer calls do not collide with a later remote offer", async () => {
    const session = await createDuplexSession();
    const { a, b } = session;
    try {
      // Arrange: b が audio を足し、適用しない createOffer を 2 回呼ぶ (MID・index が仮に振られる)。
      const own = b.pc.addTransceiver(new MediaStreamTrack({ kind: "audio" }), {
        direction: "sendonly",
      });
      await b.pc.createOffer();
      await b.pc.createOffer();

      // Act: a が同じ種類の m-line を足した offer で交渉する。
      a.pc.addTransceiver(new MediaStreamTrack({ kind: "audio" }), {
        direction: "sendonly",
      });
      await negotiate(session, a, b);

      // Assert: b の MID は重複せず、b 自身の transceiver は停止も除外もされない。
      const mids = b.pc
        .getTransceivers()
        .map((t) => t.mid)
        .filter(Boolean);
      expect(new Set(mids).size).toBe(mids.length);
      expect(b.pc.getTransceivers()).toContain(own);
      expect(own.stopped).toBe(false);
      assertNegotiationInvariants(a.pc);
      assertNegotiationInvariants(b.pc);
      await expectSessionAlive(session, "unapplied-offer-mids");
    } finally {
      await session.close();
    }
  });

  test("the final answer after an ICE restart pranswer reuses the pranswer credentials", async () => {
    const { offerer, answerer, outgoing, incoming } =
      await createConnectedVideoPeers();
    try {
      // Arrange: ICE restart offer に pranswer を返す。
      const ufragOf = (sdp: string) => sdp.match(/^a=ice-ufrag:(.*?)\r?$/m)![1];
      await offerer.setLocalDescription(
        await offerer.createOffer({ iceRestart: true }),
      );
      await answerer.setRemoteDescription(offerer.localDescription!);
      const pranswer = await answerer.createAnswer();
      await answerer.setLocalDescription({
        type: "pranswer",
        sdp: pranswer.sdp,
      });
      await offerer.setRemoteDescription({
        type: "pranswer",
        sdp: answerer.localDescription!.sdp,
      });

      // Act: 最終 answer を改めて作って適用する。
      const answer = await answerer.createAnswer();
      await answerer.setLocalDescription(answer);
      await offerer.setRemoteDescription(answerer.localDescription!);

      // Assert: pranswer で広告した資格情報のまま確定し、live と SDP が一致して RTP が届く。
      expect(ufragOf(answer.sdp)).toBe(ufragOf(pranswer.sdp));
      expect(answerer.iceTransports[0].connection.localUsername).toBe(
        ufragOf(pranswer.sdp),
      );
      assertNegotiationInvariants(offerer);
      assertNegotiationInvariants(answerer);
      await Promise.all([
        waitForCommittedNomination(offerer),
        waitForCommittedNomination(answerer),
      ]);
      await sendAndExpectRtp(outgoing, incoming, "pranswer-credentials");
    } finally {
      await Promise.allSettled([offerer.close(), answerer.close()]);
    }
  });
});

/** Findings of the pre-review self-review of pending writes to live state. */
describe("negotiation transaction live-state regressions", () => {
  test("a remote pranswer that changes send parameters is fully undone by rollback", async () => {
    const { offerer, answerer, outgoing, incoming } =
      await createConnectedVideoPeersWithRtx();
    try {
      // Arrange: offerer の送信パラメータ (RTX を含む) を控え、RTX を外した pranswer を作る。
      const sender = offerer.getTransceivers()[0].sender;
      const before = sender.snapshotSendParams();
      expect(before.rtxPayloadType).toBeDefined();
      await offerer.setLocalDescription(await offerer.createOffer());
      await answerer.setRemoteDescription(offerer.localDescription!);
      const answer = (await answerer.createAnswer()).sdp;
      const rtxPt = answer.match(/^a=rtpmap:(\d+) rtx\/90000/m)![1];
      const withoutRtx = answer
        .replace(
          /^(m=video \d+ [^ ]+)(.*)$/m,
          (_, head, pts) =>
            `${head}${pts
              .split(" ")
              .filter((pt: string) => pt !== rtxPt)
              .join(" ")}`,
        )
        .split(/\r?\n/)
        .filter(
          (line) =>
            !new RegExp(`^a=(rtpmap|fmtp|rtcp-fb):${rtxPt} `).test(line),
        )
        .join("\r\n");

      // Act: pranswer を適用して送信側が暫定値に変わった後、rollback する。
      await offerer.setRemoteDescription({ type: "pranswer", sdp: withoutRtx });
      expect(sender.snapshotSendParams().rtxPayloadType).toBeUndefined();
      await offerer.setLocalDescription({ type: "rollback" });

      // Assert: 送信パラメータは current のものへ完全に戻り、RTP も届く。
      expect(sender.snapshotSendParams()).toEqual(before);
      assertNegotiationInvariants(offerer);
      await sendAndExpectRtp(outgoing, incoming, "send-params-rollback");
    } finally {
      await Promise.allSettled([offerer.close(), answerer.close()]);
    }
  });

  test("a re-offer that changes RTCP feedback of a current payload type is staged until commit", async () => {
    const { offerer, answerer } = await createConnectedVideoPeers();
    try {
      // Arrange: current の VP8 は nack を持つ。nack を外した re-offer を作る。
      const receiver = answerer.getTransceivers()[0].receiver;
      const offer = (await offerer.createOffer()).sdp;
      const pt = Number(offer.match(/^a=rtpmap:(\d+) VP8\/90000/m)![1]);
      const feedback = () =>
        receiver
          .snapshotReceiveTables()
          .codecs[pt].rtcpFeedback.map((f) => `${f.type} ${f.parameter ?? ""}`);
      expect(feedback()).toContain("nack ");
      const withoutNack = offer.replace(
        new RegExp(`^a=rtcp-fb:${pt} nack\\r?\\n`, "m"),
        "",
      );

      // Act: remote offer として適用する (answer はまだ返さない)。
      await answerer.setRemoteDescription({ type: "offer", sdp: withoutNack });

      // Assert: pending 中は current の feedback (nack) のまま。
      expect(feedback()).toContain("nack ");
      assertNegotiationInvariants(answerer);

      // Act: answer で確定する。
      await answerer.setLocalDescription(await answerer.createAnswer());

      // Assert: 確定時に新しい feedback へ切り替わる。
      expect(feedback()).not.toContain("nack ");
    } finally {
      await Promise.allSettled([offerer.close(), answerer.close()]);
    }
  });

  test("a pending re-offer that adds transport-cc does not start TWCC feedback for the current stream", async () => {
    const { offerer, answerer, outgoing, incoming } =
      await createConnectedVideoPeers();
    try {
      // Arrange: current は transport-cc なし。transport-cc を足した re-offer を作る。
      const receiver = answerer.getTransceivers()[0].receiver;
      expect(receiver.receiverTWCC).toBeUndefined();
      const offer = (await offerer.createOffer()).sdp;
      const pt = offer.match(/^a=rtpmap:(\d+) VP8\/90000/m)![1];
      const withTwcc = offer.replace(
        new RegExp(`^(a=rtpmap:${pt} VP8/90000)`, "m"),
        `$1\r\na=rtcp-fb:${pt} transport-cc`,
      );

      // Act: remote offer を適用して current の RTP を受け、rollback する。
      await answerer.setRemoteDescription({ type: "offer", sdp: withTwcc });
      await sendAndExpectRtp(outgoing, incoming, "twcc-pending");
      const pending = receiver.receiverTWCC;
      await answerer.setRemoteDescription({ type: "rollback" });

      // Assert: pending 中も rollback 後も current の stream に TWCC は始まらない。
      expect(pending).toBeUndefined();
      expect(receiver.receiverTWCC).toBeUndefined();
      assertNegotiationInvariants(answerer);
    } finally {
      await Promise.allSettled([offerer.close(), answerer.close()]);
    }
  });

  test("a local answer that flips the DTLS setup of a connected association is rejected", async () => {
    const { offerer, answerer, outgoing, incoming } =
      await createConnectedVideoPeers();
    try {
      // Arrange: re-offer を受け、a=setup を反転させた local answer を作る。
      const dtls = answerer.dtlsTransports[0];
      const role = dtls.role;
      await offerer.setLocalDescription(await offerer.createOffer());
      await answerer.setRemoteDescription(offerer.localDescription!);
      const answer = (await answerer.createAnswer()).sdp;
      const flipped = answer.replace(/^a=setup:(\w+)/gm, (_, setup) =>
        setup === "active" ? "a=setup:passive" : "a=setup:active",
      );

      // Act: role を反転させる local answer を適用する。
      await expect(
        answerer.setLocalDescription({ type: "answer", sdp: flipped }),
      ).rejects.toMatchObject({ name: "InvalidModificationError" });

      // Assert: 状態と role は変わらず、元の answer で確定でき RTP が届く。
      expect(answerer.signalingState).toBe("have-remote-offer");
      expect(dtls.role).toBe(role);
      await answerer.setLocalDescription({ type: "answer", sdp: answer });
      await offerer.setRemoteDescription(answerer.localDescription!);
      assertNegotiationInvariants(answerer);
      await sendAndExpectRtp(outgoing, incoming, "local-setup-rejected");
    } finally {
      await Promise.allSettled([offerer.close(), answerer.close()]);
    }
  });

  test("a transceiver created for a remote offer does not make negotiation needed", async () => {
    const { offerer, answerer } = await createConnectedVideoPeers();
    try {
      // Arrange: answerer の negotiationneeded を数える。
      let needed = 0;
      answerer.onNegotiationneeded.subscribe(() => needed++);

      // Act: audio m-line を足した offer を受けて answer を返す。
      offerer.addTransceiver("audio", { direction: "sendonly" });
      await offerer.setLocalDescription(await offerer.createOffer());
      await answerer.setRemoteDescription(offerer.localDescription!);
      await answerer.setLocalDescription(await answerer.createAnswer());
      await offerer.setRemoteDescription(answerer.localDescription!);
      await new Promise((resolve) => setImmediate(resolve));

      // Assert: remote offer 由来の transceiver では再交渉は要求されない。
      expect(needed).toBe(0);
      expect(answerer.getTransceivers()).toHaveLength(2);
      assertNegotiationInvariants(answerer);
    } finally {
      await Promise.allSettled([offerer.close(), answerer.close()]);
    }
  });
});
