import { vi } from "vitest";

import {
  MediaStreamTrack,
  RTCPeerConnection,
  RTCRtpCodecParameters,
} from "../../src";
import {
  assertNegotiationInvariants,
  createConnectedVideoPeers,
  sendAndExpectRtp,
  waitForConnection,
  waitForIce,
  waitForPendingTransport,
} from "./negotiationTransactionUtils";

describe("negotiation transaction", () => {
  test("rollback preserves application stop and a new trackless transceiver", async () => {
    const { offerer, answerer, outgoing, incoming } =
      await createConnectedVideoPeers();
    try {
      // Arrange: 接続済み transceiver の identity と現在の SDP を控える。
      const existing = answerer.getTransceivers()[0];
      const currentRemote = answerer.currentRemoteDescription!.sdp;
      await offerer.setLocalDescription(await offerer.createOffer());
      await answerer.setRemoteDescription(offerer.localDescription!);

      // Act: pending 中にアプリが停止と track のない transceiver 追加を行う。
      existing.stop();
      const added = answerer.addTransceiver("audio", { direction: "recvonly" });
      await answerer.setRemoteDescription({ type: "rollback" });

      // Assert: SDP 由来の状態だけが戻り、アプリ操作と旧実通信が残る。
      expect(answerer.getTransceivers()).toContain(existing);
      expect(existing.stopping).toBe(true);
      expect(answerer.getTransceivers()).toContain(added);
      expect(added.sender.track).toBeNull();
      expect(added.mid).toBeNull();
      expect(answerer.currentRemoteDescription!.sdp).toBe(currentRemote);
      await sendAndExpectRtp(outgoing, incoming, "app-operations-rollback");
    } finally {
      await Promise.allSettled([offerer.close(), answerer.close()]);
    }
  });

  test("ICE restart pranswer connects a pending generation and rollback keeps current RTP", async () => {
    const { offerer, answerer, outgoing, incoming } =
      await createConnectedVideoPeers();
    try {
      // Arrange: 現行 pair と ICE generation を記録する。
      const oldOffererTransport = offerer.iceTransports[0];
      const oldAnswererTransport = answerer.iceTransports[0];
      const oldPair = oldOffererTransport.getSelectedCandidatePair();
      const currentRemote = answerer.currentRemoteDescription!.sdp;

      // Act: restart offer と pranswer で別の ICE/DTLS generation を接続する。
      await offerer.setLocalDescription(
        await offerer.createOffer({ iceRestart: true }),
      );
      await answerer.setRemoteDescription(offerer.localDescription!);
      const answer = await answerer.createAnswer();
      await answerer.setLocalDescription({ type: "pranswer", sdp: answer.sdp });
      await offerer.setRemoteDescription({
        type: "pranswer",
        sdp: answerer.localDescription!.sdp,
      });
      await Promise.all([
        waitForPendingTransport(offerer),
        waitForPendingTransport(answerer),
      ]);
      await sendAndExpectRtp(
        outgoing,
        incoming,
        "pending-restart-before-rollback",
      );

      // Act: 双方の pending description を破棄する。
      await offerer.setLocalDescription({ type: "rollback" });
      await answerer.setRemoteDescription({ type: "rollback" });

      // Assert: 旧 pair と SDP に戻り、RTP が実際に届く。
      expect(offerer.iceTransports[0]).toBe(oldOffererTransport);
      expect(answerer.iceTransports[0]).toBe(oldAnswererTransport);
      expect(oldOffererTransport.getSelectedCandidatePair()).toEqual(oldPair);
      expect(answerer.currentRemoteDescription!.sdp).toBe(currentRemote);
      await sendAndExpectRtp(
        outgoing,
        incoming,
        "pending-restart-after-rollback",
      );
      assertNegotiationInvariants(offerer);
      assertNegotiationInvariants(answerer);
    } finally {
      await Promise.allSettled([offerer.close(), answerer.close()]);
    }
  }, 10000);

  test("rollback removes remote-only objects and a repeated offer does not duplicate events", async () => {
    const offerer = new RTCPeerConnection();
    const answerer = new RTCPeerConnection();
    const onTrack = vi.fn();
    const onRemoteTransceiver = vi.fn();
    answerer.onTrack.subscribe(onTrack);
    answerer.onRemoteTransceiverAdded.subscribe(onRemoteTransceiver);

    try {
      // Arrange: remote offer が初回の transceiver を生成する。
      offerer.addTransceiver("audio");
      const offer = await offerer.createOffer();

      // Act: 同じ offer を再適用してから rollback する。
      await answerer.setRemoteDescription(offer);
      assertNegotiationInvariants(answerer);
      await answerer.setRemoteDescription(offer);

      // Assert: 同じ receiver と transceiver への通知は一度だけ。
      expect(onRemoteTransceiver).toHaveBeenCalledTimes(1);
      expect(onTrack).toHaveBeenCalledTimes(1);
      const oldTransceiver = answerer.getTransceivers()[0];
      await answerer.setRemoteDescription({ type: "rollback" });
      assertNegotiationInvariants(answerer);
      expect(answerer.getTransceivers()).toHaveLength(0);
      expect(oldTransceiver.stopped).toBe(true);

      // Act: rollback 後の新しい offer は新しい object を作る。
      await answerer.setRemoteDescription(offer);

      // Assert: 新しい receiver 遷移に対する通知だけが追加される。
      expect(onRemoteTransceiver).toHaveBeenCalledTimes(2);
      expect(onTrack).toHaveBeenCalledTimes(2);
      expect(answerer.getTransceivers()[0]).not.toBe(oldTransceiver);
    } finally {
      await Promise.allSettled([offerer.close(), answerer.close()]);
    }
  });

  test("rollback keeps a remote-created transceiver that received a local track", async () => {
    const offerer = new RTCPeerConnection();
    const answerer = new RTCPeerConnection();
    const localTrack = new MediaStreamTrack({ kind: "audio" });
    try {
      // Arrange: remote offer で作成された transceiver に application が送信 track を付ける。
      offerer.addTransceiver("audio", { direction: "sendonly" });
      await answerer.setRemoteDescription(await offerer.createOffer());
      const transceiver = answerer.getTransceivers()[0];
      answerer.addTrack(localTrack);

      // Act: remote offer を取り消す。
      await answerer.setRemoteDescription({ type: "rollback" });

      // Assert: application 所有の sender/track は残り、旧 m-line との関連だけ外れる。
      assertNegotiationInvariants(answerer);
      expect(answerer.getTransceivers()).toContain(transceiver);
      expect(transceiver.sender.track).toBe(localTrack);
      expect(transceiver.mid).toBeNull();
      expect(transceiver.mLineIndex).toBeUndefined();
    } finally {
      await Promise.allSettled([offerer.close(), answerer.close()]);
    }
  });

  test("rollback removes provisional receiver SSRC mappings on an existing track", async () => {
    const { offerer, answerer, outgoing, incoming } =
      await createConnectedVideoPeers();
    try {
      // Arrange: 既存 m-line に別 SSRC を提案する re-offer を作る。
      const receiver = answerer.getTransceivers()[0].receiver;
      const originalTracks = [...receiver.tracks];
      const originalSsrc = offerer.getTransceivers()[0].sender.ssrc;
      const provisionalSsrc = originalSsrc + 1;
      const offer = await offerer.createOffer();
      const changedSsrcOffer = {
        type: "offer" as const,
        sdp: offer.sdp.replaceAll(
          originalSsrc.toString(),
          provisionalSsrc.toString(),
        ),
      };

      // Act: 追加 SSRC を一時登録してから offer を取り消す。
      await answerer.setRemoteDescription(changedSsrcOffer);
      expect(receiver.trackBySSRC[provisionalSsrc]).toBeDefined();
      await answerer.setRemoteDescription({ type: "rollback" });

      // Assert: receiver の object は維持し、追加 track と SSRC 経路を除去する。
      assertNegotiationInvariants(answerer);
      expect(receiver.tracks).toEqual(originalTracks);
      expect(receiver.trackBySSRC[provisionalSsrc]).toBeUndefined();
      await sendAndExpectRtp(outgoing, incoming, "old-ssrc-after-rollback");
    } finally {
      await Promise.allSettled([offerer.close(), answerer.close()]);
    }
  });

  test("remote ICE restart offer and pending trickle leave the current RTP path alive through rollback", async () => {
    const { offerer, answerer, outgoing, incoming } =
      await createConnectedVideoPeers();
    try {
      // Arrange: committed ICE credentials と候補 pair を記録する。
      const transport = answerer.iceTransports[0];
      const oldUfrag = transport.getRemoteParameters()!.usernameFragment;
      const oldPair = transport.getSelectedCandidatePair();
      const currentRemote = answerer.currentRemoteDescription!.sdp;
      await sendAndExpectRtp(outgoing, incoming, "before-pending");
      const offer = await offerer.createOffer();
      const newUfrag = "newgeneration123";
      const newPassword = "newgenerationpassword123456";
      const restartOffer = {
        type: "offer" as const,
        sdp: offer.sdp
          .replaceAll(`a=ice-ufrag:${oldUfrag}`, `a=ice-ufrag:${newUfrag}`)
          .replace(/a=ice-pwd:[^\r\n]+/g, `a=ice-pwd:${newPassword}`),
      };

      // Act: restart proposal とその generation の trickle を pending に置く。
      await answerer.setRemoteDescription(restartOffer);
      assertNegotiationInvariants(answerer);
      await answerer.addIceCandidate({
        candidate:
          "candidate:pending 1 udp 2113937151 192.0.2.10 12345 typ host",
        sdpMid:
          answerer.pendingRemoteDescription!.sdp.match(/a=mid:([^\r\n]+)/)![1],
        usernameFragment: newUfrag,
      });
      await sendAndExpectRtp(outgoing, incoming, "during-pending");

      // Assert: current ICE pair と RTP は pending 中も保持される。
      expect(transport.getRemoteParameters()!.usernameFragment).toBe(oldUfrag);
      expect(transport.getSelectedCandidatePair()).toEqual(oldPair);
      expect(answerer.currentRemoteDescription!.sdp).toBe(currentRemote);

      // Act: pranswer を一時適用しても旧 pair を使い、restart proposal を取り消す。
      const provisional = await answerer.createAnswer();
      await answerer.setLocalDescription({
        type: "pranswer",
        sdp: provisional.sdp,
      });
      expect(transport.getSelectedCandidatePair()).toEqual(oldPair);
      await sendAndExpectRtp(outgoing, incoming, "restart-pranswer-rollback");
      await answerer.setRemoteDescription({ type: "rollback" });
      await sendAndExpectRtp(outgoing, incoming, "after-rollback");

      // Assert: pending の候補は current SDP に移らず、旧 pair が続く。
      assertNegotiationInvariants(answerer);
      expect(answerer.currentRemoteDescription!.sdp).toBe(currentRemote);
      expect(transport.getSelectedCandidatePair()).toEqual(oldPair);
    } finally {
      await Promise.allSettled([offerer.close(), answerer.close()]);
    }
  });

  test("validation failure leaves the current descriptions and SCTP association unchanged", async () => {
    const { offerer, answerer } = await createConnectedVideoPeers();
    try {
      // Arrange: current descriptions と transport identity を控える。
      const remote = answerer.currentRemoteDescription!.sdp;
      const transport = answerer.dtlsTransports[0];
      const offer = await offerer.createOffer();
      const invalid = offer.sdp
        .replace(/a=mid:([^\r\n]+)/, "a=mid:wrong")
        .replace(/a=group:BUNDLE [^\r\n]+/, "a=group:BUNDLE wrong");

      // Act: 既存 m-line の MID を変えた offer を適用する。
      await expect(
        answerer.setRemoteDescription({ type: "offer", sdp: invalid }),
      ).rejects.toMatchObject({ name: "InvalidModificationError" });

      // Assert: SDP、transport、signaling は最後の stable のまま。
      assertNegotiationInvariants(answerer);
      expect(answerer.currentRemoteDescription!.sdp).toBe(remote);
      expect(answerer.dtlsTransports[0]).toBe(transport);
      expect(answerer.signalingState).toBe("stable");
    } finally {
      await Promise.allSettled([offerer.close(), answerer.close()]);
    }
  });

  test("local SDP direction munging stays available while ICE credentials are checked", async () => {
    const peer = new RTCPeerConnection();
    try {
      // Arrange: 送受信可能な audio offer を作る。
      peer.addTransceiver("audio");
      const offer = await peer.createOffer();

      // Act: application が direction を変更した local offer を適用する。
      await peer.setLocalDescription({
        type: "offer",
        sdp: offer.sdp.replace("a=sendrecv", "a=recvonly"),
      });

      // Assert: SDP の media 編集は受け入れ、未確定のまま保持する。
      expect(peer.pendingLocalDescription!.sdp).toContain("a=recvonly");
      await peer.setLocalDescription({ type: "rollback" });
      const nextOffer = await peer.createOffer();

      // Act / Assert: 未準備の ICE credential への書換えは適用前に拒否する。
      await expect(
        peer.setLocalDescription({
          type: "offer",
          sdp: nextOffer.sdp.replace(
            /a=ice-ufrag:[^\r\n]+/,
            "a=ice-ufrag:wronggeneration",
          ),
        }),
      ).rejects.toMatchObject({ name: "InvalidModificationError" });
      expect(peer.signalingState).toBe("stable");
      expect(peer.pendingLocalDescription).toBeNull();
    } finally {
      await peer.close();
    }
  });

  test("an unsupported offered codec rejects only its m-line", async () => {
    const offerer = new RTCPeerConnection({
      codecs: {
        audio: [
          new RTCRtpCodecParameters({
            mimeType: "audio/PCMU",
            clockRate: 8000,
            channels: 1,
          }),
        ],
      },
    });
    const answerer = new RTCPeerConnection({
      codecs: {
        audio: [
          new RTCRtpCodecParameters({
            mimeType: "audio/opus",
            clockRate: 48000,
            channels: 2,
          }),
        ],
      },
    });
    const onTrack = vi.fn();
    answerer.onTrack.subscribe(onTrack);
    try {
      // Arrange: codec の共通集合がない audio offer を作る。
      offerer.addTransceiver("audio");
      await offerer.setLocalDescription(await offerer.createOffer());

      // Act: remote offer を受け、answer を適用する。
      await answerer.setRemoteDescription(offerer.localDescription!);
      const answer = await answerer.createAnswer();
      await answerer.setLocalDescription(answer);

      // Assert: m-line 単位で拒否し、track event を送らない。
      expect(answerer.currentLocalDescription!.sdp).toMatch(/m=audio 0 /);
      expect(onTrack).not.toHaveBeenCalled();
      assertNegotiationInvariants(answerer);
    } finally {
      await Promise.allSettled([offerer.close(), answerer.close()]);
    }
  });

  test("replacement offer discards earlier pending trickle while keeping the baseline", async () => {
    const { offerer, answerer, outgoing, incoming } =
      await createConnectedVideoPeers();
    try {
      // Arrange: stable の remote SDP と candidate 数を控える。
      const current = answerer.currentRemoteDescription!.sdp;
      const offerA = await offerer.createOffer();
      const ufragA = offerA.sdp.match(/a=ice-ufrag:([^\r\n]+)/)![1];
      const mid = offerA.sdp.match(/a=mid:([^\r\n]+)/)![1];
      const offerB = {
        type: "offer" as const,
        sdp: offerA.sdp.replaceAll(
          `a=ice-ufrag:${ufragA}`,
          "a=ice-ufrag:replacement123",
        ),
      };

      // Act: A に candidate を積み、B で置換する。
      await answerer.setRemoteDescription(offerA);
      await answerer.addIceCandidate({
        candidate:
          "candidate:oldpending 1 udp 2113937151 192.0.2.12 12347 typ host",
        sdpMid: mid,
        usernameFragment: ufragA,
      });
      await answerer.setRemoteDescription(offerB);
      await sendAndExpectRtp(outgoing, incoming, "replacement");

      // Assert: 古い pending candidate と revision は current に漏れない。
      expect(answerer.pendingRemoteDescription!.sdp).not.toContain(
        "oldpending",
      );
      expect(answerer.currentRemoteDescription!.sdp).toBe(current);
      assertNegotiationInvariants(answerer);
      await answerer.setRemoteDescription({ type: "rollback" });
      assertNegotiationInvariants(answerer);
      expect(answerer.currentRemoteDescription!.sdp).toBe(current);
    } finally {
      await Promise.allSettled([offerer.close(), answerer.close()]);
    }
  });

  test("initial pranswer starts provisional DataChannel traffic and rollback closes it", async () => {
    const offerer = new RTCPeerConnection();
    const answerer = new RTCPeerConnection();
    const localChannel = offerer.createDataChannel("provisional");
    let remoteChannel: typeof localChannel | undefined;
    answerer.onDataChannel.subscribe((channel) => {
      remoteChannel = channel;
    });
    try {
      // Arrange: application m-line を持つ初回 offer を適用する。
      await offerer.setLocalDescription(await offerer.createOffer());
      await answerer.setRemoteDescription(offerer.localDescription!);
      const answer = await answerer.createAnswer();

      // Act: final answer を待たずに pranswer で接続する。
      await answerer.setLocalDescription({ type: "pranswer", sdp: answer.sdp });
      await offerer.setRemoteDescription({
        type: "pranswer",
        sdp: answerer.localDescription!.sdp,
      });
      if (localChannel.readyState !== "open") {
        await localChannel.stateChanged.watch((state) => state === "open");
      }

      // Assert: stable/current は空のままで provisional channel が公開される。
      expect(localChannel.readyState).toBe("open");
      expect(remoteChannel?.label).toBe("provisional");
      expect(offerer.currentRemoteDescription).toBeNull();
      expect(answerer.currentLocalDescription).toBeNull();

      // Act: provisional negotiation を rollback する。
      await offerer.setLocalDescription({ type: "rollback" });
      await answerer.setRemoteDescription({ type: "rollback" });

      // Assert: current は空で pending-only association の channel は閉じる。
      assertNegotiationInvariants(offerer);
      assertNegotiationInvariants(answerer);
      expect(localChannel.readyState).toBe("closed");
      expect(offerer.currentLocalDescription).toBeNull();
      expect(offerer.iceTransports[0].state).toBe("new");
    } finally {
      await Promise.allSettled([offerer.close(), answerer.close()]);
    }
  });

  test("initial pranswer carries provisional RTP before final commit", async () => {
    const offerer = new RTCPeerConnection();
    const answerer = new RTCPeerConnection();
    const outgoing = new MediaStreamTrack({ kind: "video" });
    let incoming: MediaStreamTrack | undefined;
    answerer.onRemoteTransceiverAdded.subscribe((transceiver) => {
      transceiver.onTrack.subscribe((track) => {
        incoming = track;
      });
    });
    try {
      // Arrange: video の初回 offer を受け、receiver を pending に生成する。
      offerer.addTransceiver(outgoing, { direction: "sendonly" });
      await offerer.setLocalDescription(await offerer.createOffer());
      await answerer.setRemoteDescription(offerer.localDescription!);
      const answer = await answerer.createAnswer();

      // Act: 双方の pranswer だけで ICE/DTLS と RTP を開始する。
      await answerer.setLocalDescription({ type: "pranswer", sdp: answer.sdp });
      await offerer.setRemoteDescription({
        type: "pranswer",
        sdp: answerer.localDescription!.sdp,
      });
      await Promise.all([
        waitForConnection(offerer),
        waitForConnection(answerer),
      ]);
      expect(incoming).toBeDefined();
      await sendAndExpectRtp(outgoing, incoming!, "provisional-rtp");

      // Act / Assert: 接続済み provisional DTLS の証明書差替えは拒否する。
      await expect(
        offerer.setRemoteDescription({
          type: "answer",
          sdp: answer.sdp.replace(
            /a=fingerprint:sha-256 [^\r\n]+/,
            `a=fingerprint:sha-256 ${Array(32).fill("00").join(":")}`,
          ),
        }),
      ).rejects.toMatchObject({ name: "InvalidModificationError" });

      // Assert: current description は空のまま通信し、rollback で仮 transceiver を除外する。
      expect(answerer.currentRemoteDescription).toBeNull();
      expect(offerer.currentLocalDescription).toBeNull();
      await offerer.setLocalDescription({ type: "rollback" });
      await answerer.setRemoteDescription({ type: "rollback" });
      assertNegotiationInvariants(answerer);
      expect(answerer.getTransceivers()).toHaveLength(0);
    } finally {
      await Promise.allSettled([offerer.close(), answerer.close()]);
    }
  }, 15000);

  test("re-offer pranswer carries new RTP alongside the committed stream", async () => {
    const { offerer, answerer, outgoing, incoming } =
      await createConnectedVideoPeers();
    const provisionalAudio = new MediaStreamTrack({ kind: "audio" });
    let receivedAudio: MediaStreamTrack | undefined;
    answerer.onRemoteTransceiverAdded.subscribe((transceiver) => {
      if (transceiver.kind === "audio") {
        transceiver.onTrack.subscribe((track) => {
          receivedAudio = track;
        });
      }
    });
    try {
      // Arrange: 接続済み video に新しい audio m-line を加える。
      const currentRemote = answerer.currentRemoteDescription!.sdp;
      const selectedPair = answerer.iceTransports[0].getSelectedCandidatePair();
      offerer.addTransceiver(provisionalAudio, { direction: "sendonly" });
      await offerer.setLocalDescription(await offerer.createOffer());
      await answerer.setRemoteDescription(offerer.localDescription!);
      const answer = await answerer.createAnswer();

      // Act: pranswer 中に新 audio と旧 video の RTP を両方送る。
      await answerer.setLocalDescription({ type: "pranswer", sdp: answer.sdp });
      await offerer.setRemoteDescription({
        type: "pranswer",
        sdp: answerer.localDescription!.sdp,
      });
      expect(receivedAudio).toBeDefined();
      await sendAndExpectRtp(provisionalAudio, receivedAudio!, "pending-audio");
      await sendAndExpectRtp(outgoing, incoming, "current-video");

      // Assert: current の SDP と ICE pair は pranswer では入れ替わらない。
      expect(answerer.currentRemoteDescription!.sdp).toBe(currentRemote);
      expect(answerer.iceTransports[0].getSelectedCandidatePair()).toEqual(
        selectedPair,
      );

      // Act: rollback で新 audio を外し、旧 video は送り続ける。
      await offerer.setLocalDescription({ type: "rollback" });
      await answerer.setRemoteDescription({ type: "rollback" });
      await sendAndExpectRtp(outgoing, incoming, "post-pranswer-video");

      // Assert: 接続中の current 経路と description が維持される。
      assertNegotiationInvariants(answerer);
      expect(answerer.currentRemoteDescription!.sdp).toBe(currentRemote);
      expect(answerer.iceTransports[0].getSelectedCandidatePair()).toEqual(
        selectedPair,
      );
    } finally {
      await Promise.allSettled([offerer.close(), answerer.close()]);
    }
  }, 15000);

  test("a final answer can replace provisional SCTP limits without another channel event", async () => {
    const offerer = new RTCPeerConnection();
    const answerer = new RTCPeerConnection();
    const channel = offerer.createDataChannel("limits");
    const onDataChannel = vi.fn();
    answerer.onDataChannel.subscribe(onDataChannel);
    try {
      // Arrange: application offer と provisional answer を作る。
      await offerer.setLocalDescription(await offerer.createOffer());
      await answerer.setRemoteDescription(offerer.localDescription!);
      const answer = await answerer.createAnswer();
      const provisionalSdp = answer.sdp.replace(
        /a=max-message-size:[^\r\n]+/,
        "a=max-message-size:4096",
      );
      await answerer.setLocalDescription({
        type: "pranswer",
        sdp: provisionalSdp,
      });
      await offerer.setRemoteDescription({
        type: "pranswer",
        sdp: answerer.localDescription!.sdp,
      });
      if (channel.readyState !== "open") {
        await channel.stateChanged.watch((state) => state === "open");
      }

      // Act: provisional answer を置換しても既存 channel object を再通知しない。
      const replacementSdp = answer.sdp.replace(
        /a=max-message-size:[^\r\n]+/,
        "a=max-message-size:3072",
      );
      await answerer.setLocalDescription({
        type: "pranswer",
        sdp: replacementSdp,
      });
      await offerer.setRemoteDescription({
        type: "pranswer",
        sdp: answerer.localDescription!.sdp,
      });
      expect(offerer.currentRemoteDescription).toBeNull();
      expect(channel.readyState).toBe("open");

      // Act: 最終 answer では別の max-message-size を採用する。
      const finalSdp = answer.sdp.replace(
        /a=max-message-size:[^\r\n]+/,
        "a=max-message-size:2048",
      );
      await answerer.setLocalDescription({ type: "answer", sdp: finalSdp });
      await offerer.setRemoteDescription(answerer.localDescription!);

      // Assert: final SDP と association の上限が一致し、channel は再通知されない。
      assertNegotiationInvariants(offerer);
      assertNegotiationInvariants(answerer);
      expect(offerer.sctpTransport!.remoteMaxMessageSize).toBe(2048);
      expect(channel.readyState).toBe("open");
      expect(onDataChannel).toHaveBeenCalledTimes(1);
    } finally {
      await Promise.allSettled([offerer.close(), answerer.close()]);
    }
  });

  test("duplicate trickle candidate and EOC are idempotent within one generation", async () => {
    const offerer = new RTCPeerConnection();
    const answerer = new RTCPeerConnection();
    try {
      // Arrange: gathered candidate と EOC を含む offer を適用する。
      offerer.addTransceiver("audio");
      await offerer.setLocalDescription(await offerer.createOffer());
      await answerer.setRemoteDescription(offerer.localDescription!);
      const sdp = answerer.remoteDescription!.sdp;
      const candidate = sdp.match(/a=(candidate:[^\r\n]+)/)![1];
      const mid = sdp.match(/a=mid:([^\r\n]+)/)![1];
      const ufrag = sdp.match(/a=ice-ufrag:([^\r\n]+)/)![1];
      const beforeCount =
        answerer.iceTransports[0].getRemoteCandidates().length;

      // Act: 同じ candidate と EOC を二度ずつ trickle する。
      await answerer.addIceCandidate({
        candidate,
        sdpMid: mid,
        usernameFragment: ufrag,
      });
      await answerer.addIceCandidate({
        candidate,
        sdpMid: mid,
        usernameFragment: ufrag,
      });
      await answerer.addIceCandidate({
        candidate: "",
        sdpMid: mid,
        usernameFragment: ufrag,
      });
      await answerer.addIceCandidate({
        candidate: "",
        sdpMid: mid,
        usernameFragment: ufrag,
      });

      // Assert: description と ICE checklist に重複しない。
      expect(answerer.remoteDescription!.sdp).toBe(sdp);
      expect(answerer.iceTransports[0].getRemoteCandidates()).toHaveLength(
        beforeCount,
      );
    } finally {
      await Promise.allSettled([offerer.close(), answerer.close()]);
    }
  });

  test("both peers commit matching local and remote ICE restart generations", async () => {
    const { offerer, answerer, outgoing, incoming } =
      await createConnectedVideoPeers();
    try {
      // Arrange: current nomination と generation を控える。
      const oldGeneration = offerer.iceGeneration;
      const oldPair = offerer.iceTransports[0].getSelectedCandidatePair();

      // Act: local restart offer は pending に置き、旧 nomination を維持する。
      const offer = await offerer.createOffer({ iceRestart: true });
      const offeredUfrag = offer.sdp.match(/a=ice-ufrag:([^\r\n]+)/)![1];
      expect(offerer.iceGeneration).toBe(oldGeneration);
      await offerer.setLocalDescription(offer);
      expect(offerer.iceTransports[0].getSelectedCandidatePair()).toEqual(
        oldPair,
      );
      await sendAndExpectRtp(outgoing, incoming, "restart-pending");

      // Act: remote peer も新 generation を answer し、双方で確定する。
      await answerer.setRemoteDescription(offerer.localDescription!);
      const answer = await answerer.createAnswer();
      const answeredUfrag = answer.sdp.match(/a=ice-ufrag:([^\r\n]+)/)![1];
      await answerer.setLocalDescription({ type: "pranswer", sdp: answer.sdp });
      await offerer.setRemoteDescription({
        type: "pranswer",
        sdp: answerer.localDescription!.sdp,
      });
      // Assert: pranswer だけで新しい ICE/DTLS pair が接続する。
      await Promise.all([
        waitForPendingTransport(offerer),
        waitForPendingTransport(answerer),
      ]);

      // Assert: pranswer 中は旧 nomination で RTP が続き、current は旧 SDP のまま。
      expect(offerer.iceTransports[0].getSelectedCandidatePair()).toEqual(
        oldPair,
      );
      expect(offerer.iceGeneration).toBe(oldGeneration);
      await sendAndExpectRtp(outgoing, incoming, "restart-pranswer");

      // Act: 最終 answer で新 generation へ切り替える。
      await answerer.setLocalDescription({ type: "answer", sdp: answer.sdp });
      await offerer.setRemoteDescription(answerer.localDescription!);
      await Promise.all([
        waitForIce(offerer),
        waitForIce(answerer),
        waitForConnection(offerer),
        waitForConnection(answerer),
      ]);

      // Assert: answer SDP、transport credentials と新 nomination が一致する。
      assertNegotiationInvariants(offerer);
      assertNegotiationInvariants(answerer);
      expect(offerer.iceGeneration).toBeGreaterThan(oldGeneration);
      expect(offerer.iceTransports[0].localParameters.usernameFragment).toBe(
        offeredUfrag,
      );
      expect(answerer.iceTransports[0].localParameters.usernameFragment).toBe(
        answeredUfrag,
      );
      expect(
        offerer.iceTransports[0].getSelectedCandidatePair(),
      ).not.toBeNull();
      await sendAndExpectRtp(outgoing, incoming, "restart-committed");
    } finally {
      await Promise.allSettled([offerer.close(), answerer.close()]);
    }
  }, 15000);

  test("local ICE restart rollback retains the committed selected pair", async () => {
    const { offerer, answerer, outgoing, incoming } =
      await createConnectedVideoPeers();
    try {
      // Arrange: live ICE generation と選択済み pair を控える。
      const transport = offerer.iceTransports[0];
      const ufrag = transport.localParameters.usernameFragment;
      const pair = transport.getSelectedCandidatePair();
      const generation = offerer.iceGeneration;
      const candidateEvents: Array<string | undefined> = [];
      offerer.onIceCandidate.subscribe((candidate) => {
        candidateEvents.push(candidate?.toJSON().usernameFragment);
      });

      // Act: restart offer を pending にしてから rollback する。
      const restartOffer = await offerer.createOffer({ iceRestart: true });
      await offerer.setLocalDescription(restartOffer);
      const emitted = candidateEvents.length;
      await offerer.setLocalDescription(restartOffer);
      await sendAndExpectRtp(outgoing, incoming, "local-restart-pending");
      await offerer.setLocalDescription({ type: "rollback" });

      // Assert: current generation と実通信経路が変わらない。
      assertNegotiationInvariants(offerer);
      expect(emitted).toBeGreaterThan(1);
      expect(candidateEvents).toHaveLength(emitted);
      expect(candidateEvents.at(-1)).toBeUndefined();
      expect(transport.localParameters.usernameFragment).toBe(ufrag);
      expect(transport.getSelectedCandidatePair()).toEqual(pair);
      expect(offerer.iceGeneration).toBe(generation);
      await sendAndExpectRtp(outgoing, incoming, "local-restart-rollback");
    } finally {
      await Promise.allSettled([offerer.close(), answerer.close()]);
    }
  });

  test("partial BUNDLE keeps an unbundled media transport independent", async () => {
    const offerer = new RTCPeerConnection();
    const answerer = new RTCPeerConnection();
    const video = new MediaStreamTrack({ kind: "video" });
    let receivedVideo: MediaStreamTrack | undefined;
    answerer.onRemoteTransceiverAdded.subscribe((transceiver) => {
      if (transceiver.kind === "video") {
        transceiver.onTrack.subscribe((track) => {
          receivedVideo = track;
        });
      }
    });
    try {
      // Arrange: audio/application は BUNDLE、video は独立する offer を作る。
      offerer.addTransceiver("audio");
      offerer.addTransceiver(video, { direction: "sendonly" });
      offerer.createDataChannel("bundle");
      await offerer.setLocalDescription(await offerer.createOffer());
      const mids = [
        ...offerer.localDescription!.sdp.matchAll(/a=mid:([^\r\n]+)/g),
      ].map((match) => match[1]);
      const partialOffer = {
        type: "offer" as const,
        sdp: offerer.localDescription!.sdp.replace(
          /a=group:BUNDLE [^\r\n]+/,
          `a=group:BUNDLE ${mids[0]} ${mids[2]}`,
        ),
      };

      // Act: 部分 BUNDLE offer を適用して answer を作る。
      await answerer.setRemoteDescription(partialOffer);
      const answer = await answerer.createAnswer();

      // Assert: BUNDLE owner と独立 media の ICE/DTLS transport が分かれる。
      const [audio, remoteVideo] = answerer.getTransceivers();
      expect(answer.sdp).toContain(`a=group:BUNDLE ${mids[0]} ${mids[2]}`);
      expect(audio.dtlsTransport).toBe(answerer.sctpTransport!.dtlsTransport);
      expect(remoteVideo.dtlsTransport).not.toBe(audio.dtlsTransport);

      // Act: final answer 後に video RTP を独立 transport で送る。
      await answerer.setLocalDescription(answer);
      await offerer.setRemoteDescription(answerer.localDescription!);
      await Promise.all([
        waitForIce(offerer),
        waitForIce(answerer),
        waitForConnection(offerer),
        waitForConnection(answerer),
      ]);
      expect(receivedVideo).toBeDefined();
      await sendAndExpectRtp(video, receivedVideo!, "unbundled-video");

      // Act / Assert: 接続済み SCTP を別 DTLS owner へ移す answer は準備時に拒否する。
      const changedTag = await offerer.createOffer();
      await offerer.setLocalDescription({
        type: "offer",
        sdp: changedTag.sdp.replace(
          /a=group:BUNDLE [^\r\n]+/,
          `a=group:BUNDLE ${mids[1]} ${mids[0]} ${mids[2]}`,
        ),
      });
      const incompatibleAnswer = offerer.currentRemoteDescription!.sdp.replace(
        /a=group:BUNDLE [^\r\n]+/,
        `a=group:BUNDLE ${mids[1]} ${mids[0]} ${mids[2]}`,
      );
      await expect(
        offerer.setRemoteDescription({
          type: "answer",
          sdp: incompatibleAnswer,
        }),
      ).rejects.toMatchObject({ name: "InvalidModificationError" });
      await answerer.setRemoteDescription(offerer.localDescription!);
      await expect(answerer.createAnswer()).rejects.toMatchObject({
        name: "InvalidModificationError",
      });
      await offerer.setLocalDescription({ type: "rollback" });
      await answerer.setRemoteDescription({ type: "rollback" });
      await sendAndExpectRtp(video, receivedVideo!, "tag-change-rejected");

      // Act: 次の offer で全 m-line を BUNDLE に戻す。
      const oldVideoTransport = remoteVideo.dtlsTransport;
      await offerer.setLocalDescription(await offerer.createOffer());
      await answerer.setRemoteDescription(offerer.localDescription!);
      const mergedAnswer = await answerer.createAnswer();
      expect(remoteVideo.dtlsTransport).toBe(oldVideoTransport);
      await sendAndExpectRtp(video, receivedVideo!, "merge-pending-video");
      await answerer.setLocalDescription(mergedAnswer);
      await offerer.setRemoteDescription(answerer.localDescription!);

      // Assert: 旧 video owner は解放され、共有 transport で RTP が届く。
      assertNegotiationInvariants(answerer);
      expect(remoteVideo.dtlsTransport).toBe(audio.dtlsTransport);
      expect(oldVideoTransport.state).toBe("closed");
      await sendAndExpectRtp(video, receivedVideo!, "merged-video");
    } finally {
      await Promise.allSettled([offerer.close(), answerer.close()]);
    }
  }, 15000);

  test("re-offer BUNDLE split stages a new owner and rollback discards it", async () => {
    const { offerer, answerer, outgoing, incoming } =
      await createConnectedVideoPeers();
    try {
      // Arrange: 接続中の video に audio を追加し、audio を BUNDLE 外にする。
      const currentTransport = answerer.getTransceivers()[0].dtlsTransport;
      const currentRemote = answerer.currentRemoteDescription!.sdp;
      offerer.addTransceiver("audio", { direction: "sendonly" });
      const offer = await offerer.createOffer();
      const mids = [...offer.sdp.matchAll(/a=mid:([^\r\n]+)/g)].map(
        (match) => match[1],
      );
      const splitOffer = {
        type: "offer" as const,
        sdp: offer.sdp.replace(
          /a=group:BUNDLE [^\r\n]+/,
          `a=group:BUNDLE ${mids[0]}`,
        ),
      };

      // Act: 新 owner の候補を answer に準備し、現在の video を使い続ける。
      await answerer.setRemoteDescription(splitOffer);
      const firstAnswer = await answerer.createAnswer();
      const pendingTransportCount = answerer.dtlsTransports.length;
      await sendAndExpectRtp(outgoing, incoming, "split-pending");

      // Assert: pending transport は live binding にまだ現れず、SDP だけが別 ICE generation を持つ。
      expect(pendingTransportCount).toBe(1);
      expect(answerer.getTransceivers()[1].dtlsTransport).toBe(
        currentTransport,
      );
      expect(
        [...firstAnswer.sdp.matchAll(/a=ice-ufrag:([^\r\n]+)/g)].map(
          (match) => match[1],
        ),
      ).toHaveLength(2);
      expect(
        new Set(
          [...firstAnswer.sdp.matchAll(/a=ice-ufrag:([^\r\n]+)/g)].map(
            (match) => match[1],
          ),
        ).size,
      ).toBe(2);

      // Act: rollback で pending owner を破棄し、同じ proposal を再交渉して確定する。
      await answerer.setRemoteDescription({ type: "rollback" });
      expect(answerer.dtlsTransports).toHaveLength(1);
      expect(answerer.currentRemoteDescription!.sdp).toBe(currentRemote);
      await sendAndExpectRtp(outgoing, incoming, "split-rollback");
      await answerer.setRemoteDescription(splitOffer);
      const answer = await answerer.createAnswer();
      const candidateEvents: Array<
        Parameters<Parameters<typeof answerer.onIceCandidate.subscribe>[0]>[0]
      > = [];
      answerer.onIceCandidate.subscribe((candidate) => {
        candidateEvents.push(candidate);
      });
      await answerer.setLocalDescription(answer);

      // Assert: video の経路を保ち、audio owner の candidate/EOC を一度通知する。
      assertNegotiationInvariants(answerer);
      expect(answerer.getTransceivers()[0].dtlsTransport).toBe(
        currentTransport,
      );
      expect(answerer.getTransceivers()[1].dtlsTransport).not.toBe(
        currentTransport,
      );
      expect(
        candidateEvents.some((candidate) => candidate?.sdpMid === mids[1]),
      ).toBe(true);
      expect(candidateEvents.at(-1)).toBeUndefined();
      await sendAndExpectRtp(outgoing, incoming, "split-committed");
    } finally {
      await Promise.allSettled([offerer.close(), answerer.close()]);
    }
  }, 15000);

  test("a local BUNDLE split prepares independent ICE and carries both RTP streams", async () => {
    const { offerer, answerer, outgoing, incoming } =
      await createConnectedVideoPeers();
    const audio = new MediaStreamTrack({ kind: "audio" });
    let receivedAudio: MediaStreamTrack | undefined;
    answerer.onRemoteTransceiverAdded.subscribe((transceiver) => {
      if (transceiver.kind === "audio") {
        transceiver.onTrack.subscribe((track) => {
          receivedAudio = track;
        });
      }
    });
    try {
      // Arrange: 接続済み BUNDLE transport に audio を追加し、group を分割する。
      const currentLocal = offerer.currentLocalDescription!.sdp;
      const selectedPair = offerer.iceTransports[0].getSelectedCandidatePair();
      offerer.addTransceiver(audio, { direction: "sendonly" });
      const offer = await offerer.createOffer();
      const videoMid = offer.sdp.match(/a=mid:([^\r\n]+)/)![1];
      const splitSdp = offer.sdp.replace(
        /a=group:BUNDLE [^\r\n]+/,
        `a=group:BUNDLE ${videoMid}`,
      );

      // Act: 新 audio の ICE transport を pending に準備し、旧 video は継続する。
      await offerer.setLocalDescription({ type: "offer", sdp: splitSdp });
      expect(offerer.currentLocalDescription!.sdp).toBe(currentLocal);
      expect(offerer.iceTransports[0].getSelectedCandidatePair()).toEqual(
        selectedPair,
      );
      expect(offerer.dtlsTransports).toHaveLength(1);
      await sendAndExpectRtp(outgoing, incoming, "local-split-pending");

      // Act: remote answer で新 transport へ audio を結び付ける。
      await answerer.setRemoteDescription(offerer.localDescription!);
      await answerer.setLocalDescription(await answerer.createAnswer());
      await offerer.setRemoteDescription(answerer.localDescription!);
      const audioTransport = offerer.getTransceivers()[1].dtlsTransport;
      if (audioTransport.state !== "connected") {
        await Promise.race([
          audioTransport.onStateChange.watch((state) => state === "connected"),
          new Promise<never>((_, reject) =>
            setTimeout(
              () => reject(new Error("split audio transport did not connect")),
              3000,
            ),
          ),
        ]);
      }

      // Assert: video の旧 pair を維持し、独立 audio と video の RTP が届く。
      assertNegotiationInvariants(offerer);
      assertNegotiationInvariants(answerer);
      expect(audioTransport).not.toBe(
        offerer.getTransceivers()[0].dtlsTransport,
      );
      expect(receivedAudio).toBeDefined();
      await sendAndExpectRtp(audio, receivedAudio!, "split-audio");
      await sendAndExpectRtp(outgoing, incoming, "split-video");

      // Act: 次の offer で audio を新 BUNDLE tag にして video を合流させる。
      const oldVideoTransport = offerer.getTransceivers()[0].dtlsTransport;
      const mergedOffer = await offerer.createOffer();
      const audioMid = offerer.getTransceivers()[1].mid;
      await offerer.setLocalDescription({
        type: "offer",
        sdp: mergedOffer.sdp.replace(
          /a=group:BUNDLE [^\r\n]+/,
          `a=group:BUNDLE ${audioMid} ${videoMid}`,
        ),
      });
      await answerer.setRemoteDescription(offerer.localDescription!);
      await answerer.setLocalDescription(await answerer.createAnswer());
      await offerer.setRemoteDescription(answerer.localDescription!);

      // Assert: tag 変更後は audio owner を共有し、両方の RTP が届く。
      assertNegotiationInvariants(offerer);
      assertNegotiationInvariants(answerer);
      expect(offerer.getTransceivers()[0].dtlsTransport).toBe(audioTransport);
      expect(oldVideoTransport.state).toBe("closed");
      await sendAndExpectRtp(audio, receivedAudio!, "tagged-audio");
      await sendAndExpectRtp(outgoing, incoming, "tagged-video");
    } finally {
      await Promise.allSettled([offerer.close(), answerer.close()]);
    }
  });

  test("rollback of a local BUNDLE split keeps the old RTP owner", async () => {
    const { offerer, answerer, outgoing, incoming } =
      await createConnectedVideoPeers();
    try {
      // Arrange: 新 audio を非 BUNDLE にした local re-offer を作る。
      const oldTransport = offerer.getTransceivers()[0].dtlsTransport;
      const oldPair = oldTransport.iceTransport.getSelectedCandidatePair();
      const audio = new MediaStreamTrack({ kind: "audio" });
      const localAudio = offerer.addTransceiver(audio, {
        direction: "sendonly",
      });
      const offer = await offerer.createOffer();
      const videoMid = offer.sdp.match(/a=mid:([^\r\n]+)/)![1];
      const splitOffer = {
        type: "offer" as const,
        sdp: offer.sdp.replace(
          /a=group:BUNDLE [^\r\n]+/,
          `a=group:BUNDLE ${videoMid}`,
        ),
      };

      // Act: pending owner を用意してから rollback する。
      await offerer.setLocalDescription(splitOffer);
      expect(offerer.pendingLocalDescription!.sdp).toContain(
        `a=group:BUNDLE ${videoMid}`,
      );
      await sendAndExpectRtp(outgoing, incoming, "local-split-before-rollback");
      await offerer.setLocalDescription({ type: "rollback" });

      // Assert: pending transport は消え、application の audio object と旧 pair は残る。
      assertNegotiationInvariants(offerer);
      expect(offerer.dtlsTransports).toHaveLength(1);
      expect(offerer.getTransceivers()).toContain(localAudio);
      expect(localAudio.sender.track).toBe(audio);
      expect(oldTransport.iceTransport.getSelectedCandidatePair()).toEqual(
        oldPair,
      );
      await sendAndExpectRtp(outgoing, incoming, "local-split-after-rollback");
    } finally {
      await Promise.allSettled([offerer.close(), answerer.close()]);
    }
  });

  test("a connected DTLS fingerprint change fails before touching current RTP", async () => {
    const { offerer, answerer, outgoing, incoming } =
      await createConnectedVideoPeers();
    try {
      // Arrange: re-offer の fingerprint だけを別証明書の値に変える。
      const current = answerer.currentRemoteDescription!.sdp;
      const pair = answerer.iceTransports[0].getSelectedCandidatePair();
      const offer = await offerer.createOffer();
      const altered = offer.sdp.replace(
        /a=fingerprint:sha-256 [^\r\n]+/,
        `a=fingerprint:sha-256 ${Array(32).fill("00").join(":")}`,
      );

      // Act: 接続済み DTLS の fingerprint 変更を適用しようとする。
      await expect(
        answerer.setRemoteDescription({ type: "offer", sdp: altered }),
      ).rejects.toMatchObject({ name: "InvalidModificationError" });

      // Assert: current SDP、ICE pair と RTP は維持される。
      assertNegotiationInvariants(answerer);
      expect(answerer.currentRemoteDescription!.sdp).toBe(current);
      expect(answerer.iceTransports[0].getSelectedCandidatePair()).toEqual(
        pair,
      );
      await sendAndExpectRtp(outgoing, incoming, "fingerprint-rejected");
    } finally {
      await Promise.allSettled([offerer.close(), answerer.close()]);
    }
  });

  test("an existing SCTP port change is rejected before mutating the association", async () => {
    const offerer = new RTCPeerConnection();
    const answerer = new RTCPeerConnection();
    const channel = offerer.createDataChannel("port-check");
    let remoteChannel: typeof channel | undefined;
    answerer.onDataChannel.subscribe((received) => {
      remoteChannel = received;
    });
    try {
      // Arrange: DataChannel が開いた stable session を作る。
      await offerer.setLocalDescription(await offerer.createOffer());
      await answerer.setRemoteDescription(offerer.localDescription!);
      await answerer.setLocalDescription(await answerer.createAnswer());
      await offerer.setRemoteDescription(answerer.localDescription!);
      if (channel.readyState !== "open") {
        await channel.stateChanged.watch((state) => state === "open");
      }
      const oldPort = answerer.sctpRemotePort;
      const current = answerer.currentRemoteDescription!.sdp;
      const offer = await offerer.createOffer();

      // Act: 同じ association の remote SCTP port を変更する re-offer を拒否する。
      await expect(
        answerer.setRemoteDescription({
          type: "offer",
          sdp: offer.sdp.replace("a=sctp-port:5000", "a=sctp-port:5001"),
        }),
      ).rejects.toMatchObject({ name: "InvalidModificationError" });

      // Assert: SDP と port は current のままで DataChannel 通信も続く。
      expect(answerer.currentRemoteDescription!.sdp).toBe(current);
      expect(answerer.sctpRemotePort).toBe(oldPort);
      expect(remoteChannel).toBeDefined();
      const message = remoteChannel!.onMessage.watch(
        (data) => data.toString() === "after-reject",
      );
      channel.send(Buffer.from("after-reject"));
      await message;
      assertNegotiationInvariants(answerer);
    } finally {
      await Promise.allSettled([offerer.close(), answerer.close()]);
    }
  });

  test("replacement offers implicitly roll back either pranswer direction", async () => {
    const offerer = new RTCPeerConnection();
    const answerer = new RTCPeerConnection();
    try {
      // Arrange: 初回 offer と pranswer を双方の pending に置く。
      offerer.addTransceiver("audio");
      await offerer.setLocalDescription(await offerer.createOffer());
      await answerer.setRemoteDescription(offerer.localDescription!);
      const provisional = await answerer.createAnswer();
      await answerer.setLocalDescription({
        type: "pranswer",
        sdp: provisional.sdp,
      });
      await offerer.setRemoteDescription({
        type: "pranswer",
        sdp: answerer.localDescription!.sdp,
      });

      // Act: offerer は remote pranswer を、answerer は local pranswer を
      // implicit rollback して replacement offer を受ける。
      await offerer.setLocalDescription(await offerer.createOffer());
      await answerer.setRemoteDescription(offerer.localDescription!);

      // Assert: 最後の stable baseline は空で、新しい offer だけが pending。
      expect(offerer.signalingState).toBe("have-local-offer");
      expect(answerer.signalingState).toBe("have-remote-offer");
      expect(offerer.currentLocalDescription).toBeNull();
      expect(answerer.currentRemoteDescription).toBeNull();
      expect(offerer.pendingRemoteDescription).toBeNull();
      expect(answerer.pendingLocalDescription).toBeNull();
    } finally {
      await Promise.allSettled([offerer.close(), answerer.close()]);
    }
  });

  test("description and trickle operations serialize, and a rolled-back ufrag cannot be buffered", async () => {
    const offerer = new RTCPeerConnection();
    const answerer = new RTCPeerConnection();
    try {
      // Arrange: 同じ tick に渡す remote offer と candidate を用意する。
      offerer.addTransceiver("audio");
      await offerer.setLocalDescription(await offerer.createOffer());
      const offer = offerer.localDescription!;
      const mid = offer.sdp.match(/a=mid:([^\r\n]+)/)![1];
      const ufrag = offer.sdp.match(/a=ice-ufrag:([^\r\n]+)/)![1];
      const candidate = {
        candidate:
          "candidate:serial 1 udp 2113937151 192.0.2.13 12348 typ host",
        sdpMid: mid,
        usernameFragment: ufrag,
      };

      // Act: SRD と trickle を待たずに連続で開始する。
      const applied = answerer.setRemoteDescription(offer);
      const trickled = answerer.addIceCandidate(candidate);
      await Promise.all([applied, trickled]);

      // Assert: candidate は新しい pending description にだけ付く。
      expect(answerer.pendingRemoteDescription!.sdp).toContain("serial");
      await answerer.setRemoteDescription({ type: "rollback" });
      assertNegotiationInvariants(answerer);

      // Act / Assert: 破棄済み generation の遅延 candidate は次回用キューに入らない。
      await expect(answerer.addIceCandidate(candidate)).rejects.toMatchObject({
        name: "OperationError",
      });
    } finally {
      await Promise.allSettled([offerer.close(), answerer.close()]);
    }
  });
});
