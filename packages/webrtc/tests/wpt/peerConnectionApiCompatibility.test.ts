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

  test("supports rollback and end-of-candidates input forms", async () => {
    const localRollbackPc = new RTCPeerConnection();
    const remoteRollbackPc = new RTCPeerConnection();
    const noTricklePc = new RTCPeerConnection();

    localRollbackPc.addTransceiver("audio");

    try {
      // 実行: local offer を rollback できる状態まで進める
      await localRollbackPc.setLocalDescription(
        await localRollbackPc.createOffer(),
      );
      await localRollbackPc.setLocalDescription({ type: "rollback" });

      // 検証: local rollback 後は stable に戻り pending description が消える
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

      // 実行: trickle 非対応の remote SDP を適用して end-of-candidates を投入する
      const offerWithoutTrickle = removeTrickle(await createOffer());
      await noTricklePc.setRemoteDescription(offerWithoutTrickle);
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

      // 検証: 標準 API の変更不可項目は setConfiguration で拒否される
      expect(() =>
        pc.setConfiguration({ certificates: [certificate] }),
      ).toThrowError("certificates cannot be changed");
      expect(() =>
        pc.setConfiguration({ bundlePolicy: "max-bundle" }),
      ).toThrowError("bundlePolicy cannot be changed");
      expect(() =>
        pc.setConfiguration({ iceCandidatePoolSize: 1 }),
      ).toThrowError("iceCandidatePoolSize > 0 is not supported");
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
