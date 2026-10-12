import type { RTCDataChannel, RTCPeerConnection } from "../../src";
import { negotiationCases } from "./negotiationCaseRunner";
import {
  type NegotiationEvents,
  heldTransports,
} from "./negotiationTransactionUtils";

/**
 * Observable events and speculative object lifetime of a negotiation
 * transaction (TICKET 2.1 replacement/rollback row, 2.3 and 5-4).
 */
negotiationCases(
  "negotiation transaction events and object lifetime",
  [
    {
      text: `
        case: [2.1-T6] a replacement offer and its rollback repeat no delivered event and close the replacement's pending-only transports
        ref: 2.1-T6
        given: createDuplexSession()
        Arrange: 接続済み session の b で発火する通知を記録し、a に audio を足した offer A を b に適用する。
        let aEvents = recordNegotiationEvents(a)
        let bEvents = recordNegotiationEvents(b)
        let before = { a: heldTransports(a), b: heldTransports(b) }
        let audioOut = new MediaStreamTrack({ kind: "audio" })
        let audio = a.addTransceiver(audioOut, { direction: "sendonly" })
        a offer
        expect bEvents.remoteTransceivers.length == 1
        expect bEvents.tracks.length == 1
        let remoteAudio = bEvents.remoteTransceivers[0]
        Act: 同じ m-line を BUNDLE から外す replacement offer B を両側に適用し、b は answer 用 transport を準備する。
        let offerB = createSplitOffer(a, audio.mid)
        a setLocal offerB
        b setRemote local(a)
        b createAnswer
        invariants
        Assert: A で通知済みの transceiver/track は B で再通知されず、同じ object のまま。
        expect bEvents.remoteTransceivers == [remoteAudio]
        expect bEvents.tracks.length == 1
        expect b.getTransceivers() contains remoteAudio
        Assert: B は両側に pending-only の transport を作っている。
        let pendingOnly = { a: addedTransports(a, before.a), b: addedTransports(b, before.b) }
        expect pendingOnly.a.length > 0
        expect pendingOnly.b.length > 0
        Act: 両側で rollback する。
        a rollback
        Assert: rollback は通知を増やさず、remote-only の transceiver を除外する。
        expect bEvents.remoteTransceivers == [remoteAudio]
        expect bEvents.tracks.length == 1
        expect b.getTransceivers() lacks remoteAudio
        expect remoteAudio.stopped is true
        Assert: B の pending-only transport は ICE/DTLS とも閉じている。
        do assertTransportsClosed([...pendingOnly.a, ...pendingOnly.b])
        Assert: 同一 generation の同じ候補は二度通知されない。
        expect repeatedCandidates(aEvents.candidates) == []
        expect repeatedCandidates(bEvents.candidates) == []
        alive
        Act: rollback 後に B を適用し直す。
        a setLocal offerB
        b setRemote local(a)
        Assert: 除外済み transceiver の代わりに新しい object が正当な新規通知として 1 回ずつ出る。
        expect bEvents.remoteTransceivers.length == 2
        expect bEvents.tracks.length == 2
        let reapplied = bEvents.remoteTransceivers[1]
        expect reapplied isnt remoteAudio
        expect bEvents.tracks[1].transceiver is reapplied
        Act: B を final answer で確定する。
        b answer
        Assert: commit は通知を重ねず、分離した audio と既存 session が通信する。
        expect bEvents.remoteTransceivers.length == 2
        expect bEvents.tracks.length == 2
        expect repeatedCandidates(aEvents.candidates) == []
        expect repeatedCandidates(bEvents.candidates) == []
        do waitForDtlsConnected(reapplied.dtlsTransport)
        rtp audioOut -> reapplied.receiver.track
        alive
      `,
      fns: {
        /** Transports `pc` holds now that were not in `before`. */
        addedTransports: (
          pc: RTCPeerConnection,
          before: ReturnType<typeof heldTransports>,
        ) => [...heldTransports(pc)].filter((t) => !before.has(t)),
      },
    },
    `
      case: [2.3-1] a remote pranswer fires ontrack once before the final answer
      ref: 2.3-1
      given: createPeerPair()
      Arrange: 受信専用 video の初回 offer に、answerer が送信する pranswer を用意する。
      let events = recordNegotiationEvents(a)
      let receiving = a.addTransceiver("video", { direction: "recvonly" })
      a offer
      let outgoing = new MediaStreamTrack({ kind: "video" })
      let sending = b.getTransceivers()[0]
      do sending.setDirection("sendonly")
      do sending.sender.replaceTrack(outgoing)
      b createAnswer as=answer
      b setLocal answer type=pranswer
      expect events.tracks.length == 0
      Act: offerer が remote pranswer を適用する。
      a setRemote answer type=pranswer
      Assert: final answer 前に receiver の track が 1 回通知され、current は空のまま。
      expect events.tracks.length == 1
      expect events.tracks[0].transceiver is receiving
      expect events.tracks[0].receiver is receiving.receiver
      expect events.tracks[0].track is receiving.receiver.track
      expect a.currentRemoteDescription == null
      Assert: 通知した track に暫定 RTP が届く。
      do waitForPeersConnected(a, b)
      rtp outgoing -> receiving.receiver.track
      Act: 同じ内容の final answer で確定する。
      b setLocal answer
      a setRemote answer
      Assert: final answer は同じ receiver を再通知しない。
      expect events.tracks.length == 1
      rtp outgoing -> receiving.receiver.track
    `,
    `
      case: [2.3-2] rollback keeps the receiver and track and restores the last-stable stream association
      ref: 2.3-2
      given: createDuplexSession()
      Arrange: video に stream "stable-stream" を付けて確定し、別 stream へ移す re-offer を用意する。
      do aVideo.sender.setStreams([new MediaStream({ id: "stable-stream" })])
      a negotiate
      let events = recordNegotiationEvents(b)
      let receiver = bVideo.receiver
      let track = receiver.track
      expect receiver.remoteStreamIds == ["stable-stream"]
      do aVideo.sender.setStreams([new MediaStream({ id: "pending-stream" })])
      Act: stream を変えた re-offer を適用する。
      a offer
      Assert: 同じ receiver/track が新しい stream で通知される。
      expect events.tracks.length == 1
      expect events.tracks[0].receiver is receiver
      expect events.tracks[0].track is track
      expect streamIds(events.tracks[0]) == ["pending-stream"]
      Act: 両側で rollback する。
      a rollback
      Assert: receiver/track の identity を保ち、stream 関連は last-stable に戻る。
      expect bVideo.receiver is receiver
      expect receiver.track is track
      expect receiver.remoteStreamIds == ["stable-stream"]
      expect receiver.remoteStreamId is "stable-stream"
      Assert: rollback は track を通知し直さず、同じ track に RTP が届き続ける。
      expect events.tracks.length == 1
      rtp aOut -> track
      Act: stream の変更をもう一度交渉する。
      a negotiate
      Assert: last-stable からの stream 変更は実際の遷移なので再び 1 回通知される。
      expect events.tracks.length == 2
      expect events.tracks[1].track is track
      expect streamIds(events.tracks[1]) == ["pending-stream"]
      expect receiver.remoteStreamIds == ["pending-stream"]
    `,
    `
      case: [2.3-4] ontrack repeats only for a real stream addition or a transition to receiving
      ref: 2.3-4
      given: createDuplexSession()
      Arrange: stream "first" で video を確定し、b の通知を記録する。
      let first = new MediaStream({ id: "first" })
      do aVideo.sender.setStreams([first])
      a negotiate
      let events = recordNegotiationEvents(b)
      let track = bVideo.receiver.track
      Act: 何も変えない re-offer/answer を行う。
      a negotiate
      Assert: 受信方向も stream も変わらないので通知しない。
      expect events.tracks.length == 0
      Act: 同じ receiver に stream を追加した re-offer を適用し、同じ offer を再適用する。
      do aVideo.sender.setStreams([first, new MediaStream({ id: "second" })])
      a offer
      expect events.tracks.length == 1
      b setRemote local(a)
      Assert: stream 追加で 1 回だけ通知され、再適用では通知しない。
      expect events.tracks.length == 1
      expect events.tracks[0].track is track
      expect streamIds(events.tracks[0]) == ["first", "second"]
      Act: answer で確定する。
      b answer
      Assert: commit は同じ遷移を再通知しない。
      expect events.tracks.length == 1
      Act: a の送信を止める交渉をする。
      do aVideo.setDirection("recvonly")
      a negotiate
      Assert: 受信をやめる遷移では track を通知しない。
      expect events.tracks.length == 1
      Act: a の送信を再開する交渉をする。
      do aVideo.setDirection("sendrecv")
      a negotiate
      Assert: 受信方向への遷移で同じ receiver/track が 1 回だけ再通知される。
      expect events.tracks.length == 2
      expect events.tracks[1].receiver is bVideo.receiver
      expect events.tracks[1].track is track
      alive
    `,
    `
      case: [2.3-7] a remote-created transceiver kept by addTrack carries the next local offer
      ref: 2.3-7
      given: createKeptRemoteTransceiver()
      Arrange: addTrack で使った remote-created transceiver を rollback 後も残す。
      expect b.getTransceivers() == [kept]
      expect kept.sender.track is localTrack
      expect kept.mid == null
      Act: answerer 側から次の offer を作り、offerer の answer で確定する。
      b negotiate
      Assert: 残した transceiver が新しい m-line に関連付けられ、余分な transceiver は作られない。
      expect b.getTransceivers() == [kept]
      expect kept.mid != null
      expect b.currentLocalDescription.sdp.match(/^m=audio/gm).length == 1
      expect kept.currentDirection == "sendrecv"
      Assert: その m-line で localTrack の RTP が相手に届く。
      let received = offererEvents.tracks.find((event) => event.transceiver.mid === kept.mid)
      expect received != undefined
      do waitForPeersConnected(a, b)
      rtp localTrack -> received.track
    `,
    `
      case: [2.3-7] rollback leaves no candidate of the rolled-back offer on the kept transceiver's transport
      ref: 2.3-7
      given: createKeptRemoteTransceiver()
      Act: rollback 後に残った transport の live checklist を読む。
      let connection = kept.dtlsTransport.iceTransport.connection
      Assert: 旧 m-line との関連と共に、rollback した remote offer の候補も外れている。
      expect connection.remoteCandidates == []
    `,
    `
      case: [2.3-14] $outcome closes a remote-created channel of a pending-only association and drops it from the registry
      ref: 2.3-14
      given: createInitialPranswerDataChannel()
      each: [{ outcome: "rollback" }, { outcome: "replacement offer" }]
      Arrange: 初回 pranswer の provisional association で channel を開く。
      let provisionalTransport = remote.sctp
      expect registeredDataChannels(b) contains remote
      Act: pending-only association を rollback または replacement offer で破棄する。
      [outcome=rollback] a setLocal rollback
      [outcome=rollback] b setRemote rollback
      [outcome=replacement offer] a offer
      Assert: answerer の remote-created channel は閉じ、内部 registry から外れる。
      waitFor remote.readyState === "closed"
      expect Object.values(provisionalTransport.dataChannels) lacks remote
      expect registeredDataChannels(b) lacks remote
      Assert: 同じ association 上の offerer の channel も閉じ、channel は再通知されない。
      waitFor local.readyState === "closed"
      expect answererEvents.dataChannels == [remote]
    `,
    `
      case: [5-4] channels of a committed association stay open through a renegotiation rollback
      ref: 5-4
      given: createDuplexSession()
      Arrange: 確立済み session で re-offer を pranswer まで進める。
      let bEvents = recordNegotiationEvents(b)
      let association = a.sctpTransport
      a offer
      b pranswer
      Act: pending 中に committed association 上へ新しい channel を開く。
      let duringPending = a.createDataChannel("during-pending")
      waitFor duringPending.readyState === "open" && bEvents.dataChannels.length === 1
      let remoteDuringPending = bEvents.dataChannels[0]
      Act: 両側で rollback する。
      a rollback
      Assert: committed association とその上の channel はすべて open のまま通信できる。
      expect a.sctpTransport is association
      expect [aChannel, bChannel, duringPending, remoteDuringPending].map((c) => c.readyState) == ["open", "open", "open", "open"]
      do expectDataAlive(session, "committed-after-rollback")
      data duringPending -> remoteDuringPending
      Assert: rollback で channel が再通知されることはない。
      expect bEvents.dataChannels == [remoteDuringPending]
    `,
    `
      case: [2.3-19] an ICE restart pranswer and its rollback notify only real signaling transitions
      ref: 2.3-19
      given: createDuplexSession()
      Arrange: 接続済み session の状態通知を記録する。
      let aEvents = recordNegotiationEvents(a)
      let bEvents = recordNegotiationEvents(b)
      Act: ICE restart の pranswer で provisional generation を nominate させ、両側で rollback する。
      a offer restart
      b pranswer
      do waitForProvisionalNomination(a)
      a rollback
      alive
      Assert: signaling は実際の遷移だけを順に通知する。
      expect aEvents.signaling == ["have-local-offer", "have-remote-pranswer", "stable"]
      expect bEvents.signaling == ["have-remote-offer", "have-local-pranswer", "stable"]
      Assert: live の接続状態は変わらないので、接続状態の通知は出ない。
      expect [aEvents.connection, aEvents.iceConnection, bEvents.connection, bEvents.iceConnection] == [[], [], [], []]
      expect [a.connectionState, b.connectionState] == ["connected", "connected"]
    `,
    {
      text: `
        case: [2.3-19] rolling back a connection made at the first pranswer notifies only the new transitions
        ref: 2.3-19
        given: createInitialPranswerDataChannel()
        Arrange: 初回 pranswer で接続し、それまでの通知を控える。
        waitFor a.connectionState === "connected" && b.connectionState === "connected"
        let before = [counts(offererEvents), counts(answererEvents)]
        Assert: pranswer までの通知は重複のない実際の遷移になっている。
        expect offererEvents.signaling == ["have-local-offer", "have-remote-pranswer"]
        expect answererEvents.signaling == ["have-remote-offer", "have-local-pranswer"]
        expect offererEvents.connection.at(-1) is "connected"
        expect answererEvents.connection.at(-1) is "connected"
        expect repeatedStates(offererEvents.connection) == []
        expect repeatedStates(answererEvents.connection) == []
        Act: 両側で rollback する。
        a setLocal rollback
        b setRemote rollback
        Assert: rollback 後は stable と new への新しい遷移だけが 1 回ずつ追加される。
        expect since(offererEvents, before[0]) == { signaling: ["stable"], connection: ["new"], iceConnection: ["new"] }
        expect since(answererEvents, before[1]) == { signaling: ["stable"], connection: ["new"], iceConnection: ["new"] }
        expect [a.connectionState, b.connectionState] == ["new", "new"]
      `,
      fns: {
        /** How many state events of each kind `events` holds now. */
        counts: (events: NegotiationEvents) => ({
          signaling: events.signaling.length,
          connection: events.connection.length,
          iceConnection: events.iceConnection.length,
        }),
        /** The state events added after `before` (from `counts`). */
        since: (
          events: NegotiationEvents,
          before: Record<"signaling" | "connection" | "iceConnection", number>,
        ) => ({
          signaling: events.signaling.slice(before.signaling),
          connection: events.connection.slice(before.connection),
          iceConnection: events.iceConnection.slice(before.iceConnection),
        }),
        /** States reported twice in a row. */
        repeatedStates: (states: string[]) =>
          states.filter((state, index) => states[index - 1] === state),
      },
    },
    `
      case: [2.3-19] negotiationneeded waits for stable and is recomputed once after rollback
      ref: 2.3-19
      given: createDuplexSession()
      Arrange: 確立済み session で a の re-offer を pending にする。
      let aEvents = recordNegotiationEvents(a)
      a offer
      Act: pending 中に application が transceiver を追加する。
      let added = a.addTransceiver("audio")
      sleep 20
      Assert: stable でない間は negotiationneeded を通知しない。
      expect aEvents.negotiationNeeded == 0
      Act: 両側で rollback する。
      a rollback
      Assert: stable に戻った時点で必要性を再計算し、1 回だけ通知する。
      waitFor aEvents.negotiationNeeded !== 0
      sleep 20
      expect aEvents.negotiationNeeded == 1
      expect a.getTransceivers() contains added
      Act: 追加した transceiver を交渉する。
      a negotiate
      sleep 20
      Assert: 交渉済みの変更について再び通知しない。
      expect aEvents.negotiationNeeded == 1
    `,
    {
      text: `
        case: [2.3-21] re-applying the same pranswer creates no new channel, transceiver or event
        ref: 2.3-21
        given: createMutationSession("initial")
        Arrange: video と DataChannel の初回 pranswer で暫定通信を始め、両側の通知を記録する。
        let aEvents = recordNegotiationEvents(a)
        let bEvents = recordNegotiationEvents(b)
        a offer
        do prepareMutationAnswerer(session)
        b createAnswer as=answer
        b setLocal answer type=pranswer
        a setRemote answer type=pranswer
        do waitForMutationSession(session)
        let remoteChannel = session.b.channel
        let objects = objectsOf([a, b])
        let counts = () => [aEvents, bEvents].map((events) => ({ tracks: events.tracks.length, remoteTransceivers: events.remoteTransceivers.length, dataChannels: events.dataChannels.length }))
        let before = counts()
        expect before[1] == { tracks: 1, remoteTransceivers: 1, dataChannels: 1 }
        Act: 同じ pranswer を両側に再適用する。
        b setLocal answer type=pranswer
        a setRemote answer type=pranswer
        Assert: track/transceiver/channel の通知も object も増えず、同じ channel が open のまま。
        expect counts() == before
        expect objectsOf([a, b]) == objects
        expect session.b.channel is remoteChannel
        expect remoteChannel.readyState == "open"
        expect repeatedCandidates(aEvents.candidates) == []
        expect repeatedCandidates(bEvents.candidates) == []
        alive
        Act: 同じ内容の final answer で確定する。
        b setLocal answer type=answer
        a setRemote answer type=answer
        Assert: commit でも通知は増えず、同じ channel で通信を続ける。
        expect counts() == before
        expect session.b.channel is remoteChannel
        alive
      `,
      fns: {
        /** The transceivers and transports each peer holds. */
        objectsOf: (pcs: RTCPeerConnection[]) =>
          pcs.map((pc) => ({
            transceivers: pc.getTransceivers(),
            sctp: pc.sctpTransport,
            dtls: pc.dtlsTransports,
          })),
      },
    },
    `
      case: [2.3-22] a DCEP reusing a stream ID on a new association after rollback creates a new channel
      ref: 2.3-22
      given: createInitialPranswerDataChannel("first")
      Arrange: 初回 pranswer の association で channel を開いてから両側で rollback する。
      let firstStreamId = remote.id
      a setLocal rollback
      b setRemote rollback
      waitFor local.readyState === "closed" && remote.readyState === "closed"
      Act: 新しい channel で交渉し直し、新しい association を確定する。
      let second = a.createDataChannel("second")
      a negotiate
      waitFor second.readyState === "open" && answererEvents.dataChannels.length === 2
      Assert: 同じ stream ID でも association が違うので新しい object と event が作られる。
      expect second.id == firstStreamId
      expect answererEvents.dataChannels.length == 2
      let renewed = answererEvents.dataChannels[1]
      expect renewed isnt remote
      expect renewed like { id: firstStreamId, label: "second" }
      Assert: 旧 channel は閉じたままで、新しい channel だけが通信する。
      expect remote.readyState == "closed"
      data second -> renewed
      data renewed -> second
    `,
    {
      text: `
        case: [2.3-24] a DCEP held past rollback is not delivered, while the provisional channel still gets its close event
        ref: 2.3-24
        given: createInitialPranswerDataChannel("first")
        Arrange: 初回 pranswer の channel を開き、answerer に届く次の DCEP を保留する。
        let remoteEvents = recordChannelEvents(remote)
        let provisionalTransport = remote.sctp
        let dcep = holdIncomingDcep(b)
        let late = a.createDataChannel("late")
        waitFor dcep.held !== 0
        Act: 両側で rollback してから保留した DCEP を配送する。
        a setLocal rollback
        b setRemote rollback
        do dcep.release()
        sleep 50
        Assert: 廃棄済み transaction の DCEP は ondatachannel を発火せず、registry にも入らない。
        expect answererEvents.dataChannels == [remote]
        expect Object.values(provisionalTransport.dataChannels).map((c) => c.label) lacks "late"
        expect registeredDataChannels(b).map((channel) => channel.label) lacks "late"
        Assert: 既に渡した channel には close が 1 回配送される。
        expect remote.readyState == "closed"
        expect remoteEvents.states.at(-1) == "closed"
        expect remoteEvents.closes == 1
        Assert: 保留中だった offerer 側の channel も pending-only association と共に閉じる。
        waitFor late.readyState === "closed"
        invariants
      `,
      fns: {
        /** The state changes and `close` events `channel` delivers from now on. */
        recordChannelEvents: (channel: RTCDataChannel) => {
          const record = { states: [] as string[], closes: 0 };
          channel.stateChanged.subscribe((state) => {
            record.states.push(state);
          });
          channel.addEventListener("close", () => record.closes++);
          return record;
        },
      },
    },
  ],
  {
    fns: {
      /** Candidates signalled more than once (same m-line and candidate line). */
      repeatedCandidates: (candidates: NegotiationEvents["candidates"]) => {
        const keys = candidates
          .filter((candidate) => candidate !== undefined)
          .map((candidate) => `${candidate!.sdpMid} ${candidate!.candidate}`);
        return keys.filter((key, index) => keys.indexOf(key) !== index);
      },
      /** The stream IDs of a track event. */
      streamIds: (event: NegotiationEvents["tracks"][number]) =>
        event.streams.map((stream) => stream.id),
    },
  },
);
