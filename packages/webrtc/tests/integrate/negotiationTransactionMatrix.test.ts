import { MediaStreamTrack } from "../../src";
import {
  type DuplexSession,
  createDuplexSession,
  expectSessionAlive,
  mungeSection,
  negotiate,
  sdpCandidates,
  sendAndExpectRtp,
  step,
  waitForCommittedNomination,
  waitForDtlsConnected,
  withMaxMessageSize,
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
  let session: DuplexSession;
  const offerer = () => session.peers[from];
  const answerer = () => session.peers[to];

  beforeEach(async () => {
    session = await createDuplexSession();
  });
  afterEach(async () => {
    await session.close();
  });

  test("re-offer commits by answer and rolls back to the same current", async () => {
    // Arrange: current SDP を控える。
    const current = answerer().pc.currentRemoteDescription!.sdp;

    // Act: re-offer を両側に pending として置く。
    await step(session, async () =>
      offerer().pc.setLocalDescription(await offerer().pc.createOffer()),
    );
    await step(session, () =>
      answerer().pc.setRemoteDescription(offerer().pc.localDescription!),
    );
    // Assert: pending 中も current session で通信できる。
    await expectSessionAlive(session, "reoffer-pending");

    // Act: 両側で rollback する。
    await step(session, () =>
      offerer().pc.setLocalDescription({ type: "rollback" }),
    );
    await step(session, () =>
      answerer().pc.setRemoteDescription({ type: "rollback" }),
    );
    // Assert: current は変わらず通信も続く。
    expect(answerer().pc.currentRemoteDescription!.sdp).toBe(current);
    await expectSessionAlive(session, "reoffer-rollback");

    // Act: 同じ re-offer を今度は answer で commit する。
    await negotiate(session, offerer(), answerer());
    // Assert: commit 後の current session でも双方向に通信できる。
    expect(answerer().pc.signalingState).toBe("stable");
    await expectSessionAlive(session, "reoffer-answer");
  });

  test("replacement pranswer and a different final answer", async () => {
    // Arrange: re-offer を受けた answerer が answer を用意する。
    await step(session, async () =>
      offerer().pc.setLocalDescription(await offerer().pc.createOffer()),
    );
    await step(session, () =>
      answerer().pc.setRemoteDescription(offerer().pc.localDescription!),
    );
    const answer = (await answerer().pc.createAnswer()).sdp;
    const recvOnly = mungeSection(answer, VIDEO, (section) =>
      section.replace("a=sendrecv", "a=recvonly"),
    );

    // Act: 1 回目の pranswer を両側に適用する。
    await step(session, () =>
      answerer().pc.setLocalDescription({ type: "pranswer", sdp: answer }),
    );
    await step(session, () =>
      offerer().pc.setRemoteDescription({ type: "pranswer", sdp: answer }),
    );
    // Assert: pranswer 中も既存 RTP と DataChannel が届く。
    await expectSessionAlive(session, "pranswer-1");

    // Act: 方向の違う replacement pranswer を適用する。
    await step(session, () =>
      answerer().pc.setLocalDescription({ type: "pranswer", sdp: recvOnly }),
    );
    await step(session, () =>
      offerer().pc.setRemoteDescription({ type: "pranswer", sdp: recvOnly }),
    );
    // Assert: offerer→answerer の RTP は replacement 後も届く。
    await sendAndExpectRtp(
      offerer().out,
      answerer().video.receiver.track,
      "pranswer-2",
    );

    // Act: 最後の pranswer と異なる sendrecv の final answer で commit する。
    await step(session, () =>
      answerer().pc.setLocalDescription({ type: "answer", sdp: answer }),
    );
    await step(session, () =>
      offerer().pc.setRemoteDescription({ type: "answer", sdp: answer }),
    );
    // Assert: final answer の方向が current になり双方向に通信できる。
    expect(offerer().pc.currentRemoteDescription!.sdp).toBe(answer);
    expect(offerer().video.currentDirection).toBe("sendrecv");
    await expectSessionAlive(session, "final-answer");
  });

  test("pranswer followed by rollback restores the current session", async () => {
    // Arrange: current SDP を控え、re-offer と pranswer を用意する。
    const current = offerer().pc.currentRemoteDescription!.sdp;
    await step(session, async () =>
      offerer().pc.setLocalDescription(await offerer().pc.createOffer()),
    );
    await step(session, () =>
      answerer().pc.setRemoteDescription(offerer().pc.localDescription!),
    );
    const answer = (await answerer().pc.createAnswer()).sdp;

    // Act: pranswer を適用した後、両側で rollback する。
    await step(session, () =>
      answerer().pc.setLocalDescription({ type: "pranswer", sdp: answer }),
    );
    await step(session, () =>
      offerer().pc.setRemoteDescription({ type: "pranswer", sdp: answer }),
    );
    await step(session, () =>
      offerer().pc.setLocalDescription({ type: "rollback" }),
    );
    await step(session, () =>
      answerer().pc.setRemoteDescription({ type: "rollback" }),
    );

    // Assert: 旧 current に戻り、双方向に通信できる。
    expect(offerer().pc.signalingState).toBe("stable");
    expect(offerer().pc.currentRemoteDescription!.sdp).toBe(current);
    await expectSessionAlive(session, "pranswer-rollback");
  });

  test("replacement offer and implicit rollback of a glare offer", async () => {
    // Arrange: answerer 側も自分の offer を pending にしている (glare)。
    await step(session, async () =>
      answerer().pc.setLocalDescription(await answerer().pc.createOffer()),
    );
    const first = await offerer().pc.createOffer();
    await step(session, () => offerer().pc.setLocalDescription(first));

    // Act: remote offer で answerer の local offer を暗黙に rollback する。
    await step(session, () => answerer().pc.setRemoteDescription(first));
    // Assert: answerer は remote offer 待ちに移り、current で通信を続ける。
    expect(answerer().pc.signalingState).toBe("have-remote-offer");
    await expectSessionAlive(session, "implicit-rollback");

    // Act: offerer が replacement offer を出し、answerer が置き換える。
    await step(session, async () =>
      offerer().pc.setLocalDescription(await offerer().pc.createOffer()),
    );
    await step(session, () =>
      answerer().pc.setRemoteDescription(offerer().pc.localDescription!),
    );
    // Assert: pending は後の offer (latest-wins) になる。
    expect(answerer().pc.pendingRemoteDescription!.sdp).toBe(
      offerer().pc.localDescription!.sdp,
    );

    // Act: replacement offer に answer して commit する。
    await step(session, async () =>
      answerer().pc.setLocalDescription(await answerer().pc.createAnswer()),
    );
    await step(session, () =>
      offerer().pc.setRemoteDescription(answerer().pc.localDescription!),
    );
    // Assert: 双方 stable で通信できる。
    expect(offerer().pc.signalingState).toBe("stable");
    await expectSessionAlive(session, "replacement-answer");
  });

  test("validation failures leave current and pending untouched", async () => {
    // Arrange: 正常な re-offer と、PT 再割当て・DTLS fingerprint 差替え・
    // SCTP port 変更を含む不正な版を用意する。
    const offer = await offerer().pc.createOffer();
    await step(session, () => offerer().pc.setLocalDescription(offer));
    const invalidOffers = [
      mungeSection(offer.sdp, VIDEO, (section) =>
        section.replace(/a=rtpmap:(\d+) VP8\/90000/, "a=rtpmap:$1 H264/90000"),
      ),
      offer.sdp.replace(
        /a=fingerprint:(\S+) [0-9A-Fa-f:]+/g,
        `a=fingerprint:$1 ${Array(32).fill("AB").join(":")}`,
      ),
      offer.sdp.replace("a=sctp-port:5000", "a=sctp-port:5001"),
    ];
    const current = answerer().pc.currentRemoteDescription!.sdp;

    for (const sdp of invalidOffers) {
      // Act: 不正な remote offer を適用する。
      await step(session, () =>
        expect(
          answerer().pc.setRemoteDescription({ type: "offer", sdp }),
        ).rejects.toMatchObject({ name: "InvalidModificationError" }),
      );
      // Assert: signaling state と current はそのままで通信も続く。
      expect(answerer().pc.signalingState).toBe("stable");
      expect(answerer().pc.currentRemoteDescription!.sdp).toBe(current);
    }
    await expectSessionAlive(session, "invalid-offer");

    // Act: 正常な offer を適用し、PT を再割当てした remote answer を返す。
    await step(session, () => answerer().pc.setRemoteDescription(offer));
    await step(session, async () =>
      answerer().pc.setLocalDescription(await answerer().pc.createAnswer()),
    );
    const answer = answerer().pc.localDescription!.sdp;
    await step(session, () =>
      expect(
        offerer().pc.setRemoteDescription({
          type: "answer",
          sdp: mungeSection(answer, VIDEO, (section) =>
            section.replace(
              /a=rtpmap:(\d+) VP8\/90000/,
              "a=rtpmap:$1 H264/90000",
            ),
          ),
        }),
      ).rejects.toMatchObject({ name: "InvalidModificationError" }),
    );
    // Assert: offerer の pending offer は残り、通信も続く。
    expect(offerer().pc.signalingState).toBe("have-local-offer");
    await expectSessionAlive(session, "invalid-answer");

    // Act: 正しい answer で commit する。
    await step(session, () =>
      offerer().pc.setRemoteDescription({ type: "answer", sdp: answer }),
    );
    // Assert: commit 後も通信できる。
    await expectSessionAlive(session, "valid-answer");
  });

  test("SCTP max-message-size changes commit on the existing association", async () => {
    // Act: remote の max-message-size だけを変える re-offer を commit する。
    await negotiate(session, offerer(), answerer(), {
      localOffer: (sdp) =>
        mungeSection(sdp, APPLICATION, (section) =>
          section.replace(
            /a=max-message-size:\d+/,
            "a=max-message-size:131072",
          ),
        ),
    });

    // Assert: association は同じまま新しい上限を持ち、DataChannel が通じる。
    expect(answerer().pc.sctpTransport!.remoteMaxMessageSize).toBe(131072);
    await expectSessionAlive(session, "max-message-size");
  });

  test.each(["answer", "rollback"] as const)(
    "renegotiation max-message-size follows offer, pranswers and %s",
    async (outcome) => {
      // Arrange: 現在の上限を控え、wire 上の各 description で異なる上限を持たせる。
      const offererLimit = offerer().pc.sctpTransport!.remoteMaxMessageSize;
      const answererLimit = answerer().pc.sctpTransport!.remoteMaxMessageSize;
      const offer = await offerer().pc.createOffer();

      // Act: re-offer を両側に置く (answerer には上限を変えた offer が届く)。
      await step(session, () => offerer().pc.setLocalDescription(offer));
      await step(session, () =>
        answerer().pc.setRemoteDescription({
          type: "offer",
          sdp: withMaxMessageSize(offer.sdp, APPLICATION, 131072),
        }),
      );
      // Assert: remote offer の段階では current の上限のまま。
      expect(answerer().pc.sctpTransport!.remoteMaxMessageSize).toBe(
        answererLimit,
      );

      // Act: 上限を変えた pranswer を両側に適用する。
      const answer = (await answerer().pc.createAnswer()).sdp;
      const pranswer = withMaxMessageSize(answer, APPLICATION, 98304);
      await step(session, () =>
        answerer().pc.setLocalDescription({ type: "pranswer", sdp: answer }),
      );
      await step(session, () =>
        offerer().pc.setRemoteDescription({ type: "pranswer", sdp: pranswer }),
      );
      // Assert: pranswer で両側の上限が offer / pranswer の値になる。
      expect(answerer().pc.sctpTransport!.remoteMaxMessageSize).toBe(131072);
      expect(offerer().pc.sctpTransport!.remoteMaxMessageSize).toBe(98304);

      // Act: さらに別の上限の replacement pranswer を適用する。
      const replacement = withMaxMessageSize(answer, APPLICATION, 81920);
      await step(session, () =>
        answerer().pc.setLocalDescription({ type: "pranswer", sdp: answer }),
      );
      await step(session, () =>
        offerer().pc.setRemoteDescription({
          type: "pranswer",
          sdp: replacement,
        }),
      );
      // Assert: 最後の pranswer の値に置き換わる。
      expect(offerer().pc.sctpTransport!.remoteMaxMessageSize).toBe(81920);
      // Assert: 既存 DataChannel は暫定の上限を超えるメッセージを送らない。
      expect(() => offerer().channel.send(Buffer.alloc(81921))).toThrow(
        "max-message-size exceeded",
      );
      await expectSessionAlive(session, `max-message-size-pranswer-${outcome}`);

      if (outcome === "answer") {
        // Act: pranswer と異なる上限の final answer で commit する。
        const final = withMaxMessageSize(answer, APPLICATION, 262144);
        await step(session, () =>
          answerer().pc.setLocalDescription({ type: "answer", sdp: answer }),
        );
        await step(session, () =>
          offerer().pc.setRemoteDescription({ type: "answer", sdp: final }),
        );
        // Assert: final answer と offer の値が commit される。
        expect(offerer().pc.sctpTransport!.remoteMaxMessageSize).toBe(262144);
        expect(answerer().pc.sctpTransport!.remoteMaxMessageSize).toBe(131072);
      } else {
        // Act: 両側で rollback する。
        await step(session, () =>
          offerer().pc.setLocalDescription({ type: "rollback" }),
        );
        await step(session, () =>
          answerer().pc.setRemoteDescription({ type: "rollback" }),
        );
        // Assert: pranswer 前の上限に戻る。
        expect(offerer().pc.sctpTransport!.remoteMaxMessageSize).toBe(
          offererLimit,
        );
        expect(answerer().pc.sctpTransport!.remoteMaxMessageSize).toBe(
          answererLimit,
        );
      }
      // Assert: 同じ association で DataChannel が通じる。
      await expectSessionAlive(session, `max-message-size-${outcome}`);
    },
  );

  test.each(["answer", "rollback"] as const)(
    "local ICE restart then %s",
    async (outcome) => {
      // Arrange: 現在の ICE 資格情報を控える。
      const oldUfrag =
        offerer().pc.iceTransports[0].localParameters.usernameFragment;

      // Act: ICE restart offer を両側に pending として置く。
      await step(session, async () =>
        offerer().pc.setLocalDescription(
          await offerer().pc.createOffer({ iceRestart: true }),
        ),
      );
      await step(session, () =>
        answerer().pc.setRemoteDescription(offerer().pc.localDescription!),
      );
      // Assert: pending 中は旧 generation で通信を続ける。
      await expectSessionAlive(session, `restart-pending-${outcome}`);

      if (outcome === "answer") {
        // Act: answer で新 generation を commit する。
        await step(session, async () =>
          answerer().pc.setLocalDescription(await answerer().pc.createAnswer()),
        );
        await step(session, () =>
          offerer().pc.setRemoteDescription(answerer().pc.localDescription!),
        );
        await Promise.all([
          waitForCommittedNomination(offerer().pc),
          waitForCommittedNomination(answerer().pc),
        ]);
        // Assert: 新しい資格情報で nominate され、invariant が保たれる。
        expect(
          offerer().pc.iceTransports[0].localParameters.usernameFragment,
        ).not.toBe(oldUfrag);
        await step(session, () => undefined);
      } else {
        // Act: 両側で rollback する。
        await step(session, () =>
          offerer().pc.setLocalDescription({ type: "rollback" }),
        );
        await step(session, () =>
          answerer().pc.setRemoteDescription({ type: "rollback" }),
        );
        // Assert: 旧 generation の資格情報に戻る。
        expect(
          offerer().pc.iceTransports[0].localParameters.usernameFragment,
        ).toBe(oldUfrag);
      }
      // Assert: commit / rollback 後も双方向に通信できる。
      await expectSessionAlive(session, `restart-${outcome}`);
    },
  );

  test("pending trickle, duplicate candidate/EOC and a late old-generation candidate", async () => {
    // Arrange: 旧 generation の candidate を控え、ICE restart offer を用意する。
    const oldCandidates = sdpCandidates(
      offerer().pc.currentLocalDescription!.sdp,
      VIDEO,
    );
    const offer = await offerer().pc.createOffer({ iceRestart: true });
    await step(session, () => offerer().pc.setLocalDescription(offer));
    const newCandidates = sdpCandidates(offer.sdp, VIDEO);
    const withoutCandidates = offer.sdp
      .replace(/^a=candidate:[^\r\n]+\r?\n/gm, "")
      .replace(/^a=end-of-candidates\r?\n/gm, "");

    // Act: candidate を含まない offer を適用し、answer 前に trickle する。
    await step(session, () =>
      answerer().pc.setRemoteDescription({
        type: "offer",
        sdp: withoutCandidates,
      }),
    );
    for (const candidate of [...newCandidates, ...newCandidates]) {
      await step(session, () => answerer().pc.addIceCandidate(candidate));
    }
    await step(session, () => answerer().pc.addIceCandidate(null as never));
    await step(session, () => answerer().pc.addIceCandidate(null as never));
    // Assert: pending SDP には candidate が一度だけ記録され、current は影響を受けない。
    const pending = answerer().pc.pendingRemoteDescription!.sdp;
    for (const { candidate } of newCandidates) {
      expect(pending.split(`a=${candidate}`).length - 1).toBe(1);
    }
    await expectSessionAlive(session, "pending-trickle");

    // Act: answer で commit し、旧 generation の candidate を遅れて trickle する。
    await step(session, async () =>
      answerer().pc.setLocalDescription(await answerer().pc.createAnswer()),
    );
    await step(session, () =>
      offerer().pc.setRemoteDescription(answerer().pc.localDescription!),
    );
    await Promise.all([
      waitForCommittedNomination(offerer().pc),
      waitForCommittedNomination(answerer().pc),
    ]);
    for (const candidate of oldCandidates) {
      await step(session, () =>
        answerer()
          .pc.addIceCandidate(candidate)
          .catch(() => undefined),
      );
    }
    // Assert: 旧 candidate は新 generation の checklist に入らず通信も続く
    // (candidate と ufrag の一致は step 内の invariant で検査する)。
    await expectSessionAlive(session, "late-trickle");
  });

  test("transceiver stop rejects its m-line and a later transceiver reuses it", async () => {
    // Arrange: audio transceiver を追加して交渉する。
    const firstAudio = offerer().pc.addTransceiver("audio", {
      direction: "sendrecv",
    });
    await negotiate(session, offerer(), answerer());
    const audioIndex = firstAudio.mLineIndex!;

    // Act: audio transceiver を停止して交渉する。
    firstAudio.stop();
    await negotiate(session, offerer(), answerer());
    // Assert: m-line は port 0 で拒否され、共有 BUNDLE transport は止まらない。
    expect(offerer().pc.currentLocalDescription!.sdp).toMatch(/m=audio 0 /);
    await expectSessionAlive(session, "after-stop");

    // Act: 新しい audio transceiver を追加して交渉する。
    const secondAudio = offerer().pc.addTransceiver("audio", {
      direction: "sendrecv",
    });
    await negotiate(session, offerer(), answerer());
    // Assert: 停止済み m-line が再利用され、新しい MID で通信を続ける。
    expect(secondAudio.mLineIndex).toBe(audioIndex);
    expect(secondAudio.mid).not.toBe(firstAudio.mid);
    expect(
      offerer().pc.currentLocalDescription!.sdp.match(/^m=/gm)!.length,
    ).toBe(3);
    await expectSessionAlive(session, "after-reuse");
  });

  test("BUNDLE split, tag change and merge route RTP by MID", async () => {
    // Arrange: audio を追加し、全 m-line を一つの BUNDLE で交渉する。
    const audioOut = new MediaStreamTrack({ kind: "audio" });
    const audio = offerer().pc.addTransceiver(audioOut, {
      direction: "sendonly",
    });
    await negotiate(session, offerer(), answerer());
    const audioMid = audio.mid!;
    const remoteAudio = () =>
      answerer()
        .pc.getTransceivers()
        .find((t) => t.mid === audioMid)!;
    const expectAudio = (label: string) =>
      sendAndExpectRtp(audioOut, remoteAudio().receiver.track, label);
    await expectAudio("audio-bundled");

    // Act: audio を BUNDLE から外して別 transport に分割する。
    await negotiate(session, offerer(), answerer(), {
      localOffer: (sdp) =>
        sdp.replace(
          /^a=group:BUNDLE [^\r\n]+/m,
          `a=group:BUNDLE ${VIDEO} ${APPLICATION}`,
        ),
    });
    // Assert: audio は独立した transport を持ち、MID ごとの経路で届く。
    expect(audio.dtlsTransport).not.toBe(offerer().video.dtlsTransport);
    expect(remoteAudio().dtlsTransport).not.toBe(
      answerer().video.dtlsTransport,
    );
    await Promise.all([
      waitForDtlsConnected(audio.dtlsTransport),
      waitForDtlsConnected(remoteAudio().dtlsTransport),
    ]);
    await expectAudio("audio-split");
    await expectSessionAlive(session, "split");

    // Act: 再び一つの BUNDLE にまとめ、tag を application に変える。
    await negotiate(session, offerer(), answerer(), {
      localOffer: (sdp) =>
        sdp.replace(
          /^a=group:BUNDLE [^\r\n]+/m,
          `a=group:BUNDLE ${APPLICATION} ${VIDEO} ${audioMid}`,
        ),
    });
    // Assert: 全 MID が同じ transport に戻り、分割用 transport は閉じる
    // (orphan transport は step 内の invariant で検査する)。
    expect(audio.dtlsTransport).toBe(offerer().video.dtlsTransport);
    expect(remoteAudio().dtlsTransport).toBe(answerer().video.dtlsTransport);
    await expectAudio("audio-merged");
    await expectSessionAlive(session, "merged");
  });
});
