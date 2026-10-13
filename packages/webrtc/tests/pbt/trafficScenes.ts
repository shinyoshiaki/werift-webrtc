import { SCTP_STATE } from "../../../sctp/src";
import {
  MediaStream,
  MediaStreamTrack,
  type RTCDataChannel,
  type RTCIceCandidate,
  type RTCPeerConnection,
  useAbsSendTime,
} from "../../src";
import { ANSWER_OR_ROLLBACK } from "../negotiation/harness/negotiationCase";
import {
  type NegotiationEvents,
  addNegotiatedAudio,
  assertTransportsClosed,
  createBundledIceRestartPranswer,
  createConnectedMultiVideoPeers,
  createConnectedSendParamPeers,
  createConnectedVideoPeers,
  createConnectedVideoPeersWithRtx,
  createDirectedDuplexSession,
  createDuplexSession,
  createH264OnlyReoffer,
  createInitialPranswerConnectionWithOffer,
  createInitialPranswerDataChannel,
  createKeptRemoteTransceiver,
  createMutationSession,
  createPeerPair,
  createRewrittenOffer,
  createSplitOffer,
  createTwccH264OnlyReoffer,
  createUnnegotiatedPeers,
  createUnnegotiatedVideoPeers,
  createVp8RtxSessionWithH264Reoffer,
  elapsedMs,
  expectDataAlive,
  heldTransports,
  keepOnlyRtx,
  leaveBundle,
  mungeSection,
  mutate,
  negotiateAndExpectChannel,
  offeredVideoCodecs,
  payloadTypeOf,
  prepareMutationAnswerer,
  provisionalIce,
  receiveCodecNames,
  receivingMid,
  recordNegotiationEvents,
  sectionOf,
  sendAndExpectRtp,
  ssrcOf,
  trickleCandidate,
  twccFeedbackSent,
  ufragOf,
  waitForCommittedNomination,
  waitForDtlsConnected,
  waitForMutationSession,
  waitForPeersConnected,
  waitForProvisionalNomination,
  withBundle,
  withOnlyUnsupportedCodec,
  withRtcpFeedback,
  withoutCodecs,
  withoutEoc,
  withoutExtmap,
  withoutNack,
} from "../negotiation/harness/negotiationTransactionUtils";
import { trafficScene } from "./trafficPropertyUtils";

/** The first host candidate of `sdp` moved to `port` (foundation suffix: the last digit of `port`). */
const hostCandidate = (sdp: string, port: number, ufrag?: string) => {
  const [, foundation, rest] = sdp.match(
    /^a=candidate:(\S+) (\d+ \S+ \d+ \S+) \d+ typ host/m,
  )!;
  const candidate = `candidate:${foundation}${port % 10} ${rest} ${port} typ host`;
  return ufrag ? `${candidate} ufrag ${ufrag}` : candidate;
};

const eocCount = (sdp: string) =>
  sdp.match(/^a=end-of-candidates/gm)?.length ?? 0;

/** The MIDs of the BUNDLE group (the first one is the tag). */
const bundleMids = (sdp: string) =>
  sdp
    .match(/^a=group:BUNDLE (.*?)\r?$/m)![1]
    .trim()
    .split(" ");

/** The SDP with `hostCandidate(sdp, port)` added after its first host candidate. */
const withHostCandidate = (sdp: string, port: number) => {
  const [line] = sdp.match(
    /^a=candidate:\S+ \d+ \S+ \d+ \S+ \d+ typ host.*$/m,
  )!;
  return sdp.replace(line, `${line}\r\na=${hostCandidate(sdp, port)}`);
};

/** Remote candidates on `port` in the live checklist of the first ICE transport. */
const liveCandidates = (pc: RTCPeerConnection, port: number) =>
  pc.iceTransports[0].connection.remoteCandidates.filter((c) => c.port === port)
    .length;

/** The receiver the router of `pc` routes the remote SSRC `ssrc` to. */
const routedReceiver = (pc: RTCPeerConnection, ssrc: number) =>
  (pc as unknown as { router: { ssrcTable: Record<number, unknown> } }).router
    .ssrcTable[ssrc];

/**
 * Fixed scenes of the traffic property: the deterministic cases whose verdict
 * includes real traffic and that need no special environment, moved from
 * tests/negotiation/cases (same names). Each runs with `traffic: true`: the
 * property is checked after every description operation and after the body;
 * the scene keeps its own expectations.
 */
export function trafficScenes() {
  // negotiationTransaction.test.ts
  describe("negotiation transaction", () => {
    trafficScene(
      "rollback preserves application stop and a new trackless transceiver",
      { ref: "2.5-15" },
      async (c) => {
        // Arrange: 音声を追加で交渉し、re-offer を b に pending で適用する。
        const { a, b, session } = await c.given(createDuplexSession());
        const audio = await addNegotiatedAudio(session, session.a, session.b);
        const existing = audio.remote();
        const currentRemote = b.currentRemoteDescription!.sdp;
        await c.offer(a);

        // Act: pending 中にアプリが停止と track のない transceiver 追加を行い、rollback する。
        existing.stop();
        const added = b.addTransceiver("audio", { direction: "recvonly" });
        await c.setRemote(b, "rollback");

        // Assert: SDP 由来の状態だけが戻り、アプリ操作 (stop / 追加) は残る。
        for (const item of [existing, added])
          expect(b.getTransceivers()).toContain(item);
        expect(added).toMatchObject({ mid: null, sender: { track: null } });
        expect(b.currentRemoteDescription!.sdp).toEqual(currentRemote);

        // Assert: stop() で解放した pipeline は rollback でも再開しない。
        expect(existing).toMatchObject({
          stopping: true,
          receiver: { stopped: true, track: { readyState: "ended" } },
        });

        // Assert: 停止していない video と DataChannel は両方向で通信を続ける。
        await c.alive();
      },
    );

    trafficScene.for([
      {
        when: "in have-local-offer",
        kind: "local-offer",
        creator: "a",
        peer: "b",
      },
      {
        when: "in have-remote-offer",
        kind: "remote-offer",
        creator: "b",
        peer: "a",
      },
      {
        when: "between createOffer and setting that older offer",
        kind: "stale-offer",
        creator: "a",
        peer: "b",
      },
    ] as const)(
      "rollback keeps a DataChannel created $when and the next negotiation opens it",
      { ref: "2.3-15 2.3-17 2.3-18" },
      async (c, { when, kind, creator, peer }) => {
        // Arrange: m=application を含まない初回 offer で transaction を開き、その途中で DataChannel を作る。
        const { a, b, outgoing, incoming } = await c.given(
          createUnnegotiatedVideoPeers(),
        );
        let channel: RTCDataChannel;
        if (kind === "stale-offer") {
          const staleOffer = await a.createOffer();
          channel = a.createDataChannel(kind);
          await c.setLocal(a, staleOffer);
        } else {
          await c.offer(a, { hold: true });
          if (kind === "remote-offer") await c.setRemote(b, a.localDescription);
          channel = c.named(creator).createDataChannel(kind);
        }

        // Act: application の createDataChannel を挟んだ transaction を rollback する。
        await c.rollback(a);

        // Assert: SCTP transport は止まらず、未交渉 (MID/remote port なし) で残る。
        expect(c.named(creator).signalingState).toEqual("stable");
        expect(c.named(creator).sctpTransport).toBe(channel.sctp);
        expect(channel.readyState).toEqual("connecting");

        // Act: 作成側から改めて交渉する。
        if (creator === "b") b.addTransceiver("video");
        const received = await negotiateAndExpectChannel(
          c.named(creator),
          c.named(peer),
          channel,
        );

        // Assert: channel が開いて両方向に届き、交渉済みの RTP も届く。
        await c.data(received, channel);
        if (creator === "a") await c.rtp(outgoing, incoming());
      },
    );

    trafficScene(
      "an answer whose RTX has no associated codec is rejected before mutation",
      { ref: "2.5-4" },
      async (c) => {
        // Arrange: re-offer に対し、VP8 を落として RTX だけを残した answer を作る。
        const { a, b, outgoing, incoming } = await c.given(
          createConnectedVideoPeersWithRtx(),
        );
        await c.offer(a);
        await c.answer(b, { hold: true });

        // Act: apt の指す codec がない answer を適用する。共通 codec のない非ゼロ port の answer は InvalidAccessError (issue 705 と同じ規則) で、pending offer・current は変わらない。
        await c.setRemote(a, keepOnlyRtx(b.localDescription!.sdp), {
          rejects: "InvalidAccessError",
        });

        // Assert: 事前検証で拒否され、RTP は変わらず届く。
        expect(a.signalingState).toEqual("have-local-offer");
        await c.rtp(outgoing, incoming);

        // Act: 正しい answer を適用する。
        await c.setRemote(a, b.localDescription);

        // Assert: 交渉が完了し RTP も継続する。
        expect(a.signalingState).toEqual("stable");
        await c.rtp(outgoing, incoming);
      },
    );

    trafficScene(
      "a trickle candidate of the unchanged ICE generation reaches the live checklist during a re-offer",
      { ref: "origin: same-generation trickle during a re-offer" },
      async (c) => {
        // Arrange: EOC 前の世代のまま ICE restart なしの re-offer を pending にし、同じ ufrag の新しい候補を作る。
        const { a, b, outgoing, incoming } = await c.given(
          createConnectedVideoPeers({}, { trickleOpen: true }),
        );
        await c.offer(a, { hold: true });
        await c.setRemote(b, withoutEoc(a.localDescription!.sdp));
        const offer = a.localDescription!.sdp;
        const candidate = {
          candidate: hostCandidate(offer, 40999),
          sdpMid: offer.match(/^a=mid:(.*?)\r?$/m)![1],
          usernameFragment: ufragOf(offer),
        };
        expect(liveCandidates(b, 40999)).toEqual(0);

        // Act: 同じ候補を 2 回 trickle する。
        await c.addCandidate(b, candidate);
        await c.addCandidate(b, candidate);

        // Assert: pending と current の両 SDP に記録され、稼働中 checklist には 1 回だけ届く。
        expect(b.pendingRemoteDescription!.sdp).toContain(" 40999 typ host");
        expect(b.currentRemoteDescription!.sdp).toContain(" 40999 typ host");
        expect(liveCandidates(b, 40999)).toEqual(1);

        // Act: re-offer を両側で rollback する。
        await c.rollback(b);

        // Assert: 同じ世代の候補は current に残り、既存 RTP も届く。
        expect(b.currentRemoteDescription!.sdp).toContain(" 40999 typ host");
        expect(liveCandidates(b, 40999)).toEqual(1);
        await c.rtp(outgoing, incoming);
      },
    );

    trafficScene(
      "candidates in the body of a same-ufrag re-offer reach the live checklist before the answer",
      { ref: "origin: same-generation candidates in an offer body" },
      async (c) => {
        // Arrange: ICE restart なしの re-offer に、同じ ufrag の新しい候補を SDP 本文で足す (EOC なし)。
        const { a, b, outgoing, incoming } = await c.given(
          createConnectedVideoPeers({}, { trickleOpen: true }),
        );
        await c.offer(a, { hold: true });
        const withCandidate = withHostCandidate(
          withoutEoc(a.localDescription!.sdp),
          40998,
        );
        const connection = b.iceTransports[0].connection;
        expect(liveCandidates(b, 40998)).toEqual(0);

        // Act: 新しい候補を含む re-offer を適用する (answer はまだ返さない)。
        await c.setRemote(b, withCandidate);

        // Assert: 候補は answer 前に稼働中 checklist と current SDP に 1 回だけ入る。
        expect(liveCandidates(b, 40998)).toEqual(1);
        expect(b.currentRemoteDescription!.sdp).toContain(" 40998 typ host");
        expect(connection.remoteCandidatesEnd).toEqual(false);

        // Act: 同じ候補と EOC を含む置換 offer を適用する。
        await c.setRemote(
          b,
          withCandidate.trimEnd() + "\r\na=end-of-candidates\r\n",
        );

        // Assert: 候補は重複せず、同じ世代の EOC も稼働中 generation に届く。
        expect(liveCandidates(b, 40998)).toEqual(1);
        expect(connection.remoteCandidatesEnd).toEqual(true);

        // Act: re-offer を両側で rollback する。
        await c.rollback(b);

        // Assert: 同じ世代の候補は current と checklist に残り、既存 RTP も届く。
        expect(liveCandidates(b, 40998)).toEqual(1);
        expect(b.currentRemoteDescription!.sdp).toContain(" 40998 typ host");
        await c.rtp(outgoing, incoming);
      },
    );

    trafficScene(
      "end-of-candidates on a non-tag BUNDLE m-line completes the shared transport for every m-line",
      { ref: "2.8-28" },
      async (c) => {
        // Arrange: 映像 (tag) と音声 (非 tag) が一つの ICE transport を共有し、EOC 前の世代にある。
        const { a, b, outgoing, incoming } = await c.given(
          createConnectedVideoPeers({}, { trickleOpen: true, withAudio: true }),
        );
        const [tagMid, nonTagMid] = bundleMids(b.currentRemoteDescription!.sdp);
        const connection = b.iceTransports[0].connection;
        expect(b.iceTransports.length).toEqual(1);
        expect(connection.remoteCandidatesEnd).toEqual(false);

        // Act: 非 tag m-line に EOC を trickle する。
        await c.addCandidate(b, { candidate: "", sdpMid: nonTagMid });

        // Assert: 共有 transport が完了し、current SDP の両 m-line が完了扱いになる。
        expect(connection.remoteCandidatesEnd).toEqual(true);
        expect(eocCount(b.currentRemoteDescription!.sdp)).toEqual(2);

        // Act: tag m-line の候補を本文に足した同じ ufrag の re-offer を適用する。
        await c.offer(a, { hold: true });
        const withCandidate = withHostCandidate(
          withoutEoc(a.localDescription!.sdp),
          40997,
        );
        expect(withCandidate.indexOf(" 40997 typ host")).toBeLessThan(
          withCandidate.indexOf("a=mid:" + nonTagMid),
        );
        await c.setRemote(b, withCandidate);

        // Assert: 完了済み transport の候補は current SDP にも checklist にも入らない。
        expect(b.currentRemoteDescription!.sdp).not.toContain(
          " 40997 typ host",
        );
        expect(liveCandidates(b, 40997)).toEqual(0);

        // Act: re-offer を両側で rollback する。
        await c.rollback(b);

        // Assert: current SDP は受け付けていない候補を含まず、既存 RTP が届く。
        expect(b.currentRemoteDescription!.sdp).not.toContain(
          " 40997 typ host",
        );
        expect(tagMid).not.toEqual(nonTagMid);
        await c.rtp(outgoing, incoming);
      },
    );

    trafficScene.for(ANSWER_OR_ROLLBACK)(
      "end-of-candidates trickled on a non-tag m-line during a same-ufrag re-offer stays aligned after $finish",
      { ref: "2.8-30" },
      async (c, { finish }) => {
        // Arrange: EOC 前の世代のまま、ICE restart なしの re-offer を pending にする。
        const { a, b, outgoing, incoming } = await c.given(
          createConnectedVideoPeers({}, { trickleOpen: true, withAudio: true }),
        );
        await c.offer(a, { hold: true });
        await c.setRemote(b, withoutEoc(a.localDescription!.sdp));
        const nonTagMid = bundleMids(b.pendingRemoteDescription!.sdp)[1];
        const connection = b.iceTransports[0].connection;

        // Act: pending 中に非 tag m-line へ EOC を trickle する。
        await c.addCandidate(b, { candidate: "", sdpMid: nonTagMid });

        // Assert: 共有 transport が完了し、pending と current の両 SDP で 2 m-line とも完了扱い。
        expect(connection.remoteCandidatesEnd).toEqual(true);
        expect(eocCount(b.pendingRemoteDescription!.sdp)).toEqual(2);
        expect(eocCount(b.currentRemoteDescription!.sdp)).toEqual(2);

        // Act: answer で確定する、または rollback する。
        await c.finish(b, finish);

        // Assert: 確定した SDP と live transport の EOC 状態が一致し、RTP が届く。
        expect(b.signalingState).toEqual("stable");
        expect(connection.remoteCandidatesEnd).toEqual(true);
        expect(eocCount(b.currentRemoteDescription!.sdp)).toEqual(2);
        await c.rtp(outgoing, incoming);
      },
    );

    trafficScene.for(ANSWER_OR_ROLLBACK)(
      "end-of-candidates in the body of a non-tag m-line of a same-ufrag re-offer ends the shared generation after $finish",
      { ref: "2.8-30" },
      async (c, { finish }) => {
        // Arrange: 非 tag m-line の本文だけに EOC を載せた同じ ufrag の re-offer を作る。
        const { a, b, outgoing, incoming } = await c.given(
          createConnectedVideoPeers({}, { trickleOpen: true, withAudio: true }),
        );
        await c.offer(a, { hold: true });
        const stripped = withoutEoc(a.localDescription!.sdp);
        const offer = mungeSection(
          stripped,
          bundleMids(stripped)[1],
          (section) => section.trimEnd() + "\r\na=end-of-candidates\r\n",
        );
        const connection = b.iceTransports[0].connection;
        expect(eocCount(offer)).toEqual(1);
        expect(connection.remoteCandidatesEnd).toEqual(false);

        // Act: re-offer を適用する (answer はまだ返さない)。
        await c.setRemote(b, offer);

        // Assert: 共有 transport が完了し、current と pending の両 SDP で 2 m-line とも完了扱い。
        expect(connection.remoteCandidatesEnd).toEqual(true);
        expect(eocCount(b.currentRemoteDescription!.sdp)).toEqual(2);
        expect(eocCount(b.pendingRemoteDescription!.sdp)).toEqual(2);

        // Act: answer で確定する、または rollback する。
        await c.finish(b, finish);

        // Assert: 確定した SDP と live transport の EOC 状態が一致し、RTP が届く。
        expect(b.signalingState).toEqual("stable");
        expect(connection.remoteCandidatesEnd).toEqual(true);
        expect(eocCount(b.currentRemoteDescription!.sdp)).toEqual(2);
        await c.rtp(outgoing, incoming);
      },
    );

    trafficScene(
      "a candidate's ufrag in the candidate string routes it to the same generation as the usernameFragment property",
      { ref: "2.3-22" },
      async (c) => {
        // Arrange: ICE restart re-offer で current (旧) と pending (新) の ufrag を併存させる。
        const { a, b, outgoing, incoming } = await c.given(
          createConnectedVideoPeers({}, { trickleOpen: true }),
        );
        const oldUfrag = ufragOf(b.currentRemoteDescription!.sdp);
        await c.offer(a, { iceRestart: true });
        const newUfrag = ufragOf(b.pendingRemoteDescription!.sdp);
        expect(newUfrag).not.toEqual(oldUfrag);
        const current = b.currentRemoteDescription!.sdp;
        const mid = current.match(/^a=mid:(.*?)\r?$/m)![1];

        // Act: 旧 ufrag を候補文字列だけに含める形と、プロパティでも渡す形で追加する。
        await c.addCandidate(b, {
          candidate: hostCandidate(current, 40991, oldUfrag),
          sdpMid: mid,
        });
        await c.addCandidate(b, {
          candidate: hostCandidate(current, 40992, oldUfrag),
          sdpMid: mid,
          usernameFragment: oldUfrag,
        });

        // Assert: どちらも旧世代として current SDP と稼働中 checklist に入り、pending SDP には入らない。
        expect(b.currentRemoteDescription!.sdp).toContain(" 40991 typ host");
        expect(b.pendingRemoteDescription!.sdp).not.toContain(
          " 40991 typ host",
        );
        expect(liveCandidates(b, 40991)).toBeGreaterThan(0);
        expect(b.currentRemoteDescription!.sdp).toContain(" 40992 typ host");
        expect(b.pendingRemoteDescription!.sdp).not.toContain(
          " 40992 typ host",
        );
        expect(liveCandidates(b, 40992)).toBeGreaterThan(0);

        // Act: 候補文字列とプロパティで ufrag が食い違う候補を追加する。拒否され状態は変わらない。
        await c.addCandidate(
          b,
          {
            candidate: hostCandidate(current, 40993, oldUfrag),
            sdpMid: mid,
            usernameFragment: newUfrag,
          },
          { rejects: "OperationError" },
        );

        // Assert: 食い違う候補はどの世代にも記録されない。
        expect(b.currentRemoteDescription!.sdp).not.toContain(
          " 40993 typ host",
        );
        expect(b.pendingRemoteDescription!.sdp).not.toContain(
          " 40993 typ host",
        );
        expect(liveCandidates(b, 40993)).toEqual(0);

        // Act: re-offer を両側で rollback する。
        await c.rollback(b);

        // Assert: 旧世代の候補は current に残り、既存 RTP が届く。
        expect(b.currentRemoteDescription!.sdp).toContain(" 40991 typ host");
        await c.rtp(outgoing, incoming);
      },
    );

    trafficScene(
      "during a partial BUNDLE split re-offer a candidate follows the ufrag of the m-line it targets",
      { ref: "origin: partial BUNDLE split trickle" },
      async (c) => {
        // Arrange: audio を追加し、audio だけを BUNDLE から外す re-offer を b に適用する。新世代の audio 候補はまだ trickle 中 (audio section に EOC なし) として渡す。
        const { a, b, session, bVideo } = await c.given(createDuplexSession());
        const audio = await addNegotiatedAudio(session, session.a, session.b);
        await c.setLocal(a, await createSplitOffer(a, audio.mid));
        await c.setRemote(
          b,
          mungeSection(a.pendingLocalDescription!.sdp, audio.mid, (section) =>
            section.replace(/a=end-of-candidates\r\n/g, ""),
          ),
        );
        const current = () => b.currentRemoteDescription!.sdp;
        const pending = () => b.pendingRemoteDescription!.sdp;
        const oldAudioUfrag = ufragOf(sectionOf(current(), audio.mid));
        const newAudioUfrag = ufragOf(sectionOf(pending(), audio.mid));
        // Arrange: audio だけが新しい ufrag になり、video は旧 ufrag のまま。
        expect(newAudioUfrag).not.toEqual(oldAudioUfrag);
        expect(ufragOf(sectionOf(pending(), bVideo.mid!))).toEqual(
          ufragOf(sectionOf(current(), bVideo.mid!)),
        );

        // Act: 旧世代と新世代の audio 候補を追加する。
        await c.addCandidate(b, {
          candidate: hostCandidate(current(), 40981, oldAudioUfrag),
          sdpMid: audio.mid,
        });
        await c.addCandidate(b, {
          candidate: hostCandidate(current(), 40982, newAudioUfrag),
          sdpMid: audio.mid,
        });

        // Assert: 旧世代は end-of-candidates で完了済みなので current にも pending にも入らず (RFC 8838)、新世代は pending の audio にだけ記録される。
        expect(sectionOf(current(), audio.mid)).toContain(
          "a=end-of-candidates",
        );
        expect(sectionOf(current(), audio.mid)).not.toContain(
          " 40981 typ host",
        );
        expect(sectionOf(pending(), audio.mid)).not.toContain(
          " 40981 typ host",
        );
        expect(sectionOf(pending(), audio.mid)).toContain(" 40982 typ host");
        expect(sectionOf(current(), audio.mid)).not.toContain(
          " 40982 typ host",
        );

        // Act: re-offer を両側で rollback する。
        await c.rollback(b);

        // Assert: current は元のまま (新世代の候補も残らず)、映像・DataChannel も通信を続ける。
        expect(sectionOf(current(), audio.mid)).not.toContain(
          " 40982 typ host",
        );
        await c.alive();
      },
    );

    trafficScene(
      "an answer leaves the MID of a rejected m-line out of its BUNDLE group",
      { ref: "2.5-14" },
      async (c) => {
        // Arrange: 音声を追加で交渉し、b がその transceiver を stop する。
        const { a, b, session, aVideo } = await c.given(createDuplexSession());
        const audio = await addNegotiatedAudio(session, session.a, session.b);
        audio.remote().stop();

        // Act: a から再交渉する。answerer の stop() は inactive で答えるだけなので、b は自分の次の offer で port 0 を交渉し、a はその m-line を拒否した answer を返す。
        await c.negotiate(a);
        await c.negotiate(b);

        // Assert: answer の音声 m-line は port 0 で BUNDLE group に含まれない。
        const answer = a.currentLocalDescription!.sdp;
        expect(sectionOf(answer, audio.mid)).toMatch(/^m=audio 0 /);
        expect(bundleMids(answer)).not.toContain(audio.mid);
        expect(bundleMids(answer)).toContain(aVideo.mid);

        // Assert: 両側で停止が確定する。
        expect(audio.remote().stopped).toEqual(true);

        // Assert: BUNDLE に残る映像と DataChannel は両方向で通信を続ける。
        await c.alive();
      },
    );

    trafficScene(
      "rollback removes provisional receiver SSRC mappings on an existing track",
      { ref: "2.3-2 2.4-3 2.4-T6" },
      async (c) => {
        // Arrange: 既存 m-line に別 SSRC を提案する re-offer を作る。
        const { a, b, outgoing, incoming } = await c.given(
          createConnectedVideoPeers(),
        );
        const receiver = b.getTransceivers()[0].receiver;
        const originalTracks = [...receiver.tracks];
        const originalSsrc = a.getTransceivers()[0].sender.ssrc;
        const provisionalSsrc = originalSsrc + 1;
        const offer = await a.createOffer();

        // Act: 追加 SSRC を一時登録してから offer を取り消す。
        await c.setRemote(
          b,
          offer.sdp.replaceAll(String(originalSsrc), String(provisionalSsrc)),
        );
        expect(receiver.trackBySSRC[provisionalSsrc]).not.toBe(undefined);
        await c.setRemote(b, "rollback");

        // Assert: receiver の object は維持し、追加 track と SSRC 経路を除去する。
        expect(receiver.tracks).toEqual(originalTracks);
        expect(Object.keys(receiver.trackBySSRC)).not.toContain(
          String(provisionalSsrc),
        );
        await c.rtp(outgoing, incoming);
      },
    );

    trafficScene(
      "re-offer pranswer carries new RTP alongside the committed stream",
      { ref: "2.1-3 2.2-1 2.2-5 2.2-6 2.2-7" },
      async (c) => {
        // Arrange: 接続済み video に新しい audio m-line を加える。
        const { a, b, outgoing, incoming } = await c.given(
          createConnectedVideoPeers(),
        );
        const provisionalAudio = new MediaStreamTrack({ kind: "audio" });
        const events = recordNegotiationEvents(b);
        const currentRemote = b.currentRemoteDescription!.sdp;
        const selectedPair = b.iceTransports[0].getSelectedCandidatePair();
        a.addTransceiver(provisionalAudio, { direction: "sendonly" });
        await c.offer(a);

        // Act: pranswer 中に新 audio と旧 video の RTP を両方送る。
        await c.pranswer(b);
        const receivedAudio = events.tracks.find(
          (e) => e.track.kind === "audio",
        )!.track;
        await c.rtp(provisionalAudio, receivedAudio);
        await c.rtp(outgoing, incoming);

        // Assert: current の SDP と ICE pair は pranswer では入れ替わらない。
        expect(b.currentRemoteDescription!.sdp).toEqual(currentRemote);
        expect(b.iceTransports[0].getSelectedCandidatePair()).toEqual(
          selectedPair,
        );

        // Act: rollback で新 audio を外し、旧 video は送り続ける。
        await c.rollback(a);
        await c.rtp(outgoing, incoming);

        // Assert: 接続中の current 経路と description が維持される。
        expect(b.currentRemoteDescription!.sdp).toEqual(currentRemote);
        expect(b.iceTransports[0].getSelectedCandidatePair()).toEqual(
          selectedPair,
        );
      },
    );

    trafficScene(
      "local ICE restart rollback retains the committed selected pair",
      { ref: "2.1-7 2.1-T8 2.3-9 2.3-11 5-4" },
      async (c) => {
        // Arrange: live ICE generation と選択済み pair を控える。
        const { a, outgoing, incoming } = await c.given(
          createConnectedVideoPeers(),
        );
        const transport = a.iceTransports[0];
        const ufrag = transport.localParameters.usernameFragment;
        const pair = transport.getSelectedCandidatePair();
        const generation = a.iceGeneration;
        const events = recordNegotiationEvents(a);
        const candidateUfrags = () =>
          events.candidates.map(
            (candidate) => candidate?.toJSON().usernameFragment,
          );

        // Act: restart offer を pending にしてから rollback する。
        const restartOffer = await c.offer(a, { iceRestart: true, hold: true });
        const emitted = events.candidates.length;
        await c.setLocal(a, restartOffer);
        await c.rtp(outgoing, incoming);
        await c.setLocal(a, "rollback");

        // Assert: current generation と実通信経路が変わらない。
        expect(emitted).toBeGreaterThan(1);
        expect(events.candidates.length).toEqual(emitted);

        // Assert: restart の generation は commit 後に STUN から集め直すので、offer では EOC を出さない。
        expect(candidateUfrags()).not.toContain(undefined);
        expect(candidateUfrags()).not.toContain(ufrag);
        expect(transport.localParameters.usernameFragment).toEqual(ufrag);
        expect(transport.getSelectedCandidatePair()).toEqual(pair);
        expect(a.iceGeneration).toEqual(generation);
        await c.rtp(outgoing, incoming);
      },
    );

    trafficScene(
      "re-offer BUNDLE split stages a new owner and rollback discards it",
      { ref: "2.1-T9 2.3-9 2.5-T1 2.5-11 2.5-12" },
      async (c) => {
        // Arrange: 接続中の video に audio を追加し、audio を BUNDLE 外にする。
        const { a, b, outgoing, incoming } = await c.given(
          createConnectedVideoPeers(),
        );
        const currentTransport = b.getTransceivers()[0].dtlsTransport;
        const currentRemote = b.currentRemoteDescription!.sdp;
        a.addTransceiver("audio", { direction: "sendonly" });
        const offer = await a.createOffer();
        const mids = [...offer.sdp.matchAll(/a=mid:([^\r\n]+)/g)].map(
          (m) => m[1],
        );
        const splitOffer = withBundle(offer.sdp, [mids[0]]);

        // Act: 新 owner の候補を answer に準備し、現在の video を使い続ける。
        await c.setRemote(b, splitOffer);
        const firstAnswer = await b.createAnswer();
        const pendingTransportCount = b.dtlsTransports.length;
        await c.rtp(outgoing, incoming);

        // Assert: pending transport は live binding にまだ現れず、SDP だけが別 ICE generation を持つ。
        expect(pendingTransportCount).toEqual(1);
        expect(b.getTransceivers()[1].dtlsTransport).toBe(currentTransport);
        const ufrags = [
          ...firstAnswer.sdp.matchAll(/a=ice-ufrag:([^\r\n]+)/g),
        ].map((m) => m[1]);
        expect(ufrags.length).toEqual(2);
        expect(new Set(ufrags).size).toEqual(2);

        // Act: rollback で pending owner を破棄し、同じ proposal を再交渉して確定する。
        await c.setRemote(b, "rollback");
        expect(b.dtlsTransports.length).toEqual(1);
        expect(b.currentRemoteDescription!.sdp).toEqual(currentRemote);
        await c.rtp(outgoing, incoming);
        await c.setRemote(b, splitOffer);
        const answer = await b.createAnswer();
        const events = recordNegotiationEvents(b);
        await c.setLocal(b, answer);

        // Assert: video の経路を保ち、audio owner の candidate/EOC を一度通知する。
        expect(b.getTransceivers()[0].dtlsTransport).toBe(currentTransport);
        expect(b.getTransceivers()[1].dtlsTransport).not.toBe(currentTransport);
        expect(
          events.candidates.some((candidate) => candidate?.sdpMid === mids[1]),
        ).toEqual(true);
        expect(events.candidates.at(-1)).toEqual(undefined);
        await c.rtp(outgoing, incoming);
      },
    );

    trafficScene(
      "a local BUNDLE split prepares independent ICE and carries both RTP streams",
      { ref: "origin: local BUNDLE split" },
      async (c) => {
        // Arrange: 接続済み BUNDLE transport に audio を追加し、group を分割する。
        const { a, b, outgoing, incoming } = await c.given(
          createConnectedVideoPeers(),
        );
        const audio = new MediaStreamTrack({ kind: "audio" });
        const events = recordNegotiationEvents(b);
        const currentLocal = a.currentLocalDescription!.sdp;
        const selectedPair = a.iceTransports[0].getSelectedCandidatePair();
        const videoMid = a.getTransceivers()[0].mid!;
        a.addTransceiver(audio, { direction: "sendonly" });
        const split = await createRewrittenOffer(a, (sdp) =>
          withBundle(sdp, [videoMid]),
        );

        // Act: 新 audio の ICE transport を pending に準備し、旧 video は継続する。
        await c.setLocal(a, split);
        expect(a.currentLocalDescription!.sdp).toEqual(currentLocal);
        expect(a.iceTransports[0].getSelectedCandidatePair()).toEqual(
          selectedPair,
        );
        expect(a.dtlsTransports.length).toEqual(1);
        await c.rtp(outgoing, incoming);

        // Act: remote answer で新 transport へ audio を結び付ける。
        await c.setRemote(b, a.localDescription);
        await c.answer(b);
        const audioTransport = a.getTransceivers()[1].dtlsTransport;
        await c.waitFor(() => audioTransport.state === "connected", 3000);

        // Assert: video の旧 pair を維持し、独立 audio と video の RTP が届く。
        expect(audioTransport).not.toBe(a.getTransceivers()[0].dtlsTransport);
        const receivedAudio = events.tracks.find(
          (e) => e.track.kind === "audio",
        )!.track;
        await c.rtp(audio, receivedAudio);
        await c.rtp(outgoing, incoming);

        // Act: 次の offer で audio を新 BUNDLE tag にして video を合流させる。
        const oldVideoTransport = a.getTransceivers()[0].dtlsTransport;
        const audioMid = a.getTransceivers()[1].mid!;
        await c.setLocal(
          a,
          await createRewrittenOffer(a, (sdp) =>
            withBundle(sdp, [audioMid, videoMid]),
          ),
        );
        await c.setRemote(b, a.localDescription);
        await c.answer(b);

        // Assert: tag 変更後は audio owner を共有し、両方の RTP が届く。
        expect(a.getTransceivers()[0].dtlsTransport).toBe(audioTransport);
        expect(oldVideoTransport.state).toEqual("closed");
        await c.rtp(audio, receivedAudio);
        await c.rtp(outgoing, incoming);
      },
    );

    trafficScene(
      "rollback of a local BUNDLE split keeps the old RTP owner",
      { ref: "2.1-T9 2.5-11" },
      async (c) => {
        // Arrange: 新 audio を非 BUNDLE にした local re-offer を作る。
        const { a, outgoing, incoming } = await c.given(
          createConnectedVideoPeers(),
        );
        const oldTransport = a.getTransceivers()[0].dtlsTransport;
        const oldPair = oldTransport.iceTransport.getSelectedCandidatePair();
        const audio = new MediaStreamTrack({ kind: "audio" });
        const localAudio = a.addTransceiver(audio, { direction: "sendonly" });
        const videoMid = a.getTransceivers()[0].mid!;
        const splitOffer = await createRewrittenOffer(a, (sdp) =>
          withBundle(sdp, [videoMid]),
        );

        // Act: pending owner を用意してから rollback する。
        await c.setLocal(a, splitOffer);
        expect(a.pendingLocalDescription!.sdp).toContain(
          "a=group:BUNDLE " + videoMid,
        );
        await c.rtp(outgoing, incoming);
        await c.setLocal(a, "rollback");

        // Assert: pending transport は消え、application の audio object と旧 pair は残る。
        expect(a.dtlsTransports.length).toEqual(1);
        expect(a.getTransceivers()).toContain(localAudio);
        expect(localAudio.sender.track).toBe(audio);
        expect(oldTransport.iceTransport.getSelectedCandidatePair()).toEqual(
          oldPair,
        );
        await c.rtp(outgoing, incoming);
      },
    );

    trafficScene(
      "replacement offers implicitly roll back either pranswer direction",
      { ref: "2.1-6 2.1-T12 2.2-18 2.8-34 2.9-T8" },
      async (c) => {
        // Arrange: 初回 offer と pranswer を双方の pending に置き、pranswer で ICE・DTLS の暫定接続を成立させる。
        const { a, b } = await c.given(createPeerPair());
        const audioOut = new MediaStreamTrack({ kind: "audio" });
        a.addTransceiver(audioOut, { direction: "sendonly" });
        await c.offer(a);
        await c.pranswer(b);
        await waitForPeersConnected(a, b);

        // Act: offerer は remote pranswer を、answerer は local pranswer を implicit rollback して replacement offer を受ける。
        await c.offer(a);

        // Assert: 最後の stable baseline は空で、新しい offer だけが pending。
        expect(a.signalingState).toEqual("have-local-offer");
        expect(b.signalingState).toEqual("have-remote-offer");
        expect(a.currentLocalDescription).toEqual(null);
        expect(b.currentRemoteDescription).toEqual(null);
        expect(a.pendingRemoteDescription).toEqual(null);
        expect(b.pendingLocalDescription).toEqual(null);

        // Act: replacement offer を最終 answer で確定する。
        await c.answer(b);
        await waitForPeersConnected(a, b);

        // Assert: 新しい transport で接続し直し、audio の RTP が届く。
        expect(a.connectionState).toEqual("connected");
        expect(b.connectionState).toEqual("connected");
        const mid = a.getTransceivers()[0].mid;
        await c.rtp(
          audioOut,
          b.getTransceivers().find((t) => t.mid === mid)!.receiver.track,
        );
      },
    );
  });

  // negotiationTransactionCoverageCodecs.test.ts
  describe("negotiation transaction spec coverage: codecs and feedback", () => {
    trafficScene(
      "[2.4-4] a remote pranswer that changes codec, RTX, RED and header extensions of the senders is fully undone by rollback",
      { ref: "2.4-4" },
      async (c) => {
        // Arrange: video (VP8+RTX、H264) と audio (RED+Opus) を送り、両方に MID と abs-send-time を交渉した session。
        const { a, b, outgoing, incoming } = await c.given(
          createConnectedSendParamPeers(),
        );
        const [video, audio] = a.getTransceivers();
        const before = [
          video.sender.snapshotSendParams(),
          audio.sender.snapshotSendParams(),
        ];
        const absSendTime = useAbsSendTime().uri;
        expect(before[0].codec?.name.toUpperCase()).toEqual("VP8");
        expect(before[0].rtxPayloadType).not.toEqual(undefined);
        expect(before[1].redRedundantPayloadType).not.toEqual(undefined);
        expect(before[0].headerExtensions.map((e) => e.uri)).toContain(
          absSendTime,
        );
        await c.offer(a);
        const answer = await b.createAnswer();

        // Arrange: pranswer は video の VP8 (と その RTX) と audio の RED を外し、abs-send-time もなくす。
        const pranswer = withoutExtmap(
          withoutCodecs(withoutCodecs(answer.sdp, "video", ["VP8"]), "audio", [
            "red",
          ]),
          absSendTime,
        );

        // Act: 送信パラメータを変える remote pranswer を offerer に適用する。
        await c.setRemote(a, pranswer, { type: "pranswer" });

        // Assert: 再交渉の pranswer は送信パラメータを暫定的に pranswer の値にする (2.10)。
        const pending = [
          video.sender.snapshotSendParams(),
          audio.sender.snapshotSendParams(),
        ];
        expect(pending[0].codec?.name.toUpperCase()).toEqual("H264");
        expect(pending[0].rtxPayloadType).toEqual(undefined);
        expect(pending[0].headerExtensions.map((e) => e.uri)).not.toContain(
          absSendTime,
        );
        expect(pending[1].codec?.name.toLowerCase()).toEqual("opus");
        expect(pending[1].redRedundantPayloadType).toEqual(undefined);

        // Act: 両側で rollback する。
        await c.rollback(a);

        // Assert: codec・RTX・RED・header extension・MID・RID を含む送信パラメータが適用前と完全に一致する。
        expect(video.sender.snapshotSendParams()).toEqual(before[0]);
        expect(audio.sender.snapshotSendParams()).toEqual(before[1]);

        // Assert: current の VP8 で RTP が届く。
        await c.rtp(outgoing, incoming);
      },
    );

    trafficScene(
      "[2.5-16] createAnswer only proposes: sender, receive codec / RTX tables, TWCC and the remote track codec switch at the local answer commit",
      { ref: "2.5-16" },
      async (c) => {
        // Arrange: VP8+RTX で確定した session に、H264(transport-cc)+RTX だけの re-offer が届いている。
        const {
          a,
          b,
          offererOut,
          answererOut,
          offererTransceiver,
          answererTransceiver,
        } = await c.given(createVp8RtxSessionWithH264Reoffer());
        const receiver = answererTransceiver.receiver;
        const sender = answererTransceiver.sender;
        const remoteTrack = receiver.track;
        const vp8 = payloadTypeOf(b.currentRemoteDescription!.sdp, "VP8");
        const tablesBefore = receiver.snapshotReceiveTables();
        const sendBefore = sender.snapshotSendParams();
        expect(sendBefore.codec?.name.toUpperCase()).toEqual("VP8");
        expect(remoteTrack.codec?.name.toUpperCase()).toEqual("VP8");
        expect(receiver.receiverTWCC).toEqual(undefined);

        // Act: answer を作る (まだ適用しない)。
        const answer = await b.createAnswer();

        // Assert: answer は H264+RTX を提案するが、live の送受信は current のまま変わらない。
        expect(offeredVideoCodecs(answer.sdp)).toEqual(["H264"]);
        expect(answer.sdp).toMatch(/^a=rtpmap:\d+ rtx\/90000/m);
        expect(sender.snapshotSendParams()).toEqual(sendBefore);
        expect(receiver.snapshotReceiveTables()).toEqual(tablesBefore);
        expect(receiver.receiverTWCC).toEqual(undefined);
        expect(remoteTrack.codec?.name.toUpperCase()).toEqual("VP8");
        c.invariants(b);
        await c.rtp(offererOut, remoteTrack);

        // Act: answer を適用して commit する。
        await c.setLocal(b, answer);
        await c.setRemote(a, b.localDescription);

        // Assert: commit で sender・受信 codec/RTX 表・TWCC・remote track の codec が answer の値に切り替わる。
        const h264 = payloadTypeOf(answer.sdp, "H264");
        const rtx = Number(
          answer.sdp.match(new RegExp(`^a=fmtp:(\\d+) apt=${h264}`, "m"))![1],
        );
        expect(sender.codec?.name.toUpperCase()).toEqual("H264");
        expect(receiveCodecNames(receiver)).toEqual(
          Object.fromEntries([
            [h264, "H264"],
            [rtx, "RTX"],
          ]),
        );
        expect(
          Object.keys(receiver.snapshotReceiveTables().codecs),
        ).not.toContain(String(vp8));
        expect(receiver.receiverTWCC).not.toEqual(undefined);
        expect(remoteTrack.codec?.name.toUpperCase()).toEqual("H264");

        // Assert: 確定した H264 で双方向に届く。
        await c.rtp(offererOut, remoteTrack);
        await c.rtp(answererOut, offererTransceiver.receiver.track);
      },
    );

    trafficScene.for([
      { change: "stops", twccCodec: "VP8", currentTwcc: true, starts: false },
      { change: "starts", twccCodec: "H264", currentTwcc: false, starts: true },
    ] as const)(
      "[2.6-T4h] the local answer commit $change transport-cc with the answered codec without a preference change",
      { ref: "2.6-T4h" },
      async (c, { twccCodec, currentTwcc, starts }) => {
        // Arrange: current は VP8、H264 だけの re-offer を answerer に適用済み。transport-cc feedback は twccCodec の codec だけが持つ。
        const { b, receiver, outgoing, incoming } = await c.given(
          createTwccH264OnlyReoffer(twccCodec),
        );
        expect(!!receiver.receiverTWCC).toBe(currentTwcc);

        // Act: preference を変えずに answer を作って commit する。
        await c.answer(b);

        // Assert: 受信表と remote track の codec は H264 に、TWCC は H264 の feedback に置き換わる。
        expect(Object.values(receiveCodecNames(receiver))).toEqual(["H264"]);
        expect(incoming.codec?.name.toUpperCase()).toEqual("H264");
        expect(!!receiver.receiverTWCC).toBe(starts);

        // Assert: 受信した RTP に transport-cc feedback を送るか (starts) / 送らないか (stops)。
        expect(await twccFeedbackSent(outgoing, receiver)).toBe(starts);
        await c.rtp(outgoing, incoming);
      },
    );

    trafficScene.for(ANSWER_OR_ROLLBACK)(
      "[5-13] RTP received while a fmtp change is staged is decoded with the current fmtp until $finish",
      { ref: "5-13" },
      async (c, { finish }) => {
        // Arrange: 接続済みの VP8 に fmtp を足した re-offer を作る。
        const { a, b, outgoing, incoming } = await c.given(
          createConnectedVideoPeers(),
        );
        const receiver = b.getTransceivers()[0].receiver;
        const offer = await a.createOffer();
        const pt = payloadTypeOf(offer.sdp, "VP8");
        const currentFmtp =
          receiver.snapshotReceiveTables().codecs[pt].parameters;
        const changed = offer.sdp.replace(
          new RegExp(`^(a=rtpmap:${pt} VP8/90000)`, "m"),
          `$1\r\na=fmtp:${pt} max-fr=30`,
        );

        // Act: fmtp を変える remote offer を適用し、RTP を送る。
        await c.setRemote(b, changed, { type: "offer" });

        // Assert: fmtp の変更は staged で、pending 中の RTP は current の fmtp の codec で処理されて届く。
        const tables = receiver.snapshotReceiveTables();
        expect(tables.codecs[pt].parameters).toBe(currentFmtp);
        expect(tables.stagedCodecs[pt]?.parameters).toBe("max-fr=30");
        await c.rtp(outgoing, incoming);
        c.invariants(b);

        // Act: answer で確定する、または rollback する。
        await c.finish(b, finish);

        // Assert: 確定すると新しい fmtp に、rollback なら current の fmtp に戻り、RTP が届く。
        if (finish === "answer") {
          expect(receiver.snapshotReceiveTables().codecs[pt].parameters).toBe(
            "max-fr=30",
          );
        } else {
          expect(receiver.snapshotReceiveTables().codecs[pt].parameters).toBe(
            currentFmtp,
          );
        }
        expect(receiver.snapshotReceiveTables().stagedCodecs).toEqual({});
        await c.rtp(outgoing, incoming);
        c.invariants(b);
      },
    );
  });

  // negotiationTransactionCoverageEvents.test.ts
  describe("negotiation transaction events and object lifetime", () => {
    const repeatedCandidates = (
      candidates: NegotiationEvents["candidates"],
    ) => {
      const keys = candidates
        .filter((candidate) => candidate !== undefined)
        .map((candidate) => `${candidate!.sdpMid} ${candidate!.candidate}`);
      return keys.filter((key, index) => keys.indexOf(key) !== index);
    };
    const streamIds = (event: NegotiationEvents["tracks"][number]) =>
      event.streams.map((stream) => stream.id);
    trafficScene(
      "[2.1-T6] a replacement offer and its rollback repeat no delivered event and close the replacement's pending-only transports",
      { ref: "2.1-T6" },
      async (c) => {
        const addedTransports = (
          pc: RTCPeerConnection,
          before: ReturnType<typeof heldTransports>,
        ) => [...heldTransports(pc)].filter((t) => !before.has(t));

        // Arrange: 接続済み session の b で発火する通知を記録し、a に audio を足した offer A を b に適用する。
        const { a, b } = await c.given(createDuplexSession());
        const aEvents = recordNegotiationEvents(a);
        const bEvents = recordNegotiationEvents(b);
        const before = { a: heldTransports(a), b: heldTransports(b) };
        const audioOut = new MediaStreamTrack({ kind: "audio" });
        const audio = a.addTransceiver(audioOut, { direction: "sendonly" });
        await c.offer(a);
        expect(bEvents.remoteTransceivers.length).toEqual(1);
        expect(bEvents.tracks.length).toEqual(1);
        const remoteAudio = bEvents.remoteTransceivers[0];

        // Act: 同じ m-line を BUNDLE から外す replacement offer B を両側に適用し、b は answer 用 transport を準備する。
        const offerB = await createSplitOffer(a, audio.mid!);
        await c.setLocal(a, offerB);
        await c.setRemote(b, a.localDescription);
        await b.createAnswer();
        c.invariants();

        // Assert: A で通知済みの transceiver/track は B で再通知されず、同じ object のまま。
        expect(bEvents.remoteTransceivers).toEqual([remoteAudio]);
        expect(bEvents.tracks.length).toEqual(1);
        expect(b.getTransceivers()).toContain(remoteAudio);

        // Assert: B は両側に pending-only の transport を作っている。
        const pendingOnly = {
          a: addedTransports(a, before.a),
          b: addedTransports(b, before.b),
        };
        expect(pendingOnly.a.length).toBeGreaterThan(0);
        expect(pendingOnly.b.length).toBeGreaterThan(0);

        // Act: 両側で rollback する。
        await c.rollback(a);

        // Assert: rollback は通知を増やさず、remote-only の transceiver を除外する。
        expect(bEvents.remoteTransceivers).toEqual([remoteAudio]);
        expect(bEvents.tracks.length).toEqual(1);
        expect(b.getTransceivers()).not.toContain(remoteAudio);
        expect(remoteAudio.stopped).toBe(true);

        // Assert: B の pending-only transport は ICE/DTLS とも閉じている。
        assertTransportsClosed([...pendingOnly.a, ...pendingOnly.b]);

        // Assert: 同一 generation の同じ候補は二度通知されない。
        expect(repeatedCandidates(aEvents.candidates)).toEqual([]);
        expect(repeatedCandidates(bEvents.candidates)).toEqual([]);
        await c.alive();

        // Act: rollback 後に B を適用し直す。
        await c.setLocal(a, offerB);
        await c.setRemote(b, a.localDescription);

        // Assert: 除外済み transceiver の代わりに新しい object が正当な新規通知として 1 回ずつ出る。
        expect(bEvents.remoteTransceivers.length).toEqual(2);
        expect(bEvents.tracks.length).toEqual(2);
        const reapplied = bEvents.remoteTransceivers[1];
        expect(reapplied).not.toBe(remoteAudio);
        expect(bEvents.tracks[1].transceiver).toBe(reapplied);

        // Act: B を final answer で確定する。
        await c.answer(b);

        // Assert: commit は通知を重ねず、分離した audio と既存 session が通信する。
        expect(bEvents.remoteTransceivers.length).toEqual(2);
        expect(bEvents.tracks.length).toEqual(2);
        expect(repeatedCandidates(aEvents.candidates)).toEqual([]);
        expect(repeatedCandidates(bEvents.candidates)).toEqual([]);
        await waitForDtlsConnected(reapplied.dtlsTransport);
        await c.rtp(audioOut, reapplied.receiver.track);
        await c.alive();
      },
    );

    trafficScene(
      "[2.3-1] a remote pranswer fires ontrack once before the final answer",
      { ref: "2.3-1" },
      async (c) => {
        // Arrange: 受信専用 video の初回 offer に、answerer が送信する pranswer を用意する。
        const { a, b } = await c.given(createPeerPair());
        const events = recordNegotiationEvents(a);
        const receiving = a.addTransceiver("video", { direction: "recvonly" });
        await c.offer(a);
        const outgoing = new MediaStreamTrack({ kind: "video" });
        const sending = b.getTransceivers()[0];
        sending.setDirection("sendonly");
        await sending.sender.replaceTrack(outgoing);
        const answer = await c.pranswer(b, { hold: true });
        expect(events.tracks.length).toEqual(0);

        // Act: offerer が remote pranswer を適用する。
        await c.setRemote(a, answer, { type: "pranswer" });

        // Assert: final answer 前に receiver の track が 1 回通知され、current は空のまま。
        expect(events.tracks.length).toEqual(1);
        expect(events.tracks[0].transceiver).toBe(receiving);
        expect(events.tracks[0].receiver).toBe(receiving.receiver);
        expect(events.tracks[0].track).toBe(receiving.receiver.track);
        expect(a.currentRemoteDescription).toEqual(null);

        // Assert: 通知した track に暫定 RTP が届く。
        await waitForPeersConnected(a, b);
        await c.rtp(outgoing, receiving.receiver.track);

        // Act: 同じ内容の final answer で確定する。
        await c.setLocal(b, answer);
        await c.setRemote(a, answer);

        // Assert: final answer は同じ receiver を再通知しない。
        expect(events.tracks.length).toEqual(1);
        await c.rtp(outgoing, receiving.receiver.track);
      },
    );

    trafficScene(
      "[2.3-2] rollback keeps the receiver and track and restores the last-stable stream association",
      { ref: "2.3-2" },
      async (c) => {
        // Arrange: video に stream "stable-stream" を付けて確定し、別 stream へ移す re-offer を用意する。
        const { a, b, aOut, aVideo, bVideo } = await c.given(
          createDuplexSession(),
        );
        aVideo.sender.setStreams([new MediaStream({ id: "stable-stream" })]);
        await c.negotiate(a);
        const events = recordNegotiationEvents(b);
        const receiver = bVideo.receiver;
        const track = receiver.track;
        expect(receiver.remoteStreamIds).toEqual(["stable-stream"]);
        aVideo.sender.setStreams([new MediaStream({ id: "pending-stream" })]);

        // Act: stream を変えた re-offer を適用する。
        await c.offer(a);

        // Assert: 同じ receiver/track が新しい stream で通知される。
        expect(events.tracks.length).toEqual(1);
        expect(events.tracks[0].receiver).toBe(receiver);
        expect(events.tracks[0].track).toBe(track);
        expect(streamIds(events.tracks[0])).toEqual(["pending-stream"]);

        // Act: 両側で rollback する。
        await c.rollback(a);

        // Assert: receiver/track の identity を保ち、stream 関連は last-stable に戻る。
        expect(bVideo.receiver).toBe(receiver);
        expect(receiver.track).toBe(track);
        expect(receiver.remoteStreamIds).toEqual(["stable-stream"]);
        expect(receiver.remoteStreamId).toBe("stable-stream");

        // Assert: rollback は track を通知し直さず、同じ track に RTP が届き続ける。
        expect(events.tracks.length).toEqual(1);
        await c.rtp(aOut, track);

        // Act: stream の変更をもう一度交渉する。
        await c.negotiate(a);

        // Assert: last-stable からの stream 変更は実際の遷移なので再び 1 回通知される。
        expect(events.tracks.length).toEqual(2);
        expect(events.tracks[1].track).toBe(track);
        expect(streamIds(events.tracks[1])).toEqual(["pending-stream"]);
        expect(receiver.remoteStreamIds).toEqual(["pending-stream"]);
      },
    );

    trafficScene(
      "[2.3-4] ontrack repeats only for a real stream addition or a transition to receiving",
      { ref: "2.3-4" },
      async (c) => {
        // Arrange: stream "first" で video を確定し、b の通知を記録する。
        const { a, b, aVideo, bVideo } = await c.given(createDuplexSession());
        const first = new MediaStream({ id: "first" });
        aVideo.sender.setStreams([first]);
        await c.negotiate(a);
        const events = recordNegotiationEvents(b);
        const track = bVideo.receiver.track;

        // Act: 何も変えない re-offer/answer を行う。
        await c.negotiate(a);

        // Assert: 受信方向も stream も変わらないので通知しない。
        expect(events.tracks.length).toEqual(0);

        // Act: 同じ receiver に stream を追加した re-offer を適用し、同じ offer を再適用する。
        aVideo.sender.setStreams([first, new MediaStream({ id: "second" })]);
        await c.offer(a);
        expect(events.tracks.length).toEqual(1);
        await c.setRemote(b, a.localDescription);

        // Assert: stream 追加で 1 回だけ通知され、再適用では通知しない。
        expect(events.tracks.length).toEqual(1);
        expect(events.tracks[0].track).toBe(track);
        expect(streamIds(events.tracks[0])).toEqual(["first", "second"]);

        // Act: answer で確定する。
        await c.answer(b);

        // Assert: commit は同じ遷移を再通知しない。
        expect(events.tracks.length).toEqual(1);

        // Act: a の送信を止める交渉をする。
        aVideo.setDirection("recvonly");
        await c.negotiate(a);

        // Assert: 受信をやめる遷移では track を通知しない。
        expect(events.tracks.length).toEqual(1);

        // Act: a の送信を再開する交渉をする。
        aVideo.setDirection("sendrecv");
        await c.negotiate(a);

        // Assert: 受信方向への遷移で同じ receiver/track が 1 回だけ再通知される。
        expect(events.tracks.length).toEqual(2);
        expect(events.tracks[1].receiver).toBe(bVideo.receiver);
        expect(events.tracks[1].track).toBe(track);
        await c.alive();
      },
    );

    trafficScene(
      "[2.3-7] a remote-created transceiver kept by addTrack carries the next local offer",
      { ref: "2.3-7" },
      async (c) => {
        // Arrange: addTrack で使った remote-created transceiver を rollback 後も残す。
        const { a, b, kept, localTrack, offererEvents } = await c.given(
          createKeptRemoteTransceiver(),
        );
        expect(b.getTransceivers()).toEqual([kept]);
        expect(kept.sender.track).toBe(localTrack);
        expect(kept.mid).toEqual(null);

        // Act: answerer 側から次の offer を作り、offerer の answer で確定する。
        await c.negotiate(b);

        // Assert: 残した transceiver が新しい m-line に関連付けられ、余分な transceiver は作られない。
        expect(b.getTransceivers()).toEqual([kept]);
        expect(kept.mid).not.toEqual(null);
        expect(
          b.currentLocalDescription!.sdp.match(/^m=audio/gm)!.length,
        ).toEqual(1);
        expect(kept.currentDirection).toEqual("sendrecv");

        // Assert: その m-line で localTrack の RTP が相手に届く。
        const received = offererEvents.tracks.find(
          (event) => event.transceiver.mid === kept.mid,
        );
        expect(received).not.toEqual(undefined);
        await waitForPeersConnected(a, b);
        await c.rtp(localTrack, received!.track);
      },
    );

    trafficScene(
      "[5-4] channels of a committed association stay open through a renegotiation rollback",
      { ref: "5-4" },
      async (c) => {
        // Arrange: 確立済み session で re-offer を pranswer まで進める。
        const { a, b, session, aChannel, bChannel } = await c.given(
          createDuplexSession(),
        );
        const bEvents = recordNegotiationEvents(b);
        const association = a.sctpTransport;
        await c.offer(a);
        await c.pranswer(b);

        // Act: pending 中に committed association 上へ新しい channel を開く。
        const duringPending = a.createDataChannel("during-pending");
        await c.waitFor(
          () =>
            duringPending.readyState === "open" &&
            bEvents.dataChannels.length === 1,
        );
        const remoteDuringPending = bEvents.dataChannels[0];

        // Act: 両側で rollback する。
        await c.rollback(a);

        // Assert: committed association とその上の channel はすべて open のまま通信できる。
        expect(a.sctpTransport).toBe(association);
        expect(
          [aChannel, bChannel, duringPending, remoteDuringPending].map(
            (channel) => channel.readyState,
          ),
        ).toEqual(["open", "open", "open", "open"]);
        await expectDataAlive(session, "committed-after-rollback");
        await c.data(duringPending, remoteDuringPending);

        // Assert: rollback で channel が再通知されることはない。
        expect(bEvents.dataChannels).toEqual([remoteDuringPending]);
      },
    );

    trafficScene(
      "[2.3-19] an ICE restart pranswer and its rollback notify only real signaling transitions",
      { ref: "2.3-19" },
      async (c) => {
        // Arrange: 接続済み session の状態通知を記録する。
        const { a, b } = await c.given(createDuplexSession());
        const aEvents = recordNegotiationEvents(a);
        const bEvents = recordNegotiationEvents(b);

        // Act: ICE restart の pranswer で provisional generation を nominate させ、両側で rollback する。
        await c.offer(a, { iceRestart: true });
        await c.pranswer(b);
        await waitForProvisionalNomination(a);
        await c.rollback(a);
        await c.alive();

        // Assert: signaling は実際の遷移だけを順に通知する。
        expect(aEvents.signaling).toEqual([
          "have-local-offer",
          "have-remote-pranswer",
          "stable",
        ]);
        expect(bEvents.signaling).toEqual([
          "have-remote-offer",
          "have-local-pranswer",
          "stable",
        ]);

        // Assert: live の接続状態は変わらないので、接続状態の通知は出ない。
        expect([
          aEvents.connection,
          aEvents.iceConnection,
          bEvents.connection,
          bEvents.iceConnection,
        ]).toEqual([[], [], [], []]);
        expect([a.connectionState, b.connectionState]).toEqual([
          "connected",
          "connected",
        ]);
      },
    );

    trafficScene(
      "[2.3-21] re-applying the same pranswer creates no new channel, transceiver or event",
      { ref: "2.3-21" },
      async (c) => {
        const objectsOf = (pcs: RTCPeerConnection[]) =>
          pcs.map((pc) => ({
            transceivers: pc.getTransceivers(),
            sctp: pc.sctpTransport,
            dtls: pc.dtlsTransports,
          }));

        // Arrange: video と DataChannel の初回 pranswer で暫定通信を始め、両側の通知を記録する。
        const { a, b, session } = await c.given(
          createMutationSession("initial"),
        );
        const aEvents = recordNegotiationEvents(a);
        const bEvents = recordNegotiationEvents(b);
        await c.offer(a);
        await prepareMutationAnswerer(session);
        const answer = await c.pranswer(b, { hold: true });
        await c.setRemote(a, answer, { type: "pranswer" });
        await waitForMutationSession(session);
        const remoteChannel = session.b.channel;
        const objects = objectsOf([a, b]);
        const counts = () =>
          [aEvents, bEvents].map((events) => ({
            tracks: events.tracks.length,
            remoteTransceivers: events.remoteTransceivers.length,
            dataChannels: events.dataChannels.length,
          }));
        const before = counts();
        expect(before[1]).toEqual({
          tracks: 1,
          remoteTransceivers: 1,
          dataChannels: 1,
        });

        // Act: 同じ pranswer を両側に再適用する。
        await c.setLocal(b, answer, { type: "pranswer" });
        await c.setRemote(a, answer, { type: "pranswer" });

        // Assert: track/transceiver/channel の通知も object も増えず、同じ channel が open のまま。
        expect(counts()).toEqual(before);
        expect(objectsOf([a, b])).toEqual(objects);
        expect(session.b.channel).toBe(remoteChannel);
        expect(remoteChannel.readyState).toEqual("open");
        expect(repeatedCandidates(aEvents.candidates)).toEqual([]);
        expect(repeatedCandidates(bEvents.candidates)).toEqual([]);
        await c.alive();

        // Act: 同じ内容の final answer で確定する。
        await c.setLocal(b, answer, { type: "answer" });
        await c.setRemote(a, answer, { type: "answer" });

        // Assert: commit でも通知は増えず、同じ channel で通信を続ける。
        expect(counts()).toEqual(before);
        expect(session.b.channel).toBe(remoteChannel);
        await c.alive();
      },
    );

    trafficScene(
      "[2.3-22] a DCEP reusing a stream ID on a new association after rollback creates a new channel",
      { ref: "2.3-22" },
      async (c) => {
        // Arrange: 初回 pranswer の association で channel を開いてから両側で rollback する。
        const { a, b, remote, local, answererEvents } = await c.given(
          createInitialPranswerDataChannel("first"),
        );
        const firstStreamId = remote.id;
        await c.setLocal(a, "rollback");
        await c.setRemote(b, "rollback");
        await c.waitFor(
          () => local.readyState === "closed" && remote.readyState === "closed",
        );

        // Act: 新しい channel で交渉し直し、新しい association を確定する。
        const second = a.createDataChannel("second");
        await c.negotiate(a);
        await c.waitFor(
          () =>
            second.readyState === "open" &&
            answererEvents.dataChannels.length === 2,
        );

        // Assert: 同じ stream ID でも association が違うので新しい object と event が作られる。
        expect(second.id).toEqual(firstStreamId);
        expect(answererEvents.dataChannels.length).toEqual(2);
        const renewed = answererEvents.dataChannels[1];
        expect(renewed).not.toBe(remote);
        expect(renewed).toMatchObject({ id: firstStreamId, label: "second" });

        // Assert: 旧 channel は閉じたままで、新しい channel だけが通信する。
        expect(remote.readyState).toEqual("closed");
        await c.data(second, renewed);
        await c.data(renewed, second);
      },
    );
  });

  // negotiationTransactionCoverageIce.test.ts
  describe("negotiation transaction spec coverage: ICE", () => {
    trafficScene(
      "[2.8-29] end-of-candidates on a non-tag m-line completes the provisional generation of a restart pranswer for its whole BUNDLE group",
      { ref: "2.8-29" },
      async (c) => {
        // Arrange: pranswer は end-of-candidates を含まず、provisional generation は未完了。
        const { a, video, audio, outgoing, incoming, ufrag } = await c.given(
          createBundledIceRestartPranswer(),
        );
        expect(provisionalIce(a)!.remoteCandidatesEnd).toBe(false);

        // Act: BUNDLE の非 tag (audio) m-line に restart generation の end-of-candidates を trickle する。
        await c.addCandidate(a, {
          candidate: "",
          sdpMid: audio,
          usernameFragment: ufrag,
        });

        // Assert: provisional generation が完了し、pending SDP の group の全 m-line が end-of-candidates を持つ。
        const provisional = provisionalIce(a);
        expect(provisional!.remoteCandidatesEnd).toBe(true);
        expect(sectionOf(a.pendingRemoteDescription!.sdp, video)).toContain(
          "a=end-of-candidates",
        );
        expect(sectionOf(a.pendingRemoteDescription!.sdp, audio)).toContain(
          "a=end-of-candidates",
        );

        // Act: その後に tag (video) m-line へ同じ generation の候補が届く。
        const candidates = provisional!.remoteCandidates.length;
        await c.addCandidate(a, trickleCandidate(50996, ufrag, video));

        // Assert: 完了した generation の候補は pending SDP にも provisional checklist にも入らない。
        expect(a.pendingRemoteDescription!.sdp).not.toContain(" 50996 ");
        expect(provisional!.remoteCandidates.length).toEqual(candidates);
        expect(
          provisional!.pairs.some(
            (pair) => pair.remoteCandidate.port === 50996,
          ),
        ).toBe(false);

        // Assert: live pair の RTP は続く。
        await c.rtp(outgoing, incoming);
      },
    );
  });

  // negotiationTransactionCoverageTransport.test.ts
  describe("negotiation transaction spec coverage: transport", () => {
    trafficScene(
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
              t.iceTransport.state !== "new" &&
              t.iceTransport.state !== "closed",
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

    trafficScene(
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
        expect(provisional.sctp.associationState).toEqual(
          SCTP_STATE.ESTABLISHED,
        );
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
        expect(provisional.sctp.associationState).toEqual(
          SCTP_STATE.ESTABLISHED,
        );
        expect(aChannel.readyState).toEqual("open");

        // Assert: 受理された video は確定した transport で届き続ける。
        await c.rtp(aOut, session.b.video.receiver.track);

        // Assert: 次の offer は同じ MID の application を再提案する (その後の通信は harness の継続確認)。
        const next = await a.createOffer();
        expect(sectionOf(next.sdp, "1")).toMatch(/^m=application [1-9]/);
      },
    );

    trafficScene(
      "[2.2-16] rollback stops the RTP a renegotiation pranswer started and keeps the current stream",
      { ref: "2.2-16" },
      async (c) => {
        // Arrange: 確立済み session に新しい audio を足した re-offer を pranswer まで進め、新 audio の RTP が届くことを確かめる。
        const { a, b } = await c.given(createDuplexSession());
        const audioOut = new MediaStreamTrack({ kind: "audio" });
        const audio = a.addTransceiver(audioOut, { direction: "sendonly" });
        await c.offer(a);
        await c.pranswer(b);
        const remoteAudio = b
          .getTransceivers()
          .find((t) => t.mid === audio.mid)!;
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

    trafficScene(
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
  });

  // negotiationTransactionCoverageTransport.test.ts
  for (const from of ["a", "b"] as const) {
    describe(`negotiation transaction spec coverage: transport (offerer=${from})`, () => {
      trafficScene(
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
    });
  }

  // negotiationTransactionMatrix.test.ts
  for (const from of ["a", "b"] as const) {
    describe(`negotiation transaction matrix (offerer=${from})`, () => {
      trafficScene(
        "transceiver stop rejects its m-line and a later transceiver reuses it",
        { ref: "2.1-T10" },
        async (c) => {
          // Arrange: audio transceiver を追加して交渉する。
          const { a } = await c.given(createDirectedDuplexSession(from));
          const firstAudio = a.addTransceiver("audio", {
            direction: "sendrecv",
          });
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
    });
  }

  // negotiationTransactionRegression.test.ts
  describe("negotiation transaction regressions", () => {
    trafficScene(
      "a replacement local offer keeps a new transceiver associated with its m-line",
      { ref: "2.1-T5; origin: property test" },
      async (c) => {
        // Arrange: a が audio を足した offer を適用し、b にも渡す。
        const { a, b } = await c.given(createDuplexSession());
        const out = new MediaStreamTrack({ kind: "audio" });
        const audio = a.addTransceiver(out, { direction: "sendonly" });
        await c.offer(a);
        const mid = audio.mid;

        // Act: 同じ内容の replacement offer を適用する。
        await c.offer(a, { hold: true });

        // Assert: pending 中も transceiver は自分の m-line (MID・index) に結び付いたまま。
        expect(audio.mid).toBe(mid);
        expect(sectionOf(a.pendingLocalDescription!.sdp, mid!)).toContain(
          "m=audio",
        );

        // Act: replacement offer に answer を返す。
        await c.setRemote(b, a.localDescription);
        await c.answer(b);

        // Assert: audio が届き、既存の video・DataChannel も継続する。
        await c.rtp(
          out,
          b.getTransceivers().find((t) => t.mid === mid)!.receiver.track,
        );
        await c.alive();
      },
    );

    trafficScene(
      "MIDs from unapplied createOffer calls do not collide with a later remote offer",
      { ref: "origin: property test" },
      async (c) => {
        // Arrange: b が audio を足し、適用しない createOffer を 2 回呼ぶ (MID・index が仮に振られる)。
        const { a, b } = await c.given(createDuplexSession());
        const own = b.addTransceiver(new MediaStreamTrack({ kind: "audio" }), {
          direction: "sendonly",
        });
        await b.createOffer();
        await b.createOffer();

        // Act: a が同じ種類の m-line を足した offer で交渉する。
        a.addTransceiver(new MediaStreamTrack({ kind: "audio" }), {
          direction: "sendonly",
        });
        await c.negotiate(a);

        // Assert: b の MID は重複せず、b 自身の transceiver は停止も除外もされない。
        const mids = b
          .getTransceivers()
          .map((t) => t.mid)
          .filter(Boolean);
        expect(new Set(mids).size).toEqual(mids.length);
        expect(b.getTransceivers()).toContain(own);
        expect(own.stopped).toEqual(false);
        await c.alive();
      },
    );
  });

  // negotiationTransactionRegression.test.ts
  describe("negotiation transaction live-state regressions", () => {
    trafficScene(
      "a remote pranswer that changes send parameters is fully undone by rollback",
      { ref: "2.2-9 2.4-4; origin: self-review (live state)" },
      async (c) => {
        // Arrange: offerer の送信パラメータ (RTX を含む) を控え、RTX を外した pranswer を作る。
        const { a, b, outgoing, incoming } = await c.given(
          createConnectedVideoPeersWithRtx(),
        );
        const sender = a.getTransceivers()[0].sender;
        const before = sender.snapshotSendParams();
        expect(before.rtxPayloadType).not.toEqual(undefined);
        await c.offer(a);
        const answer = await b.createAnswer();

        // Act: pranswer を適用して送信側が暫定値に変わった後、rollback する。
        await c.setRemote(a, withoutCodecs(answer.sdp, "video", ["rtx"]), {
          type: "pranswer",
        });
        expect(sender.snapshotSendParams()?.rtxPayloadType).toBe(undefined);
        await c.setLocal(a, "rollback");

        // Assert: 送信パラメータは current のものへ完全に戻り、RTP も届く。
        expect(sender.snapshotSendParams()).toEqual(before);
        c.invariants(a);
        await c.rtp(outgoing, incoming);
      },
    );

    trafficScene(
      "a pending re-offer that adds transport-cc does not start TWCC feedback for the current stream",
      { ref: "2.4-5; origin: self-review (live state)" },
      async (c) => {
        // Arrange: current は transport-cc なし。transport-cc を足した re-offer を作る (a は適用しない)。
        const { a, b, outgoing, incoming } = await c.given(
          createConnectedVideoPeers(),
        );
        const receiver = b.getTransceivers()[0].receiver;
        expect(receiver?.receiverTWCC).toBe(undefined);
        const offer = await a.createOffer();

        // Act: remote offer を適用して current の RTP を受け、rollback する。
        await c.setRemote(
          b,
          withRtcpFeedback(offer.sdp, "VP8", "transport-cc"),
        );
        await c.rtp(outgoing, incoming);
        const pending = receiver?.receiverTWCC;
        await c.setRemote(b, "rollback");

        // Assert: pending 中も rollback 後も current の stream に TWCC は始まらない。
        expect(pending).toBe(undefined);
        expect(receiver?.receiverTWCC).toBe(undefined);
      },
    );

    trafficScene(
      "a final answer replaces the RTCP feedback a pranswer staged",
      { ref: "2.4-T7a 2.5-13; origin: self-review (live state)" },
      async (c) => {
        // Arrange: re-offer を b に渡し、VP8 の NACK を外した pranswer を用意する。
        const { a, b, aVideo } = await c.given(createDuplexSession());
        await c.offer(a);
        const answer = await b.createAnswer();
        const pt = Number(answer.sdp.match(/^a=rtpmap:(\d+) VP8\/90000/m)![1]);
        const pranswer = withoutNack(answer.sdp, pt);
        expect(pranswer).not.toEqual(answer.sdp);
        const hasNack = () =>
          aVideo.receiver
            .snapshotReceiveTables()
            .codecs[pt].rtcpFeedback.some(
              (f) => f.type === "nack" && !f?.parameter,
            );

        // Act: NACK なしの pranswer を受ける。
        await c.setLocal(b, answer.sdp, { type: "pranswer" });
        await c.setRemote(a, pranswer, { type: "pranswer" });

        // Assert: pranswer の feedback 変更は commit まで保留され、current の NACK を保つ。
        expect(hasNack()).toEqual(true);

        // Act: NACK を含む final answer で確定する。
        await c.setLocal(b, answer);
        await c.setRemote(a, b.localDescription);

        // Assert: 確定 SDP と receiver の feedback が一致し (helper も検査する)、通信が続く。
        expect(a.currentRemoteDescription!.sdp).toContain(
          "a=rtcp-fb:" + pt + " nack\r\n",
        );
        expect(hasNack()).toEqual(true);
        await c.alive();
      },
    );

    trafficScene(
      "a sender added during a rolled-back offer keeps receiving RTCP after renegotiation",
      { ref: "5-8; origin: self-review (live state)" },
      async (c) => {
        // Arrange: re-offer を適用した pending 中に、アプリが送信用 video を追加する。
        const { a, b } = await c.given(createDuplexSession());
        await c.offer(a, { hold: true });
        const late = a.addTransceiver(new MediaStreamTrack({ kind: "video" }), {
          direction: "sendonly",
        });
        const onPli = vi.fn();
        late.sender.onPictureLossIndication.subscribe(onPli);

        // Act: pending offer を rollback する (追加した sender は残る)。
        await c.setLocal(a, "rollback");

        // Assert: rollback 後も追加した sender の SSRC 経路が残る (helper も検査する)。
        c.invariants(a);

        // Act: 改めて交渉し、相手から PLI を送る。
        await c.negotiate(a);
        await b
          .getTransceivers()
          .find((t) => t.mid === late.mid)!
          .receiver.sendRtcpPLI(late.sender.ssrc);

        // Assert: 相手の PLI が追加した sender に実際に届き、既存の通信も続く。
        await c.waitFor(() => onPli.mock.calls.length !== 0, 2000);
        await c.alive();
      },
    );

    trafficScene(
      "an ICE restart commit does not wait for an unreachable STUN server",
      { ref: "2.8-4; origin: self-review (live state)" },
      async (c) => {
        // Arrange: 到達できない STUN server を設定した接続済み peer (初回の gather は 1 秒で打ち切る)
        const { a, b, outgoing, incoming } = await c.given(
          createConnectedVideoPeers({
            iceServers: [{ urls: "stun:192.0.2.1:3478" }],
            iceStunGatherTimeout: 1,
          }),
        );
        a.restartIce();
        await c.offer(a);

        // Act: 双方で restart の answer を適用 (commit) する
        const answerElapsed = await elapsedMs(() =>
          b.createAnswer().then((answer) => b.setLocalDescription(answer)),
        );
        const commitElapsed = await elapsedMs(() =>
          a.setRemoteDescription(b.localDescription!),
        );

        // Assert: commit は STUN の応答 (最大 1 秒) を待たずに終わり、新しい generation で RTP が届く
        expect(Math.max(answerElapsed, commitElapsed)).toBeLessThan(500);
        await waitForCommittedNomination(a);
        await c.rtp(outgoing, incoming);
      },
    );

    trafficScene(
      "a remote re-offer committed by the local answer switches the receive tables and the remote track codec",
      { ref: "2.5-16 2.6-T4h; origin: self-review (live state)" },
      async (c) => {
        // Arrange: current は VP8、offerer が H264 だけの re-offer を出し answerer が適用済み (preference の変更なし)
        const { b, outgoing, incoming, transceiver } = await c.given(
          createH264OnlyReoffer(),
        );

        // Act: answer を作って適用し、offerer も answer を適用する
        await c.answer(b);

        // Assert: 受信表は H264 だけになり、remote track の codec も H264 に切り替わる
        expect(
          Object.values(
            transceiver.receiver.snapshotReceiveTables().codecs,
          ).map((codec) => codec.name.toUpperCase()),
        ).toEqual(["H264"]);
        expect(incoming?.codec?.mimeType.toLowerCase()).toEqual("video/h264");
        c.invariants(b);
        await c.rtp(outgoing, incoming);
      },
    );

    trafficScene(
      "a re-applied restart offer that fails to parse leaves no staged credentials",
      { ref: "2.9-4 2.9-9; origin: self-review (live state)" },
      async (c) => {
        // Arrange: audio を含む restart offer を適用して rollback し、相手の通常 offer で同じ m-line 位置に video を確定する。
        const { a, b, outgoing, incoming } = await c.given(
          createConnectedVideoPeers(),
        );
        const audio = a.addTransceiver("audio", { direction: "sendonly" });
        const saved = await c.offer(a, { iceRestart: true, hold: true });
        await c.setLocal(a, "rollback");
        b.addTransceiver("video", { direction: "sendonly" });
        await c.negotiate(b);
        const iceTransport = a.iceTransports[0];
        const state = () => ({
          signalingState: a.signalingState,
          current: a.currentLocalDescription!.sdp,
          ufrag: iceTransport.localParameters.usernameFragment,
          staged: iceTransport.hasStagedRestart,
          audio: { mid: audio.mid, index: audio.mLineIndex },
        });
        const before = state();

        // Act / Assert: 保存した offer の再適用は m-line の不整合で拒否される。
        await c.setLocal(a, saved, { rejects: "InvalidModificationError" });

        // Assert: stage し直した資格情報や MID は残らず、失敗前と同じ状態になる。
        expect(state()).toEqual(before);
        expect(before.staged).toEqual(false);
        expect(before.current).toContain("a=ice-ufrag:" + before.ufrag);
        c.invariants(a);
        await c.rtp(outgoing, incoming);
      },
    );

    trafficScene(
      "a remote answer that answers only the leading m-lines of the offer is accepted and rejects the rest",
      { ref: "2.9-T9; origin: self-review (live state)" },
      async (c) => {
        // Arrange: 相手の前回の answer (m-line が少ない) を保存し、offerer は video を足した offer を適用する。
        const { a, b, outgoing, incoming } = await c.given(
          createConnectedVideoPeers(),
        );
        const staleAnswer = b.currentLocalDescription;
        const added = a.addTransceiver("video", { direction: "sendonly" });
        await c.offer(a, { hold: true });

        // Act: 先頭の m-line だけに答える前回の answer を適用する (develop も受理する)。
        await c.setRemote(a, staleAnswer);

        // Assert: 確定し、答えられなかった m-line は拒否として停止する。既存の映像は届く。
        expect(a.signalingState).toEqual("stable");
        expect(added.stopped).toEqual(true);
        c.invariants(a);
        await c.rtp(outgoing, incoming);
      },
    );

    trafficScene(
      "a first offer with a DataChannel re-applied after its rollback opens the channel",
      { ref: "2.3-15 2.9-10 2.9-T5; origin: self-review (live state)" },
      async (c) => {
        // Arrange: DataChannel を持つ初回 offer を作り、適用して rollback する。
        const { a, b } = await c.given(createUnnegotiatedPeers());
        const channel = a.createDataChannel("reapplied");
        const offer = await c.offer(a, { hold: true });
        await c.setLocal(a, "rollback");
        const sctpTransport = a.sctpTransport!.dtlsTransport;

        // Act: 同じ offer を再適用し、answer で確定する。
        await c.setLocal(a, offer);
        await c.setRemote(b, a.localDescription);
        await c.answer(b);

        // Assert: SCTP の m-line は offer が作られた SCTP transport のまま交渉され (余分な transport を作らない)、DataChannel が開いて届く。
        expect(a.sctpTransport!.dtlsTransport).toBe(sctpTransport);
        const received = await b.onDataChannel
          .asPromise(5000)
          .then((args) => args[0]);
        await c.waitFor(() => channel.readyState === "open", 5000);
        await c.data(channel, received);
        c.invariants(a);
      },
    );
  });

  // negotiationTransactionRouting.test.ts
  describe("negotiation transaction routing tables", () => {
    trafficScene.for([
      { finish: "answer", after: "1" },
      { finish: "rollback", after: "0" },
    ] as const)(
      "an SSRC a re-offer moves to another m-line keeps its current route until $finish",
      {
        ref: "2.1-T3 2.4-2 2.4-T3",
        exempt: "b commits a hand-edited offer that a never applied",
      },
      async (c, { finish, after }) => {
        // Arrange: m-line 0 の SSRC を m-line 1 に移し、m-line 0 には新しい SSRC 999111 を付けた re-offer を作る。
        const { a, b, outgoing } = await c.given(
          createConnectedMultiVideoPeers(2),
        );
        const offer = await a.createOffer();
        const ssrc0 = ssrcOf(offer.sdp, "0");
        const moved = mungeSection(
          mungeSection(offer.sdp, "0", (s) => s.split(ssrc0).join("999111")),
          "1",
          (s) => s.split(ssrcOf(offer.sdp, "1")).join(ssrc0),
        );

        // Act: SSRC を付け替える remote offer を適用する (answer はまだ返さない)。
        await c.setRemote(b, moved);

        // Assert: pending 中は current の経路のまま m-line 0 に届き、付け替えは保留される。
        expect(await receivingMid(outgoing[0], b, "ssrc-pending")).toEqual("0");

        // Act: answer で確定する、または rollback する。
        await c.finish(b, finish);

        // Assert: 確定すると SDP どおり m-line 1 へ、rollback なら m-line 0 のまま届く。
        expect(
          await receivingMid(outgoing[0], b, `ssrc-after-${finish}`),
        ).toEqual(after);
      },
    );

    trafficScene.for(ANSWER_OR_ROLLBACK)(
      "an RTX SSRC a re-offer pairs with another media SSRC keeps its current pairing until $finish",
      {
        ref: "2.4-3 2.4-T4",
        exempt: "b commits a hand-edited offer that a never applied",
      },
      async (c, { finish }) => {
        // Arrange: FID の RTX SSRC は変えず、対になるメディア SSRC を 999333 に付け替えた re-offer を作る。
        const { a, b, outgoing, incoming } = await c.given(
          createConnectedVideoPeersWithRtx(),
        );
        const offer = await a.createOffer();
        const [, media, rtx] = offer.sdp.match(
          /^a=ssrc-group:FID (\d+) (\d+)/m,
        )!;
        const pairing = () =>
          b.getTransceivers()[0].receiver.snapshotReceiveTables().ssrcByRtx[
            rtx
          ];
        expect(pairing()).toEqual(Number(media));

        // Act: RTX の対応を変える remote offer を適用する (answer はまだ返さない)。
        await c.setRemote(b, offer.sdp.split(media).join("999333"));

        // Assert: pending 中は current の RTX 対応のまま (付け替えは保留)。
        expect(pairing()).toEqual(Number(media));

        // Act: answer で確定する、または rollback する。
        await c.finish(b, finish);

        // Assert: 確定すると新しい対応に、rollback なら元の対応のまま RTP が届く。
        if (finish === "answer") expect(pairing()).toEqual(999333);
        if (finish === "rollback") expect(pairing()).toEqual(Number(media));
        if (finish === "rollback") await c.rtp(outgoing, incoming);
      },
    );
  });
}
