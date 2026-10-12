import type { RTCIceCandidate, RTCPeerConnection } from "../../src";
import { negotiationCases } from "./negotiationCaseRunner";

type IceConnectionInternals = {
  nominated?: object;
  checkList: object[];
  provisionalNominated?: object;
  remoteCandidates: { port: number }[];
};
const iceConnection = (pc: RTCPeerConnection) =>
  pc.iceTransports[0].connection as unknown as IceConnectionInternals;

/**
 * Spec coverage of the ICE rules of the negotiation transaction ticket
 * (2.6 TURN settings, 2.7 provisional ICE generation, 2.8 ICE rules and
 * section 5 restartIce() / end-of-candidates). Test names start with the
 * requirement ID.
 */
negotiationCases(
  "negotiation transaction spec coverage: ICE",
  [
    {
      text: `
        case: [2.7-T4a] the final answer checks the restarted generation from scratch instead of taking the provisional nomination
        ref: 2.7-T4a
        given: createConnectedVideoPeers()
        Arrange: ICE restart offer に pranswer を返し、双方の provisional generation が nominate するまで待つ。
        a offer restart
        b createAnswer as=answer
        b setLocal answer type=pranswer
        a setRemote answer type=pranswer
        do Promise.all([waitForProvisionalNomination(a), waitForProvisionalNomination(b)])
        let provisional = [iceConnection(a).provisionalNominated, iceConnection(b).provisionalNominated]
        let states = [recordIceConnectionStates(a), recordIceConnectionStates(b)]
        Act: pranswer と同じ内容の final answer で restart を確定する。
        b setLocal answer type=answer
        a setRemote answer type=answer
        do Promise.all([waitForCommittedNomination(a), waitForCommittedNomination(b)])
        Assert: live generation は checking を経て一から接続確認をやり直し、provisional で nominate した pair は引き継がず新しい checklist の pair を選び、commit 後に provisional generation は残らない。
        expect restartCheck(a, provisional[0], states[0]) == { sawChecking: true, checkingBeforeConnected: true, nominated: true, tookProvisional: false, provisionalInCheckList: false, nominatedInCheckList: true, provisionalLeft: false }
        expect restartCheck(b, provisional[1], states[1]) == { sawChecking: true, checkingBeforeConnected: true, nominated: true, tookProvisional: false, provisionalInCheckList: false, nominatedInCheckList: true, provisionalLeft: false }
        invariants
        Assert: 確定した generation で RTP が届く。
        rtp outgoing -> incoming
      `,
      fns: {
        /** How `pc`'s live ICE connection was checked after the restart commit. */
        restartCheck: (
          pc: RTCPeerConnection,
          provisional: object,
          states: string[],
        ) => {
          const connection = iceConnection(pc);
          return {
            sawChecking: states.includes("checking"),
            checkingBeforeConnected:
              states.indexOf("checking") < states.lastIndexOf("connected"),
            nominated: connection.nominated !== undefined,
            tookProvisional: connection.nominated === provisional,
            provisionalInCheckList: connection.checkList.includes(provisional),
            nominatedInCheckList: connection.checkList.includes(
              connection.nominated!,
            ),
            provisionalLeft: connection.provisionalNominated !== undefined,
          };
        },
      },
    },
    `
      case: [2.7-T4b] $replacement ends the provisional generation of a restart pranswer and the live pair keeps carrying RTP
      ref: 2.7-T4b
      given: createIceRestartPranswer()
      each: [{ replacement: "a replacement offer" }, { replacement: "a replacement ICE restart offer" }]
      Arrange: pranswer の provisional generation が nominate するまで待ち、live pair を控える。
      do waitForProvisionalNomination(a)
      let live = iceConnection(a).nominated
      Act: pranswer を受けた offerer が置き換えの offer (restartIce() 後の restart offer を含む) を作って適用する。
      [replacement=a replacement ICE restart offer] do a.restartIce()
      a createOffer as=offer
      a setLocal offer
      Assert: pranswer の generation の check と nominate は終わり、live pair は変わらない。
      expect a.signalingState == "have-local-offer"
      expect iceConnection(a).provisionalNominated == undefined
      expect (provisionalIce(a)?.pairs || []).length == 0
      expect (provisionalIce(a)?.remoteCandidates || []).length == 0
      expect iceConnection(a).nominated is live
      expect a.iceTransports[0].getRemoteParameters()?.usernameFragment isnt ufrag
      rtp outgoing -> incoming
      Act: answerer は pranswer を取り消し、置き換えの offer に answer して確定する。
      b setRemote rollback
      b setRemote local(a)
      b answer
      do Promise.all([waitForCommittedNomination(a), waitForCommittedNomination(b)])
      Assert: 置き換えの offer の generation で確定し、RTP が届く。
      expect ufragOf(a.currentLocalDescription.sdp) == ufragOf(offer.sdp)
      invariants
      rtp outgoing -> incoming
    `,
    `
      case: [2.8-5] an ICE restart without ICE servers puts end-of-candidates in its descriptions and trickles nothing after the commit
      ref: 2.8-5
      given: createConnectedVideoPeers({ iceServers: [] }, { withAudio: true })
      Arrange: 両 peer の ICE agent に問い合わせる server がない状態にし、onIceCandidate を記録する。
      do removeIceAgentServers(a)
      do removeIceAgentServers(b)
      let events = { offerer: recordIceCandidates(a), answerer: recordIceCandidates(b) }
      Act: ICE server のない session で ICE restart を offer / answer で確定する。
      do a.restartIce()
      a createOffer as=offer
      a setLocal offer
      b setRemote offer
      b createAnswer as=answer
      b setLocal answer
      a setRemote answer
      Assert: restart の offer と answer は全 m-line に end-of-candidates を含む。
      expect offer.sdp.match(/^a=end-of-candidates/gm).length == offer.sdp.match(/^m=/gm).length
      expect answer.sdp.match(/^a=end-of-candidates/gm).length == answer.sdp.match(/^m=/gm).length
      expect ufragOf(a.currentLocalDescription.sdp) == ufragOf(offer.sdp)
      Act: commit 後の新 generation の接続を待ち、背景の gather が走る時間をおく。
      let signalled = { offerer: events.offerer.length, answerer: events.answerer.length }
      do Promise.all([waitForCommittedNomination(a), waitForCommittedNomination(b)])
      sleep 500
      Assert: commit 後に追加の候補も end-of-candidates も trickle されない。
      expect events.offerer.length == signalled.offerer
      expect events.answerer.length == signalled.answerer
      Assert: end-of-candidates は generation ごとに高々一度。
      expect events.offerer.filter((candidate) => candidate === undefined).length <= 1
      expect events.answerer.filter((candidate) => candidate === undefined).length <= 1
      expect [a.iceGatheringState, b.iceGatheringState] == ["complete", "complete"]
      invariants
      rtp outgoing -> incoming
    `,
    `
      case: [2.8-27] an answer that starts no connection work leaves a $state connectionState unchanged
      ref: 2.8-27
      given: createConnectedVideoPeers()
      each: [{ state: "connected" }, { state: "failed" }]
      Arrange: 確立済みの session (failed の場合は offerer の ICE generation を consent 失効相当で failed にする)。
      [state=failed] do forceIceState(a, "failed")
      let before = [a, b].map((pc) => ({ connection: pc.connectionState, ice: pc.iceConnectionState }))
      let recorded = [a, b].map((pc) => ({ connection: recordConnectionStates(pc), ice: recordIceConnectionStates(pc) }))
      expect a.connectionState == "$state"
      Act: ICE restart も新しい transport も含まない再交渉を answer まで行う。
      a negotiate
      sleep 200
      Assert: 接続処理を始めも待ちもしないので、connectionState も ICE の状態も変わらず通知もない。
      expect [a, b].map((pc) => ({ connection: pc.connectionState, ice: pc.iceConnectionState })) == before
      expect recorded == [{ connection: [], ice: [] }, { connection: [], ice: [] }]
    `,
    `
      case: [2.8-29] end-of-candidates on a non-tag m-line completes the provisional generation of a restart pranswer for its whole BUNDLE group
      ref: 2.8-29
      given: createBundledIceRestartPranswer()
      Arrange: pranswer は end-of-candidates を含まず、provisional generation は未完了。
      expect provisionalIce(a).remoteCandidatesEnd is false
      Act: BUNDLE の非 tag (audio) m-line に restart generation の end-of-candidates を trickle する。
      a addCandidate { candidate: "", sdpMid: audio, usernameFragment: ufrag }
      Assert: provisional generation が完了し、pending SDP の group の全 m-line が end-of-candidates を持つ。
      let provisional = provisionalIce(a)
      expect provisional.remoteCandidatesEnd is true
      expect sectionOf(a.pendingRemoteDescription.sdp, video) contains "a=end-of-candidates"
      expect sectionOf(a.pendingRemoteDescription.sdp, audio) contains "a=end-of-candidates"
      Act: その後に tag (video) m-line へ同じ generation の候補が届く。
      let candidates = provisional.remoteCandidates.length
      a addCandidate trickleCandidate(50996, ufrag, video)
      Assert: 完了した generation の候補は pending SDP にも provisional checklist にも入らない。
      expect a.pendingRemoteDescription.sdp lacks " 50996 "
      expect provisional.remoteCandidates.length == candidates
      expect provisional.pairs.some((pair) => pair.remoteCandidate.port === 50996) is false
      Assert: live pair の RTP は続く。
      rtp outgoing -> incoming
    `,
    `
      case: [2.8-35] after the $side rolls back a first pranswer connection it reports no later state of that connection
      ref: 2.8-35
      given: createInitialPranswerConnection()
      each: [{ side: "offerer", rolling: "a", peer: "b" }, { side: "answerer", rolling: "b", peer: "a" }]
      timeout: 10000
      Arrange: 初回 pranswer で両 peer が接続済みと報告している。
      do Promise.all([waitForConnection(a), waitForConnection(b)])
      Act: 片側で初回交渉を rollback する。
      [side=offerer] a setLocal rollback
      [side=answerer] b setRemote rollback
      Assert: current session がないので接続状態は new に戻る。
      expect [$rolling.connectionState, $rolling.iceConnectionState] == ["new", "new"]
      let connectionStates = recordConnectionStates($rolling)
      let iceStates = recordIceConnectionStates($rolling)
      Act: 相手が提案の接続を閉じ (DTLS close / ICE の consent 喪失)、遅延処理が走る時間待つ。相手の close() 自体が検証対象の操作なので、両 peer とも継続確認の対象外にする。
      exempt close() is the operation under test
      do $peer.close()
      sleep 1500
      Assert: rollback した提案の接続処理は以後の状態を報告しない。
      expect [$rolling.connectionState, $rolling.iceConnectionState] == ["new", "new"]
      expect connectionStates == []
      expect iceStates == []
      expect $rolling.signalingState == "stable"
    `,
    `
      case: [5-12] an mDNS candidate of a restart pranswer still resolving at $interruption reaches neither the SDP nor any checklist
      ref: 5-12
      given: createIceRestartPranswer()
      each: [{ interruption: "a replacement pranswer" }, { interruption: "a rollback" }]
      Arrange: provisional generation の mDNS 候補を解決中にする。
      let mdns = stubIceMdns(a)
      a addCandidate trickleCandidate(50995, ufrag, mid, "peer.local")
      expect mdns.requested == 1
      Act: 解決前に replacement pranswer (別の資格情報) を適用するか、rollback する。
      [interruption=a replacement pranswer] a setRemote withIceCredentials(local(b).sdp.replace(/^a=end-of-candidates\\r?\\n/gm, ""), "repl", "replacementpassword00000") type=pranswer
      [interruption=a rollback] a setLocal rollback
      Act: その後で mDNS の解決を完了させる。
      do mdns.resolveAll("127.0.0.1")
      sleep 100
      Assert: 解決した候補は新しい provisional checklist にも live の checklist にも入らない。
      let provisional = provisionalIce(a)
      expect !!provisional?.remoteCandidates.some((c) => c.port === 50995) is false
      expect !!provisional?.pairs.some((p) => p.remoteCandidate.port === 50995) is false
      expect iceConnection(a).remoteCandidates.some((c) => c.port === 50995) is false
      Assert: pending / current の SDP にも入らない。
      [interruption=a replacement pranswer] expect provisional?.remoteCandidatesEnd is false
      [interruption=a replacement pranswer] expect a.pendingRemoteDescription.sdp lacks " 50995 "
      [interruption=a rollback] expect a.pendingRemoteDescription is null
      expect a.currentRemoteDescription.sdp lacks " 50995 "
      Assert: live pair の RTP は続く。
      rtp outgoing -> incoming
    `,
    `
      case: [2.6-T3a] ICE servers set while an ICE restart is pending survive its rollback and apply to the next restart
      ref: 2.6-T3a
      given: createConnectedMediaAndDataPeers()
      Arrange: TURN なしで接続済みの peer と、後から設定するローカル TURN server を用意する。
      let turn = createLocalTurnIceServer()
      do closing(turn.server)
      do a.restartIce()
      a createOffer
      a setLocal
      Act: restart offer の pending 中に TURN を設定し、その offer を rollback する。
      do a.setConfiguration({ iceServers: turn.iceServers })
      a setLocal rollback
      Assert: ICE server 設定は configuration なので rollback で戻らない。
      expect a.getConfiguration().iceServers == turn.iceServers
      Act: 次の ICE restart を確定し、commit 後に出る候補を answerer へ trickle する。
      let events = recordIceCandidates(a)
      do a.restartIce()
      a createOffer
      a setLocal
      let offerSdp = local(a).sdp
      b setRemote local(a)
      b createAnswer
      b setLocal
      let committedFrom = events.length
      a setRemote local(b)
      do waitForEndOfCandidates(events)
      let committed = events.slice(committedFrom)
      do trickleAll(b, committed)
      Assert: 次の restart は設定した TURN で集め直し、relay 候補を commit 後に trickle する。
      expect offerSdp lacks "typ relay"
      expect committed.some((c) => c?.candidate.includes("typ relay")) is true
      expect committed.at(-1) is undefined
      expect b.iceTransports[0].getRemoteCandidates().some((c) => c.candidate.includes("typ relay")) is true
      Assert: 新しい generation が nominate され、DataChannel が通信できる。
      do waitForCommittedNomination(a)
      invariants a
      data channel -> received
    `,
    `
      case: [2.6-T3b] ICE servers set after a restart offer was created apply to that restart's gathering at its commit
      ref: 2.6-T3b
      given: createConnectedMediaAndDataPeers()
      Arrange: TURN なしで接続済みの peer で、restartIce() の offer を作って restart を stage する。
      let turn = createLocalTurnIceServer()
      do closing(turn.server)
      let events = recordIceCandidates(a)
      do a.restartIce()
      a createOffer as=offer
      Act: stage した後に TURN を設定し、その offer を適用して answer で確定する。
      do a.setConfiguration({ iceServers: turn.iceServers })
      a setLocal offer
      b setRemote local(a)
      b createAnswer
      b setLocal
      let committedFrom = events.length
      a setRemote local(b)
      do waitForEndOfCandidates(events)
      let committed = events.slice(committedFrom)
      do trickleAll(b, committed)
      Assert: offer は relay も end-of-candidates も含まず、commit 後の背景 gather が新しい TURN の relay 候補を trickle する (JSEP 4.1.18)。
      expect offer.sdp lacks "typ relay"
      expect offer.sdp lacks "a=end-of-candidates"
      expect committed.some((c) => c?.candidate.includes("typ relay")) is true
      expect committed.at(-1) is undefined
      expect b.iceTransports[0].getRemoteCandidates().some((c) => c.candidate.includes("typ relay")) is true
      Assert: 新しい generation が nominate され、DataChannel が通信できる。
      do waitForCommittedNomination(a)
      invariants a
      data channel -> received
    `,
  ],
  {
    fns: {
      iceConnection,
      ufragOf: (sdp: string) => sdp.match(/^a=ice-ufrag:(\S+)/m)![1],
      /** Signal `candidates` (undefined = end-of-candidates) to `pc` in order. */
      trickleAll: async (
        pc: RTCPeerConnection,
        candidates: (RTCIceCandidate | undefined)[],
      ) => {
        for (const candidate of candidates) {
          await pc.addIceCandidate(candidate?.toJSON() ?? (null as never));
        }
      },
    },
  },
);
