import { setTimeout } from "timers/promises";
import { vi } from "vitest";

import { HashAlgorithm } from "../../../dtls/src/cipher/const";
import { CandidatePairState, type Connection } from "../../../ice/src";
import { SCTP_STATE } from "../../../sctp/src";
import {
  DtlsVersion,
  MediaStream,
  MediaStreamTrack,
  RTCCertificate,
  type RTCDataChannel,
  RTCPeerConnection,
  RTCTrackEvent,
  RTP_EXTENSION_URI,
  RtcpRrPacket,
  RtpHeader,
  RtpPacket,
  createSelfSignedCertificate,
  useSdesMid,
  useTWCC,
  useTransportWideCC,
  useVP8,
} from "../../src";
import { SignatureAlgorithm } from "../../src/const";
import { createDataChannelPair, exchangeOfferAnswer } from "../utils";

describe("peerConnection", () => {
  test("test_connect_datachannel_modern_sdp", async () =>
    new Promise<void>(async (done) => {
      const pc1 = new RTCPeerConnection({});
      const pc2 = new RTCPeerConnection({});

      pc2.onDataChannel.subscribe((channel) => {
        channel.onMessage.subscribe((data) => {
          expect(data.toString()).toBe("hello");
          done();
        });
      });

      const dc = pc1.createDataChannel("chat", { protocol: "bob" });
      expect(dc.label).toBe("chat");
      expect(dc.maxPacketLifeTime).toBeNull();
      expect(dc.maxRetransmits).toBeNull();
      expect(dc.ordered).toBeTruthy();
      expect(dc.protocol).toBe("bob");
      expect(dc.readyState).toBe("connecting");

      dc.stateChanged.subscribe((state) => {
        if (state === "open") {
          dc.send(Buffer.from("hello"));
        }
      });

      const offer = await pc1.createOffer();
      expect(offer.type).toBe("offer");
      expect(offer.sdp.includes("m=application")).toBeTruthy();
      expect(offer.sdp.includes("a=candidate")).toBeFalsy();
      expect(offer.sdp.includes("a=end-of-candidates")).toBeFalsy();

      expect(pc1.iceConnectionState).toBe("new");
      await pc1.setLocalDescription(offer);
      expect(pc1.iceConnectionState).toBe("completed");
      // expect(pc1.iceGatheringState).toBe("complete");

      expect(pc1.localDescription!.sdp.includes("m=application ")).toBeTruthy();
      expect(
        pc1.localDescription!.sdp.includes("a=sctp-port:5000"),
      ).toBeTruthy();
      assertHasIceCandidate(pc1.localDescription!.sdp);
      assertHasDtls(pc1.localDescription!.sdp, "actpass");

      // # handle offer
      await pc2.setRemoteDescription(pc1.localDescription!);
      expect(pc2.remoteDescription!.sdp).toBe(pc1.localDescription!.sdp);

      // # create answer
      const answer = await pc2.createAnswer()!;
      expect(answer.sdp.includes("m=application")).toBeTruthy();
      // expect(answer.sdp.includes("a=candidate")).toBeFalsy();
      // expect(answer.sdp.includes("a=end-of-candidates")).toBeFalsy();

      await pc2.setLocalDescription(answer);
      // expect(pc2.iceConnectionState).toBe("checking");
      // expect(pc2.iceGatheringState).toBe("complete");
      expect(pc2.localDescription!.sdp.includes("m=application ")).toBeTruthy();
      expect(
        pc2.localDescription!.sdp.includes("a=sctp-port:5000"),
      ).toBeTruthy();
      assertHasIceCandidate(pc2.localDescription!.sdp);
      assertHasDtls(pc2.localDescription!.sdp, "active");

      // # handle answer
      await pc1.setRemoteDescription(pc2.localDescription!);
      expect(pc1.remoteDescription!.sdp).toBe(pc2.localDescription!.sdp);
      expect(pc1.iceConnectionState).toBe("checking");

      await assertIceCompleted(pc1, pc2);

      await assertDataChannelOpen(dc);
      expect(true).toBe(true);
    }));

  test("test_close_datachannel", async () =>
    new Promise<void>(async (done) => {
      const pcOffer = new RTCPeerConnection({});
      const pcAnswer = new RTCPeerConnection({});

      const dc = pcOffer.createDataChannel("chat");

      pcAnswer.onDataChannel.subscribe((channel) => {
        channel.onMessage.subscribe(async (data) => {
          expect(data.toString()).toBe("hello");
          channel.close();
          await Promise.all([
            new Promise<void>((r) => {
              dc.stateChanged.subscribe((state) => {
                if (state === "closed") {
                  r();
                }
              });
            }),
            new Promise<void>((r) => {
              channel.stateChanged.subscribe((state) => {
                if (state === "closed") {
                  r();
                }
              });
            }),
          ]);
          done();
        });
      });

      dc.stateChanged.subscribe((state) => {
        if (state === "open") {
          dc.send(Buffer.from("hello"));
        }
      });

      const offer = await pcOffer.createOffer()!;
      await pcOffer.setLocalDescription(offer);
      await pcAnswer.setRemoteDescription(pcOffer.localDescription!);

      const answer = await pcAnswer.createAnswer()!;
      await pcAnswer.setLocalDescription(answer);
      await pcOffer.setRemoteDescription(pcAnswer.localDescription!);

      await assertIceCompleted(pcOffer, pcAnswer);
      await assertDataChannelOpen(dc);
    }));

  test("rejects_tampered_remote_fingerprint", async () => {
    const caller = new RTCPeerConnection({});
    const callee = new RTCPeerConnection({});
    const channel = caller.createDataChannel("chat");
    let closeEvents = 0;
    channel.onclose = () => closeEvents++;
    let remoteChannelOpened = false;

    callee.onDataChannel.subscribe((remoteChannel) => {
      remoteChannel.stateChanged.subscribe((state) => {
        if (state === "open") {
          remoteChannelOpened = true;
        }
      });
    });

    await caller.setLocalDescription(await caller.createOffer());
    await callee.setRemoteDescription(caller.localDescription!);

    const answer = await callee.createAnswer()!;
    await callee.setLocalDescription({
      type: answer.type,
      sdp: tamperFingerprints(answer.sdp),
    });
    await caller.setRemoteDescription(callee.localDescription!);

    await waitForConnectionState(caller, "failed");
    await setTimeout(200);

    expect(caller.connectionState).toBe("failed");
    expect(channel.readyState).not.toBe("open");
    expect(channel.readyState).toBe("closed");
    expect(closeEvents).toBe(1);
    expect(remoteChannelOpened).toBeFalsy();

    await Promise.allSettled([caller.close(), callee.close()]);
  });

  test("post-connect fingerprint変更のremote offerはcurrent DTLS associationを維持する", async () => {
    // Arrange: 実際の PeerConnection で DataChannel を接続済みにする。
    const caller = new RTCPeerConnection({});
    const callee = new RTCPeerConnection({});
    const channel = caller.createDataChannel("chat");
    const remoteChannelPromise = new Promise<RTCDataChannel>((resolve) => {
      callee.onDataChannel.subscribe((remoteChannel) => resolve(remoteChannel));
    });

    try {
      await caller.setLocalDescription(await caller.createOffer());
      await callee.setRemoteDescription(caller.localDescription!);
      await callee.setLocalDescription(await callee.createAnswer());
      await caller.setRemoteDescription(callee.localDescription!);
      await assertDataChannelOpen(channel);
      const remoteChannel = await remoteChannelPromise;
      await assertDataChannelOpen(remoteChannel);
      expect(channel.readyState).toBe("open");

      // Act: 再ネゴシエーションの remote offer に新しい fingerprint set を適用する。
      const renegotiationOffer = await callee.createOffer();
      await callee.setLocalDescription(renegotiationOffer);
      await caller.setRemoteDescription({
        type: "offer",
        sdp: tamperFingerprints(callee.localDescription!.sdp),
      });

      // Assert: RFC 8842 の新association提案であり、現行associationはSRD時点で落とさない。
      expect(caller.dtlsTransports[0].state).toBe("connected");
      expect(caller.connectionState).toBe("connected");
      expect(caller.sctp?.sctp.associationState).toBe(SCTP_STATE.ESTABLISHED);
      expect(channel.readyState).toBe("open");

      // Assert: subsequent offerはassociation reuseでも setup:actpass を出す。
      expect(renegotiationOffer.sdp).toMatch(/a=setup:actpass/);

      // Act: answererは新associationを受け入れず、対応m-lineをrejectする。
      const answer = await caller.createAnswer();
      expect(answer.sdp).toMatch(/m=application 0 /);
      expect(answer.sdp).toMatch(/a=sctp-port:0/);

      // Act: 旧DataChannelで通信し、reject answerを非zeroで受理しようとするとSLDを拒否する。
      const receivedMessage = remoteChannel.onMessage.asPromise(5_000);
      channel.send("fingerprint-pending");
      expect((await receivedMessage)[0].toString()).toBe("fingerprint-pending");

      const acceptedAnswer = {
        type: "answer" as const,
        sdp: answer.sdp.replace(/m=application 0 /, "m=application 9 "),
      };
      await expect(caller.setLocalDescription(acceptedAnswer)).rejects.toThrow(
        "DTLS association replacement is not implemented",
      );
      expect(caller.dtlsTransports[0].state).toBe("connected");
      expect(channel.readyState).toBe("open");

      // Act: reject answerをcommitし、runtimeのSCTP/DTLSを停止する。
      await caller.setLocalDescription(answer);

      // Assert: SDP上のrejectが現行transportへ反映される。
      expect(caller.signalingState).toBe("stable");
      expect(channel.readyState).toBe("closed");
      expect(caller.sctp?.sctp.associationState).toBe(SCTP_STATE.CLOSED);
      expect(caller.dtlsTransports[0].state).toBe("closed");
    } finally {
      await Promise.allSettled([caller.close(), callee.close()]);
    }
  }, 30_000);

  test("unbundledで片方のfingerprint変更をrejectしてもaccepted RTPとconnectionStateを維持する", async () => {
    // Arrange: unbundled の audio/video を別DTLSで接続する。
    const caller = new RTCPeerConnection({
      iceServers: [],
      bundlePolicy: "disable",
    });
    const callee = new RTCPeerConnection({
      iceServers: [],
      bundlePolicy: "disable",
    });
    const audioTrack = new MediaStreamTrack({ kind: "audio" });
    const videoTrack = new MediaStreamTrack({ kind: "video" });
    caller.addTransceiver(audioTrack, { direction: "sendonly" });
    caller.addTransceiver(videoTrack, { direction: "sendonly" });
    callee.addTransceiver("audio", { direction: "recvonly" });
    callee.addTransceiver("video", { direction: "recvonly" });

    try {
      await caller.setLocalDescription(await caller.createOffer());
      await callee.setRemoteDescription(caller.localDescription!);
      await callee.setLocalDescription(await callee.createAnswer());
      await caller.setRemoteDescription(callee.localDescription!);
      await Promise.all([
        waitForConnectionState(caller, "connected"),
        waitForConnectionState(callee, "connected"),
      ]);

      const audioTransport = callee
        .getTransceivers()
        .find((transceiver) => transceiver.kind === "audio")!.dtlsTransport;
      const videoTransport = callee
        .getTransceivers()
        .find((transceiver) => transceiver.kind === "video")!.dtlsTransport;
      expect(audioTransport.id).not.toBe(videoTransport.id);
      const remoteAudio = callee
        .getTransceivers()
        .find((transceiver) => transceiver.kind === "audio")!.receiver.track;

      // Act: video m-lineだけfingerprintを変えたsubsequent offerをSRDしてreject answerする。
      await caller.setLocalDescription(await caller.createOffer());
      await callee.setRemoteDescription({
        type: "offer",
        sdp: tamperFingerprintForKind(caller.localDescription!.sdp, "video"),
      });
      const answer = await callee.createAnswer();
      expect(answer.sdp).toMatch(/^m=video 0 /m);
      expect(answer.sdp).toMatch(/^m=audio 9 /m);
      await callee.setLocalDescription(answer);

      // Assert: rejected DTLSだけ閉じ、accepted RTPとPC接続は続く。
      expect(videoTransport.state).toBe("closed");
      expect(audioTransport.state).toBe("connected");
      expect(callee.connectionState).toBe("connected");
      const receivedRtpPromise = remoteAudio.onReceiveRtp.asPromise(5_000);
      audioTrack.writeRtp(
        new RtpPacket(
          new RtpHeader({ sequenceNumber: 41, payloadType: 96 }),
          Buffer.from("audio-kept"),
        ).serialize(),
      );
      const [receivedRtp] = await receivedRtpPromise;
      expect(receivedRtp.payload).toEqual(Buffer.from("audio-kept"));
    } finally {
      await Promise.allSettled([caller.close(), callee.close()]);
    }
  }, 30_000);

  test("media-only の古い connect は fingerprint変更のremote offerでfailedにしない", async () => {
    // Arrange: media-only の実接続を用意し、初回 connect の完了直前を保持する。
    const caller = new RTCPeerConnection({});
    const callee = new RTCPeerConnection({});
    caller.addTransceiver("audio");
    await caller.setLocalDescription(await caller.createOffer());
    await callee.setRemoteDescription(caller.localDescription!);
    await callee.setLocalDescription(await callee.createAnswer());

    const dtls = caller.dtlsTransports[0]!;
    const originalStart = dtls.start;
    let startEntered!: () => void;
    const startEnteredPromise = new Promise<void>((resolve) => {
      startEntered = resolve;
    });
    let releaseStart!: () => void;
    const startGate = new Promise<void>((resolve) => {
      releaseStart = resolve;
    });
    dtls.start = async () => {
      await originalStart.call(dtls);
      startEntered();
      await startGate;
    };

    try {
      // Act: DTLS は connected まで進めるが、古い connect() の最終判定を止める。
      await caller.setRemoteDescription(callee.localDescription!);
      await startEnteredPromise;
      expect(dtls.state).toBe("connected");

      // Act: 保留中の connect() より先に、不一致 fingerprint の offer を適用する。
      const renegotiationOffer = await callee.createOffer();
      await callee.setLocalDescription(renegotiationOffer);
      await caller.setRemoteDescription({
        type: "offer",
        sdp: tamperFingerprints(callee.localDescription!.sdp),
      });
      expect(dtls.state).toBe("connected");

      // Act: 古い connect() を再開する。
      releaseStart();
      await setTimeout(0);

      // Assert: fingerprint変更は現行associationをfailedにせず、古いconnect完了後も維持する。
      expect(dtls.state).toBe("connected");
      expect(caller.connectionState).not.toBe("failed");
    } finally {
      dtls.start = originalStart;
      await Promise.allSettled([caller.close(), callee.close()]);
    }
  }, 30_000);

  test("接続中に追加した未交渉 transport は接続判定へ混入しない", async () => {
    // Arrange: bundle を無効にした DTLS 1.2、direct DTLS 1.3、SPED DTLS 1.3 の接続を用意する。
    const cases = [
      ["DTLS 1.2", {}],
      ["direct DTLS 1.3", { dtls: { protocolVersions: [DtlsVersion.V1_3] } }],
      [
        "SPED DTLS 1.3",
        { sped: true, dtls: { protocolVersions: [DtlsVersion.V1_3] } },
      ],
    ] as const;

    for (const [label, extraConfig] of cases) {
      const caller = new RTCPeerConnection({
        iceServers: [],
        bundlePolicy: "disable",
        ...extraConfig,
      });
      const callee = new RTCPeerConnection({
        iceServers: [],
        bundlePolicy: "disable",
        ...extraConfig,
      });
      caller.addTransceiver("audio");
      const initialTransport = caller.dtlsTransports[0]!;
      let addedVideo = false;
      const receivedPayloads: string[] = [];

      caller.onconnectionstatechange = () => {
        if (caller.connectionState === "connecting" && !addedVideo) {
          addedVideo = true;
          // Act: 初回接続の通知中に、次の SDP 交渉用 transport を追加する。
          caller.addTransceiver("video");
        }
      };

      try {
        // Act: 音声だけを含む初回 offer/answer を適用して接続を開始する。
        await caller.setLocalDescription(await caller.createOffer());
        await callee.setRemoteDescription(caller.localDescription!);
        callee.dtlsTransports[0]!.onRtp.subscribe((packet) => {
          receivedPayloads.push(packet.payload.toString());
        });
        await callee.setLocalDescription(await callee.createAnswer());
        await caller.setRemoteDescription(callee.localDescription!);

        // Act: 対象 transport の接続完了を待ち、既存 media の送信を行う。
        const deadline = Date.now() + 5_000;
        while (
          (initialTransport.state !== "connected" ||
            caller.connectionState !== "connected") &&
          Date.now() < deadline
        ) {
          await setTimeout(10);
        }
        await initialTransport.sendRtp(
          Buffer.from("existing-audio-is-live"),
          new RtpHeader({
            ssrc: 3456,
            payloadType: 96,
            sequenceNumber: 1,
          }),
        );
        while (receivedPayloads.length === 0 && Date.now() < deadline) {
          await setTimeout(10);
        }

        // Assert: 新規 transport は未交渉のままでも、既存接続の成功を失敗にしない。
        expect(initialTransport.state, label).toBe("connected");
        expect(caller.connectionState, label).toBe("connected");
        expect(caller.dtlsTransports).toHaveLength(2);
        expect(caller.dtlsTransports[1]?.state).toBe("new");
        expect(receivedPayloads).toContain("existing-audio-is-live");
      } finally {
        await Promise.allSettled([caller.close(), callee.close()]);
      }
    }
  }, 60_000);

  test("BUNDLE tag の DTLS/ICE parameters が後続 media section で上書きされない", async () => {
    // Arrange: BUNDLE の tag 以外の m-line だけ別証明書・ICE parameters になる offer を用意する。
    const alternateKeys = await createSelfSignedCertificate({
      signature: SignatureAlgorithm.ecdsa_3,
      hash: HashAlgorithm.sha256_4,
    });
    const alternateCertificate = new RTCCertificate(
      alternateKeys.keyPem,
      alternateKeys.certPem,
      alternateKeys.signatureHash,
    );
    const cases = [
      ["DTLS 1.2", {}],
      ["direct DTLS 1.3", { dtls: { protocolVersions: [DtlsVersion.V1_3] } }],
      [
        "SPED DTLS 1.3",
        { sped: true, dtls: { protocolVersions: [DtlsVersion.V1_3] } },
      ],
    ] as const;

    for (const [label, extraConfig] of cases) {
      const caller = new RTCPeerConnection({
        iceServers: [],
        bundlePolicy: "max-compat",
        ...extraConfig,
      });
      const callee = new RTCPeerConnection({
        iceServers: [],
        ...extraConfig,
      });
      caller.addTransceiver("audio");
      caller.addTransceiver("video");
      const originalTransports = [...caller.dtlsTransports];
      let receivedAudio: string | undefined;

      try {
        await caller.setLocalDescription(await caller.createOffer());

        // Act: BUNDLE tag の audio の値を保存し、video だけ異なる値へ書き換える。
        caller.dtlsTransports[1]!.localCertificate = alternateCertificate;
        const fingerprint = alternateCertificate.getFingerprints()[0]!;
        const sections = caller.localDescription!.sdp.split(/(?=^m=)/m);
        const tagSection = sections[1]!;
        const tagUfragMatch = tagSection.match(/^a=ice-ufrag:([^\r\n]+)$/m);
        const tagPasswordMatch = tagSection.match(/^a=ice-pwd:([^\r\n]+)$/m);
        const tagCandidates = [
          ...tagSection.matchAll(/^a=candidate:([^\r\n]+)$/gm),
        ].map((match) => match[1]!);
        expect(tagUfragMatch).not.toBeNull();
        expect(tagPasswordMatch).not.toBeNull();
        expect(tagCandidates.length).toBeGreaterThan(0);

        const nonTagCandidate = "a=candidate:9999 1 udp 1 192.0.2.1 9 typ host";
        sections[2] = sections[2]!
          .replace(
            /^a=fingerprint:.*$/gm,
            `a=fingerprint:${fingerprint.algorithm} ${fingerprint.value}`,
          )
          .replace(/^a=ice-ufrag:.*$/gm, "a=ice-ufrag:NonTagUfrag1234")
          .replace(
            /^a=ice-pwd:.*$/gm,
            "a=ice-pwd:NonTagPassword01234567890123456789",
          )
          .replace(/^a=candidate:.*$/gm, nonTagCandidate);
        const modifiedOffer = {
          type: "offer" as const,
          sdp: sections.join(""),
        };
        await callee.setRemoteDescription(modifiedOffer);
        await callee.setLocalDescription(await callee.createAnswer());

        // Assert: 非 tag の credentials/candidate が共有 transport に混入していない。
        const calleeIce = callee.dtlsTransports[0]!.iceTransport.connection;
        expect(calleeIce.remoteUsername).toBe(tagUfragMatch![1]);
        expect(calleeIce.remotePassword).toBe(tagPasswordMatch![1]);
        expect(
          calleeIce.remoteCandidates.map((candidate) => candidate.toSdp()),
        ).toEqual(tagCandidates);

        callee.dtlsTransports[0]!.onRtp.subscribe((packet) => {
          receivedAudio = packet.payload.toString();
        });
        await caller.setRemoteDescription(callee.localDescription!);

        // Act: 両端の BUNDLE transport が認証済みになるまで待って audio を送る。
        const deadline = Date.now() + 10_000;
        while (
          (caller.connectionState !== "connected" ||
            callee.connectionState !== "connected") &&
          Date.now() < deadline
        ) {
          await setTimeout(10);
        }
        await caller.dtlsTransports[0]!.sendRtp(
          Buffer.from("bundled-audio"),
          new RtpHeader({ ssrc: 0x713, sequenceNumber: 1, payloadType: 96 }),
        );
        while (receivedAudio === undefined && Date.now() < deadline) {
          await setTimeout(10);
        }

        // Assert: tag の DTLS/ICE 値で認証・接続され、後続 video の値で失敗しない。
        expect(caller.connectionState, label).toBe("connected");
        expect(callee.connectionState, label).toBe("connected");
        expect(callee.dtlsTransports[0]!.state, label).toBe("connected");
        expect(receivedAudio, label).toBe("bundled-audio");
        expect(caller.dtlsTransports, label).not.toContain(
          originalTransports[1],
        );
        expect(originalTransports[1]!.state, label).toBe("closed");
        expect(originalTransports[1]!.iceTransport.state, label).toBe("closed");
      } finally {
        await Promise.allSettled([caller.close(), callee.close()]);
        await Promise.allSettled(
          originalTransports.map((transport) => transport.stop()),
        );
      }
    }
  }, 90_000);

  test("setRemoteDescription は close 後に signalingState を再開しない", async () => {
    const cases = [
      ["transport replacement なし", false],
      ["BUNDLE transport replacement あり", true],
    ] as const;

    for (const [label, withBundleReplacement] of cases) {
      // Arrange: remote transceiver 通知から SRD の await 中に close する構成を作る。
      const caller = new RTCPeerConnection({
        iceServers: [],
        ...(withBundleReplacement
          ? { bundlePolicy: "max-compat" as const }
          : {}),
      });
      const callee = new RTCPeerConnection({ iceServers: [] });
      caller.addTransceiver("audio");
      if (withBundleReplacement) {
        caller.addTransceiver("video");
      }
      await caller.setLocalDescription(await caller.createOffer());

      let closePromise: Promise<void> | undefined;
      callee.onRemoteTransceiverAdded.subscribe(() => {
        if (closePromise) return;
        closePromise = new Promise<void>((resolve) => {
          queueMicrotask(() => {
            void callee.close().finally(resolve);
          });
        });
      });

      try {
        // Act: SRD の transceiver 通知後、追加された stopTransport 待機へ入る。
        await callee.setRemoteDescription(caller.localDescription!);
        expect(closePromise, label).toBeDefined();
        await closePromise;

        // Assert: close 済みの PeerConnection は両方の公開状態を終端に保つ。
        expect(callee.connectionState, label).toBe("closed");
        expect(callee.signalingState, label).toBe("closed");
      } finally {
        await Promise.allSettled([caller.close(), callee.close()]);
      }
    }
  });

  test("BUNDLE tag の順序変更で同種 transceiver の割り当てを入れ替えない", async () => {
    // Arrange: 未割り当ての video transceiver と、逆順の BUNDLE tag を持つ offer を用意する。
    const codecs = {
      video: [useVP8({ payloadType: 96, rtcpFeedback: [useTWCC()] })],
    };
    const caller = new RTCPeerConnection({
      iceServers: [],
      bundlePolicy: "max-compat",
      codecs,
    });
    const callee = new RTCPeerConnection({ iceServers: [], codecs });
    const callerCamera = new MediaStreamTrack({ kind: "video" });
    const callerScreen = new MediaStreamTrack({ kind: "video" });
    const calleeCamera = new MediaStreamTrack({ kind: "video" });
    const calleeScreen = new MediaStreamTrack({ kind: "video" });
    caller.addTransceiver(callerCamera);
    caller.addTransceiver(callerScreen);
    const cameraSender = callee.addTrack(calleeCamera);
    const screenSender = callee.addTrack(calleeScreen);
    const originalCalleeTransports = [...callee.dtlsTransports];
    const expectedBundleTransport = originalCalleeTransports[1]!;
    const trackEventTransports: unknown[] = [];
    callee.ontrack = ({ receiver }) => {
      trackEventTransports.push(receiver.transport);
    };

    try {
      await caller.setLocalDescription(await caller.createOffer());
      const originalSdp = caller.localDescription!.sdp;
      const bundleMatch = originalSdp.match(/^a=group:BUNDLE ([^\r\n]+)$/m);
      expect(bundleMatch).not.toBeNull();
      const reversedBundle = bundleMatch![1]!
        .trim()
        .split(" ")
        .reverse()
        .join(" ");
      const modifiedOffer = {
        type: "offer" as const,
        sdp: originalSdp.replace(
          bundleMatch![0],
          `a=group:BUNDLE ${reversedBundle}`,
        ),
      };
      const offerMids = [
        ...modifiedOffer.sdp.matchAll(/^a=mid:([^\r\n]+)$/gm),
      ].map((match) => match[1]!);

      // Act: m-line 順を維持したまま、逆順 tag の offer を適用する。
      await callee.setRemoteDescription(modifiedOffer);
      const transceivers = callee.getTransceivers();

      // Assert: sender の track と remote m-line の MID 対応は SDP 順のままになる。
      expect(transceivers).toHaveLength(2);
      expect(transceivers[0]!.sender).toBe(cameraSender);
      expect(transceivers[0]!.sender.track).toBe(calleeCamera);
      expect(transceivers[0]!.mid).toBe(offerMids[0]);
      expect(transceivers[1]!.sender).toBe(screenSender);
      expect(transceivers[1]!.sender.track).toBe(calleeScreen);
      expect(transceivers[1]!.mid).toBe(offerMids[1]);

      // Assert: ontrack と TWCC は遅延 rebind 前の停止済み transport を保持しない。
      expect(trackEventTransports).toEqual([
        expectedBundleTransport,
        expectedBundleTransport,
      ]);
      const receiverTwcc = (
        transceivers[0]!.receiver as unknown as {
          receiverTWCC?: { handleTWCC(sequenceNumber: number): void };
        }
      ).receiverTWCC;
      expect(receiverTwcc).toBeDefined();
      let tagFeedback = 0;
      let staleFeedback = 0;
      const staleTransport = originalCalleeTransports[0]!;
      expect(staleTransport).not.toBe(expectedBundleTransport);
      const originalTagSendRtcp = expectedBundleTransport.sendRtcp;
      const originalStaleSendRtcp = staleTransport.sendRtcp;
      expectedBundleTransport.sendRtcp = async () => {
        tagFeedback++;
        return undefined;
      };
      staleTransport.sendRtcp = async () => {
        staleFeedback++;
        return undefined;
      };
      try {
        // Act: feedback thresholdを越えるtransport-wide sequenceを受信する。
        for (let sequenceNumber = 0; sequenceNumber < 11; sequenceNumber++) {
          receiverTwcc!.handleTWCC(sequenceNumber);
        }
        await setTimeout(0);

        // Assert: TWCC feedbackも最終BUNDLE tag transportだけを使う。
        expect(tagFeedback).toBe(1);
        expect(staleFeedback).toBe(0);
      } finally {
        expectedBundleTransport.sendRtcp = originalTagSendRtcp;
        staleTransport.sendRtcp = originalStaleSendRtcp;
      }

      // Act: answer生成から両端の接続完了までreverse tagを維持する。
      const answer = await callee.createAnswer();
      const answerBundle = answer.sdp.match(/^a=group:BUNDLE ([^\r\n]+)$/m);
      expect(answerBundle?.[1]).toBe(reversedBundle);
      await callee.setLocalDescription(answer);
      expect(staleTransport.state).toBe("closed");
      await caller.setRemoteDescription(callee.localDescription!);
      await Promise.all([
        waitForConnectionState(caller, "connected"),
        waitForConnectionState(callee, "connected"),
      ]);

      // Assert: reverse tagのoffer/answer negotiationが接続まで成立する。
      expect(caller.connectionState).toBe("connected");
      expect(callee.connectionState).toBe("connected");
    } finally {
      await Promise.allSettled([caller.close(), callee.close()]);
    }
  });

  test("partial BUNDLE は group外 m-line を独立 transport に割り当てる", async () => {
    // Arrange: applicationをgroup外に置き、第2 mediaをtagにしたpartial BUNDLE offerを作る。
    const caller = new RTCPeerConnection({
      iceServers: [],
      bundlePolicy: "max-compat",
    });
    const callee = new RTCPeerConnection({ iceServers: [] });
    caller.addTransceiver("audio");
    caller.addTransceiver("video");
    caller.createDataChannel("outside-bundle");

    try {
      await caller.setLocalDescription(await caller.createOffer());
      const offerSdp = caller.localDescription!.sdp;
      const mids = [...offerSdp.matchAll(/^a=mid:([^\r\n]+)$/gm)].map(
        (match) => match[1]!,
      );
      expect(mids).toHaveLength(3);
      const offeredBundle = `${mids[1]} ${mids[0]}`;
      const modifiedOffer = {
        type: "offer" as const,
        sdp: offerSdp.replace(
          /^a=group:BUNDLE [^\r\n]+$/m,
          `a=group:BUNDLE ${offeredBundle}`,
        ),
      };

      // Act: partial/reverse BUNDLE offerを適用してtransport graphを構築する。
      await callee.setRemoteDescription(modifiedOffer);

      // Assert: audio/videoだけがtag transportを共有し、applicationは独立する。
      const [audioTransceiver, videoTransceiver] = callee.getTransceivers();
      expect(callee.dtlsTransports).toHaveLength(2);
      expect(audioTransceiver?.dtlsTransport).toBe(
        videoTransceiver?.dtlsTransport,
      );
      expect(callee.sctp?.dtlsTransport).not.toBe(
        audioTransceiver?.dtlsTransport,
      );

      const answer = await callee.createAnswer();

      // Assert: answerはtagを並べ替えず、group外MIDも勝手に追加しない。
      expect(answer.sdp.match(/^a=group:BUNDLE ([^\r\n]+)$/m)?.[1]).toBe(
        offeredBundle,
      );

      // Act: partial BUNDLE answerを双方へ適用し、独立transportも接続する。
      await callee.setLocalDescription(answer);
      expect(
        callee.sctp?.dtlsTransport.iceTransport.connection.remoteUsername,
      ).toBe(
        modifiedOffer.sdp
          .split(/(?=^m=)/m)
          .find((section) => section.startsWith("m=application"))
          ?.match(/^a=ice-ufrag:([^\r\n]+)$/m)?.[1],
      );
      expect(
        callee.sctp?.dtlsTransport.iceTransport.connection.localUsername,
      ).not.toBe(
        audioTransceiver?.dtlsTransport.iceTransport.connection.localUsername,
      );
      await caller.setRemoteDescription(callee.localDescription!);
      await Promise.all([
        waitForConnectionState(caller, "connected"),
        waitForConnectionState(callee, "connected"),
      ]);

      // Assert: SDP上だけでなく、BUNDLE transportとapplication transportが
      // それぞれICE/DTLS接続済みになる。
      expect(caller.connectionState).toBe("connected");
      expect(callee.connectionState).toBe("connected");
      expect(callee.sctp?.dtlsTransport.state).toBe("connected");
    } finally {
      await Promise.allSettled([caller.close(), callee.close()]);
    }
  });

  test("partial BUNDLE は事前割り当て済みtag transportからgroup外SCTPを分離する", async () => {
    // Arrange: answererのmax-bundleで先に全m-lineを同じtransportへ置く。
    const caller = new RTCPeerConnection({ iceServers: [] });
    const callee = new RTCPeerConnection({
      iceServers: [],
      bundlePolicy: "max-bundle",
    });
    caller.addTransceiver("audio");
    caller.addTransceiver("video");
    caller.createDataChannel("outside-bundle");
    callee.createDataChannel("preallocated");
    callee.addTransceiver("audio");
    callee.addTransceiver("video");

    try {
      await caller.setLocalDescription(await caller.createOffer());
      const offerSdp = caller.localDescription!.sdp;
      const mids = [...offerSdp.matchAll(/^a=mid:([^\r\n]+)$/gm)].map(
        (match) => match[1]!,
      );
      const modifiedOffer = {
        type: "offer" as const,
        sdp: offerSdp.replace(
          /^a=group:BUNDLE [^\r\n]+$/m,
          `a=group:BUNDLE ${mids[1]} ${mids[0]}`,
        ),
      };

      // Act: group外applicationを、既存の共有transportを持つanswererへ適用する。
      await callee.setRemoteDescription(modifiedOffer);

      // Assert: 既存transportを再利用せず、application専用transportを確保する。
      const [audioTransceiver, videoTransceiver] = callee.getTransceivers();
      expect(audioTransceiver?.dtlsTransport).toBe(
        videoTransceiver?.dtlsTransport,
      );
      expect(callee.sctp?.dtlsTransport).not.toBe(
        audioTransceiver?.dtlsTransport,
      );
    } finally {
      await Promise.allSettled([caller.close(), callee.close()]);
    }
  });

  test("initial BUNDLE は拒否されたtagから受理MIDへfallbackし、credentialsを一致させる", async () => {
    // Arrange: 先頭 audio は answer 側で stop して拒否し、videoだけ受理する。
    const caller = new RTCPeerConnection({ iceServers: [] });
    const callee = new RTCPeerConnection({ iceServers: [] });
    caller.addTransceiver("audio");
    caller.addTransceiver("video");
    callee.addTransceiver("audio");
    callee.addTransceiver("video");

    try {
      await caller.setLocalDescription(await caller.createOffer());
      const offer = caller.localDescription!;
      const offerSections = offer.sdp.split(/(?=^m=)/m);
      const audioSection = offerSections.find((section) =>
        section.startsWith("m=audio"),
      )!;
      const videoSection = offerSections.find((section) =>
        section.startsWith("m=video"),
      )!;
      const audioMid = audioSection.match(/^a=mid:([^\r\n]+)$/m)![1]!;
      const videoMid = videoSection.match(/^a=mid:([^\r\n]+)$/m)![1]!;
      const videoUfrag = videoSection.match(/^a=ice-ufrag:([^\r\n]+)$/m)![1]!;

      // Act: initial BUNDLE offerを適用したあと、suggested tagをrejectする。
      await callee.setRemoteDescription(offer);
      callee.getTransceivers()[0]!.stop();
      const answer = await callee.createAnswer();

      // Assert: answer groupは受理されたvideo MIDを先頭tagにし、audioを含めない。
      expect(answer.sdp).toMatch(
        new RegExp(`^a=group:BUNDLE ${videoMid}$`, "m"),
      );
      const answerAudio = answer.sdp
        .split(/(?=^m=)/m)
        .find((section) => section.startsWith("m=audio"));
      expect(answerAudio).toMatch(/^m=audio 0 /);
      expect(answer.sdp).toContain(`a=mid:${audioMid}`);

      // Act: 確定したanswer tagのcredentialsをcommitする。
      await callee.setLocalDescription(answer);

      // Assert: 共有transportは拒否したaudioではなくvideoのremote ufragを使う。
      const videoTransceiver = callee
        .getTransceivers()
        .find((transceiver) => transceiver.mid === videoMid);
      expect(
        videoTransceiver?.dtlsTransport.iceTransport.connection.remoteUsername,
      ).toBe(videoUfrag);
    } finally {
      await Promise.allSettled([caller.close(), callee.close()]);
    }
  });

  test("確立済みBUNDLEはremote offererのtag変更とICE restartを受け入れる", async () => {
    // Arrange: 2つのm-lineをBUNDLEで接続し、後続offerのtag候補を用意する。
    const caller = new RTCPeerConnection({
      iceServers: [],
      bundlePolicy: "max-compat",
    });
    const callee = new RTCPeerConnection({
      iceServers: [],
      bundlePolicy: "max-compat",
    });
    caller.addTransceiver("audio");
    caller.addTransceiver("video");

    try {
      await caller.setLocalDescription(await caller.createOffer());
      await callee.setRemoteDescription(caller.localDescription!);
      await callee.setLocalDescription(await callee.createAnswer());
      await caller.setRemoteDescription(callee.localDescription!);
      await Promise.all([
        waitForConnectionState(caller, "connected"),
        waitForConnectionState(callee, "connected"),
      ]);

      const establishedTransport = callee.dtlsTransports[0]!;
      const offer = await caller.createOffer({ iceRestart: true });
      await caller.setLocalDescription(offer);
      const sections = caller.localDescription!.sdp.split(/(?=^m=)/m);
      const mids = sections
        .filter((section) => section.startsWith("m="))
        .map((section) => section.match(/^a=mid:([^\r\n]+)$/m)![1]!);
      expect(mids).toHaveLength(2);
      const reversedBundle = `${mids[1]} ${mids[0]}`;
      const invalidOldTagFingerprint =
        "a=fingerprint:sha-256 00:00:00:00:00:00:00:00:00:00:00:00:00:00:00:00:00:00:00:00:00:00:00:00:00:00:00:00:00:00:00:00:00:00:00:00";
      const modifiedOfferSdp = sections
        .map((section) =>
          section.match(/^a=mid:([^\r\n]+)$/m)?.[1] === mids[0]
            ? section.replace(
                /^a=fingerprint:[^\r\n]+$/m,
                invalidOldTagFingerprint,
              )
            : section,
        )
        .join("")
        .replace(
          /^a=group:BUNDLE [^\r\n]+$/m,
          `a=group:BUNDLE ${reversedBundle}`,
        );

      // Act: remote offerの先頭MIDを変更し、old tagのfingerprintだけを無効化する。
      await callee.setRemoteDescription({
        type: "offer",
        sdp: modifiedOfferSdp,
      });

      // Assert: offererの新tagだけを認証対象にして、既存transportを保つ。
      expect(callee.dtlsTransports[0]).toBe(establishedTransport);
      expect(establishedTransport.state).not.toBe("failed");
      const answer = await callee.createAnswer();
      expect(answer.sdp).toMatch(
        new RegExp(`^a=group:BUNDLE ${reversedBundle}$`, "m"),
      );

      // Act: reverse-tag answerを適用し、ICE restartを完了させる。
      await callee.setLocalDescription(answer);
      await caller.setRemoteDescription(callee.localDescription!);
      await Promise.all([
        waitForConnectionState(caller, "connected"),
        waitForConnectionState(callee, "connected"),
      ]);

      // Assert: remote tag変更後も双方の接続状態を維持する。
      expect(caller.connectionState).toBe("connected");
      expect(callee.connectionState).toBe("connected");
    } finally {
      await Promise.allSettled([caller.close(), callee.close()]);
    }
  }, 30_000);

  test("確立済みBUNDLEから外したm-lineは独立transportへsplitする", async () => {
    // Arrange: 2つのvideo m-lineをBUNDLEで接続する。
    const caller = new RTCPeerConnection({
      iceServers: [],
      bundlePolicy: "max-compat",
    });
    const callee = new RTCPeerConnection({
      iceServers: [],
      bundlePolicy: "max-compat",
    });
    caller.addTransceiver("video");
    caller.addTransceiver("video");

    try {
      await caller.setLocalDescription(await caller.createOffer());
      await callee.setRemoteDescription(caller.localDescription!);
      await callee.setLocalDescription(await callee.createAnswer());
      await caller.setRemoteDescription(callee.localDescription!);
      await Promise.all([
        waitForConnectionState(caller, "connected"),
        waitForConnectionState(callee, "connected"),
      ]);
      expect(caller.getTransceivers()[0]!.dtlsTransport).toBe(
        caller.getTransceivers()[1]!.dtlsTransport,
      );

      const offer = await caller.createOffer();
      const mids = [...offer.sdp.matchAll(/^a=mid:([^\r\n]+)$/gm)].map(
        (match) => match[1]!,
      );
      const splitOfferSdp = offer.sdp.replace(
        /^a=group:BUNDLE [^\r\n]+$/m,
        `a=group:BUNDLE ${mids[0]}`,
      );
      (caller as unknown as { lastCreatedOffer?: unknown }).lastCreatedOffer =
        undefined;

      const currentCalleeTransport = callee.getTransceivers()[1]!.dtlsTransport;

      // Act: local pending offerではまだcurrent transportをrebindしない。
      await caller.setLocalDescription({
        type: "offer",
        sdp: splitOfferSdp,
      });
      await callee.setRemoteDescription(caller.localDescription!);

      // Assert: answer前のcurrent graphは共有transportのまま維持する。
      expect(callee.getTransceivers()[1]!.dtlsTransport).toBe(
        currentCalleeTransport,
      );

      // Act: answerをcommitして、group外videoを独立transportへ移行する。
      const answer = await callee.createAnswer();
      expect(answer.sdp).toMatch(
        new RegExp(`^a=group:BUNDLE ${mids[0]}$`, "m"),
      );
      await callee.setLocalDescription(answer);
      await caller.setRemoteDescription(callee.localDescription!);
      await Promise.all([
        waitForConnectionState(caller, "connected"),
        waitForConnectionState(callee, "connected"),
      ]);

      // Assert: audio相当のtag m-lineとsplit m-lineが別々に接続される。
      const [callerTag, callerSplit] = caller.getTransceivers();
      const [calleeTag, calleeSplit] = callee.getTransceivers();
      expect(callerTag!.dtlsTransport).not.toBe(callerSplit!.dtlsTransport);
      expect(calleeTag!.dtlsTransport).not.toBe(calleeSplit!.dtlsTransport);
      expect(callerSplit!.dtlsTransport.state).toBe("connected");
      expect(calleeSplit!.dtlsTransport.state).toBe("connected");
    } finally {
      await Promise.allSettled([caller.close(), callee.close()]);
    }
  }, 30_000);

  test("local subsequent offerで追加したm-lineを確立済みBUNDLEへstageする", async () => {
    // Arrange: 1つのvideo m-lineをBUNDLEで接続し、後からvideoを追加する。
    const caller = new RTCPeerConnection({
      iceServers: [],
      bundlePolicy: "max-compat",
    });
    const callee = new RTCPeerConnection({
      iceServers: [],
      bundlePolicy: "max-compat",
    });
    caller.addTransceiver("video");

    try {
      await caller.setLocalDescription(await caller.createOffer());
      await callee.setRemoteDescription(caller.localDescription!);
      await callee.setLocalDescription(await callee.createAnswer());
      await caller.setRemoteDescription(callee.localDescription!);
      await Promise.all([
        waitForConnectionState(caller, "connected"),
        waitForConnectionState(callee, "connected"),
      ]);

      const establishedCallerTransport =
        caller.getTransceivers()[0]!.dtlsTransport;
      const newTransceiver = caller.addTransceiver("video");
      const offer = await caller.createOffer();
      const offerSections = offer.sdp.split(/(?=^m=)/m);
      const offerMids = [...offer.sdp.matchAll(/^a=mid:([^\r\n]+)$/gm)].map(
        (match) => match[1]!,
      );
      expect(offerMids).toHaveLength(2);
      const bundleItems = offer.sdp.match(/^a=group:BUNDLE ([^\r\n]+)$/m)?.[1];
      expect(bundleItems).toBe(`${offerMids[0]} ${offerMids[1]}`);
      const tagSection = offerSections.find((section) =>
        section.includes(`a=mid:${offerMids[0]}`),
      )!;
      const addedSection = offerSections.find((section) =>
        section.includes(`a=mid:${offerMids[1]}`),
      )!;
      expect(addedSection.match(/^a=ice-ufrag:([^\r\n]+)$/m)?.[1]).toBe(
        tagSection.match(/^a=ice-ufrag:([^\r\n]+)$/m)?.[1],
      );
      expect(addedSection.match(/^a=fingerprint:([^\r\n]+)$/m)?.[1]).toBe(
        tagSection.match(/^a=fingerprint:([^\r\n]+)$/m)?.[1],
      );

      // Act: local offerを適用するが、answer前は新transceiverを旧transportへbindしない。
      await caller.setLocalDescription(offer);
      expect(newTransceiver.dtlsTransport).not.toBe(establishedCallerTransport);
      await callee.setRemoteDescription(caller.localDescription!);

      // Assert: remote側もpending中はcurrent graphを維持する。
      expect(callee.getTransceivers()).toHaveLength(2);
      expect(callee.getTransceivers()[1]!.dtlsTransport).not.toBe(
        callee.getTransceivers()[0]!.dtlsTransport,
      );

      // Act: answer commit時に新m-lineを確立済みtagへ追加する。
      const answer = await callee.createAnswer();
      expect(answer.sdp).toMatch(
        new RegExp(`^a=group:BUNDLE ${offerMids[0]} ${offerMids[1]}$`, "m"),
      );
      await callee.setLocalDescription(answer);
      await caller.setRemoteDescription(callee.localDescription!);
      await Promise.all([
        waitForConnectionState(caller, "connected"),
        waitForConnectionState(callee, "connected"),
      ]);

      // Assert: answer後は追加m-lineもtag transportを共有して接続する。
      expect(newTransceiver.dtlsTransport).toBe(establishedCallerTransport);
      expect(callee.getTransceivers()[1]!.dtlsTransport).toBe(
        callee.getTransceivers()[0]!.dtlsTransport,
      );
    } finally {
      await Promise.allSettled([caller.close(), callee.close()]);
    }
  }, 30_000);

  test("pending remote BUNDLE offerのrollbackはcurrent RTP/DataChannelを維持する", async () => {
    // Arrange: unbundledで接続済みのRTP/DataChannelと現在のtransport graphを用意する。
    const { caller, callee, channel, remoteChannel, track, remoteTrack } =
      await createConnectedUnbundledPair();

    try {
      const currentRemoteSdp = callee.currentRemoteDescription!.sdp;
      const currentVideoTransport = callee.getTransceivers()[0]!.dtlsTransport;
      const currentApplicationTransport = callee.sctp!.dtlsTransport;
      const currentAssociation = callee.sctp!.sctp;

      // Act: BUNDLE renegotiation offerをpending状態まで適用する。
      await caller.setLocalDescription(await caller.createOffer());
      await callee.setRemoteDescription(caller.localDescription!);

      // Assert: answer前はcurrent SDP/transport/associationを変更しない。
      expect(callee.signalingState).toBe("have-remote-offer");
      expect(callee.currentRemoteDescription!.sdp).toBe(currentRemoteSdp);
      expect(callee.getTransceivers()[0]!.dtlsTransport).toBe(
        currentVideoTransport,
      );
      expect(callee.sctp!.dtlsTransport).toBe(currentApplicationTransport);
      expect(callee.sctp!.sctp).toBe(currentAssociation);
      expect(currentApplicationTransport.state).toBe("connected");
      expect(currentAssociation.associationState).toBe(SCTP_STATE.ESTABLISHED);

      // Act: remote rollbackを適用してpending planを破棄する。
      await callee.setRemoteDescription({ type: "rollback" });

      // Assert: rollback後もcurrent graphと公開SDPは元のまま維持される。
      expect(callee.signalingState).toBe("stable");
      expect(callee.currentRemoteDescription!.sdp).toBe(currentRemoteSdp);
      expect(callee.getTransceivers()[0]!.dtlsTransport).toBe(
        currentVideoTransport,
      );
      expect(callee.sctp!.dtlsTransport).toBe(currentApplicationTransport);
      expect(callee.sctp!.sctp).toBe(currentAssociation);

      // Act: rollback後に旧DataChannelと旧RTP transportで通信する。
      const receivedMessage = remoteChannel.onMessage.asPromise(5_000);
      channel.send("rollback-live");
      const receivedRtpPromise = remoteTrack.onReceiveRtp.asPromise(5_000);
      track.writeRtp(
        new RtpPacket(
          new RtpHeader({ sequenceNumber: 10 }),
          Buffer.from("rollback-rtp"),
        ).serialize(),
      );

      // Assert: rollbackは既存のDataChannel/RTP通信を中断しない。
      expect((await receivedMessage)[0].toString()).toBe("rollback-live");
      const [receivedRtp] = await receivedRtpPromise;
      expect(receivedRtp.payload).toEqual(Buffer.from("rollback-rtp"));
    } finally {
      await Promise.allSettled([caller.close(), callee.close()]);
    }
  }, 30_000);

  test("subsequent ICE restart中の不正candidateは即rejectしcurrent ICEを維持する", async () => {
    // Arrange: 接続済みsessionのICE generationとDataChannelを記録する。
    const { caller, callee, channel, remoteChannel } =
      await createConnectedUnbundledPair();

    try {
      const ice = callee.iceTransports[0]!.connection;
      const generation = ice.generation;
      const remoteUsername = ice.remoteUsername;
      const iceState = callee.iceTransports[0]!.state;

      const restartOffer = await caller.createOffer();
      const currentUfrag = callee.iceTransports[0]!.connection.remoteUsername;
      const restartSdp = restartOffer.sdp.replace(
        new RegExp(`a=ice-ufrag:${currentUfrag}`, "g"),
        "a=ice-ufrag:Rst1",
      );
      expect(restartSdp).not.toBe(restartOffer.sdp);
      await callee.setRemoteDescription({
        type: "offer",
        sdp: restartSdp,
      });

      // Act: have-remote-offer中に存在しないMIDのcandidateを投入する。
      await expect(
        callee.addIceCandidate({
          sdpMid: "does-not-exist",
          candidate: addIceCandidateLine1,
        }),
      ).rejects.toThrow();

      // Assert: candidateは遅延せずrejectされ、current ICEは変わらない。
      expect(callee.signalingState).toBe("have-remote-offer");
      expect(ice.generation).toBe(generation);
      expect(ice.remoteUsername).toBe(remoteUsername);
      expect(callee.iceTransports[0]!.state).toBe(iceState);

      const receivedMessage = remoteChannel.onMessage.asPromise(5_000);
      channel.send("ice-restart-pending");
      expect((await receivedMessage)[0].toString()).toBe("ice-restart-pending");
    } finally {
      await Promise.allSettled([caller.close(), callee.close()]);
    }
  }, 30_000);

  test("SCTP BUNDLE migrationのanswer commit前失敗は旧DataChannelを維持する", async () => {
    // Arrange: unbundled DataChannelを接続し、BUNDLE renegotiationをpendingにする。
    const { caller, callee, channel, remoteChannel } =
      await createConnectedUnbundledPair();

    try {
      await caller.setLocalDescription(await caller.createOffer());
      await callee.setRemoteDescription(caller.localDescription!);
      const sdpManager = (
        callee as unknown as {
          sdpManager: {
            setLocal: (...args: unknown[]) => unknown;
          };
        }
      ).sdpManager;
      const originalSetLocal = sdpManager.setLocal.bind(sdpManager);
      let injected = false;
      sdpManager.setLocal = (...args: unknown[]) => {
        if (!injected) {
          injected = true;
          throw new Error("injected setLocal failure");
        }
        return originalSetLocal(...args);
      };

      try {
        // Act: answer commit直前のlocal projectionを失敗させる。
        await expect(
          callee.setLocalDescription(await callee.createAnswer()),
        ).rejects.toThrow("injected setLocal failure");
      } finally {
        sdpManager.setLocal = originalSetLocal;
      }

      // Assert: rollback後も旧associationでDataChannel通信が続く。
      expect(callee.signalingState).toBe("have-remote-offer");
      const receivedMessage = remoteChannel.onMessage.asPromise(5_000);
      channel.send("sctp-precommit");
      expect((await receivedMessage)[0].toString()).toBe("sctp-precommit");
    } finally {
      await Promise.allSettled([caller.close(), callee.close()]);
    }
  }, 30_000);

  test("remote offerのpayload type変更はanswer commitまで送信PTを変えない", async () => {
    // Arrange: 双方sendrecvのVP8/PT96で接続する。
    const codecs = { video: [useVP8({ payloadType: 96 })] };
    const caller = new RTCPeerConnection({ iceServers: [], codecs });
    const callee = new RTCPeerConnection({ iceServers: [], codecs });
    const callerTrack = new MediaStreamTrack({ kind: "video" });
    const calleeTrack = new MediaStreamTrack({ kind: "video" });
    caller.addTransceiver(callerTrack, { direction: "sendrecv" });
    callee.addTransceiver(calleeTrack, { direction: "sendrecv" });

    try {
      await caller.setLocalDescription(await caller.createOffer());
      await callee.setRemoteDescription(caller.localDescription!);
      await callee.setLocalDescription(await callee.createAnswer());
      await caller.setRemoteDescription(callee.localDescription!);
      await Promise.all([
        waitForConnectionState(caller, "connected"),
        waitForConnectionState(callee, "connected"),
      ]);

      const senderTransport = caller.getTransceivers()[0]!.dtlsTransport;
      const payloadTypes: number[] = [];
      const originalSendRtp = senderTransport.sendRtp.bind(senderTransport);
      senderTransport.sendRtp = async (payload, header) => {
        payloadTypes.push(header.payloadType);
        return originalSendRtp(payload, header);
      };

      // Act: remote offerだけPTを97へ変えてSRDする。
      const offer = await callee.createOffer();
      await callee.setLocalDescription(offer);
      await caller.setRemoteDescription({
        type: "offer",
        sdp: callee
          .localDescription!.sdp.replace(
            /a=rtpmap:96 VP8\/90000/g,
            "a=rtpmap:97 VP8/90000",
          )
          .replace(
            /m=video 9 UDP\/TLS\/RTP\/SAVPF 96/g,
            "m=video 9 UDP/TLS/RTP/SAVPF 97",
          ),
      });

      callerTrack.writeRtp(
        new RtpPacket(
          new RtpHeader({ sequenceNumber: 21, payloadType: 96 }),
          Buffer.from("pt-before-answer"),
        ).serialize(),
      );
      await setTimeout(20);

      // Assert: answer前の送信は現行PT96のまま。
      expect(payloadTypes.at(-1)).toBe(96);

      // Act: local answerをcommitしてから再送する。
      await caller.setLocalDescription(await caller.createAnswer());
      callerTrack.writeRtp(
        new RtpPacket(
          new RtpHeader({ sequenceNumber: 22, payloadType: 96 }),
          Buffer.from("pt-after-answer"),
        ).serialize(),
      );
      await setTimeout(20);

      // Assert: answer commit後は新PT97で送る。
      expect(payloadTypes.at(-1)).toBe(97);
    } finally {
      await Promise.allSettled([caller.close(), callee.close()]);
    }
  }, 30_000);

  test("remote offerのheader extension ID変更はanswer commitまで送信IDを変えない", async () => {
    // Arrange: MID header extensionをID=1で接続する。
    const codecs = { video: [useVP8({ payloadType: 96 })] };
    const headerExtensions = { video: [useSdesMid()] };
    const caller = new RTCPeerConnection({
      iceServers: [],
      codecs,
      headerExtensions,
    });
    const callee = new RTCPeerConnection({
      iceServers: [],
      codecs,
      headerExtensions,
    });
    const callerTrack = new MediaStreamTrack({ kind: "video" });
    caller.addTransceiver(callerTrack, { direction: "sendonly" });
    callee.addTransceiver("video", { direction: "recvonly" });

    try {
      await caller.setLocalDescription(await caller.createOffer());
      await callee.setRemoteDescription(caller.localDescription!);
      await callee.setLocalDescription(await callee.createAnswer());
      await caller.setRemoteDescription(callee.localDescription!);
      await Promise.all([
        waitForConnectionState(caller, "connected"),
        waitForConnectionState(callee, "connected"),
      ]);

      const senderTransport = caller.getTransceivers()[0]!.dtlsTransport;
      const extensionIds: number[] = [];
      const originalSendRtp = senderTransport.sendRtp.bind(senderTransport);
      senderTransport.sendRtp = async (payload, header) => {
        if (header.extensions[0]) {
          extensionIds.push(header.extensions[0].id);
        }
        return originalSendRtp(payload, header);
      };

      const offer = await callee.createOffer();
      await callee.setLocalDescription(offer);
      const offerSdp = callee.localDescription!.sdp.replace(
        /^a=extmap:1 /gm,
        "a=extmap:7 ",
      );
      await caller.setRemoteDescription({ type: "offer", sdp: offerSdp });

      callerTrack.writeRtp(
        new RtpPacket(
          new RtpHeader({ sequenceNumber: 31, payloadType: 96 }),
          Buffer.from("ext-before-answer"),
        ).serialize(),
      );
      await setTimeout(20);
      expect(extensionIds.at(-1)).toBe(1);

      await caller.setLocalDescription(await caller.createAnswer());
      callerTrack.writeRtp(
        new RtpPacket(
          new RtpHeader({ sequenceNumber: 32, payloadType: 96 }),
          Buffer.from("ext-after-answer"),
        ).serialize(),
      );
      await setTimeout(20);
      expect(extensionIds.at(-1)).toBe(7);
    } finally {
      await Promise.allSettled([caller.close(), callee.close()]);
    }
  }, 30_000);

  test("remote re-offerのsctp-port変更はanswer前に現行associationを書き換えない", async () => {
    // Arrange: 接続済みDataChannelと現行remotePortを記録する。
    const { caller, callee, channel, remoteChannel } =
      await createConnectedUnbundledPair();

    try {
      const currentRemotePort = callee.sctpRemotePort;
      expect(currentRemotePort).toBe(5000);

      // Act: subsequent offerの a=sctp-port だけ 6000 に変えてSRDする。
      await caller.setLocalDescription(await caller.createOffer());
      await callee.setRemoteDescription({
        type: "offer",
        sdp: caller.localDescription!.sdp.replace(
          /a=sctp-port:\d+/g,
          "a=sctp-port:6000",
        ),
      });

      // Assert: answer前は現行associationのremotePortが変わらず、旧DCが通信できる。
      expect(callee.signalingState).toBe("have-remote-offer");
      expect(callee.sctpRemotePort).toBe(currentRemotePort);
      const receivedMessage = remoteChannel.onMessage.asPromise(5_000);
      channel.send("sctp-port-pending");
      expect((await receivedMessage)[0].toString()).toBe("sctp-port-pending");

      // Act: pending offerをrollbackし、両endpointが新local portを広告するO/Aを完了する。
      await callee.setRemoteDescription({ type: "rollback" });
      await caller.setLocalDescription({ type: "rollback" });
      const oldCalleeAssociation = callee.sctp!.sctp;
      const oldCallerAssociation = caller.sctp!.sctp;
      await setLocalOfferWithSctpPort(caller, 6000);
      await callee.setRemoteDescription(caller.localDescription!);
      const answer = await callee.createAnswer();
      expect(answer.sdp).toMatch(/a=sctp-port:5001/);
      await callee.setLocalDescription(answer);
      await caller.setRemoteDescription(callee.localDescription!);

      // Assert: 旧associationは閉じ、新しいidentityでESTABLISHEDになりlocal portも変わる。
      await Promise.all([
        waitForSctpClosed(oldCalleeAssociation),
        waitForSctpClosed(oldCallerAssociation),
      ]);
      expect(callee.sctp!.sctp).not.toBe(oldCalleeAssociation);
      expect(caller.sctp!.sctp).not.toBe(oldCallerAssociation);
      await Promise.all([
        waitForSctpConnected(callee.sctp!.sctp),
        waitForSctpConnected(caller.sctp!.sctp),
      ]);
      expect(caller.sctp!.port).toBe(6000);
      expect(callee.sctp!.port).toBe(5001);
      expect(callee.sctpRemotePort).toBe(6000);
      expect(caller.sctpRemotePort).toBe(5001);
    } finally {
      await Promise.allSettled([caller.close(), callee.close()]);
    }
  }, 30_000);

  test("a=sctp-port:0 のofferはSCTP associationだけを閉じDTLSを維持する", async () => {
    // Arrange: 接続済みDataChannelとDTLSを記録する。
    const { caller, callee, channel, remoteChannel, track, remoteTrack } =
      await createConnectedUnbundledPair();

    try {
      const applicationDtls = callee.sctp!.dtlsTransport;
      expect(applicationDtls.state).toBe("connected");

      // Act: subsequent offerの a=sctp-port だけ 0 にしてSRDする。
      await setLocalOfferWithSctpPort(caller, 0);
      await callee.setRemoteDescription(caller.localDescription!);

      // Assert: answer前は現行associationが生きており、旧DCで通信できる。
      expect(callee.sctpRemotePort).toBe(5000);
      const receivedMessage = remoteChannel.onMessage.asPromise(5_000);
      channel.send("sctp-port-zero-pending");
      expect((await receivedMessage)[0].toString()).toBe(
        "sctp-port-zero-pending",
      );

      // Act: a=sctp-port:0 のanswerをcommitする。
      const answer = await callee.createAnswer();
      expect(answer.sdp).toMatch(/m=application 9 /);
      expect(answer.sdp).toMatch(/a=sctp-port:0/);
      await callee.setLocalDescription(answer);
      await caller.setRemoteDescription(callee.localDescription!);

      // Assert: SCTP/DataChannelは閉じ、DTLSと既存RTPは維持される。
      expect(callee.sctpRemotePort).toBeUndefined();
      expect(callee.sctp!.sctp.associationState).toBe(SCTP_STATE.CLOSED);
      expect(caller.sctp!.sctp.associationState).toBe(SCTP_STATE.CLOSED);
      expect(channel.readyState).toBe("closed");
      expect(applicationDtls.state).toBe("connected");
      expect(callee.sctp!.dtlsTransport.state).toBe("connected");
      const receivedRtpPromise = remoteTrack.onReceiveRtp.asPromise(5_000);
      track.writeRtp(
        new RtpPacket(
          new RtpHeader({ sequenceNumber: 40 }),
          Buffer.from("sctp-zero-rtp"),
        ).serialize(),
      );
      const [receivedRtp] = await receivedRtpPromise;
      expect(receivedRtp.payload).toEqual(Buffer.from("sctp-zero-rtp"));
    } finally {
      await Promise.allSettled([caller.close(), callee.close()]);
    }
  }, 30_000);

  test("remote offerのinbound extmap衝突はanswer前に現行RX mappingを上書きしない", async () => {
    // Arrange: MID(id=1) と TWCC を交渉したvideoを接続する。
    const codecs = { video: [useVP8({ payloadType: 96 })] };
    const headerExtensions = {
      video: [useSdesMid(), useTransportWideCC()],
    };
    const caller = new RTCPeerConnection({
      iceServers: [],
      codecs,
      headerExtensions,
    });
    const callee = new RTCPeerConnection({
      iceServers: [],
      codecs,
      headerExtensions,
    });
    const callerTrack = new MediaStreamTrack({ kind: "video" });
    caller.addTransceiver(callerTrack, { direction: "sendonly" });
    callee.addTransceiver("video", { direction: "recvonly" });

    try {
      await caller.setLocalDescription(await caller.createOffer());
      await callee.setRemoteDescription(caller.localDescription!);
      await callee.setLocalDescription(await callee.createAnswer());
      await caller.setRemoteDescription(callee.localDescription!);
      await Promise.all([
        waitForConnectionState(caller, "connected"),
        waitForConnectionState(callee, "connected"),
      ]);

      const midId = Number(
        Object.entries(callee.extIdUriMap).find(
          ([, uri]) => uri === RTP_EXTENSION_URI.sdesMid,
        )?.[0],
      );
      expect(midId).toBeGreaterThan(0);
      const receiver = callee.getTransceivers()[0]!.receiver;
      const ssrc = caller.getTransceivers()[0]!.sender.ssrc;
      const mid = caller.getTransceivers()[0]!.mid!;
      const router = (
        callee as unknown as {
          router: { routeRtp: (packet: RtpPacket) => void };
        }
      ).router;
      const injectMid = () =>
        router.routeRtp(
          new RtpPacket(
            new RtpHeader({
              ssrc,
              payloadType: 96,
              extensions: [{ id: midId, payload: Buffer.from(mid) }],
            }),
            Buffer.from("ext-rx"),
          ),
        );

      // Act: remote subsequent offerで現行MIDのextmap IDをTWCCへ付け替える。
      const offer = await caller.createOffer();
      await caller.setLocalDescription(offer);
      await expect(
        callee.setRemoteDescription({
          type: "offer",
          sdp: caller.localDescription!.sdp.replace(
            new RegExp(`a=extmap:${midId} ${RTP_EXTENSION_URI.sdesMid}`),
            `a=extmap:${midId} ${RTP_EXTENSION_URI.transportWideCC}`,
          ),
        }),
      ).rejects.toThrow(/extmap id .* remapped/);

      // Assert: RFC 8285のID remapはSRDで拒否し、現行RX mappingを維持する。
      expect(callee.signalingState).toBe("stable");
      expect(callee.extIdUriMap[midId]).toBe(RTP_EXTENSION_URI.sdesMid);
      injectMid();
      expect(receiver.sdesMid).toBe(mid);
    } finally {
      await Promise.allSettled([caller.close(), callee.close()]);
    }
  }, 30_000);

  test("subsequent remote offerのontrackはlocal answerより前に発火する", async () => {
    // Arrange: video 1本で接続したあと、追加のremote video offerを作る。
    const caller = new RTCPeerConnection({
      iceServers: [],
      bundlePolicy: "max-bundle",
    });
    const callee = new RTCPeerConnection({
      iceServers: [],
      bundlePolicy: "max-bundle",
    });
    const firstTrack = new MediaStreamTrack({ kind: "video" });
    caller.addTransceiver(firstTrack, { direction: "sendonly" });
    callee.addTransceiver("video", { direction: "recvonly" });

    try {
      await caller.setLocalDescription(await caller.createOffer());
      await callee.setRemoteDescription(caller.localDescription!);
      await callee.setLocalDescription(await callee.createAnswer());
      await caller.setRemoteDescription(callee.localDescription!);
      await Promise.all([
        waitForConnectionState(caller, "connected"),
        waitForConnectionState(callee, "connected"),
      ]);

      const extraTrack = new MediaStreamTrack({ kind: "video" });
      caller.addTransceiver(extraTrack, { direction: "sendonly" });
      const onTrack = new Promise<RTCTrackEvent>((resolve) => {
        callee.addEventListener("track", resolve, { once: true });
      });
      await caller.setLocalDescription(await caller.createOffer());

      // Act: subsequent offerをSRDする。
      await callee.setRemoteDescription(caller.localDescription!);

      // Assert: answer前に新しいtrackがsurfaceされる。
      const event = await onTrack;
      expect(event).toBeInstanceOf(RTCTrackEvent);
      expect(callee.signalingState).toBe("have-remote-offer");

      // Act: local answerをcommitし、captureしたtrackへRTPを送る。
      await callee.setLocalDescription(await callee.createAnswer());
      await caller.setRemoteDescription(callee.localDescription!);
      const receivedRtpPromise = event.track.onReceiveRtp.asPromise(5_000);
      extraTrack.writeRtp(
        new RtpPacket(
          new RtpHeader({ sequenceNumber: 31, payloadType: 96 }),
          Buffer.from("ontrack-rtp"),
        ).serialize(),
      );

      // Assert: event.track は receiver.track と同一で、RTPもそのobjectへ届く。
      const [receivedRtp] = await receivedRtpPromise;
      expect(receivedRtp.payload).toEqual(Buffer.from("ontrack-rtp"));
      expect(event.track).toBe(event.receiver.track);
    } finally {
      await Promise.allSettled([caller.close(), callee.close()]);
    }
  }, 30_000);

  test("rollbackはaddTrackで再利用したremote transceiverを削除しない", async () => {
    // Arrange: remote offerで作ったtransceiverへaddTrackする。
    const caller = new RTCPeerConnection({ iceServers: [] });
    const callee = new RTCPeerConnection({ iceServers: [] });
    caller.addTransceiver("video", { direction: "sendonly" });
    const localTrack = new MediaStreamTrack({ kind: "video" });

    try {
      await caller.setLocalDescription(await caller.createOffer());
      await callee.setRemoteDescription(caller.localDescription!);
      expect(callee.getTransceivers()).toHaveLength(1);
      callee.getTransceivers()[0]!.direction = "sendrecv";
      callee.addTrack(localTrack);

      // Act: remote rollbackする。
      await callee.setRemoteDescription({ type: "rollback" });

      // Assert: addTrack済みtransceiverとapplicationのdirection変更は残る。
      expect(callee.getTransceivers()).toHaveLength(1);
      const kept = callee.getTransceivers()[0]!;
      expect(kept.sender.track).toBe(localTrack);
      expect(kept.direction).toBe("sendrecv");
      expect(kept.mid).toBeNull();
      expect(kept.mLineIndex).toBeUndefined();

      // Act: rollback後のcreateOfferで、残したtrack用m-lineを再生成する。
      const offer = await callee.createOffer();

      // Assert: added trackのm-lineがMID付きで生成される。
      expect(offer.sdp).toMatch(/m=video /);
      expect(kept.mid).not.toBeNull();
      expect(kept.mLineIndex).toBeDefined();
    } finally {
      await Promise.allSettled([caller.close(), callee.close()]);
    }
  });

  test("inactiveはBUNDLE membershipからm-lineを外さない", async () => {
    // Arrange: 2本のvideoをBUNDLEで接続する。
    const caller = new RTCPeerConnection({
      iceServers: [],
      bundlePolicy: "max-compat",
    });
    const callee = new RTCPeerConnection({
      iceServers: [],
      bundlePolicy: "max-compat",
    });
    caller.addTransceiver("video");
    caller.addTransceiver("video");

    try {
      await caller.setLocalDescription(await caller.createOffer());
      await callee.setRemoteDescription(caller.localDescription!);
      await callee.setLocalDescription(await callee.createAnswer());
      await caller.setRemoteDescription(callee.localDescription!);
      await Promise.all([
        waitForConnectionState(caller, "connected"),
        waitForConnectionState(callee, "connected"),
      ]);
      const sharedTransport = callee.getTransceivers()[0]!.dtlsTransport;
      expect(callee.getTransceivers()[1]!.dtlsTransport).toBe(sharedTransport);

      const offer = await caller.createOffer();
      const inactiveOfferSdp = offer.sdp.replace(
        /(m=video 9 UDP\/TLS\/RTP\/SAVPF[\s\S]*?)(a=sendrecv)/,
        "$1a=inactive",
      );
      await caller.setLocalDescription(offer);
      await callee.setRemoteDescription({
        type: "offer",
        sdp: inactiveOfferSdp,
      });
      const answer = await callee.createAnswer();

      // Assert: inactiveでもport=0にはせず、BUNDLE groupへ残す。
      expect(answer.sdp).toMatch(/^a=group:BUNDLE /m);
      expect(answer.sdp).not.toMatch(/^m=video 0 /m);
      await callee.setLocalDescription(answer);

      expect(callee.getTransceivers()[0]!.dtlsTransport).toBe(sharedTransport);
      expect(callee.getTransceivers()[1]!.dtlsTransport).toBe(sharedTransport);
    } finally {
      await Promise.allSettled([caller.close(), callee.close()]);
    }
  }, 30_000);

  test("inactive m-line を残した subsequent offer でも新しい mid の answer を作れる", async () => {
    // Arrange: Chrome の addTransceiver と同様、送信済み m-line を inactive にしたあと
    // 別 mid を追加する。answerer が inactive transceiver を盗むと createAnswer が落ちる。
    const caller = new RTCPeerConnection({ iceServers: [] });
    const callee = new RTCPeerConnection({ iceServers: [] });
    const first = new MediaStreamTrack({ kind: "video" });
    const second = new MediaStreamTrack({ kind: "video" });
    const third = new MediaStreamTrack({ kind: "video" });
    caller.addTransceiver(first, { direction: "sendonly" });
    const secondTransceiver = caller.addTransceiver(second, {
      direction: "sendonly",
    });
    caller.addTransceiver(third, { direction: "sendonly" });

    try {
      await exchangeOfferAnswer(caller, callee);
      caller.removeTrack(secondTransceiver.sender);
      await exchangeOfferAnswer(caller, callee);
      const inactiveMid = secondTransceiver.mid;
      expect(inactiveMid).toBeTruthy();
      expect(
        callee.getTransceivers().find((t) => t.mid === inactiveMid)
          ?.currentDirection,
      ).toBe("inactive");

      caller.addTransceiver(new MediaStreamTrack({ kind: "video" }), {
        direction: "sendonly",
      });

      // Act: inactive m-line を残したまま新しい m-line を含む offer を answer する。
      await caller.setLocalDescription(await caller.createOffer());
      await callee.setRemoteDescription(caller.localDescription!);
      const answer = await callee.createAnswer();
      await callee.setLocalDescription(answer);
      await caller.setRemoteDescription(answer);

      // Assert: 旧 mid は inactive のまま残り、新しい m-line 用の transceiver が増える。
      const offerMids = [
        ...caller.localDescription!.sdp.matchAll(/^a=mid:([^\r\n]+)$/gm),
      ].map((match) => match[1]!);
      expect(offerMids).toHaveLength(4);
      expect(callee.getTransceivers()).toHaveLength(4);
      expect(
        callee.getTransceivers().map((transceiver) => transceiver.mid),
      ).toEqual(offerMids);
      expect(
        callee.getTransceivers().find((t) => t.mid === inactiveMid)
          ?.currentDirection,
      ).toBe("inactive");
      expect(answer.sdp.match(/^m=/gm)).toHaveLength(4);
    } finally {
      await Promise.allSettled([caller.close(), callee.close()]);
    }
  });

  test("closeはpending local planのstaged transportを停止する", async () => {
    // Arrange: BUNDLE接続後にsplit offerで独立transportをstageする。
    const caller = new RTCPeerConnection({
      iceServers: [],
      bundlePolicy: "max-compat",
    });
    const callee = new RTCPeerConnection({
      iceServers: [],
      bundlePolicy: "max-compat",
    });
    caller.addTransceiver("video");
    caller.addTransceiver("video");

    try {
      await caller.setLocalDescription(await caller.createOffer());
      await callee.setRemoteDescription(caller.localDescription!);
      await callee.setLocalDescription(await callee.createAnswer());
      await caller.setRemoteDescription(callee.localDescription!);
      await Promise.all([
        waitForConnectionState(caller, "connected"),
        waitForConnectionState(callee, "connected"),
      ]);

      const offer = await caller.createOffer();
      const mids = [...offer.sdp.matchAll(/^a=mid:([^\r\n]+)$/gm)].map(
        (match) => match[1]!,
      );
      (caller as unknown as { lastCreatedOffer?: unknown }).lastCreatedOffer =
        undefined;
      await caller.setLocalDescription({
        type: "offer",
        sdp: offer.sdp.replace(
          /^a=group:BUNDLE [^\r\n]+$/m,
          `a=group:BUNDLE ${mids[0]}`,
        ),
      });
      const staged = [
        ...((
          caller as unknown as {
            pendingLocalOfferPlan?: {
              createdTransports: Set<{ state: string }>;
            };
          }
        ).pendingLocalOfferPlan?.createdTransports ?? []),
      ][0];
      expect(staged).toBeDefined();
      expect(staged!.state).not.toBe("closed");

      // Act: remote answer前にPeerConnectionを閉じる。
      await caller.close();

      // Assert: current graphに載っていないstaged transportも停止する。
      expect(staged!.state).toBe("closed");
    } finally {
      await Promise.allSettled([caller.close(), callee.close()]);
    }
  }, 30_000);

  test("接続済みsessionへのcodec-invalid remote offerはcurrent graphを変更しない", async () => {
    // Arrange: 接続済みの旧SDP/transportと通信相手を用意する。
    const { caller, callee, channel, remoteChannel, track, remoteTrack } =
      await createConnectedUnbundledPair();

    try {
      const currentRemoteSdp = callee.currentRemoteDescription!.sdp;
      const currentTransports = [...callee.dtlsTransports];

      // Act: 新しいofferをlocal pendingにして、remote側だけcodecを壊す。
      const offer = await caller.createOffer();
      await caller.setLocalDescription(offer);
      const invalidOffer = {
        type: "offer" as const,
        sdp: caller.localDescription!.sdp.replace(/VP8/g, "VP9"),
      };
      await expect(callee.setRemoteDescription(invalidOffer)).rejects.toThrow(
        "negotiate codecs failed",
      );

      // Assert: SRD rejectionでcurrent SDP/transportを破壊しない。
      expect(callee.currentRemoteDescription!.sdp).toBe(currentRemoteSdp);
      expect(callee.dtlsTransports).toEqual(currentTransports);
      expect(
        currentTransports.every((transport) => transport.state === "connected"),
      ).toBe(true);
      expect(callee.connectionState).toBe("connected");

      // Act: rejectされたofferの後も旧DataChannel/RTPで通信する。
      const receivedMessage = remoteChannel.onMessage.asPromise(5_000);
      channel.send("invalid-offer-live");
      const receivedRtpPromise = remoteTrack.onReceiveRtp.asPromise(5_000);
      track.writeRtp(
        new RtpPacket(
          new RtpHeader({ sequenceNumber: 11 }),
          Buffer.from("invalid-offer-rtp"),
        ).serialize(),
      );

      // Assert: rejected offerは既存の通信を中断しない。
      expect((await receivedMessage)[0].toString()).toBe("invalid-offer-live");
      const [receivedRtp] = await receivedRtpPromise;
      expect(receivedRtp.payload).toEqual(Buffer.from("invalid-offer-rtp"));
    } finally {
      await Promise.allSettled([caller.close(), callee.close()]);
    }
  }, 30_000);

  test("codec-invalid remote answerはcurrent SDPとtransportを変更しない", async () => {
    // Arrange: 接続済みsessionと、次のlocal offerを用意する。
    const { caller, callee } = await createConnectedUnbundledPair();

    try {
      const currentRemoteSdp = caller.currentRemoteDescription!.sdp;
      const currentTransports = [...caller.dtlsTransports];
      await caller.setLocalDescription(await caller.createOffer());
      await callee.setRemoteDescription(caller.localDescription!);
      const answer = await callee.createAnswer();
      const invalidAnswer = {
        type: "answer" as const,
        sdp: answer.sdp.replace(/VP8/g, "VP9"),
      };

      // Act: codec不一致のremote answerを適用して失敗させる。
      await expect(caller.setRemoteDescription(invalidAnswer)).rejects.toThrow(
        "negotiate codecs failed",
      );

      // Assert: answer rejection後もcurrent SDP/transportと接続状態を保つ。
      expect(caller.currentRemoteDescription!.sdp).toBe(currentRemoteSdp);
      expect(caller.dtlsTransports).toEqual(currentTransports);
      expect(
        currentTransports.every((transport) => transport.state === "connected"),
      ).toBe(true);
      expect(caller.connectionState).toBe("connected");
    } finally {
      await Promise.allSettled([caller.close(), callee.close()]);
    }
  }, 30_000);

  test("fingerprint-invalid remote answerはcurrent SDPとtransportを変更しない", async () => {
    // Arrange: 接続済みsessionと、次のlocal offerを用意する。
    const { caller, callee } = await createConnectedUnbundledPair();

    try {
      const currentRemoteSdp = caller.currentRemoteDescription!.sdp;
      const currentTransports = [...caller.dtlsTransports];
      await caller.setLocalDescription(await caller.createOffer());
      await callee.setRemoteDescription(caller.localDescription!);
      const answer = await callee.createAnswer();

      // Act: 認証済みtransportと一致しないremote answerを適用する。
      await expect(
        caller.setRemoteDescription({
          type: "answer",
          sdp: tamperFingerprints(answer.sdp),
        }),
      ).rejects.toThrow();

      // Assert: fingerprint検証失敗でもcurrent graphを維持する。
      expect(caller.currentRemoteDescription!.sdp).toBe(currentRemoteSdp);
      expect(caller.dtlsTransports).toEqual(currentTransports);
      expect(
        currentTransports.every((transport) => transport.state === "connected"),
      ).toBe(true);
      expect(caller.connectionState).toBe("connected");
    } finally {
      await Promise.allSettled([caller.close(), callee.close()]);
    }
  }, 30_000);

  test("subsequent BUNDLE rebind は既存 ReceiverTWCC と SCTP association を更新する", async () => {
    // Arrange: 最初は BUNDLE なしで video と DataChannel を接続する。
    const codecs = {
      video: [useVP8({ payloadType: 96, rtcpFeedback: [useTWCC()] })],
    };
    const caller = new RTCPeerConnection({
      iceServers: [],
      bundlePolicy: "max-compat",
      codecs,
    });
    const callee = new RTCPeerConnection({
      iceServers: [],
      bundlePolicy: "max-compat",
      codecs,
    });
    caller.addTransceiver("video");
    const channel = caller.createDataChannel("rebind");
    const remoteChannelPromise = new Promise<RTCDataChannel>((resolve) => {
      callee.ondatachannel = ({ channel: remoteChannel }) =>
        resolve(remoteChannel);
    });

    try {
      const generatedOffer = await caller.createOffer();
      const initialOfferSdp = generatedOffer.sdp.replace(
        /^a=group:BUNDLE [^\r\n]+\r?\n/m,
        "",
      );
      // The test intentionally supplies a valid no-BUNDLE first offer so the
      // second negotiation is the first BUNDLE negotiation for this session.
      (caller as unknown as { lastCreatedOffer?: unknown }).lastCreatedOffer =
        undefined;
      await caller.setLocalDescription({
        type: "offer",
        sdp: initialOfferSdp,
      });
      await callee.setRemoteDescription(caller.localDescription!);
      await callee.setLocalDescription(await callee.createAnswer());
      await caller.setRemoteDescription(callee.localDescription!);
      await Promise.all([
        waitForConnectionState(caller, "connected"),
        waitForConnectionState(callee, "connected"),
        assertDataChannelOpen(channel),
      ]);
      const remoteChannel = await remoteChannelPromise;
      await assertDataChannelOpen(remoteChannel);

      const calleeVideoTransport = callee.getTransceivers()[0]!.dtlsTransport;
      const calleeSctpTransport = callee.sctp!;
      const oldCalleeAppTransport = calleeSctpTransport.dtlsTransport;
      const oldCalleeAssociation = calleeSctpTransport.sctp;
      const receiverTwcc = (
        callee.getReceivers()[0] as unknown as {
          receiverTWCC?: { handleTWCC(sequenceNumber: number): void };
        }
      ).receiverTWCC;
      expect(receiverTwcc).toBeDefined();
      expect(calleeVideoTransport).not.toBe(calleeSctpTransport.dtlsTransport);

      // Act: 次の offer で初めて BUNDLE を成立させ、applicationをvideoへrebindする。
      await caller.setLocalDescription(await caller.createOffer());
      await callee.setRemoteDescription(caller.localDescription!);

      // Assert: pending offer中はcurrent graphとSCTP1を変更しない。
      expect(calleeSctpTransport.sctp).toBe(oldCalleeAssociation);
      expect(calleeSctpTransport.dtlsTransport).toBe(oldCalleeAppTransport);
      expect(oldCalleeAppTransport.state).not.toBe("closed");

      // Act: answerを適用してから、BUNDLE migrationをcommitする。
      const answer = await callee.createAnswer();
      const oldAssociationAbort = vi.spyOn(oldCalleeAssociation, "abort");
      await callee.setLocalDescription(answer);

      // Assert: commit後だけSCTP2へ切り替え、旧transportを停止する。
      const newCalleeAssociation = calleeSctpTransport.sctp;
      expect(newCalleeAssociation).not.toBe(oldCalleeAssociation);
      expect(calleeSctpTransport.dtlsTransport).toBe(calleeVideoTransport);
      expect(oldAssociationAbort).not.toHaveBeenCalled();
      oldAssociationAbort.mockRestore();
      await waitForSctpClosed(oldCalleeAssociation);
      expect(oldCalleeAppTransport.state).toBe("closed");

      let tagFeedback = 0;
      let staleFeedback = 0;
      const originalSendRtcp = calleeVideoTransport.sendRtcp;
      const originalStaleSendRtcp = oldCalleeAppTransport.sendRtcp;
      calleeVideoTransport.sendRtcp = async () => {
        tagFeedback++;
        return undefined;
      };
      oldCalleeAppTransport.sendRtcp = async () => {
        staleFeedback++;
        return undefined;
      };
      try {
        // Act: rebind後のReceiverTWCCからfeedbackを生成する。
        for (let sequenceNumber = 0; sequenceNumber < 11; sequenceNumber++) {
          receiverTwcc!.handleTWCC(sequenceNumber);
        }
        await setTimeout(0);

        // Assert: feedbackは新しいtag transportへだけ送る。
        expect(tagFeedback).toBe(1);
        expect(staleFeedback).toBe(0);
      } finally {
        calleeVideoTransport.sendRtcp = originalSendRtcp;
        oldCalleeAppTransport.sendRtcp = originalStaleSendRtcp;
      }

      await caller.setRemoteDescription(callee.localDescription!);
      const newCallerAssociation = caller.sctp!.sctp;
      await Promise.all([
        waitForSctpConnected(newCalleeAssociation),
        waitForSctpConnected(newCallerAssociation),
      ]);

      // Act: associationを張り直した後も同じDataChannelで送信する。
      const received = remoteChannel.onMessage.asPromise(5_000);
      channel.send("after-rebind");

      // Assert: DataChannel registry/IDを保持したまま再送受信できる。
      expect((await received)[0].toString()).toBe("after-rebind");
      expect(channel.readyState).toBe("open");
      expect(remoteChannel.readyState).toBe("open");
    } finally {
      await Promise.allSettled([caller.close(), callee.close()]);
    }
  }, 30_000);

  test("BUNDLE second passの失敗時はcurrent transportを変更しない", async () => {
    // Arrange: 後段のtag m-lineだけcodec不一致にし、second passが失敗する
    // offerを作る。
    const caller = new RTCPeerConnection({
      iceServers: [],
      bundlePolicy: "max-compat",
    });
    const callee = new RTCPeerConnection({
      iceServers: [],
      bundlePolicy: "max-compat",
    });
    caller.addTransceiver("video");
    caller.addTransceiver("video");
    callee.addTransceiver("video");
    callee.addTransceiver("video");

    try {
      await caller.setLocalDescription(await caller.createOffer());
      const sections = caller.localDescription!.sdp.split(/(?=^m=)/m);
      const mediaSections = sections.filter((section) =>
        section.startsWith("m=video"),
      );
      expect(mediaSections).toHaveLength(2);
      const tagMid = mediaSections[1]!.match(/^a=mid:([^\r\n]+)$/m)![1]!;
      const nonTagMid = mediaSections[0]!.match(/^a=mid:([^\r\n]+)$/m)![1]!;
      const invalidTagSection = mediaSections[1]!.replace(
        /^(a=rtpmap:\d+ )VP8(\/[^\r\n]+)$/gm,
        "$1VP9$2",
      );
      expect(invalidTagSection).not.toBe(mediaSections[1]);
      const modifiedSdp = sections
        .map((section) =>
          section === mediaSections[0]
            ? section
            : section === mediaSections[1]
              ? invalidTagSection
              : section,
        )
        .join("")
        .replace(
          /^a=group:BUNDLE [^\r\n]+$/m,
          `a=group:BUNDLE ${tagMid} ${nonTagMid}`,
        );
      const oldNonTagTransport = callee.getTransceivers()[0]!.dtlsTransport;

      // Act: tag sectionのcodec検証でSRDを失敗させる。
      await expect(
        callee.setRemoteDescription({ type: "offer", sdp: modifiedSdp }),
      ).rejects.toThrow("negotiate codecs failed");

      // Assert: SRD失敗時は既存のtransport graphを維持する。
      expect(oldNonTagTransport.state).toBe("new");
      expect(oldNonTagTransport.iceTransport.state).toBe("new");
      expect(callee.dtlsTransports).toContain(oldNonTagTransport);
      expect(callee.dtlsTransports).toHaveLength(2);
    } finally {
      await Promise.allSettled([caller.close(), callee.close()]);
    }
  });

  test("SCTP start failure 後の PeerConnection close は DataChannel を閉じる", async () => {
    // Arrange: negotiated channel を作成し、SCTP association を開始前の状態にする。
    const peer = new RTCPeerConnection({});
    const channel = peer.createDataChannel("negotiated", {
      negotiated: true,
      id: 0,
    });
    let closeEvents = 0;
    channel.onclose = () => closeEvents++;

    try {
      await peer.setLocalDescription(await peer.createOffer());
      const association = peer.sctp!.sctp;

      // Act: INIT 失敗後に下位 SCTP が CLOSED になった状態で PC を閉じる。
      association.setState(SCTP_STATE.CLOSED);
      expect(channel.readyState).toBe("connecting");
      await peer.close();

      // Assert: SCTP の購読解除後でも保持中 channel を明示的に閉じる。
      expect(channel.readyState).toBe("closed");
      expect(closeEvents).toBe(1);
    } finally {
      await peer.close();
    }
  });

  test("media-only handshake 中の close 後は connect の失敗で closed を上書きしない", async () => {
    // Arrange: SCTP を持たない media-only の offer/answer を用意する。
    const caller = new RTCPeerConnection({});
    const callee = new RTCPeerConnection({});
    caller.addTransceiver("audio");
    await caller.setLocalDescription(await caller.createOffer());
    await callee.setRemoteDescription(caller.localDescription!);
    await callee.setLocalDescription(await callee.createAnswer());

    const dtls = caller.dtlsTransports[0]!;
    const originalIceStart = dtls.iceTransport.start;
    const originalDtlsStart = dtls.start;
    let startEntered!: () => void;
    const startEnteredPromise = new Promise<void>((resolve) => {
      startEntered = resolve;
    });
    let rejectStart!: (error: Error) => void;
    const startFailure = new Promise<never>((_, reject) => {
      rejectStart = reject;
    });
    dtls.iceTransport.start = async () => {};
    dtls.start = async () => {
      startEntered();
      return startFailure;
    };

    try {
      // Act: answer適用で connect() を開始し、DTLS start の reject を保留する。
      await caller.setRemoteDescription(callee.localDescription!);
      await startEnteredPromise;

      // Act: 下位待機を閉じた後に失敗させる。
      await caller.close();
      rejectStart(new Error("handshake aborted by close"));
      await setTimeout(0);

      // Assert: connect の失敗処理は close 済み PC を failed へ戻さない。
      expect(caller.connectionState).toBe("closed");
    } finally {
      dtls.iceTransport.start = originalIceStart;
      dtls.start = originalDtlsStart;
      await Promise.allSettled([caller.close(), callee.close()]);
    }
  });

  test("ICE/DTLS connected 後の再接続でも SCTP retry に到達する", async () => {
    // Arrange: 実 DataChannel を確立し、ICE/DTLS/SCTP が一度成功した状態を作る。
    const caller = new RTCPeerConnection({});
    const callee = new RTCPeerConnection({});
    const [channel] = await createDataChannelPair({}, caller, callee);
    const manager = (
      caller as unknown as {
        sctpManager: { connectSctp(): Promise<void> };
      }
    ).sctpManager;
    const originalConnectSctp = manager.connectSctp.bind(manager);
    let attempts = 0;
    manager.connectSctp = async () => {
      attempts++;
      if (attempts === 1) {
        throw new Error("simulated SCTP INIT failure");
      }
      await originalConnectSctp();
    };

    try {
      // Act: 接続済みの早期 return からも SCTP の初回 retry を実行する。
      await (caller as unknown as { connect(): Promise<void> }).connect();
      expect(caller.connectionState).toBe("failed");

      // Act: 再ネゴシエーション相当の connect() を再度実行する。
      await (caller as unknown as { connect(): Promise<void> }).connect();

      // Assert: manager の二回目の開始へ到達し、PCだけ connected にはしない。
      expect(attempts).toBe(2);
      expect(caller.connectionState).toBe("connected");
      expect(channel.readyState).toBe("open");
    } finally {
      manager.connectSctp = originalConnectSctp;
      await Promise.allSettled([caller.close(), callee.close()]);
    }
  });

  test("constructor applies WebIDL-style validation for configuration dictionaries", () => {
    const certificateValues = [null, undefined];

    // Assert: null は空辞書として扱われ、無効な certificates / iceCandidatePoolSize は TypeError になる。
    expect(() => new RTCPeerConnection(null as any)).not.toThrow();
    expect(() => new RTCPeerConnection({ certificates: null as any })).toThrow(
      TypeError,
    );
    for (const value of certificateValues) {
      expect(
        // Act: certificates 辞書メンバーへ nullish な要素を渡して構築する。
        () => new RTCPeerConnection({ certificates: [value as any] }),
      ).toThrow(TypeError);
    }
    expect(
      () => new RTCPeerConnection({ iceCandidatePoolSize: Symbol("x") as any }),
    ).toThrow(TypeError);
  });

  test("createDataChannel coerces [EnforceRange] unsigned short options", async () => {
    const pc = new RTCPeerConnection();

    try {
      // Act: omitted なメンバーは null を返し、数値文字列は number へ正規化する。
      const omitted = pc.createDataChannel("omitted");
      const coerced = pc.createDataChannel("coerced", {
        maxPacketLifeTime: "100" as any,
      });

      // Assert: omitted/null と coercion の挙動が WPT と一致する。
      expect(omitted.maxPacketLifeTime).toBeNull();
      expect(omitted.maxRetransmits).toBeNull();
      expect(coerced.maxPacketLifeTime).toBe(100);
      expect(() =>
        pc.createDataChannel("invalid", { maxRetransmits: 65536 as any }),
      ).toThrow(TypeError);
      expect(() =>
        pc.createDataChannel("invalid", {
          maxPacketLifeTime: Number.NaN as any,
        }),
      ).toThrow(TypeError);
    } finally {
      await pc.close();
    }
  });

  test("setRemoteDescription implicitly rolls back a local offer before applying a remote offer", async () => {
    const pc1 = new RTCPeerConnection();
    const pc2 = new RTCPeerConnection();
    const states: string[] = [];
    let negotiationNeededCount = 0;
    let resolveNegotiationNeeded: (() => void) | undefined;
    const negotiationNeeded = new Promise<void>((resolve) => {
      resolveNegotiationNeeded = resolve;
    });

    try {
      // Arrange: それぞれの peer に別々の transceiver を追加して競合する offer を作れる状態にする。
      pc1.addTransceiver("audio");
      pc2.addTransceiver("video");
      pc1.onsignalingstatechange = () => {
        states.push(pc1.signalingState);
      };
      pc1.onnegotiationneeded = () => {
        negotiationNeededCount += 1;
        resolveNegotiationNeeded?.();
      };

      // Act: local offer を pending にした peer へ remote offer を適用し、implicit rollback を発生させる。
      await pc1.setLocalDescription(await pc1.createOffer());
      expect(pc1.signalingState).toBe("have-local-offer");
      await pc1.setRemoteDescription(await pc2.createOffer());

      // Assert: rollback を経由して have-remote-offer へ遷移し、その後 answer を作成できる。
      expect(states).toEqual([
        "have-local-offer",
        "stable",
        "have-remote-offer",
      ]);
      expect(pc1.pendingLocalDescription).toBeNull();
      expect(pc1.currentLocalDescription).toBeNull();
      expect(pc1.signalingState).toBe("have-remote-offer");

      // Act: rollback 後の state を前提に answer を生成・適用する。
      await pc1.setLocalDescription(await pc1.createAnswer());
      await negotiationNeeded;

      // Assert: answer 適用後に stable へ戻り、rollback で保留された negotiationneeded が再通知される。
      expect(pc1.signalingState).toBe("stable");
      expect(states).toEqual([
        "have-local-offer",
        "stable",
        "have-remote-offer",
        "stable",
      ]);
      expect(negotiationNeededCount).toBeGreaterThan(0);
    } finally {
      await Promise.allSettled([pc1.close(), pc2.close()]);
    }
  });

  test("removeTrack is a no-op for a stopped transceiver", async () => {
    const pc = new RTCPeerConnection();
    const stream = new MediaStream();
    const track = new MediaStreamTrack({ kind: "audio" });
    stream.addTrack(track);
    const sender = pc.addTrack(track, stream);

    try {
      // Act: transceiver を stopping 状態にしたあと removeTrack を呼ぶ。
      pc.getTransceivers()[0].stop();
      pc.removeTrack(sender);

      // Assert: stopped transceiver では sender.track が維持される。
      expect(sender.track).toBe(track);
    } finally {
      await pc.close();
    }
  });

  test("ontrack lives on the prototype and rejected sections do not dispatch track", async () => {
    const pc = new RTCPeerConnection();
    const onTrack = vi.fn();
    pc.ontrack = onTrack;

    try {
      // Act: ontrack 属性の descriptor を確認し、port 0 の rejected m-line を適用する。
      const descriptor = Object.getOwnPropertyDescriptor(
        RTCPeerConnection.prototype,
        "ontrack",
      );
      await pc.setRemoteDescription({
        type: "offer",
        sdp: `v=0
o=- 166855176514521964 2 IN IP4 127.0.0.1
s=-
t=0 0
a=msid-semantic:WMS *
m=audio 0 UDP/TLS/RTP/SAVPF 111
c=IN IP4 0.0.0.0
a=rtcp:9 IN IP4 0.0.0.0
a=ice-ufrag:someufrag
a=ice-pwd:somelongpwdwithenoughrandomness
a=fingerprint:sha-256 00:00:00:00:00:00:00:00:00:00:00:00:00:00:00:00:00:00:00:00:00:00:00:00:00:00:00:00:00:00:00:00
a=setup:actpass
a=mid:0
a=sendonly
a=rtcp-mux
a=rtpmap:111 opus/48000/2
a=ssrc:1001 cname:some
`,
      });

      // Assert: ontrack は prototype accessor として公開され、rejected media section では発火しない。
      expect(descriptor?.get).toBeTypeOf("function");
      expect(descriptor?.set).toBeTypeOf("function");
      expect(onTrack).not.toHaveBeenCalled();
    } finally {
      await pc.close();
    }
  });

  test("setRemoteDescription keeps addTrack transceiver ahead of remote ones while pending", async () => {
    const caller = new RTCPeerConnection();
    const callee = new RTCPeerConnection();
    const localTrack = new MediaStreamTrack({ kind: "audio" });

    try {
      // Arrange: remote offer 側は video transceiver を1本だけ持つ。
      caller.addTransceiver("video");
      const offer = await caller.createOffer();

      // Act: SRD の Promise を保持したまま addTrack し、await 前の並びを観測する。
      const pending = callee.setRemoteDescription(offer);
      expect(callee.getTransceivers()).toHaveLength(0);
      const sender = callee.addTrack(localTrack);

      // Assert: addTrack が先に transceiver を作り、SRD 完了後も先頭を維持する。
      expect(callee.getTransceivers()).toHaveLength(1);
      expect(callee.getTransceivers()[0].sender).toBe(sender);
      expect(callee.getTransceivers()[0].mid).toBeNull();

      await pending;

      expect(callee.getTransceivers()).toHaveLength(2);
      expect(callee.getTransceivers()[0].sender).toBe(sender);
      expect(callee.getTransceivers()[0].mid).toBeNull();
      expect(callee.getTransceivers()[1].mid).not.toBeNull();
    } finally {
      await Promise.allSettled([caller.close(), callee.close()]);
    }
  });

  test("ontrack exposes all remote streams and RTCTrackEvent instances", async () => {
    const caller = new RTCPeerConnection();
    const callee = new RTCPeerConnection();
    const track = new MediaStreamTrack({ kind: "audio" });
    const stream0 = new MediaStream();
    const stream1 = new MediaStream();
    const onTrack = new Promise<RTCTrackEvent>((resolve) => {
      callee.addEventListener("track", resolve, { once: true });
    });

    try {
      // Act: 2つの stream を同じ addTrack に渡して offer を適用する。
      caller.addTrack(track, stream0, stream1);
      await caller.setLocalDescription(await caller.createOffer());
      await callee.setRemoteDescription(caller.localDescription!);

      // Assert: track event は RTCTrackEvent で、stream id が順序どおりに復元される。
      const event = await onTrack;
      expect(event).toBeInstanceOf(RTCTrackEvent);
      expect(event.streams.map((stream) => stream.id)).toEqual([
        stream0.id,
        stream1.id,
      ]);
    } finally {
      await Promise.allSettled([caller.close(), callee.close()]);
    }
  });

  test("addIceCandidate appends the candidate to the targeted remote m-section", async () => {
    const pc = new RTCPeerConnection();

    try {
      await pc.setRemoteDescription({
        type: "offer",
        sdp: addIceCandidateUnbundledSdp,
      });

      // Act: video m-section を指す candidate を追加する。
      await pc.addIceCandidate({
        candidate: addIceCandidateLine2,
        sdpMid: addIceCandidateSdpMid2,
        sdpMLineIndex: addIceCandidateSdpMLineIndex2,
        usernameFragment: addIceCandidateUsernameFragment2,
      });

      // Assert: candidate 行が video m-section のみへ追加される。
      expect(
        isCandidateLineBetween(
          pc.remoteDescription!.sdp,
          addIceCandidateMediaLine1,
          `a=${addIceCandidateLine2}`,
          addIceCandidateMediaLine2,
        ),
      ).toBeFalsy();
      expect(
        isCandidateLineAfter(
          pc.remoteDescription!.sdp,
          addIceCandidateMediaLine2,
          `a=${addIceCandidateLine2}`,
        ),
      ).toBeTruthy();
    } finally {
      await pc.close();
    }
  });

  test("addIceCandidate targets end-of-candidates by usernameFragment and media selector", async () => {
    const pc = new RTCPeerConnection();

    try {
      await pc.setRemoteDescription({
        type: "offer",
        sdp: addIceCandidateUnbundledSdp,
      });

      // Act: 第2 m-section の generation にだけ end-of-candidates を適用する。
      await pc.addIceCandidate({
        usernameFragment: addIceCandidateUsernameFragment2,
        sdpMLineIndex: addIceCandidateSdpMLineIndex2,
      });

      // Assert: a=end-of-candidates は video m-section のみに現れる。
      expect(
        isCandidateLineBetween(
          pc.remoteDescription!.sdp,
          addIceCandidateMediaLine1,
          addIceCandidateEndOfCandidatesLine,
          addIceCandidateMediaLine2,
        ),
      ).toBeFalsy();
      expect(
        isCandidateLineAfter(
          pc.remoteDescription!.sdp,
          addIceCandidateMediaLine2,
          addIceCandidateEndOfCandidatesLine,
        ),
      ).toBeTruthy();
    } finally {
      await pc.close();
    }
  });

  test("addIceCandidate rejects missing selectors and mismatched usernameFragment", async () => {
    const pc = new RTCPeerConnection();

    try {
      await pc.setRemoteDescription({
        type: "offer",
        sdp: addIceCandidateWptSdp,
      });

      // Act / Assert: selector のない candidate は TypeError になる。
      await expect(
        pc.addIceCandidate({
          candidate: addIceCandidateLine1,
        }),
      ).rejects.toBeInstanceOf(TypeError);

      // Act / Assert: m-section と一致しない usernameFragment は OperationError になる。
      await expect(
        pc.addIceCandidate({
          candidate: addIceCandidateLine2,
          sdpMid: addIceCandidateSdpMid2,
          sdpMLineIndex: addIceCandidateSdpMLineIndex2,
          usernameFragment: addIceCandidateUsernameFragment1,
        }),
      ).rejects.toMatchObject({
        name: "OperationError",
      });
    } finally {
      await pc.close();
    }
  });

  test("addIceCandidate buffers candidates before a remote description exists", async () => {
    const pc = new RTCPeerConnection();

    try {
      const candidate = {
        candidate: addIceCandidateLine1,
        sdpMid: addIceCandidateSdpMid1,
        sdpMLineIndex: addIceCandidateSdpMLineIndex1,
        usernameFragment: addIceCandidateUsernameFragment1,
      };

      // Act: remoteDescription より先に届いた candidate を先行投入する。
      await expect(pc.addIceCandidate(candidate)).resolves.toBeUndefined();
      await pc.setRemoteDescription({
        type: "offer",
        sdp: addIceCandidateWptSdp,
      });

      // Assert: setRemoteDescription 完了時に保留 candidate が反映される。
      expect(
        isCandidateLineBetween(
          pc.remoteDescription!.sdp,
          addIceCandidateMediaLine1,
          `a=${addIceCandidateLine1}`,
          addIceCandidateMediaLine2,
        ),
      ).toBeTruthy();
    } finally {
      await pc.close();
    }
  });

  test("initial BUNDLE answer 前は non-tag の Trickle ICE candidate を共有 transport に適用しない", async () => {
    const timings = ["SRD前", "SRD後"] as const;

    for (const timing of timings) {
      // Arrange: tag=a1、non-tag=v1でICE credentialが異なるinitial offerを用意する。
      const pc = new RTCPeerConnection();
      const nonTagCandidate = {
        candidate: addIceCandidateLine2,
        sdpMid: addIceCandidateSdpMid2,
        sdpMLineIndex: addIceCandidateSdpMLineIndex2,
        usernameFragment: addIceCandidateUsernameFragment2,
      };

      try {
        if (timing === "SRD前") {
          // Act: remote descriptionより先にnon-tag candidateを保留する。
          await pc.addIceCandidate(nonTagCandidate);
        }
        await pc.setRemoteDescription({
          type: "offer",
          sdp: addIceCandidateWptSdp,
        });
        if (timing === "SRD後") {
          // Act: remote offer適用後、answer前にnon-tag candidateを投入する。
          await pc.addIceCandidate(nonTagCandidate);
        }

        // Assert: 保留経路・直接経路のどちらもtag transportを汚染しない。
        expect(pc.remoteDescription!.sdp).toContain(
          `a=${addIceCandidateLine2}`,
        );
        expect(
          pc.iceTransports[0]!.connection.remoteCandidates,
          timing,
        ).toEqual([]);

        // Act: answerでBUNDLEが成立した後はbundled MIDのcandidateを共有する。
        await pc.setLocalDescription(await pc.createAnswer());
        await pc.addIceCandidate({
          candidate: addIceCandidateLine2,
          sdpMid: addIceCandidateSdpMid2,
          sdpMLineIndex: addIceCandidateSdpMLineIndex2,
        });

        // Assert: 成立後のTrickle ICEはRFCどおり共有transportへ適用される。
        expect(pc.iceTransports[0]!.connection.remoteCandidates).toHaveLength(
          1,
        );
      } finally {
        await pc.close();
      }
    }
  });

  test("addTransceiver preserves initial sendEncodings in sender.getParameters()", async () => {
    const pc = new RTCPeerConnection();
    const track = new MediaStreamTrack({ kind: "audio" });

    try {
      // Act: sendEncodings.active=false を持つ transceiver を作成する。
      const transceiver = pc.addTransceiver(track, {
        sendEncodings: [{ active: false }],
      });

      // Assert: sender.getParameters() が初期 encodings を返す。
      expect(transceiver.sender.getParameters().encodings[0]?.active).toBe(
        false,
      );
    } finally {
      await pc.close();
    }
  });

  test.skip("portRange", async () => {
    const peer = new RTCPeerConnection({ icePortRange: [44444, 44455] });
    peer.createDataChannel("test");
    const offer = await peer.createOffer();
    await peer.setLocalDescription(offer);

    const candidates = peer.iceTransports[0].localCandidates;
    for (const candidate of candidates) {
      expect(candidate.port >= 44444 && candidate.port < 44455).toBeTruthy();
    }
    await peer.close();
  });

  test("remote offer isLite", async () => {
    const a = new RTCPeerConnection();
    const b = new RTCPeerConnection();

    a.createDataChannel("test");
    const offer = await a.setLocalDescription(await a.createOffer());
    offer.media.forEach((m) => (m.iceParams!.iceLite = true));

    await b.setRemoteDescription(offer.toJSON());
    expect(b.iceTransports[0].connection.remoteIsLite).toBeTruthy();

    await b.setLocalDescription(await b.createAnswer());
    expect(b.iceTransports[0].connection.iceControlling).toBeTruthy();

    a.close();
    b.close();
  });

  test("local offer can advertise ice-lite and remain controlled", async () => {
    const lite = new RTCPeerConnection({
      iceLite: true,
      iceServers: [],
    });
    const full = new RTCPeerConnection({
      iceServers: [],
    });
    const channel = lite.createDataChannel("chat");
    const remoteChannelPromise = new Promise<RTCDataChannel>((resolve) => {
      full.onDataChannel.subscribe(resolve);
    });

    try {
      // Arrange: ICE lite の offerer と full ICE の answerer を作る。
      await lite.setLocalDescription(await lite.createOffer());

      // Assert: local SDP に a=ice-lite が含まれ、lite 側は controlled のままである。
      expect(lite.localDescription!.sdp).toContain("a=ice-lite");
      expect(lite.iceTransports[0].connection.iceLite).toBeTruthy();
      expect(lite.iceTransports[0].connection.iceControlling).toBeFalsy();

      // Act: full 側で offer を受けて answer を返し、ICE/DTLS/SCTP を接続する。
      await full.setRemoteDescription(lite.localDescription!);
      expect(full.iceTransports[0].connection.remoteIsLite).toBeTruthy();
      expect(full.iceTransports[0].connection.iceControlling).toBeTruthy();

      await full.setLocalDescription(await full.createAnswer());
      await lite.setRemoteDescription(full.localDescription!);
      await Promise.all([
        waitForConnectionState(lite, "connected"),
        waitForConnectionState(full, "connected"),
      ]);

      const remoteChannel = await remoteChannelPromise;
      await Promise.all([
        assertDataChannelOpen(channel),
        assertDataChannelOpen(remoteChannel),
      ]);

      // Assert: DataChannel が双方向に開き、送受信まで成立する。
      channel.send(Buffer.from("from-lite"));
      let [data] = await remoteChannel.onMessage.asPromise();
      expect(data.toString()).toBe("from-lite");

      remoteChannel.send(Buffer.from("from-full"));
      [data] = await channel.onMessage.asPromise();
      expect(data.toString()).toBe("from-full");
    } finally {
      await Promise.allSettled([lite.close(), full.close()]);
    }
  });

  test("advertises configured local max-message-size in offer and answer", async () => {
    const caller = new RTCPeerConnection({ maxMessageSize: 1234 });
    const callee = new RTCPeerConnection({ maxMessageSize: 0 });
    caller.createDataChannel("chat");

    try {
      await caller.setLocalDescription(await caller.createOffer());
      expect(caller.localDescription!.sdp).toContain("a=max-message-size:1234");

      await callee.setRemoteDescription(caller.localDescription!);
      // remoteMaxMessageSize は現行associationをanswer commitまで変えない。

      await callee.setLocalDescription(await callee.createAnswer());
      expect(callee.localDescription!.sdp).toContain("a=max-message-size:0");
      expect(callee.sctpTransport!.remoteMaxMessageSize).toBe(1234);

      await caller.setRemoteDescription(callee.localDescription!);
      expect(caller.sctpTransport!.remoteMaxMessageSize).toBe(0);
    } finally {
      await caller.close();
      await callee.close();
    }
  });

  test("respects remote max-message-size advertised in answer", async () => {
    const { pc1, pc2, dc } = await prepareDataChannelWithRemoteAnswer((sdp) =>
      replaceMaxMessageSize(sdp, 10),
    );

    try {
      expect(pc1.sctpTransport!.remoteMaxMessageSize).toBe(10);
      expect(() => dc.send(Buffer.from("hello world"))).toThrow(
        "max-message-size exceeded",
      );
    } finally {
      await pc1.close();
      await pc2.close();
    }
  });

  test("defaults remote max-message-size to 65536 when omitted from answer", async () => {
    const { pc1, pc2, dc } = await prepareDataChannelWithRemoteAnswer((sdp) =>
      removeMaxMessageSize(sdp),
    );

    try {
      expect(pc1.sctpTransport!.remoteMaxMessageSize).toBe(65536);
      const withinDefaultLimit = Buffer.alloc(65536, 1);
      expect(() => dc.send(withinDefaultLimit)).not.toThrow();
      expect(() => dc.send(Buffer.alloc(65537, 1))).toThrow(
        "max-message-size exceeded",
      );
    } finally {
      await pc1.close();
      await pc2.close();
    }
  });

  test("treats remote max-message-size 0 as unlimited", async () => {
    const { pc1, pc2, dc } = await prepareDataChannelWithRemoteAnswer((sdp) =>
      replaceMaxMessageSize(sdp, 0),
    );

    try {
      expect(pc1.sctpTransport!.remoteMaxMessageSize).toBe(0);
      const payload = Buffer.alloc(1024, 1);
      expect(() => dc.send(payload)).not.toThrow();
      expect(dc.messagesSent).toBe(1);
      expect(dc.bytesSent).toBe(payload.length);
      expect(dc.bufferedAmount).toBe(payload.length);
    } finally {
      await pc1.close();
      await pc2.close();
    }
  });

  test("updates remote max-message-size when a renegotiated answer changes it", async () => {
    const { pc1, pc2, dc } = await prepareDataChannelWithRemoteAnswer((sdp) =>
      replaceMaxMessageSize(sdp, 10),
    );

    try {
      expect(pc1.sctpTransport!.remoteMaxMessageSize).toBe(10);
      expect(() => dc.send(Buffer.alloc(11, 1))).toThrow(
        "max-message-size exceeded",
      );

      await renegotiateDataChannelWithRemoteAnswer(pc1, pc2, (sdp) =>
        replaceMaxMessageSize(sdp, 20),
      );

      expect(pc1.sctpTransport!.remoteMaxMessageSize).toBe(20);
      expect(() => dc.send(Buffer.alloc(11, 1))).not.toThrow();
      expect(() => dc.send(Buffer.alloc(21, 1))).toThrow(
        "max-message-size exceeded",
      );
    } finally {
      await pc1.close();
      await pc2.close();
    }
  });

  test("ICE restart 中は remote nomination だけの pair から RTP/RTCP を送らない", async () => {
    // Arrange: 非 SPED・DTLS 1.2 の実 PeerConnection と DTLS/SRTP を接続する。
    const caller = new RTCPeerConnection({});
    const callee = new RTCPeerConnection({});
    let receivedRtp = 0;
    let receivedRtcp = 0;

    try {
      await createDataChannelPair(undefined, caller, callee);
      const sender = callee.dtlsTransports[0]!;
      const receiver = caller.dtlsTransports[0]!;
      receiver.onRtp.subscribe(() => receivedRtp++);
      receiver.onRtcp.subscribe(() => receivedRtcp++);

      const controlledIce = callee.dtlsTransports[0]!.iceTransport
        .connection as Connection;
      const generationBeforeRestart = controlledIce.generation;

      // Act: ICE restart を実行し、新 generation の候補交換を開始する。
      await caller.setLocalDescription(
        await caller.createOffer({ iceRestart: true }),
      );
      await callee.setRemoteDescription(caller.localDescription!);
      await callee.setLocalDescription(await callee.createAnswer());
      await caller.setRemoteDescription(callee.localDescription!);

      const deadline = Date.now() + 5_000;
      while (
        (controlledIce.generation <= generationBeforeRestart ||
          controlledIce.checkList.length === 0) &&
        Date.now() < deadline
      ) {
        await setTimeout(10);
      }
      expect(controlledIce.generation).toBeGreaterThan(generationBeforeRestart);
      const pair = controlledIce.checkList[0];
      expect(pair).toBeDefined();

      // Act: USE-CANDIDATE は届いたが、成功応答はまだ無い状態を再現する。
      pair!.handle?.resolve?.();
      controlledIce.checkList = [pair!];
      pair!.remoteNominated = true;
      pair!.nominated = false;
      pair!.responsesReceived = 0;
      pair!.updateState(CandidatePairState.IN_PROGRESS);
      controlledIce.nominated = undefined;
      controlledIce.state = "connected";
      (controlledIce as any).consentFresh = false;
      const packetsSentBefore = sender.packetsSent;
      const bytesSentBefore = sender.bytesSent;

      const blockedRtp = await sender.sendRtp(
        Buffer.from("before-consent"),
        new RtpHeader({ ssrc: 0x7101, payloadType: 96 }),
      );
      const blockedRtcp = await sender.sendRtcp([
        new RtcpRrPacket({ ssrc: 0x7101, reports: [] }),
      ]);
      await setTimeout(50);

      // Assert: nomination通知だけでは wire、RTP/RTCP callback、統計を進めない。
      expect(blockedRtp).toBe(0);
      expect(blockedRtcp).toBe(0);
      expect(receivedRtp).toBe(0);
      expect(receivedRtcp).toBe(0);
      expect(sender.packetsSent).toBe(packetsSentBefore);
      expect(sender.bytesSent).toBe(bytesSentBefore);

      // Act: 対応する成功応答と consent を成立させてから再送する。
      pair!.updateState(CandidatePairState.SUCCEEDED);
      pair!.nominated = true;
      controlledIce.nominated = pair;
      (controlledIce as any).consentFresh = true;
      const allowedRtp = await sender.sendRtp(
        Buffer.from("after-consent"),
        new RtpHeader({ ssrc: 0x7102, payloadType: 96 }),
      );
      await sender.sendRtcp([new RtcpRrPacket({ ssrc: 0x7102, reports: [] })]);

      // Assert: successful check response 後だけ実際の peer へ配送される。
      expect(allowedRtp).toBeGreaterThan(0);
      expect(sender.packetsSent).toBe(packetsSentBefore + 2);
      expect(sender.bytesSent).toBeGreaterThan(bytesSentBefore);
      const deliveryDeadline = Date.now() + 5_000;
      while (
        (receivedRtp === 0 || receivedRtcp === 0) &&
        Date.now() < deliveryDeadline
      ) {
        await setTimeout(10);
      }
      expect(receivedRtp).toBe(1);
      expect(receivedRtcp).toBe(1);
    } finally {
      await Promise.allSettled([caller.close(), callee.close()]);
    }
  }, 20_000);
});

describe("initial config", () => {
  describe("dtls", () => {
    it("both peer use keys with rsa", () =>
      new Promise<void>(async (done) => {
        const { keyPem, certPem, signatureHash } =
          await createSelfSignedCertificate({
            signature: SignatureAlgorithm.rsa_1,
            hash: HashAlgorithm.sha256_4,
          });
        const caller = new RTCPeerConnection({
          dtls: { keys: { keyPem, certPem, signatureHash } },
        });
        const callee = new RTCPeerConnection({
          dtls: { keys: { keyPem, certPem, signatureHash } },
        });

        const channel = caller.createDataChannel("label");
        channel.onopen = () => {
          channel.send("hi");
        };

        callee.onDataChannel.subscribe((channel) => {
          channel.onMessage.once(() => {
            caller.close();
            callee.close();
            done();
          });
        });

        await caller.setLocalDescription(await caller.createOffer());
        await callee.setRemoteDescription(caller.localDescription!);
        await callee.setLocalDescription(await callee.createAnswer());
        await caller.setRemoteDescription(callee.localDescription!);
      }));

    it("caller use keys with rsa", () =>
      new Promise<void>(async (done) => {
        const { keyPem, certPem, signatureHash } =
          await createSelfSignedCertificate({
            signature: SignatureAlgorithm.rsa_1,
            hash: HashAlgorithm.sha256_4,
          });
        const caller = new RTCPeerConnection({
          dtls: { keys: { keyPem, certPem, signatureHash } },
        });
        const callee = new RTCPeerConnection({
          // dtls: { keys: { keyPem, certPem, signatureHash } },
        });

        const channel = caller.createDataChannel("label");
        channel.onopen = () => {
          channel.send("hi");
        };

        callee.onDataChannel.subscribe((channel) => {
          channel.onMessage.once(() => {
            caller.close();
            callee.close();
            done();
          });
        });

        await caller.setLocalDescription(await caller.createOffer());
        await callee.setRemoteDescription(caller.localDescription!);
        await callee.setLocalDescription(await callee.createAnswer());
        await caller.setRemoteDescription(callee.localDescription!);
      }));

    it("callee use keys with rsa", () =>
      new Promise<void>(async (done) => {
        const { keyPem, certPem, signatureHash } =
          await createSelfSignedCertificate({
            signature: SignatureAlgorithm.rsa_1,
            hash: HashAlgorithm.sha256_4,
          });
        const caller = new RTCPeerConnection({
          // dtls: { keys: { keyPem, certPem, signatureHash } },
        });
        const callee = new RTCPeerConnection({
          dtls: { keys: { keyPem, certPem, signatureHash } },
        });

        const channel = caller.createDataChannel("label");
        channel.onopen = () => {
          channel.send("hi");
        };

        callee.onDataChannel.subscribe((channel) => {
          channel.onMessage.once(() => {
            caller.close();
            callee.close();
            done();
          });
        });

        await caller.setLocalDescription(await caller.createOffer());
        await callee.setRemoteDescription(caller.localDescription!);
        await callee.setLocalDescription(await callee.createAnswer());
        await caller.setRemoteDescription(callee.localDescription!);
      }));
  });
});

function assertHasIceCandidate(sdp: string) {
  expect(sdp.includes("a=candidate:")).toBeTruthy();
  expect(sdp.includes("a=end-of-candidates")).toBeTruthy();
}

function assertHasDtls(sdp: string, setup: string) {
  expect(sdp.includes("a=fingerprint:sha-256")).toBeTruthy();
  expect(sdp.includes("a=setup:" + setup)).toBeTruthy();
}

const addIceCandidateMediaLine1 = "m=audio";
const addIceCandidateMediaLine2 = "m=video";
const addIceCandidateSdpMid1 = "a1";
const addIceCandidateSdpMLineIndex1 = 0;
const addIceCandidateSdpMid2 = "v1";
const addIceCandidateSdpMLineIndex2 = 1;
const addIceCandidateUsernameFragment1 = "ETEn";
const addIceCandidateUsernameFragment2 = "BGKk";
const addIceCandidateLine1 =
  "candidate:1 1 udp 2113929471 203.0.113.100 10100 typ host";
const addIceCandidateLine2 =
  "candidate:1 2 udp 2113929470 203.0.113.100 10101 typ host";
const addIceCandidateEndOfCandidatesLine = "a=end-of-candidates";
const addIceCandidateWptSdp = `v=0
o=- 4962303333179871722 1 IN IP4 0.0.0.0
s=-
t=0 0
a=ice-options:trickle
a=group:BUNDLE a1 v1
a=group:LS a1 v1
m=audio 10100 UDP/TLS/RTP/SAVPF 96 0 8 97 98
c=IN IP4 203.0.113.100
a=mid:a1
a=sendrecv
a=rtpmap:96 opus/48000/2
a=rtpmap:0 PCMU/8000
a=rtpmap:8 PCMA/8000
a=rtpmap:97 telephone-event/8000
a=rtpmap:98 telephone-event/48000
a=maxptime:120
a=extmap:1 urn:ietf:params:rtp-hdrext:sdes:mid
a=extmap:2 urn:ietf:params:rtp-hdrext:ssrc-audio-level
a=msid:47017fee-b6c1-4162-929c-a25110252400 f83006c5-a0ff-4e0a-9ed9-d3e6747be7d9
a=ice-ufrag:ETEn
a=ice-pwd:OtSK0WpNtpUjkY4+86js7ZQl
a=fingerprint:sha-256 19:E2:1C:3B:4B:9F:81:E6:B8:5C:F4:A5:A8:D8:73:04:BB:05:2F:70:9F:04:A9:0E:05:E9:26:33:E8:70:88:A2
a=setup:actpass
a=dtls-id:1
a=rtcp:10101 IN IP4 203.0.113.100
a=rtcp-mux
a=rtcp-rsize
m=video 10102 UDP/TLS/RTP/SAVPF 100 101
c=IN IP4 203.0.113.100
a=mid:v1
a=sendrecv
a=rtpmap:100 VP8/90000
a=rtpmap:101 rtx/90000
a=fmtp:101 apt=100
a=extmap:1 urn:ietf:params:rtp-hdrext:sdes:mid
a=rtcp-fb:100 ccm fir
a=rtcp-fb:100 nack
a=rtcp-fb:100 nack pli
a=msid:47017fee-b6c1-4162-929c-a25110252400 f30bdb4a-5db8-49b5-bcdc-e0c9a23172e0
a=ice-ufrag:BGKk
a=ice-pwd:mqyWsAjvtKwTGnvhPztQ9mIf
a=fingerprint:sha-256 19:E2:1C:3B:4B:9F:81:E6:B8:5C:F4:A5:A8:D8:73:04:BB:05:2F:70:9F:04:A9:0E:05:E9:26:33:E8:70:88:A2
a=setup:actpass
a=dtls-id:1
a=rtcp:10103 IN IP4 203.0.113.100
a=rtcp-mux
a=rtcp-rsize
`;
const addIceCandidateUnbundledSdp = addIceCandidateWptSdp.replace(
  /^a=group:BUNDLE.*\n/m,
  "",
);

function escapeRegExp(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function isCandidateLineBetween(
  sdp: string,
  beforeMediaLine: string,
  candidateLine: string,
  afterMediaLine: string,
) {
  const line1 = escapeRegExp(beforeMediaLine);
  const line2 = escapeRegExp(candidateLine);
  const line3 = escapeRegExp(afterMediaLine);
  return new RegExp(`${line1}[^]+${line2}[^]+${line3}`).test(sdp);
}

function isCandidateLineAfter(
  sdp: string,
  beforeMediaLine: string,
  candidateLine: string,
) {
  const line1 = escapeRegExp(beforeMediaLine);
  const line2 = escapeRegExp(candidateLine);
  return new RegExp(`${line1}[^]+${line2}`).test(sdp);
}

async function assertIceCompleted(
  pc1: RTCPeerConnection,
  pc2: RTCPeerConnection,
) {
  const wait = (pc: RTCPeerConnection) => {
    if (pc.iceConnectionState === "completed") {
      return Promise.resolve();
    }

    return new Promise<void>((r) => {
      pc.iceConnectionStateChange.subscribe((v) => {
        if (v === "completed") {
          r();
        }
      });
    });
  };

  await Promise.all([wait(pc1), wait(pc2)]);
}

async function assertDataChannelOpen(dc: RTCDataChannel) {
  if (dc.readyState === "open") {
    return;
  }

  return new Promise<void>((r) => {
    dc.stateChanged.subscribe((v) => {
      if (v === "open") {
        r();
      }
    });
  });
}

async function waitForSctpConnected(association: {
  associationState: SCTP_STATE;
  stateChanged: {
    connected: { asPromise(timeLimit?: number): Promise<unknown> };
  };
}) {
  if (association.associationState === SCTP_STATE.ESTABLISHED) return;
  await association.stateChanged.connected.asPromise(5_000);
}

async function waitForSctpClosed(association: {
  associationState: SCTP_STATE;
  stateChanged: { closed: { asPromise(timeLimit?: number): Promise<unknown> } };
}) {
  if (association.associationState === SCTP_STATE.CLOSED) return;
  await association.stateChanged.closed.asPromise(5_000);
}

function removeMaxMessageSize(sdp: string) {
  return sdp
    .split(/\r\n|\n/)
    .filter((line) => !line.startsWith("a=max-message-size:"))
    .join("\r\n");
}

function replaceMaxMessageSize(sdp: string, size: number) {
  return sdp.replace(/a=max-message-size:\d+/, `a=max-message-size:${size}`);
}

async function setLocalOfferWithSctpPort(pc: RTCPeerConnection, port: number) {
  const offer = await pc.createOffer();
  (pc as unknown as { lastCreatedOffer?: unknown }).lastCreatedOffer =
    undefined;
  const sdp = offer.sdp
    .split(/\r\n|\n/)
    .filter((line) => !line.startsWith("a=group:BUNDLE"))
    .join("\r\n")
    .replace(/a=sctp-port:\d+/g, `a=sctp-port:${port}`);
  await pc.setLocalDescription({
    type: "offer",
    sdp,
  });
}

async function createConnectedUnbundledPair() {
  const caller = new RTCPeerConnection({
    iceServers: [],
    bundlePolicy: "max-compat",
  });
  const callee = new RTCPeerConnection({
    iceServers: [],
    bundlePolicy: "max-compat",
  });
  const track = new MediaStreamTrack({ kind: "video" });
  caller.addTransceiver(track, { direction: "sendonly" });
  const channel = caller.createDataChannel("transactional");
  const remoteChannelPromise = new Promise<RTCDataChannel>((resolve) => {
    callee.ondatachannel = ({ channel: remoteChannel }) =>
      resolve(remoteChannel);
  });
  const remoteTrackPromise = new Promise<MediaStreamTrack>((resolve) => {
    callee.onRemoteTransceiverAdded.subscribe((transceiver) => {
      transceiver.onTrack.subscribe(resolve);
    });
  });

  try {
    const initialOffer = await caller.createOffer();
    const initialOfferSdp = initialOffer.sdp
      .split(/\r\n|\n/)
      .filter((line) => !line.startsWith("a=group:BUNDLE"))
      .join("\r\n");
    (caller as unknown as { lastCreatedOffer?: unknown }).lastCreatedOffer =
      undefined;
    await caller.setLocalDescription({
      type: "offer",
      sdp: initialOfferSdp,
    });
    await callee.setRemoteDescription(caller.localDescription!);
    await callee.setLocalDescription(await callee.createAnswer());
    await caller.setRemoteDescription(callee.localDescription!);
    await Promise.all([
      waitForConnectionState(caller, "connected"),
      waitForConnectionState(callee, "connected"),
      assertDataChannelOpen(channel),
    ]);

    return {
      caller,
      callee,
      channel,
      remoteChannel: await remoteChannelPromise,
      track,
      remoteTrack: await remoteTrackPromise,
    };
  } catch (error) {
    await Promise.allSettled([caller.close(), callee.close()]);
    throw error;
  }
}

async function prepareDataChannelWithRemoteAnswer(
  mutateAnswerSdp: (sdp: string) => string,
) {
  const pc1 = new RTCPeerConnection({});
  const pc2 = new RTCPeerConnection({});
  const dc = pc1.createDataChannel("chat");

  await renegotiateDataChannelWithRemoteAnswer(pc1, pc2, mutateAnswerSdp);

  return { pc1, pc2, dc };
}

async function renegotiateDataChannelWithRemoteAnswer(
  pc1: RTCPeerConnection,
  pc2: RTCPeerConnection,
  mutateAnswerSdp: (sdp: string) => string,
) {
  await pc1.setLocalDescription(await pc1.createOffer());
  await pc2.setRemoteDescription(pc1.localDescription!);

  const answer = await pc2.createAnswer();
  const mutatedAnswer = {
    type: "answer" as const,
    sdp: mutateAnswerSdp(answer.sdp),
  };
  await pc1.setRemoteDescription(mutatedAnswer);
  await pc2.setLocalDescription(mutatedAnswer);
}

async function waitForConnectionState(
  pc: RTCPeerConnection,
  expected: "failed" | "connected",
) {
  if (pc.connectionState === expected) {
    return;
  }

  return new Promise<void>((resolve, reject) => {
    const subscription = pc.connectionStateChange.subscribe((state) => {
      if (state === expected) {
        subscription.unSubscribe();
        resolve();
      } else if (state === "failed" || state === "closed") {
        subscription.unSubscribe();
        reject(
          new Error(
            `Expected connection state ${expected}, got terminal state ${state}`,
          ),
        );
      }
    });
  });
}

function tamperFingerprints(sdp: string) {
  return sdp.replace(
    /a=fingerprint:([^\s]+) ([0-9A-Fa-f:]+)/g,
    (_, algorithm: string, value: string) =>
      `a=fingerprint:${algorithm} ${mutateFingerprint(value)}`,
  );
}

function mutateFingerprint(value: string) {
  const normalized = value.replace(/[^0-9a-f]/gi, "").toUpperCase();
  const flipped = `${normalized[0] === "A" ? "B" : "A"}${normalized.slice(1)}`;
  return flipped.match(/.{2}/g)!.join(":");
}
