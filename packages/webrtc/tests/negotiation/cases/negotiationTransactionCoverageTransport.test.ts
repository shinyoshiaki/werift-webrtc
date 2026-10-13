import { SCTP_STATE } from "../../../../sctp/src";
import {
  MediaStreamTrack,
  RTCPeerConnection,
  type RTCRtpTransceiver,
} from "../../../src";
import {
  REMOTE_UFRAG,
  type RemoteSection,
  answerRemoteOffer,
  buildRemoteSdp,
  bundleGroups,
  createAudioOnlyPeer,
  expectTransportsMatchBundle,
} from "../../issue/705.helpers";
import { describeCases, negotiationCase } from "../harness/negotiationCase";
import {
  assertTransportsClosed,
  closeDuringNextPreparedGather,
  createConnectedMultiVideoPeers,
  createDirectedDuplexSession,
  createDuplexSession,
  createInitialPranswerConnectionWithOffer,
  createMutationSession,
  createRewrittenOffer,
  expectMediaAlive,
  heldTransports,
  holdNewDtlsStart,
  leaveBundle,
  mungeSection,
  mutate,
  prepareMutationAnswerer,
  reverseSetupRole,
  sdpCandidates,
  sectionOf,
  sendAndExpectRtp,
  trickleCandidate,
  waitForDtlsConnected,
  waitForMutationSession,
  waitForPeersConnected,
  withIceCredentials,
  withOnlyUnsupportedCodec,
} from "../harness/negotiationTransactionUtils";

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

/** The receiver the router of `pc` routes the remote SSRC `ssrc` to. */
const routedReceiver = (pc: RTCPeerConnection, ssrc: number) =>
  (pc as unknown as { router: { ssrcTable: Record<number, unknown> } }).router
    .ssrcTable[ssrc];

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

const BOGUS_FINGERPRINT = Array(32).fill("AB").join(":");

/**
 * Spec coverage for the pranswer lifecycle, DTLS, BUNDLE and signaling
 * transitions of TICKET-ticket-0ad06d37 (§2.2, §2.4, §2.5, §2.8, §2.9, §5).
 * The requirement ID leads each test name. Video is MID "0" and the
 * application MID "1" in a duplex or mutation session.
 */
describeCases("negotiation transaction spec coverage: transport", () => {
  negotiationCase(
    "[2.2-8] a replacement pranswer's DTLS fingerprint and role take effect on a new association that has not started",
    { ref: "2.2-8" },
    async (c) => {
      // Arrange: 確立済み session で、新しい audio を BUNDLE 外に出す re-offer (新しい DTLS association) を両側に置き、offerer の新 transport の DTLS 開始を止める。
      const { a, b, aVideo } = await c.given(createDuplexSession());
      const audioOut = new MediaStreamTrack({ kind: "audio" });
      const audio = a.addTransceiver(audioOut, { direction: "sendonly" });
      await c.setLocal(
        a,
        await createRewrittenOffer(a, (sdp) => leaveBundle(sdp, audio.mid!)),
      );
      const mid = audio.mid!;
      const hold = holdNewDtlsStart(a);
      await c.setRemote(b, a.localDescription);
      const answer = await b.createAnswer();
      const shared = aVideo.dtlsTransport;
      const [sharedRole, sharedFingerprint] = [
        shared.role,
        remoteFingerprint(shared),
      ];
      const realFingerprint = /^a=fingerprint:\S+ (\S+)/m.exec(
        sectionOf(answer.sdp, mid),
      )![1];
      // Arrange: 1 回目は新 association の fingerprint と a=setup だけを変えた pranswer。
      const first = mungeSection(answer.sdp, mid, (section) =>
        reverseSetupRole(section).replace(
          /^a=fingerprint:(\S+) \S+/m,
          `a=fingerprint:$1 ${BOGUS_FINGERPRINT}`,
        ),
      );
      const newTransport = () =>
        [...heldTransports(a)].find(
          (t) => t !== shared && t.state !== "closed",
        )!;

      // Act: 1 回目の pranswer を両側に適用する。
      await c.setLocal(b, answer, { type: "pranswer" });
      await c.setRemote(a, first, { type: "pranswer" });

      // Assert: 未接続の新 association は 1 回目の pranswer の fingerprint / role になる。
      expect(hold.held.length).toEqual(1);
      expect(remoteFingerprint(newTransport())).toEqual(BOGUS_FINGERPRINT);
      expect(newTransport().role).toEqual("client");

      // Act: 正しい fingerprint と a=setup の replacement pranswer を適用する。
      await c.setRemote(a, answer, { type: "pranswer" });

      // Assert: 新 association は最新の pranswer の値に置き換わり、既存 association は変わらない。
      expect(remoteFingerprint(newTransport())).toEqual(realFingerprint);
      expect(newTransport().role).toEqual("server");
      expect([shared.role, remoteFingerprint(shared)]).toEqual([
        sharedRole,
        sharedFingerprint,
      ]);

      // Act: DTLS の開始を許し、新 association の接続を待つ。
      hold.release();
      const remoteAudio = b.getTransceivers().find((t) => t.mid === mid)!;
      await waitForPeersConnected(a, b);
      await Promise.all([
        waitForDtlsConnected(newTransport()),
        waitForDtlsConnected(remoteAudio.dtlsTransport),
      ]);

      // Assert: 最新の pranswer の値で接続し、新しい audio の RTP と既存 session が通じる。
      expect(b.signalingState).toEqual("have-local-pranswer");
      await c.rtp(audioOut, remoteAudio.receiver.track);
      await c.alive();
    },
  );

  negotiationCase(
    "[2.2-8] a replacement pranswer that adds BUNDLE detaches the transports a no-BUNDLE pranswer used and stops their checks",
    { ref: "2.2-8" },
    async (c) => {
      // Arrange: 初回交渉で、BUNDLE なしの pranswer を offerer に適用する。
      const { a, b, session, aVideo } = await c.given(
        createMutationSession("initial"),
      );
      await c.offer(a);
      await prepareMutationAnswerer(session);
      const answer = await b.createAnswer();
      await c.setLocal(b, answer, { type: "pranswer" });
      await c.setRemote(a, mutate(answer.sdp, ["noBundle"]), {
        type: "pranswer",
      });
      const unbundled = [...a.dtlsTransports];
      expect(unbundled.length).toBeGreaterThan(1);

      // Act: BUNDLE を受理した replacement pranswer を適用する。
      await c.setRemote(a, answer, { type: "pranswer" });

      // Assert: 全 m-line が tag の transport を共有し、旧 pranswer だけが使った transport は外れて、その暫定の ICE checks は止まる (new か closed)。
      const detached = unbundled.filter((t) => !a.dtlsTransports.includes(t));
      expect(a.sctpTransport!.dtlsTransport).toBe(aVideo.dtlsTransport);
      expect(detached.length).toBeGreaterThan(0);
      expect(
        detached.filter(
          (t) =>
            t.iceTransport.state !== "new" && t.iceTransport.state !== "closed",
        ),
      ).toEqual([]);

      // Assert: final answer 前の最新 topology で RTP と DataChannel が通じる。
      await waitForMutationSession(session);
      expect(a.signalingState).toEqual("have-remote-pranswer");
      await c.alive();

      // Act: final answer で確定する。
      await c.setLocal(b, answer);
      await c.setRemote(a, answer);

      // Assert: 確定後も同じ topology で通じる。
      await c.alive();
    },
  );

  negotiationCase(
    "[2.2-13] a final answer that rejects the application m-line keeps the SCTP association a first pranswer opened, as develop does",
    { ref: "2.2-13 2.11-2; origin: develop comparison" },
    async (c) => {
      // Arrange: 初回交渉の pranswer で SCTP association と DataChannel を開く。
      const { a, b, session, aOut, aChannel } = await c.given(
        createMutationSession("initial"),
      );
      await c.offer(a);
      await prepareMutationAnswerer(session);
      const answer = await b.createAnswer();
      await c.setLocal(b, answer, { type: "pranswer" });
      await c.setRemote(a, answer, { type: "pranswer" });
      await waitForMutationSession(session);
      const provisional = a.sctpTransport!;
      expect(provisional.sctp.associationState).toEqual(SCTP_STATE.ESTABLISHED);
      const rejected = leaveBundle(
        mungeSection(answer.sdp, "1", (s) =>
          s.replace(/^m=application \d+/m, "m=application 0"),
        ),
        "1",
      );

      // Act: application m-line を port 0 で拒否した final answer を offerer に適用する。
      await c.setLocal(b, answer);
      await c.setRemote(a, rejected);

      // Assert: develop と同じく SCTP transport と DataChannel は閉じず、同じ MID に束縛されたまま。
      expect(a.sctpTransport).toBe(provisional);
      expect(provisional.mid).toEqual("1");
      expect(provisional.sctp.associationState).toEqual(SCTP_STATE.ESTABLISHED);
      expect(aChannel.readyState).toEqual("open");

      // Assert: 受理された video は確定した transport で届き続ける。
      await c.rtp(aOut, session.b.video.receiver.track);

      // Assert: 次の offer は同じ MID の application を再提案する (その後の通信は harness の継続確認)。
      const next = await a.createOffer();
      expect(sectionOf(next.sdp, "1")).toMatch(/^m=application [1-9]/);
    },
  );

  negotiationCase(
    "[2.2-13] the candidates of a pranswer generation the final answer replaced leave the live checklist",
    { ref: "2.2-13" },
    async (c) => {
      // Arrange: 初回交渉で、final answer と別の ICE generation の候補を持つ pranswer を offerer に適用する。
      const { a, b, session } = await c.given(createMutationSession("initial"));
      await c.offer(a);
      await prepareMutationAnswerer(session);
      const answer = await b.createAnswer();
      const ufrag = attribute(answer.sdp, "0", "ice-ufrag");
      // Arrange: pranswer は別の (provisional) ICE generation とその候補 (port 50991) を伝える。
      const extra = trickleCandidate(50991, "prov", "0").candidate;
      const provisional = withIceCredentials(
        answer.sdp,
        "prov",
        "provisionalpasswordprovisional",
      ).replace(/ ufrag \S+/g, " ufrag prov");
      const pranswer = mungeSection(provisional, "0", (s) =>
        s.replace(/^(a=ice-pwd:[^\r\n]+\r\n)/m, `$1a=${extra}\r\n`),
      );
      const connection = a.iceTransports[0].connection;
      await c.setLocal(b, answer, { type: "pranswer" });
      await c.setRemote(a, pranswer, { type: "pranswer" });
      await c.waitFor(() =>
        connection.remoteCandidates.some((c) => c.port === 50991),
      );

      // Act: その候補を含まない final answer で確定する。
      await c.setLocal(b, answer);
      await c.setRemote(a, answer);

      // Assert: final answer の generation に切り替わり、pranswer だけが伝えた候補は live checklist と current SDP から外れる。
      const live = a.iceTransports[0].connection;
      expect(live.remoteUsername).toEqual(ufrag);
      expect(live.remoteCandidates.some((c) => c.port === 50991)).toEqual(
        false,
      );
      expect(
        live.checkList.some((pair) => pair.remoteCandidate.port === 50991),
      ).toEqual(false);
      expect(a.currentRemoteDescription!.sdp).not.toContain(" 50991 ");
      await waitForMutationSession(session);
      await expectMediaAlive(session, "pranswer-candidate-released");
    },
  );

  negotiationCase(
    "[2.2-16] rollback stops the RTP a renegotiation pranswer started and keeps the current stream",
    { ref: "2.2-16" },
    async (c) => {
      // Arrange: 確立済み session に新しい audio を足した re-offer を pranswer まで進め、新 audio の RTP が届くことを確かめる。
      const { a, b } = await c.given(createDuplexSession());
      const audioOut = new MediaStreamTrack({ kind: "audio" });
      const audio = a.addTransceiver(audioOut, { direction: "sendonly" });
      await c.offer(a);
      await c.pranswer(b);
      const remoteAudio = b.getTransceivers().find((t) => t.mid === audio.mid)!;
      const [audioTrack, audioSsrc] = [
        remoteAudio.receiver.track,
        audio.sender.ssrc,
      ];
      await c.rtp(audioOut, audioTrack);
      expect(routedReceiver(b, audioSsrc)).toBe(remoteAudio.receiver);

      // Act: 両側で rollback する。
      await c.rollback(a);

      // Assert: 新 audio の RTP は届かなくなり、受信側 router にその SSRC は残らない。
      await c.rejects(
        () => sendAndExpectRtp(audioOut, audioTrack, "rolled-back-audio"),
        "RTP was not received",
      );
      expect(routedReceiver(b, audioSsrc)).toBe(undefined);

      // Assert: 旧 current の video と DataChannel は双方向に届き続ける。
      await c.alive();
    },
  );

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

  negotiationCase(
    "[2.8-20] a first answer's own MIDs are read as the offered MIDs in BUNDLE, and a later answer must match exactly",
    {
      ref: "2.8-20",
      exempt: "no real remote peer (a hand-written remote answer)",
      explicitInvariants: true,
    },
    async (c) => {
      // Arrange: #142 の fixture を、BUNDLE も answer 側の独自 MID で書いた版にする (fixture の payload type は offer と異なるので invariant は検査しない)。
      const a = c.peer(new RTCPeerConnection(), "a");
      a.addTrack(new MediaStreamTrack({ kind: "audio" }));
      a.addTrack(new MediaStreamTrack({ kind: "video" }));
      a.createDataChannel("dc");
      await c.offer(a, { hold: true });

      // Act: 初回 answer として適用する。
      await c.setRemote(a, issue142Answer);

      // Assert: 受理され、MID と BUNDLE の項目が offer の MID に読み替えられて transport を共有する。
      expect(a.signalingState).toEqual("stable");
      expect(a.getTransceivers().map((t) => t.mid)).toEqual(["0", "1"]);
      expect(bundleGroups(a.currentRemoteDescription!.sdp)).toEqual([
        ["0", "2", "1"],
      ]);
      const [audio, video] = a.getTransceivers();
      expect(video.dtlsTransport).toBe(audio.dtlsTransport);
      expect(a.sctpTransport!.dtlsTransport).toBe(audio.dtlsTransport);
      expect(a.dtlsTransports.length).toEqual(1);

      // Act: 再交渉で、同じ独自 MID の answer を適用する。session 確立後は MID の不一致を拒否し、状態は変わらない。
      await c.offer(a, { hold: true });
      await c.setRemote(a, issue142Answer, {
        rejects: "InvalidModificationError",
      });

      // Assert: pending offer のまま残る。
      expect(a.signalingState).toEqual("have-local-offer");
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

  negotiationCase(
    "[2.8-47] an actpass answer makes a new association the DTLS client",
    { ref: "2.8-47" },
    async (c) => {
      // Arrange: 初回 offer (actpass) と、全 m-line を a=setup:actpass にした remote answer。
      const { a, b, session } = await c.given(createMutationSession("initial"));
      await c.offer(a, { hold: true });
      expect(a.localDescription!.sdp).toMatch(/^a=setup:actpass/m);
      await c.setRemote(b, a.localDescription);
      await prepareMutationAnswerer(session);
      await c.answer(b, { hold: true });

      // Act: actpass の answer を適用する。
      await c.setRemote(a, mutate(b.localDescription!.sdp, ["setupActpass"]), {
        type: "answer",
      });

      // Assert: 受理され、新しい association の role は client になる。
      expect(a.signalingState).toEqual("stable");
      expect(a.dtlsTransports.map((t) => t.role)).toEqual(
        a.dtlsTransports.map(() => "client"),
      );
    },
  );

  negotiationCase(
    "[2.9-T8] the same offer replaces a pranswer a first negotiation connected and the final answer reconnects",
    { ref: "2.9-T8" },
    async (c) => {
      // Arrange: 初回交渉の pranswer で ICE / DTLS を接続した peer。
      const { a, b, offer } = await c.given(
        createInitialPranswerConnectionWithOffer(),
      );
      const out = a.getTransceivers()[0].sender.track!;

      // Act: 最後に作った同じ offer を offerer に再適用する。
      await c.setLocal(a, offer);

      // Assert: remote pranswer は先に rollback され、offerer は have-local-offer に戻る。
      expect(a.signalingState).toEqual("have-local-offer");
      expect(a.pendingRemoteDescription).toBe(null);
      expect(a.currentRemoteDescription).toBe(null);

      // Act: answerer に offer を渡し、final answer で確定する。
      await c.setRemote(b, a.localDescription);
      const received = b.getTransceivers()[0];
      await received.sender.replaceTrack(
        new MediaStreamTrack({ kind: "video" }),
      );
      await c.answer(b);

      // Assert: final answer で接続し直し、RTP が届く。
      await waitForPeersConnected(a, b);
      expect(a.signalingState).toEqual("stable");
      await c.rtp(out, received.receiver.track);
    },
  );

  negotiationCase(
    "[5-11] staged topology, candidate delivery, DTLS role and the answer's tags apply to the second BUNDLE group",
    {
      ref: "5-11",
      exempt: "no real remote peer (hand-written remote offers)",
    },
    async (c) => {
      // Arrange: [0,1] と [2,3] の 2 つの BUNDLE group を確立した answerer。
      const a = c.peer(createAudioOnlyPeer(), "a");
      const sections = (ufrag: string): RemoteSection[] => [
        { kind: "audio", mid: "0" },
        { kind: "audio", mid: "1" },
        { kind: "audio", mid: "2", ufrag: "groupbufrag" },
        { kind: "audio", mid: "3", ufrag },
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
      await answerRemoteOffer(a, twoGroups);
      const [t0, t1, t2, t3] = a.getTransceivers();
      const [groupA, groupB] = [t0.dtlsTransport, t2.dtlsTransport];
      expect(t3.dtlsTransport).toBe(groupB);
      expect(groupB).not.toBe(groupA);

      // Act: 2 つ目の group だけを分割する re-offer を適用する。
      await c.setRemote(a, splitSecond);

      // Assert: pending 中は 2 つ目の group の共有 transport と remote 資格情報が変わらない。
      expect([t0, t1, t2, t3].map((t) => t.dtlsTransport)).toEqual([
        groupA,
        groupA,
        groupB,
        groupB,
      ]);
      expect(groupB.iceTransport.connection.remoteUsername).toEqual(
        "groupbufrag",
      );

      // Act: rollback し、2 つ目の group の非 tag m-line (3) に候補と EOC を trickle する。
      await c.setRemote(a, "rollback");
      await c.addCandidate(a, trickleCandidate(50993, "groupbufrag", "3"));
      await c.addCandidate(a, {
        candidate: "",
        sdpMid: "3",
        usernameFragment: "groupbufrag",
      });

      // Assert: 候補と EOC はその group の transport にだけ届く。
      await c.waitFor(() =>
        groupB.iceTransport.connection.remoteCandidates.some(
          (c) => c.port === 50993,
        ),
      );
      await c.waitFor(() => groupB.iceTransport.connection.remoteCandidatesEnd);
      expect(
        groupA.iceTransport.connection.remoteCandidates.some(
          (c) => c.port === 50993,
        ),
      ).toEqual(false);
      expect(groupA.iceTransport.connection.remoteCandidatesEnd).toEqual(false);
      expect(groupA.iceTransport.connection.remoteUsername).toEqual(
        REMOTE_UFRAG,
      );

      // Act: 2 つ目の group を分割する re-offer に answer して確定する。
      const answer = await answerRemoteOffer(a, splitSecond);

      // Assert: answer の group と tag は offer と一致し、分割した m-line だけが新しい transport に移る。
      expect(bundleGroups(answer)).toEqual([["0", "1"], ["2"], ["3"]]);
      expectTransportsMatchBundle(a);
      expect(t2.dtlsTransport).toBe(groupB);
      expect(t3.dtlsTransport).not.toBe(groupB);
      expect(t3.dtlsTransport).not.toBe(groupA);
      expect([t0.dtlsTransport, t1.dtlsTransport]).toEqual([groupA, groupA]);
      c.invariants(a);
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
    () => {
      negotiationCase(
        "[2.5-T3] an answer to an m-line outside the BUNDLE group offered with a=setup:active is passive",
        { ref: "2.5-T3" },
        async (c) => {
          // Arrange: 新しい audio を BUNDLE 外に出した offer を作り、answerer に届く remote offer ではその m-line だけ a=setup:active にする。
          const { a, b, aVideo, bVideo } = await c.given(
            createDirectedDuplexSession(from),
          );
          const audioOut = new MediaStreamTrack({ kind: "audio" });
          const audio = a.addTransceiver(audioOut, { direction: "sendonly" });
          const offer = await createRewrittenOffer(a, (sdp) =>
            leaveBundle(sdp, audio.mid!),
          );
          const mid = audio.mid!;
          const roles = [aVideo.dtlsTransport.role, bVideo.dtlsTransport.role];
          await c.setLocal(a, offer);
          const remoteOffer = mungeSection(a.localDescription!.sdp, mid, (s) =>
            s.replace(/^a=setup:\w+/m, "a=setup:active"),
          );
          expect(attribute(remoteOffer, mid, "setup")).toEqual("active");
          await c.setRemote(b, remoteOffer);

          // Act: answer を作る。
          const answer = await b.createAnswer();

          // Assert: group 外の m-line は offer の逆の passive で答え、group は従来の role のまま。
          expect(attribute(answer.sdp, mid, "setup")).toEqual("passive");
          expect(attribute(answer.sdp, "0", "setup")).toEqual(
            bVideo.dtlsTransport.role === "client" ? "active" : "passive",
          );

          // Act: answer で確定する。
          await c.setLocal(b, answer);
          await c.setRemote(a, answer);
          const remoteAudio = b.getTransceivers().find((t) => t.mid === mid)!;

          // Assert: 独立 transport の role は answerer が server、offerer が client。
          expect(remoteAudio.dtlsTransport).not.toBe(bVideo.dtlsTransport);
          expect(remoteAudio.dtlsTransport.role).toEqual("server");
          expect(audio.dtlsTransport.role).toEqual("client");
          expect([
            aVideo.dtlsTransport.role,
            bVideo.dtlsTransport.role,
          ]).toEqual(roles);

          // Assert: 独立 transport で接続し、audio と既存 session が通じる。
          await Promise.all([
            waitForDtlsConnected(audio.dtlsTransport),
            waitForDtlsConnected(remoteAudio.dtlsTransport),
          ]);
          await c.rtp(audioOut, remoteAudio.receiver.track);
          await c.alive();
        },
      );

      negotiationCase(
        "[5-2] an m-line without a common codec, its port 0 answer and duplicate applications keep the invariants",
        { ref: "5-2" },
        async (c) => {
          // Arrange: 新しい video m-line を足した re-offer を作り、wire 上でその m-line を共通 codec のない提案にする。
          const { a, b, aVideo, bVideo } = await c.given(
            createDirectedDuplexSession(from),
          );
          const extra = a.addTransceiver(
            new MediaStreamTrack({ kind: "video" }),
            { direction: "sendonly" },
          );
          const offer = await a.createOffer();
          const mid = extra.mid!;
          const unsupported = {
            type: "offer",
            sdp: withOnlyUnsupportedCodec(offer.sdp, mid),
          };
          await c.setLocal(a, offer);

          // Act: 同じ remote offer を二重に適用する。
          await c.setRemote(b, unsupported);
          const transceivers = b.getTransceivers();
          await c.setRemote(b, unsupported);

          // Assert: 二重適用で transceiver は増えず、pending 中は何も止まらず通信も続く。
          expect(b.getTransceivers()).toEqual(transceivers);
          const rejecting = b.getTransceivers().find((t) => t.mid === mid)!;
          expect([rejecting.stopped, extra.stopped]).toEqual([false, false]);
          await c.alive();

          // Act: port 0 を含む answer を作り、pranswer を二重に適用してから確定する。
          const answer = await b.createAnswer();
          expect(sectionOf(answer.sdp, mid)).toMatch(/^m=video 0 /);
          await c.setLocal(b, answer, { type: "pranswer" });
          await c.setRemote(a, answer, { type: "pranswer" });
          await c.setLocal(b, answer, { type: "pranswer" });
          await c.setRemote(a, answer, { type: "pranswer" });

          // Assert: pranswer 中も拒否予定の m-line は止まらない。
          expect([rejecting.stopped, extra.stopped]).toEqual([false, false]);

          // Act: final answer で確定する。
          await c.setLocal(b, answer);
          await c.setRemote(a, answer);

          // Assert: commit で拒否予定の m-line だけが両側で停止し、既存 session は通じる。
          expect([
            rejecting.stopped,
            extra.stopped,
            aVideo.stopped,
            bVideo.stopped,
          ]).toEqual([true, true, false, false]);
          await c.alive();
        },
      );
    },
  );
}
