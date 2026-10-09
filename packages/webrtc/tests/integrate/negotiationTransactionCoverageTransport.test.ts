import { SCTP_STATE } from "../../../sctp/src";
import { MediaStreamTrack, RTCPeerConnection } from "../../src";
import {
  REMOTE_UFRAG,
  answerRemoteOffer,
  buildRemoteSdp,
  bundleGroups,
  createAudioOnlyPeer,
  expectTransportsMatchBundle,
} from "../issue/705.helpers";
import {
  type DuplexSession,
  assertNegotiationInvariants,
  assertTransportsClosed,
  closeDuringNextPreparedGather,
  createConnectedMultiVideoPeers,
  createDuplexSession,
  createInitialPranswerConnectionWithOffer,
  createMutationSession,
  createRewrittenOffer,
  expectMediaAlive,
  expectSessionAlive,
  heldTransports,
  holdNewDtlsStart,
  leaveBundle,
  mungeSection,
  mutate,
  negotiate,
  negotiationSnapshot,
  prepareMutationAnswerer,
  reverseSetupRole,
  sdpCandidates,
  sectionOf,
  sendAndExpectRtp,
  step,
  trickleCandidate,
  waitForDtlsConnected,
  waitForMutationSession,
  waitForPeersConnected,
  waitUntil,
  withIceCredentials,
  withOnlyUnsupportedCodec,
} from "./negotiationTransactionUtils";

const VIDEO = "0";
const APPLICATION = "1";
const BOGUS_FINGERPRINT = Array(32).fill("AB").join(":");

type Peer = DuplexSession["a"];

/** The value of `a=<name>` in the m-section `mid`. */
const attribute = (sdp: string, mid: string, name: string) =>
  new RegExp(`^a=${name}:(\\S+)`, "m").exec(sectionOf(sdp, mid))?.[1];

/** The remote fingerprint a DTLS transport would verify. */
const remoteFingerprint = (
  transport: RTCPeerConnection["dtlsTransports"][number],
) =>
  (
    transport as unknown as {
      remoteParameters?: { fingerprints: { value: string }[] };
    }
  ).remoteParameters?.fingerprints[0]?.value;

/** The remote SSRC route table of `pc`'s router. */
const ssrcTable = (pc: RTCPeerConnection) =>
  (pc as unknown as { router: { ssrcTable: Record<number, unknown> } }).router
    .ssrcTable;

/**
 * Spec coverage for the pranswer lifecycle, DTLS, BUNDLE and signaling
 * transitions of TICKET-ticket-0ad06d37 (§2.2, §2.4, §2.5, §2.8, §2.9, §5).
 * The requirement ID leads each test name.
 */
describe("negotiation transaction spec coverage: transport", () => {
  let session: DuplexSession | undefined;
  const cleanups: (() => Promise<unknown>)[] = [];

  afterEach(async () => {
    await session?.close();
    session = undefined;
    for (const cleanup of cleanups.splice(0)) await cleanup();
  });

  test("[2.2-8] a replacement pranswer's DTLS fingerprint and role take effect on a new association that has not started", async () => {
    // Arrange: 確立済み session で、新しい audio を BUNDLE 外に出す re-offer
    // (新しい DTLS association) を両側に置き、offerer の新 transport の DTLS 開始を止める。
    session = await createDuplexSession();
    const { a, b } = session;
    const audioOut = new MediaStreamTrack({ kind: "audio" });
    const audio = a.pc.addTransceiver(audioOut, { direction: "sendonly" });
    const offer = await createRewrittenOffer(a.pc, (sdp) =>
      leaveBundle(sdp, audio.mid!),
    );
    const mid = audio.mid!;
    await step(session, () => a.pc.setLocalDescription(offer));
    const hold = holdNewDtlsStart(a.pc);
    await step(session, () =>
      b.pc.setRemoteDescription(a.pc.localDescription!),
    );
    const answer = (await b.pc.createAnswer()).sdp;
    const shared = a.video.dtlsTransport;
    const sharedRole = shared.role;
    const sharedFingerprint = remoteFingerprint(shared);
    const realFingerprint = /^a=fingerprint:\S+ (\S+)/m.exec(
      sectionOf(answer, mid),
    )![1];
    // 1 回目は新 association の fingerprint と a=setup だけを変えた pranswer。
    const first = mungeSection(answer, mid, (section) =>
      reverseSetupRole(section).replace(
        /^a=fingerprint:(\S+) \S+/m,
        `a=fingerprint:$1 ${BOGUS_FINGERPRINT}`,
      ),
    );
    const newTransport = () =>
      [...heldTransports(a.pc)].find(
        (transport) => transport !== shared && transport.state !== "closed",
      )!;

    // Act: 1 回目の pranswer を両側に適用する。
    await step(session, () =>
      b.pc.setLocalDescription({ type: "pranswer", sdp: answer }),
    );
    await step(session, () =>
      a.pc.setRemoteDescription({ type: "pranswer", sdp: first }),
    );
    // Assert: 未接続の新 association は 1 回目の pranswer の fingerprint / role になる。
    expect(hold.held).toHaveLength(1);
    expect(remoteFingerprint(newTransport())).toBe(BOGUS_FINGERPRINT);
    expect(newTransport().role).toBe("client");

    // Act: 正しい fingerprint と a=setup の replacement pranswer を適用する。
    await step(session, () =>
      a.pc.setRemoteDescription({ type: "pranswer", sdp: answer }),
    );
    // Assert: 新 association は最新の pranswer の値に置き換わり、既存 association は変わらない。
    expect(remoteFingerprint(newTransport())).toBe(realFingerprint);
    expect(newTransport().role).toBe("server");
    expect(shared.role).toBe(sharedRole);
    expect(remoteFingerprint(shared)).toBe(sharedFingerprint);

    // Act: DTLS の開始を許し、新 association の接続を待つ。
    hold.release();
    const remoteAudio = b.pc.getTransceivers().find((t) => t.mid === mid)!;
    await waitForPeersConnected(a.pc, b.pc);
    await Promise.all([
      waitForDtlsConnected(newTransport()),
      waitForDtlsConnected(remoteAudio.dtlsTransport),
    ]);
    // Assert: 最新の pranswer の値で接続し、新しい audio の RTP と既存 session が通じる。
    expect(b.pc.signalingState).toBe("have-local-pranswer");
    await sendAndExpectRtp(
      audioOut,
      remoteAudio.receiver.track,
      "replacement-pranswer-audio",
    );
    await expectSessionAlive(session, "replacement-pranswer-dtls");
  });

  test("[2.2-8] a replacement pranswer that adds BUNDLE detaches the transports a no-BUNDLE pranswer used and stops their checks", async () => {
    // Arrange: 初回交渉で、BUNDLE なしの pranswer を offerer に適用する。
    session = await createMutationSession("initial");
    const { a, b } = session;
    await step(session, async () =>
      a.pc.setLocalDescription(await a.pc.createOffer()),
    );
    await step(session, () =>
      b.pc.setRemoteDescription(a.pc.localDescription!),
    );
    await prepareMutationAnswerer(session);
    const answer = (await b.pc.createAnswer()).sdp;
    await step(session, () =>
      b.pc.setLocalDescription({ type: "pranswer", sdp: answer }),
    );
    await step(session, () =>
      a.pc.setRemoteDescription({
        type: "pranswer",
        sdp: mutate(answer, ["noBundle"]),
      }),
    );
    const unbundled = [...a.pc.dtlsTransports];
    expect(unbundled.length).toBeGreaterThan(1);

    // Act: BUNDLE を受理した replacement pranswer を適用する。
    await step(session, () =>
      a.pc.setRemoteDescription({ type: "pranswer", sdp: answer }),
    );
    const detached = unbundled.filter(
      (transport) => !a.pc.dtlsTransports.includes(transport),
    );

    // Assert: 全 m-line が tag の transport を共有し、旧 pranswer だけが使った
    // transport は外れて、その暫定の ICE checks は止まる。
    expect(a.pc.sctpTransport!.dtlsTransport).toBe(a.video.dtlsTransport);
    expect(detached.length).toBeGreaterThan(0);
    for (const transport of detached) {
      expect(["new", "closed"]).toContain(transport.iceTransport.state);
    }
    // Assert: final answer 前の最新 topology で RTP と DataChannel が通じる。
    await waitForMutationSession(session);
    expect(a.pc.signalingState).toBe("have-remote-pranswer");
    await expectSessionAlive(session, "replacement-pranswer-bundle");

    // Act: final answer で確定する。
    await step(session, () =>
      b.pc.setLocalDescription({ type: "answer", sdp: answer }),
    );
    await step(session, () =>
      a.pc.setRemoteDescription({ type: "answer", sdp: answer }),
    );
    // Assert: 確定後も同じ topology で通じる。
    await expectSessionAlive(session, "replacement-pranswer-bundle-final");
  });

  test("[2.2-13] a final answer that rejects the application m-line closes the SCTP association a first pranswer opened", async () => {
    // Arrange: 初回交渉の pranswer で SCTP association と DataChannel を開く。
    session = await createMutationSession("initial");
    const { a, b } = session;
    await step(session, async () =>
      a.pc.setLocalDescription(await a.pc.createOffer()),
    );
    await step(session, () =>
      b.pc.setRemoteDescription(a.pc.localDescription!),
    );
    await prepareMutationAnswerer(session);
    const answer = (await b.pc.createAnswer()).sdp;
    await step(session, () =>
      b.pc.setLocalDescription({ type: "pranswer", sdp: answer }),
    );
    await step(session, () =>
      a.pc.setRemoteDescription({ type: "pranswer", sdp: answer }),
    );
    await waitForMutationSession(session);
    const provisional = a.pc.sctpTransport!;
    expect(provisional.sctp.associationState).toBe(SCTP_STATE.ESTABLISHED);
    const rejected = leaveBundle(
      mungeSection(answer, APPLICATION, (section) =>
        section.replace(/^m=application \d+/m, "m=application 0"),
      ),
      APPLICATION,
    );

    // Act: application m-line を port 0 で拒否した final answer を offerer に適用する。
    await b.pc.setLocalDescription({ type: "answer", sdp: answer });
    await a.pc.setRemoteDescription({ type: "answer", sdp: rejected });
    assertNegotiationInvariants(a.pc);

    // Assert: provisional SCTP association と DataChannel が閉じ、sctpTransport は残らない。
    await waitUntil(
      () => a.channel.readyState === "closed",
      "provisional DataChannel did not close",
    );
    expect(provisional.sctp.associationState).toBe(SCTP_STATE.CLOSED);
    expect(a.pc.sctpTransport).toBeUndefined();
    // Assert: 受理された video は確定した transport で届き続ける。
    await sendAndExpectRtp(
      a.out,
      b.video.receiver.track,
      "video-after-sctp-reject",
    );
  });

  test("[2.2-13] the candidates of a pranswer generation the final answer replaced leave the live checklist", async () => {
    // Arrange: 初回交渉で、final answer と別の ICE generation の候補を持つ pranswer を offerer に適用する。
    session = await createMutationSession("initial");
    const { a, b } = session;
    await step(session, async () =>
      a.pc.setLocalDescription(await a.pc.createOffer()),
    );
    await step(session, () =>
      b.pc.setRemoteDescription(a.pc.localDescription!),
    );
    await prepareMutationAnswerer(session);
    const answer = (await b.pc.createAnswer()).sdp;
    const ufrag = attribute(answer, VIDEO, "ice-ufrag")!;
    // pranswer は別の (provisional) ICE generation とその候補を伝える。
    const extra = trickleCandidate(50991, "prov", VIDEO).candidate;
    const pranswer = mungeSection(
      withIceCredentials(
        answer,
        "prov",
        "provisionalpasswordprovisional",
      ).replace(/ ufrag \S+/g, " ufrag prov"),
      VIDEO,
      (section) =>
        section.replace(/^(a=ice-pwd:[^\r\n]+\r\n)/m, `$1a=${extra}\r\n`),
    );
    const connection = a.pc.iceTransports[0].connection;
    await step(session, () =>
      b.pc.setLocalDescription({ type: "pranswer", sdp: answer }),
    );
    await step(session, () =>
      a.pc.setRemoteDescription({ type: "pranswer", sdp: pranswer }),
    );
    await waitUntil(
      () => connection.remoteCandidates.some((c) => c.port === 50991),
      "the pranswer candidate was not added",
    );

    // Act: その候補を含まない final answer で確定する。
    await step(session, () =>
      b.pc.setLocalDescription({ type: "answer", sdp: answer }),
    );
    await step(session, () =>
      a.pc.setRemoteDescription({ type: "answer", sdp: answer }),
    );

    // Assert: final answer の generation に切り替わり、pranswer だけが伝えた候補は
    // live checklist と current SDP から外れる。
    const live = a.pc.iceTransports[0].connection;
    expect(live.remoteUsername).toBe(ufrag);
    expect(live.remoteCandidates.some((c) => c.port === 50991)).toBe(false);
    expect(
      live.checkList.some((pair) => pair.remoteCandidate.port === 50991),
    ).toBe(false);
    expect(a.pc.currentRemoteDescription!.sdp).not.toContain(" 50991 ");
    await waitForMutationSession(session);
    await expectMediaAlive(session, "pranswer-candidate-released");
  });

  test("[2.2-16] rollback stops the RTP a renegotiation pranswer started and keeps the current stream", async () => {
    // Arrange: 確立済み session に新しい audio を足した re-offer を pranswer まで進め、
    // 新 audio の RTP が届くことを確かめる。
    session = await createDuplexSession();
    const { a, b } = session;
    const audioOut = new MediaStreamTrack({ kind: "audio" });
    const audio = a.pc.addTransceiver(audioOut, { direction: "sendonly" });
    await step(session, async () =>
      a.pc.setLocalDescription(await a.pc.createOffer()),
    );
    await step(session, () =>
      b.pc.setRemoteDescription(a.pc.localDescription!),
    );
    const answer = (await b.pc.createAnswer()).sdp;
    await step(session, () =>
      b.pc.setLocalDescription({ type: "pranswer", sdp: answer }),
    );
    await step(session, () =>
      a.pc.setRemoteDescription({ type: "pranswer", sdp: answer }),
    );
    const remoteAudio = b.pc
      .getTransceivers()
      .find((t) => t.mid === audio.mid)!;
    const audioTrack = remoteAudio.receiver.track;
    const audioSsrc = audio.sender.ssrc;
    await sendAndExpectRtp(audioOut, audioTrack, "pranswer-audio");
    expect(ssrcTable(b.pc)[audioSsrc]).toBe(remoteAudio.receiver);

    // Act: 両側で rollback する。
    await step(session, () => a.pc.setLocalDescription({ type: "rollback" }));
    await step(session, () => b.pc.setRemoteDescription({ type: "rollback" }));

    // Assert: 新 audio の RTP は届かなくなり、受信側 router にその SSRC は残らない。
    await expect(
      sendAndExpectRtp(audioOut, audioTrack, "rolled-back-audio"),
    ).rejects.toThrow("RTP was not received");
    expect(ssrcTable(b.pc)[audioSsrc]).toBeUndefined();
    // Assert: 旧 current の video と DataChannel は双方向に届き続ける。
    await expectSessionAlive(session, "pranswer-rollback-current");
  });

  test("[2.2-19] a stable session after the final answer cannot be rolled back", async () => {
    // Arrange: final answer まで交渉して stable にし、両 peer の状態を控える。
    session = await createDuplexSession();
    const { a, b } = session;
    await negotiate(session, a, b);
    const before = [a.pc, b.pc].map(negotiationSnapshot);
    const pairs = [a.pc, b.pc].map((pc) =>
      pc.iceTransports[0].getSelectedCandidatePair(),
    );
    const transports = [a.pc, b.pc].map((pc) => [...pc.dtlsTransports]);

    for (const pc of [a.pc, b.pc]) {
      // Act / Assert: stable での local / remote rollback は InvalidStateError で拒否される (W3C)。
      await step(session, () =>
        expect(
          pc.setLocalDescription({ type: "rollback" }),
        ).rejects.toMatchObject({ name: "InvalidStateError" }),
      );
      await step(session, () =>
        expect(
          pc.setRemoteDescription({ type: "rollback" }),
        ).rejects.toMatchObject({ name: "InvalidStateError" }),
      );
    }

    // Assert: description・transport・selected pair は変わらず、通信も続く。
    expect([a.pc, b.pc].map(negotiationSnapshot)).toEqual(before);
    expect(
      [a.pc, b.pc].map((pc) => pc.iceTransports[0].getSelectedCandidatePair()),
    ).toEqual(pairs);
    expect([a.pc, b.pc].map((pc) => [...pc.dtlsTransports])).toEqual(
      transports,
    );
    await expectSessionAlive(session, "stable-rollback-rejected");
  });

  test("[2.8-18] close() while a local offer stages the transports of a BUNDLE split leaves none running", async () => {
    const { offerer, close } = await createConnectedMultiVideoPeers(3);
    cleanups.push(close);
    // Arrange: 3 m-line の BUNDLE から 2 つを外す (owner transport を 2 つ stage させる) local offer を用意する。
    const [first] = offerer.getTransceivers().map((t) => t.mid!);
    const split = await createRewrittenOffer(offerer, (sdp) =>
      sdp.replace(/^a=group:BUNDLE [^\r\n]+/m, `a=group:BUNDLE ${first}`),
    );
    const live = [...offerer.dtlsTransports];
    const hook = closeDuringNextPreparedGather(offerer);
    cleanups.push(async () => hook.restore());

    // Act: local offer の stage (最初の gather) の途中で close する。
    await expect(offerer.setLocalDescription(split)).rejects.toMatchObject({
      name: "InvalidStateError",
    });
    await hook.closed();
    hook.restore();

    // Assert: stage を始めた transport は止まり、close の後に新しい transport は作られない。
    expect(hook.gathered).toHaveLength(1);
    for (const transport of hook.gathered) {
      expect(transport.state).toBe("closed");
    }
    assertTransportsClosed(live);
    expect(offerer.connectionState).toBe("closed");
    expect(offerer.signalingState).toBe("closed");
  });

  test("[2.8-20] a first answer's own MIDs are read as the offered MIDs in BUNDLE, and a later answer must match exactly", async () => {
    // Arrange: #142 の fixture を、BUNDLE も answer 側の独自 MID で書いた版にする。
    const pc = new RTCPeerConnection();
    cleanups.push(() => pc.close());
    pc.addTrack(new MediaStreamTrack({ kind: "audio" }));
    pc.addTrack(new MediaStreamTrack({ kind: "video" }));
    pc.createDataChannel("dc");
    await pc.setLocalDescription(await pc.createOffer());

    // Act: 初回 answer として適用する。
    // (fixture の payload type は offer と異なるので invariant helper は使わない。)
    await pc.setRemoteDescription({ type: "answer", sdp: issue142Answer });

    // Assert: 受理され、MID と BUNDLE の項目が offer の MID に読み替えられて transport を共有する。
    expect(pc.signalingState).toBe("stable");
    expect(pc.getTransceivers().map((t) => t.mid)).toEqual(["0", "1"]);
    expect(bundleGroups(pc.currentRemoteDescription!.sdp)).toEqual([
      ["0", "2", "1"],
    ]);
    const [audio, video] = pc.getTransceivers();
    expect(video.dtlsTransport).toBe(audio.dtlsTransport);
    expect(pc.sctpTransport!.dtlsTransport).toBe(audio.dtlsTransport);
    expect(pc.dtlsTransports).toHaveLength(1);

    // Act: 再交渉で、同じ独自 MID の answer を適用する。
    await pc.setLocalDescription(await pc.createOffer());
    const before = negotiationSnapshot(pc);
    await expect(
      pc.setRemoteDescription({ type: "answer", sdp: issue142Answer }),
    ).rejects.toThrow();

    // Assert: session 確立後は MID の不一致を拒否し、状態は変わらない。
    expect(negotiationSnapshot(pc)).toEqual(before);
    expect(pc.signalingState).toBe("have-local-offer");
  });

  test.each(["max-compat", "balanced"] as const)(
    "[2.8-41] a %s first offer keeps each m-line on its own transport and candidates until an answer accepts BUNDLE",
    async (bundlePolicy) => {
      // Arrange: audio + video の初回 offerer と、BUNDLE を受理する answerer。
      const offerer = new RTCPeerConnection({ bundlePolicy });
      const answerer = new RTCPeerConnection();
      cleanups.push(() =>
        Promise.allSettled([offerer.close(), answerer.close()]),
      );
      const audioOut = new MediaStreamTrack({ kind: "audio" });
      const videoOut = new MediaStreamTrack({ kind: "video" });
      const audio = offerer.addTransceiver(audioOut, { direction: "sendonly" });
      const video = offerer.addTransceiver(videoOut, { direction: "sendonly" });

      // Act: offer を作って適用する。
      await offerer.setLocalDescription(await offerer.createOffer());
      assertNegotiationInvariants(offerer);

      // Assert: offer は BUNDLE を提案するが、各 m-line は自分の transport を持ち、
      // その transport の候補を広告する。
      const offer = offerer.localDescription!.sdp;
      expect(bundleGroups(offer)).toEqual([[audio.mid, video.mid]]);
      expect(audio.dtlsTransport).not.toBe(video.dtlsTransport);
      const advertised = (mid: string) =>
        new Set(
          sdpCandidates(offer, mid).map(
            ({ candidate }) => candidate.split(" ")[5],
          ),
        );
      const gathered = (transceiver: typeof audio) =>
        new Set(
          transceiver.dtlsTransport.iceTransport.connection.localCandidates.map(
            (candidate) => String(candidate.port),
          ),
        );
      for (const transceiver of [audio, video]) {
        expect(advertised(transceiver.mid!).size).toBeGreaterThan(0);
        expect(advertised(transceiver.mid!)).toEqual(gathered(transceiver));
      }
      expect(
        [...advertised(audio.mid!)].some((port) =>
          advertised(video.mid!).has(port),
        ),
      ).toBe(false);
      const proposed = heldTransports(offerer);

      // Act: BUNDLE を受理した answer で確定する。
      await answerer.setRemoteDescription(offerer.localDescription!);
      await answerer.setLocalDescription(await answerer.createAnswer());
      await offerer.setRemoteDescription(answerer.localDescription!);
      assertNegotiationInvariants(offerer);
      assertNegotiationInvariants(answerer);

      // Assert: tag の transport に統合され、余った transport は閉じる。
      expect(video.dtlsTransport).toBe(audio.dtlsTransport);
      const dropped = [...proposed].filter(
        (transport) => transport !== audio.dtlsTransport,
      );
      expect(dropped).toHaveLength(1);
      assertTransportsClosed(dropped);
      // Assert: 統合した transport で audio・video とも届く。
      await waitForPeersConnected(offerer, answerer);
      const received = (mid: string) =>
        answerer.getTransceivers().find((t) => t.mid === mid)!.receiver.track;
      await sendAndExpectRtp(audioOut, received(audio.mid!), "bundled-audio");
      await sendAndExpectRtp(videoOut, received(video.mid!), "bundled-video");
    },
  );

  test("[2.8-43] a max-bundle first offer shares the tag's transport at the offer", async () => {
    // Arrange: max-bundle の初回 offerer (audio + video + DataChannel)。
    const pc = new RTCPeerConnection({ bundlePolicy: "max-bundle" });
    cleanups.push(() => pc.close());
    const audio = pc.addTransceiver("audio", { direction: "sendonly" });
    const video = pc.addTransceiver("video", { direction: "sendonly" });
    pc.createDataChannel("dc");

    // Act: offer を作って適用する。
    await pc.setLocalDescription(await pc.createOffer());
    assertNegotiationInvariants(pc);

    // Assert: 全 m-line の ufrag が同じで、transport も tag (audio) のものを共有する。
    const offer = pc.localDescription!.sdp;
    const mids = offer.match(/^a=mid:\S+/gm)!.map((line) => line.slice(6));
    expect(
      new Set(mids.map((mid) => attribute(offer, mid, "ice-ufrag"))),
    ).toHaveProperty("size", 1);
    expect(video.dtlsTransport).toBe(audio.dtlsTransport);
    expect(pc.sctpTransport!.dtlsTransport).toBe(audio.dtlsTransport);
    expect(heldTransports(pc).size).toBe(1);
  });

  test("[2.8-43] an m-line added to a session whose peer accepted BUNDLE shares the tag's transport at the offer", async () => {
    // Arrange: BUNDLE を受理済みの session に audio を追加する。
    session = await createDuplexSession();
    const { a } = session;
    const audio = a.pc.addTransceiver("audio", { direction: "sendonly" });

    // Act: offer を作って適用する。
    await step(session, async () =>
      a.pc.setLocalDescription(await a.pc.createOffer()),
    );

    // Assert: 新しい m-line は tag と同じ ufrag で、tag の transport を共有する。
    const offer = a.pc.localDescription!.sdp;
    expect(attribute(offer, audio.mid!, "ice-ufrag")).toBe(
      attribute(offer, VIDEO, "ice-ufrag"),
    );
    expect(audio.dtlsTransport).toBe(a.video.dtlsTransport);
    expect(heldTransports(a.pc)).toEqual(new Set([a.video.dtlsTransport]));
  });

  test("[2.8-47] an actpass answer makes a new association the DTLS client", async () => {
    // Arrange: 初回 offer (actpass) と、全 m-line を a=setup:actpass にした remote answer。
    session = await createMutationSession("initial");
    const { a, b } = session;
    await a.pc.setLocalDescription(await a.pc.createOffer());
    expect(a.pc.localDescription!.sdp).toMatch(/^a=setup:actpass/m);
    await b.pc.setRemoteDescription(a.pc.localDescription!);
    await prepareMutationAnswerer(session);
    await b.pc.setLocalDescription(await b.pc.createAnswer());

    // Act: actpass の answer を適用する。
    await a.pc.setRemoteDescription({
      type: "answer",
      sdp: mutate(b.pc.localDescription!.sdp, ["setupActpass"]),
    });

    // Assert: 受理され、新しい association の role は client になる。
    expect(a.pc.signalingState).toBe("stable");
    expect(a.pc.dtlsTransports.map((transport) => transport.role)).toEqual(
      a.pc.dtlsTransports.map(() => "client"),
    );
    assertNegotiationInvariants(a.pc);
  });

  test("[2.9-T8] the same offer replaces a pranswer a first negotiation connected and the final answer reconnects", async () => {
    // Arrange: 初回交渉の pranswer で ICE / DTLS を接続した peer。
    const { offerer, answerer, offer, close } =
      await createInitialPranswerConnectionWithOffer();
    cleanups.push(close);
    const out = offerer.getTransceivers()[0].sender.track!;

    // Act: 最後に作った同じ offer を offerer に再適用する。
    await offerer.setLocalDescription(offer);
    assertNegotiationInvariants(offerer);
    // Assert: remote pranswer は先に rollback され、offerer は have-local-offer に戻る。
    expect(offerer.signalingState).toBe("have-local-offer");
    expect(offerer.pendingRemoteDescription).toBeNull();
    expect(offerer.currentRemoteDescription).toBeNull();

    // Act: answerer に offer を渡し、final answer で確定する。
    await answerer.setRemoteDescription(offerer.localDescription!);
    const received = answerer.getTransceivers()[0];
    await received.sender.replaceTrack(new MediaStreamTrack({ kind: "video" }));
    await answerer.setLocalDescription(await answerer.createAnswer());
    await offerer.setRemoteDescription(answerer.localDescription!);
    assertNegotiationInvariants(offerer);
    assertNegotiationInvariants(answerer);

    // Assert: final answer で接続し直し、RTP が届く。
    await waitForPeersConnected(offerer, answerer);
    expect(offerer.signalingState).toBe("stable");
    await sendAndExpectRtp(
      out,
      received.receiver.track,
      "same-offer-after-first-pranswer",
    );
  });

  test("[5-11] staged topology, candidate delivery, DTLS role and the answer's tags apply to the second BUNDLE group", async () => {
    // Arrange: [0,1] と [2,3] の 2 つの BUNDLE group を確立した answerer。
    const pc = createAudioOnlyPeer();
    cleanups.push(() => pc.close());
    const sections = (mid3Ufrag: string) => [
      { kind: "audio" as const, mid: "0" },
      { kind: "audio" as const, mid: "1" },
      { kind: "audio" as const, mid: "2", ufrag: "groupbufrag" },
      { kind: "audio" as const, mid: "3", ufrag: mid3Ufrag },
    ];
    const twoGroups = buildRemoteSdp({
      sections: sections("groupbufrag"),
      bundles: [
        ["0", "1"],
        ["2", "3"],
      ],
    });
    const splitSecond = buildRemoteSdp({
      sections: sections("splitufrag"),
      bundles: [["0", "1"], ["2"], ["3"]],
    });
    await answerRemoteOffer(pc, twoGroups);
    const [t0, t1, t2, t3] = pc.getTransceivers();
    const groupA = t0.dtlsTransport;
    const groupB = t2.dtlsTransport;
    expect(t3.dtlsTransport).toBe(groupB);
    expect(groupB).not.toBe(groupA);

    // Act: 2 つ目の group だけを分割する re-offer を適用する。
    await pc.setRemoteDescription({ type: "offer", sdp: splitSecond });
    assertNegotiationInvariants(pc);
    // Assert: pending 中は 2 つ目の group の共有 transport と remote 資格情報が変わらない。
    expect([t0, t1, t2, t3].map((t) => t.dtlsTransport)).toEqual([
      groupA,
      groupA,
      groupB,
      groupB,
    ]);
    expect(groupB.iceTransport.connection.remoteUsername).toBe("groupbufrag");

    // Act: rollback し、2 つ目の group の非 tag m-line (3) に候補と EOC を trickle する。
    await pc.setRemoteDescription({ type: "rollback" });
    assertNegotiationInvariants(pc);
    await pc.addIceCandidate(trickleCandidate(50993, "groupbufrag", "3"));
    await pc.addIceCandidate({
      candidate: "",
      sdpMid: "3",
      usernameFragment: "groupbufrag",
    });
    assertNegotiationInvariants(pc);
    // Assert: 候補と EOC はその group の transport にだけ届く。
    await waitUntil(
      () =>
        groupB.iceTransport.connection.remoteCandidates.some(
          (c) => c.port === 50993,
        ),
      "candidate did not reach the second group",
    );
    await waitUntil(
      () => groupB.iceTransport.connection.remoteCandidatesEnd,
      "EOC did not reach the second group",
    );
    expect(
      groupA.iceTransport.connection.remoteCandidates.some(
        (c) => c.port === 50993,
      ),
    ).toBe(false);
    expect(groupA.iceTransport.connection.remoteCandidatesEnd).toBe(false);
    expect(groupA.iceTransport.connection.remoteUsername).toBe(REMOTE_UFRAG);

    // Act: 2 つ目の group を分割する re-offer に answer して確定する。
    const answer = await answerRemoteOffer(pc, splitSecond);

    // Assert: answer の group と tag は offer と一致し、分割した m-line だけが新しい transport に移る。
    expect(bundleGroups(answer)).toEqual([["0", "1"], ["2"], ["3"]]);
    expectTransportsMatchBundle(pc);
    expect(t2.dtlsTransport).toBe(groupB);
    expect(t3.dtlsTransport).not.toBe(groupB);
    expect(t3.dtlsTransport).not.toBe(groupA);
    expect([t0.dtlsTransport, t1.dtlsTransport]).toEqual([groupA, groupA]);
    assertNegotiationInvariants(pc);
  });
});

/**
 * Transitions run in both offerer directions (each peer is once the local
 * and once the remote offerer, which also swaps the DTLS roles).
 */
describe.each([
  ["a", "b"],
  ["b", "a"],
] as const)(
  "negotiation transaction spec coverage: transport (offerer=%s)",
  (from, to) => {
    let session: DuplexSession;
    const offerer = (): Peer => session.peers[from];
    const answerer = (): Peer => session.peers[to];

    beforeEach(async () => {
      session = await createDuplexSession();
    });
    afterEach(async () => {
      await session.close();
    });

    test("[2.4-8] a local pranswer that flips the DTLS setup of a connected association is rejected", async () => {
      // Arrange: re-offer を受け、a=setup を反転させた local pranswer を用意する。
      const dtls = answerer().video.dtlsTransport;
      const role = dtls.role;
      await step(session, async () =>
        offerer().pc.setLocalDescription(await offerer().pc.createOffer()),
      );
      await step(session, () =>
        answerer().pc.setRemoteDescription(offerer().pc.localDescription!),
      );
      const answer = (await answerer().pc.createAnswer()).sdp;
      const flipped = reverseSetupRole(answer);
      expect(flipped).not.toBe(answer);

      // Act: role を反転させる local pranswer を適用する。
      await step(session, () =>
        expect(
          answerer().pc.setLocalDescription({ type: "pranswer", sdp: flipped }),
        ).rejects.toMatchObject({
          name: "InvalidModificationError",
          message: expect.stringMatching(/DTLS role/),
        }),
      );

      // Assert: signaling state と role は変わらず、current session で通信を続ける。
      expect(answerer().pc.signalingState).toBe("have-remote-offer");
      expect(answerer().pc.pendingLocalDescription).toBeNull();
      expect(dtls.role).toBe(role);
      await expectSessionAlive(session, "local-pranswer-setup-rejected");

      // Act: 元の pranswer と answer で確定する。
      await step(session, () =>
        answerer().pc.setLocalDescription({ type: "pranswer", sdp: answer }),
      );
      await step(session, () =>
        answerer().pc.setLocalDescription({ type: "answer", sdp: answer }),
      );
      await step(session, () =>
        offerer().pc.setRemoteDescription({ type: "answer", sdp: answer }),
      );
      // Assert: role は保たれ、確定後も通信できる。
      expect(dtls.role).toBe(role);
      await expectSessionAlive(session, "local-pranswer-setup-final");
    });

    test("[2.5-T3] an answer to an m-line outside the BUNDLE group offered with a=setup:active is passive", async () => {
      // Arrange: 新しい audio を BUNDLE 外に出した offer を作り、answerer に届く
      // remote offer ではその m-line だけ a=setup:active にする。
      const audioOut = new MediaStreamTrack({ kind: "audio" });
      const audio = offerer().pc.addTransceiver(audioOut, {
        direction: "sendonly",
      });
      const offer = await createRewrittenOffer(offerer().pc, (sdp) =>
        leaveBundle(sdp, audio.mid!),
      );
      const mid = audio.mid!;
      const roles = [offerer(), answerer()].map(
        (peer) => peer.video.dtlsTransport.role,
      );
      await step(session, () => offerer().pc.setLocalDescription(offer));
      const remoteOffer = mungeSection(
        offerer().pc.localDescription!.sdp,
        mid,
        (section) => section.replace(/^a=setup:\w+/m, "a=setup:active"),
      );
      expect(attribute(remoteOffer, mid, "setup")).toBe("active");
      await step(session, () =>
        answerer().pc.setRemoteDescription({ type: "offer", sdp: remoteOffer }),
      );

      // Act: answer を作る。
      const answer = (await answerer().pc.createAnswer()).sdp;

      // Assert: group 外の m-line は offer の逆の passive で答え、group は従来の role のまま。
      expect(attribute(answer, mid, "setup")).toBe("passive");
      expect(attribute(answer, VIDEO, "setup")).toBe(
        answerer().video.dtlsTransport.role === "client" ? "active" : "passive",
      );

      // Act: answer で確定する。
      await step(session, () =>
        answerer().pc.setLocalDescription({ type: "answer", sdp: answer }),
      );
      await step(session, () =>
        offerer().pc.setRemoteDescription({ type: "answer", sdp: answer }),
      );
      const remoteAudio = answerer()
        .pc.getTransceivers()
        .find((t) => t.mid === mid)!;

      // Assert: 独立 transport の role は answerer が server、offerer が client。
      expect(remoteAudio.dtlsTransport).not.toBe(
        answerer().video.dtlsTransport,
      );
      expect(remoteAudio.dtlsTransport.role).toBe("server");
      expect(audio.dtlsTransport.role).toBe("client");
      expect(
        [offerer(), answerer()].map((peer) => peer.video.dtlsTransport.role),
      ).toEqual(roles);
      // Assert: 独立 transport で接続し、audio と既存 session が通じる。
      await Promise.all([
        waitForDtlsConnected(audio.dtlsTransport),
        waitForDtlsConnected(remoteAudio.dtlsTransport),
      ]);
      await sendAndExpectRtp(
        audioOut,
        remoteAudio.receiver.track,
        "outside-audio",
      );
      await expectSessionAlive(session, "outside-setup-active");
    });

    test("[2.9-T8] the same offer replaces a renegotiation pranswer in have-remote-pranswer", async () => {
      // Arrange: re-offer に inactive の pranswer を返し、offerer を have-remote-pranswer にする。
      const offer = await offerer().pc.createOffer();
      await step(session, () => offerer().pc.setLocalDescription(offer));
      await step(session, () => answerer().pc.setRemoteDescription(offer));
      const answer = (await answerer().pc.createAnswer()).sdp;
      const inactive = mungeSection(answer, VIDEO, (section) =>
        section.replace("a=sendrecv", "a=inactive"),
      );
      await step(session, () =>
        answerer().pc.setLocalDescription({ type: "pranswer", sdp: inactive }),
      );
      await step(session, () =>
        offerer().pc.setRemoteDescription({ type: "pranswer", sdp: inactive }),
      );
      expect(offerer().pc.signalingState).toBe("have-remote-pranswer");
      expect(offerer().video.currentDirection).toBe("inactive");
      const current = offerer().pc.currentRemoteDescription!.sdp;

      // Act: 最後に作った同じ offer を offerer に再適用する。
      await step(session, () => offerer().pc.setLocalDescription(offer));

      // Assert: remote pranswer は rollback され、have-local-offer に戻り、暫定の inactive は消える。
      expect(offerer().pc.signalingState).toBe("have-local-offer");
      expect(offerer().pc.pendingRemoteDescription).toBeNull();
      expect(offerer().pc.currentRemoteDescription!.sdp).toBe(current);
      expect(offerer().video.currentDirection).toBe("sendrecv");
      await sendAndExpectRtp(
        offerer().out,
        answerer().video.receiver.track,
        "same-offer-pending",
      );

      // Act: answerer に同じ offer を渡し、answer で確定する。
      // (byte 単位で同じ remote offer の再適用は冪等なので、answerer はその offer に答える。)
      await step(session, () => answerer().pc.setRemoteDescription(offer));
      await step(session, async () =>
        answerer().pc.setLocalDescription(await answerer().pc.createAnswer()),
      );
      await step(session, () =>
        offerer().pc.setRemoteDescription(answerer().pc.localDescription!),
      );
      // Assert: 双方 stable で双方向に通信できる。
      expect(offerer().pc.signalingState).toBe("stable");
      await expectSessionAlive(session, "same-offer-final");
    });

    test("[5-2] an m-line without a common codec, its port 0 answer and duplicate applications keep the invariants", async () => {
      // Arrange: 新しい video m-line を足した re-offer を作り、wire 上でその m-line を
      // 共通 codec のない提案にする。
      const extra = offerer().pc.addTransceiver(
        new MediaStreamTrack({ kind: "video" }),
        { direction: "sendonly" },
      );
      const offer = await offerer().pc.createOffer();
      const mid = extra.mid!;
      const unsupported = {
        type: "offer" as const,
        sdp: withOnlyUnsupportedCodec(offer.sdp, mid),
      };
      await step(session, () => offerer().pc.setLocalDescription(offer));

      // Act: 同じ remote offer を二重に適用する。
      await step(session, () =>
        answerer().pc.setRemoteDescription(unsupported),
      );
      const transceivers = answerer().pc.getTransceivers();
      await step(session, () =>
        answerer().pc.setRemoteDescription(unsupported),
      );
      // Assert: 二重適用で transceiver は増えず、pending 中は何も止まらず通信も続く。
      expect(answerer().pc.getTransceivers()).toEqual(transceivers);
      const rejecting = answerer()
        .pc.getTransceivers()
        .find((t) => t.mid === mid)!;
      expect(rejecting.stopped).toBe(false);
      expect(extra.stopped).toBe(false);
      await expectSessionAlive(session, "unsupported-pending");

      // Act: port 0 を含む answer を作り、pranswer を二重に適用してから確定する。
      const answer = (await answerer().pc.createAnswer()).sdp;
      expect(sectionOf(answer, mid)).toMatch(/^m=video 0 /);
      for (let i = 0; i < 2; i++) {
        await step(session, () =>
          answerer().pc.setLocalDescription({ type: "pranswer", sdp: answer }),
        );
        await step(session, () =>
          offerer().pc.setRemoteDescription({ type: "pranswer", sdp: answer }),
        );
      }
      // Assert: pranswer 中も拒否予定の m-line は止まらない。
      expect(rejecting.stopped).toBe(false);
      expect(extra.stopped).toBe(false);
      await step(session, () =>
        answerer().pc.setLocalDescription({ type: "answer", sdp: answer }),
      );
      await step(session, () =>
        offerer().pc.setRemoteDescription({ type: "answer", sdp: answer }),
      );

      // Assert: commit で拒否予定の m-line だけが両側で停止し、既存 session は通じる。
      expect(rejecting.stopped).toBe(true);
      expect(extra.stopped).toBe(true);
      expect(offerer().video.stopped).toBe(false);
      expect(answerer().video.stopped).toBe(false);
      await expectSessionAlive(session, "unsupported-committed");
    });
  },
);

/** #142 fixture with its BUNDLE group written in the answerer's own MIDs. */
const issue142Answer = `v=0
o=- 0 2 IN IP4 127.0.0.1
s=-
t=0 0
a=group:BUNDLE 0_srtp 2_sctp 1_srtp
a=msid-semantic: WMS 13945094204333313074/3212739396 virtual-6666
a=ice-lite
m=audio 19305 UDP/TLS/RTP/SAVPF 96
c=IN IP4 <redacted>
a=rtcp:9 IN IP4 0.0.0.0
a=candidate: 1 udp 2113939711 2607:f8b0:400e:c03::7f 19305 typ host generation 0
a=candidate: 1 tcp 2113939710 2607:f8b0:400e:c03::7f 19305 typ host tcptype passive generation 0
a=candidate: 1 ssltcp 2113939709 2607:f8b0:400e:c03::7f 443 typ host generation 0
a=candidate: 1 udp 2113932031 74.125.197.127 19305 typ host generation 0
a=candidate: 1 tcp 2113932030 74.125.197.127 19305 typ host tcptype passive generation 0
a=candidate: 1 ssltcp 2113932029 74.125.197.127 443 typ host generation 0
a=ice-ufrag:KFPTBCP4YKPZTY1Q
a=ice-pwd:VA0L9MQMWS8IYO9NJF+ITE++
a=fingerprint:sha-256 92:D6:06:D6:CB:64:B4:EF:47:76:00:F7:48:E0:ED:DD:9F:3E:DA:16:41:49:47:43:E0:77:DD:C6:D7:83:7E:19
a=setup:passive
a=mid:0_srtp
a=sendrecv
a=msid:virtual-6666 virtual-6666
a=rtcp-mux
a=rtpmap:96 opus/48000/2
a=fmtp:96 minptime=10;useinbandfec=1
a=ssrc:6666 cname:6666
m=video 9 UDP/TLS/RTP/SAVPF 97
c=IN IP4 0.0.0.0
a=rtcp:9 IN IP4 0.0.0.0
a=ice-ufrag:KFPTBCP4YKPZTY1Q
a=ice-pwd:VA0L9MQMWS8IYO9NJF+ITE++
a=fingerprint:sha-256 92:D6:06:D6:CB:64:B4:EF:47:76:00:F7:48:E0:ED:DD:9F:3E:DA:16:41:49:47:43:E0:77:DD:C6:D7:83:7E:19
a=setup:passive
a=mid:1_srtp
a=sendrecv
a=msid:13945094204333313074/3212739396 13945094204333313074/3212739396
a=rtcp-mux
a=rtpmap:97 VP8/90000
a=rtcp-fb:97 ccm fir
a=rtcp-fb:97 nack
a=rtcp-fb:97 nack pli
a=rtcp-fb:97 goog-remb
a=ssrc:3212739396 cname:3212739396
m=application 9 DTLS/SCTP 5000
c=IN IP4 0.0.0.0
a=ice-ufrag:KFPTBCP4YKPZTY1Q
a=ice-pwd:VA0L9MQMWS8IYO9NJF+ITE++
a=fingerprint:sha-256 92:D6:06:D6:CB:64:B4:EF:47:76:00:F7:48:E0:ED:DD:9F:3E:DA:16:41:49:47:43:E0:77:DD:C6:D7:83:7E:19
a=setup:passive
a=mid:2_sctp
a=sctpmap:5000 webrtc-datachannel 1024
`;
