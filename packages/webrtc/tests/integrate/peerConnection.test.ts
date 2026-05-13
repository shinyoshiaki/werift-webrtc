import { setTimeout } from "timers/promises";
import { vi } from "vitest";

import { HashAlgorithm } from "../../../dtls/src/cipher/const";
import {
  MediaStream,
  MediaStreamTrack,
  type RTCDataChannel,
  RTCPeerConnection,
  RTCTrackEvent,
  createSelfSignedCertificate,
} from "../../src";
import { SignatureAlgorithm } from "../../src/const";

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
    expect(remoteChannelOpened).toBeFalsy();

    await Promise.allSettled([caller.close(), callee.close()]);
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
        sdp: addIceCandidateWptSdp,
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
        sdp: addIceCandidateWptSdp,
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
      expect(callee.sctpTransport!.remoteMaxMessageSize).toBe(1234);

      await callee.setLocalDescription(await callee.createAnswer());
      expect(callee.localDescription!.sdp).toContain("a=max-message-size:0");

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

function removeMaxMessageSize(sdp: string) {
  return sdp
    .split(/\r\n|\n/)
    .filter((line) => !line.startsWith("a=max-message-size:"))
    .join("\r\n");
}

function replaceMaxMessageSize(sdp: string, size: number) {
  return sdp.replace(/a=max-message-size:\d+/, `a=max-message-size:${size}`);
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

  return new Promise<void>((resolve) => {
    pc.connectionStateChange.subscribe((state) => {
      if (state === expected) {
        resolve();
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
