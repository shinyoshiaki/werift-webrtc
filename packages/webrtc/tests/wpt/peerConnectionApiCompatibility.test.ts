import {
  RTCDtlsTransport,
  RTCPeerConnection,
  type RTCSessionDescription,
} from "../../src";
import { addEventListenerPromise, createDataChannelPair } from "../utils";

describe("wpt/peerConnection api compatibility", () => {
  test("exposes W3C-compatible description getters, canTrickleIceCandidates, and sctp", async () => {
    const caller = new RTCPeerConnection();
    const callee = new RTCPeerConnection();

    caller.createDataChannel("chat");

    try {
      // 実行: type を省略した setLocalDescription で暗黙の offer を作る
      const offer = await caller.setLocalDescription({});

      // 検証: localDescription と pending/current description が offer に更新される
      expect(offer.type).toBe("offer");
      expect(caller.localDescription?.type).toBe("offer");
      expect(caller.pendingLocalDescription?.type).toBe("offer");
      expect(caller.currentLocalDescription).toBeUndefined();
      expect(caller.canTrickleIceCandidates).toBeNull();

      // 実行: remote offer を適用して W3C getter を更新する
      await callee.setRemoteDescription(caller.localDescription!);

      // 検証: remote 側の pending/current description と trickle/SCTP 状態を公開できる
      expect(callee.pendingRemoteDescription?.type).toBe("offer");
      expect(callee.currentRemoteDescription).toBeUndefined();
      expect(callee.canTrickleIceCandidates).toBe(true);
      expect(callee.sctp).toBeDefined();

      // 実行: 空 SDP の pranswer を受け付けて provisional answer を作る
      const pranswer = await callee.setLocalDescription({
        type: "pranswer",
        sdp: "",
      });
      await caller.setRemoteDescription(callee.localDescription!);

      // 検証: pranswer は pending description と signaling state に反映される
      expect(pranswer.type).toBe("pranswer");
      expect(callee.localDescription?.type).toBe("pranswer");
      expect(callee.pendingLocalDescription?.type).toBe("pranswer");
      expect(caller.pendingRemoteDescription?.type).toBe("pranswer");
      expect(caller.signalingState).toBe("have-remote-pranswer");

      // 実行: 空 SDP の answer で最終確定する
      const answer = await callee.setLocalDescription({
        type: "answer",
        sdp: "",
      });
      await caller.setRemoteDescription(callee.localDescription!);

      // 検証: final answer 後は current description に昇格し pending が解消される
      expect(answer.type).toBe("answer");
      expect(callee.currentLocalDescription?.type).toBe("answer");
      expect(callee.currentRemoteDescription?.type).toBe("offer");
      expect(callee.pendingLocalDescription).toBeUndefined();
      expect(callee.pendingRemoteDescription).toBeUndefined();
      expect(caller.currentLocalDescription?.type).toBe("offer");
      expect(caller.currentRemoteDescription?.type).toBe("answer");
      expect(caller.pendingLocalDescription).toBeUndefined();
      expect(caller.pendingRemoteDescription).toBeUndefined();
    } finally {
      await Promise.allSettled([caller.close(), callee.close()]);
    }
  });

  test("supports rollback, rejects invalid addIceCandidate inputs, and handles end-of-candidates", async () => {
    const localRollbackPc = new RTCPeerConnection();
    const remoteRollbackPc = new RTCPeerConnection();
    const noTricklePc = new RTCPeerConnection();

    localRollbackPc.addTransceiver("audio");

    try {
      // 実行: local offer を rollback できる状態まで進める
      await localRollbackPc.setLocalDescription(
        await localRollbackPc.createOffer(),
      );
      const rollbackResult = await localRollbackPc.setLocalDescription({
        type: "rollback",
      });

      // 検証: local rollback は undefined を返し、stable に戻って pending description が消える
      expect(rollbackResult).toBeUndefined();
      expect(localRollbackPc.signalingState).toBe("stable");
      expect(localRollbackPc.localDescription).toBeUndefined();
      expect(localRollbackPc.pendingLocalDescription).toBeUndefined();

      // 実行: remote offer を rollback できる状態まで進める
      await remoteRollbackPc.setRemoteDescription(await createOffer());
      await remoteRollbackPc.setRemoteDescription({ type: "rollback" });

      // 検証: remote rollback 後も stable に戻り pending description が消える
      expect(remoteRollbackPc.signalingState).toBe("stable");
      expect(remoteRollbackPc.remoteDescription).toBeUndefined();
      expect(remoteRollbackPc.pendingRemoteDescription).toBeUndefined();

      // 実行: remoteDescription が無い状態では addIceCandidate を拒否する
      await expect(noTricklePc.addIceCandidate()).rejects.toThrowError(
        "The remote description was null",
      );
      await expect(noTricklePc.addIceCandidate(null)).rejects.toThrowError(
        "The remote description was null",
      );
      await expect(
        noTricklePc.addIceCandidate({ candidate: "" }),
      ).rejects.toThrowError("The remote description was null");

      // 実行: trickle 非対応の remote SDP を適用し、不正 candidate と end-of-candidates を投入する
      const offerWithoutTrickle = removeTrickle(await createOffer());
      await noTricklePc.setRemoteDescription(offerWithoutTrickle);
      await expect(
        noTricklePc.addIceCandidate({
          candidate: "candidate:invalid",
          sdpMid: "0",
        }),
      ).rejects.toThrowError("Failed to parse ICE candidate");
      await noTricklePc.addIceCandidate(null);
      await noTricklePc.addIceCandidate();
      await noTricklePc.addIceCandidate({ candidate: "" });

      // 検証: trickle 判定と end-of-candidates の扱いが W3C 互換になる
      expect(noTricklePc.canTrickleIceCandidates).toBe(false);
      expect(noTricklePc.iceTransports[0].connection.remoteCandidatesEnd).toBe(
        true,
      );
    } finally {
      await Promise.allSettled([
        localRollbackPc.close(),
        remoteRollbackPc.close(),
        noTricklePc.close(),
      ]);
    }
  });

  test("remote rollback clears bundled transport reuse", async () => {
    const rollbackPc = new RTCPeerConnection();
    const freshPc = new RTCPeerConnection();
    const offerer = new RTCPeerConnection();

    const rollbackAudio = rollbackPc.addTransceiver("audio");
    const freshAudio = freshPc.addTransceiver("audio");
    offerer.addTransceiver("audio");

    try {
      // 実行: BUNDLE を含む remote offer を適用してから rollback する
      const bundledOffer = await offerer.createOffer();
      expect(bundledOffer.sdp).toContain("a=group:BUNDLE");
      await rollbackPc.setRemoteDescription(bundledOffer);
      await rollbackPc.setRemoteDescription({ type: "rollback" });

      // 実行: rollback 後と fresh peer でそれぞれ 2 本目の transceiver を追加する
      const rollbackVideo = rollbackPc.addTransceiver("video");
      const freshVideo = freshPc.addTransceiver("video");

      // 検証: rollback 後の transport 割り当ては fresh peer と同様に BUNDLE 前提へ残留しない
      expect(rollbackPc.signalingState).toBe("stable");
      expect(rollbackPc.remoteDescription).toBeUndefined();
      expect(rollbackPc.pendingRemoteDescription).toBeUndefined();
      expect(rollbackVideo.dtlsTransport.id).not.toBe(
        rollbackAudio.dtlsTransport.id,
      );
      expect(freshVideo.dtlsTransport.id).not.toBe(freshAudio.dtlsTransport.id);
      expect(rollbackPc.dtlsTransports).toHaveLength(2);
      expect(freshPc.dtlsTransports).toHaveLength(2);
    } finally {
      await Promise.allSettled([
        rollbackPc.close(),
        freshPc.close(),
        offerer.close(),
      ]);
    }
  });

  test("routes addIceCandidate by sdpMid without sdpMLineIndex", async () => {
    const caller = new RTCPeerConnection({ bundlePolicy: "disable" });
    const callee = new RTCPeerConnection({ bundlePolicy: "disable" });
    const gatheredCandidates: any[] = [];

    caller.addTransceiver("audio");
    caller.addTransceiver("video");
    caller.onIceCandidate.subscribe((candidate) => {
      if (candidate) {
        gatheredCandidates.push(candidate);
      }
    });

    try {
      // 実行: candidate 未含有の offer を適用しつつ、local 側では MID 付き candidate を収集する
      const offer = await caller.createOffer();
      await caller.setLocalDescription(offer);
      await callee.setRemoteDescription(offer);

      const videoCandidate = gatheredCandidates.find(
        (candidate) => candidate.sdpMid === "1",
      );

      // 検証: bundle 無効時は transport が分かれ、video MID の candidate を特定できる
      expect(callee.iceTransports).toHaveLength(2);
      expect(videoCandidate).toBeDefined();
      const [audioTransport, videoTransport] = callee.iceTransports;

      // 実行: sdpMLineIndex を省いて sdpMid だけで candidate を追加する
      await callee.addIceCandidate({
        candidate: videoCandidate.candidate,
        sdpMid: videoCandidate.sdpMid,
      });

      // 検証: candidate は対応する MID の transport にだけ追加される
      expect(audioTransport.connection.remoteCandidates).toHaveLength(0);
      expect(videoTransport.connection.remoteCandidates).toHaveLength(1);
    } finally {
      await Promise.allSettled([caller.close(), callee.close()]);
    }
  });

  test("accepts W3C-compatible RTCConfiguration fields", async () => {
    const certificate = await RTCDtlsTransport.SetupCertificate();
    const pc = new RTCPeerConnection({
      iceServers: [
        {
          urls: [
            "turn:turn.example.com:3478?transport=tcp",
            "stun:stun.l.google.com:19302",
          ],
          credential: "credential",
          username: "username",
        },
      ],
      bundlePolicy: "balanced",
      rtcpMuxPolicy: "require",
      iceCandidatePoolSize: 0,
      certificates: [certificate],
    });

    pc.createDataChannel("chat");

    try {
      // 実行: setLocalDescription 前は未対応の pool size を拒否する
      expect(() =>
        pc.setConfiguration({ iceCandidatePoolSize: 1 }),
      ).toThrowError("iceCandidatePoolSize > 0 is not supported");

      // 実行: W3C 互換設定で transport を作成し getConfiguration の戻り値を取得する
      await pc.setLocalDescription({});
      const configuration = pc.getConfiguration();

      // 検証: 標準設定項目が保持され、certificate が transport に適用される
      expect(configuration.bundlePolicy).toBe("max-compat");
      expect(configuration.rtcpMuxPolicy).toBe("require");
      expect(configuration.iceCandidatePoolSize).toBe(0);
      expect(configuration.iceServers[0].urls).toEqual([
        "turn:turn.example.com:3478?transport=tcp",
        "stun:stun.l.google.com:19302",
      ]);
      expect(configuration.certificates).toEqual([certificate]);
      expect(configuration.iceServers).not.toBe(pc.config.iceServers);
      expect(pc.dtlsTransports[0].localCertificate).toBe(certificate);

      // 実行: getConfiguration の戻り値をそのまま再適用する
      pc.setConfiguration(configuration);

      // 検証: 設定の round-trip は通り、変更不可項目の実変更だけが拒否される
      expect(() => pc.setConfiguration({ certificates: [] })).toThrowError(
        "certificates cannot be changed",
      );
      expect(() =>
        pc.setConfiguration({ bundlePolicy: "max-bundle" }),
      ).toThrowError("bundlePolicy cannot be changed");
      expect(() =>
        pc.setConfiguration({ iceCandidatePoolSize: 1 }),
      ).toThrowError(
        "iceCandidatePoolSize cannot be changed after setLocalDescription",
      );
    } finally {
      await pc.close();
    }
  });

  test("distinguishes unsupported and immutable iceCandidatePoolSize errors", async () => {
    const pc = new RTCPeerConnection();

    try {
      // 実行: setLocalDescription 前は未対応値として reject する
      expect(() =>
        pc.setConfiguration({ iceCandidatePoolSize: 1 }),
      ).toThrowError("iceCandidatePoolSize > 0 is not supported");

      pc.createDataChannel("chat");

      // 実行: setLocalDescription 後は変更不可として reject する
      await pc.setLocalDescription({});

      // 検証: 同じ入力値でも状態遷移後は変更不可エラーに切り替わる
      expect(() =>
        pc.setConfiguration({ iceCandidatePoolSize: 1 }),
      ).toThrowError(
        "iceCandidatePoolSize cannot be changed after setLocalDescription",
      );
    } finally {
      await pc.close();
    }
  });

  test("fires standard signaling and transport event names", async () => {
    const caller = new RTCPeerConnection();
    const callee = new RTCPeerConnection();

    const negotiationNeededPromise = addEventListenerPromise(
      caller,
      "negotiationneeded",
    );

    caller.createDataChannel("chat");

    try {
      // 実行: negotiationneeded を発火させて標準イベント名で待ち受ける
      await negotiationNeededPromise;

      const signalingStateChangePromise = addEventListenerPromise(
        caller,
        "signalingstatechange",
        () => caller.signalingState,
      );
      const iceGatheringStateChangePromise = addEventListenerPromise(
        caller,
        "icegatheringstatechange",
        () => caller.iceGatheringState,
      );
      const iceCandidatePromise = addEventListenerPromise(
        caller,
        "icecandidate",
        (event) => event.candidate,
      );
      const iceConnectionStateChangePromise = addEventListenerPromise(
        caller,
        "iceconnectionstatechange",
        () => caller.iceConnectionState,
      );
      const connectionStateChangePromise = addEventListenerPromise(
        caller,
        "connectionstatechange",
        () => caller.connectionState,
      );

      // 実行: offer/answer を交換して signaling と transport の状態を遷移させる
      await caller.setLocalDescription({});
      await callee.setRemoteDescription(caller.localDescription!);
      await callee.setLocalDescription({});
      await caller.setRemoteDescription(callee.localDescription!);

      // 検証: 標準イベント名で状態遷移と ICE candidate を購読できる
      expect(await signalingStateChangePromise).toBe("have-local-offer");
      expect(await iceGatheringStateChangePromise).toBe("gathering");
      expect(await iceCandidatePromise).toBeDefined();
      expect(await iceConnectionStateChangePromise).toMatch(
        /checking|connected|completed/,
      );
      expect(await connectionStateChangePromise).toMatch(
        /connecting|connected/,
      );
    } finally {
      await Promise.allSettled([caller.close(), callee.close()]);
    }
  });

  test("fires datachannel with addEventListener", async () => {
    const caller = new RTCPeerConnection();
    const callee = new RTCPeerConnection();

    const dataChannelEventPromise = addEventListenerPromise(
      callee,
      "datachannel",
    );

    try {
      // 実行: addEventListener で datachannel を待ちながら接続を確立する
      const [, remoteChannel] = await createDataChannelPair(
        undefined,
        caller,
        callee,
      );
      const dataChannelEvent: any = await dataChannelEventPromise;

      // 検証: datachannel イベントから受信側の channel にアクセスできる
      expect(dataChannelEvent.channel).toBe(remoteChannel);
      expect(dataChannelEvent.channel.label).toBe(remoteChannel.label);
    } finally {
      await Promise.allSettled([caller.close(), callee.close()]);
    }
  });

  test("fires track with addEventListener", async () => {
    const caller = new RTCPeerConnection();
    const callee = new RTCPeerConnection();

    const trackEventPromise = addEventListenerPromise(callee, "track");

    caller.addTransceiver("audio");

    try {
      // 実行: addEventListener で track を待ちながら remote offer を適用する
      await callee.setRemoteDescription(await caller.createOffer());
      const trackEvent: any = await trackEventPromise;

      // 検証: 標準 track イベントから track / receiver / transceiver にアクセスできる
      expect(trackEvent.track.kind).toBe("audio");
      expect(trackEvent.receiver.track).toBe(trackEvent.track);
      expect(trackEvent.transceiver.receiver).toBe(trackEvent.receiver);
    } finally {
      await Promise.allSettled([caller.close(), callee.close()]);
    }
  });
});

async function createOffer() {
  const pc = new RTCPeerConnection();
  pc.addTransceiver("audio");
  try {
    return await pc.createOffer();
  } finally {
    await pc.close();
  }
}

function removeTrickle(description: RTCSessionDescription) {
  return {
    ...description,
    sdp: description.sdp.replace(/^a=ice-options:trickle\r?$\n?/gm, ""),
  };
}
