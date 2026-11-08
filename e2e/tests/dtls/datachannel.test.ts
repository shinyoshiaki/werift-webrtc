import {
  assertNegotiatedVersions,
  BROWSER_DTLS_CASES,
  ensureDtlsPeer,
  peer,
  pingPong,
  requestWeriftStats,
  waitForChannelOpen,
} from "./fixture";

const iceServers = [{ urls: "stun:stun.l.google.com:19302" }];

describe("dtls parameterized datachannel", () => {
  for (const testCase of BROWSER_DTLS_CASES) {
    it(`${testCase.name} Chromium offerer → werift answerer`, async () => {
      await ensureDtlsPeer();
      const method = "dtls_datachannel_offer";
      const pc = new RTCPeerConnection({ iceServers });
      try {
        const channel = pc.createDataChannel("dc");
        const opened = waitForChannelOpen(channel);
        pc.onicecandidate = ({ candidate }) => {
          peer
            .request(method, { type: "candidate", payload: candidate })
            .catch(() => {});
        };

        await pc.setLocalDescription(await pc.createOffer());
        expect(pc.localDescription?.sdp.includes("goog-sped-v1")).toBe(false);

        const answer = await peer.request(method, {
          type: "init",
          payload: {
            protocolVersions: testCase.weriftVersions,
            description: pc.localDescription,
          },
        });
        expect(answer.sped).toBe(false);
        await pc.setRemoteDescription(answer.description);
        await opened;

        // Act: Chromium → werift ping、werift → Chromium pong。
        await pingPong(channel);

        // Assert: 双方の negotiated version。
        await assertNegotiatedVersions(pc, method, testCase);
      } finally {
        pc.close();
      }
    }, 30_000);

    it(`${testCase.name} werift offerer → Chromium answerer`, async () => {
      await ensureDtlsPeer();
      const method = "dtls_datachannel_answer";
      const pc = new RTCPeerConnection({ iceServers });
      try {
        const opened = new Promise<RTCDataChannel>((resolve, reject) => {
          const timer = setTimeout(
            () => reject(new Error("ondatachannel timeout")),
            20_000,
          );
          pc.ondatachannel = ({ channel }) => {
            clearTimeout(timer);
            resolve(channel);
          };
        });
        pc.onicecandidate = ({ candidate }) => {
          peer
            .request(method, { type: "candidate", payload: candidate })
            .catch(() => {});
        };

        const offer = await peer.request(method, {
          type: "init",
          payload: { protocolVersions: testCase.weriftVersions },
        });
        expect(offer.sped).toBe(false);
        await pc.setRemoteDescription(offer.description);
        await pc.setLocalDescription(await pc.createAnswer());
        peer
          .request(method, { type: "answer", payload: pc.localDescription })
          .catch(() => {});

        const channel = await opened;
        await waitForChannelOpen(channel);
        await pingPong(channel);
        await assertNegotiatedVersions(pc, method, testCase);
      } finally {
        pc.close();
      }
    }, 30_000);
  }

  it("WARP sendBeforeNomination: werift (SPED, DTLS [1.3, 1.2]) は nomination 前に valid pair で SCTP / DataChannel を Chromium と通す", async () => {
    // Arrange: Chromium offerer (ICE controlling、SPED 無効) と、nomination を保留した werift answerer
    await ensureDtlsPeer();
    const method = "dtls_datachannel_offer";
    const pc = new RTCPeerConnection({ iceServers });
    try {
      const channel = pc.createDataChannel("dc");
      const opened = waitForChannelOpen(channel);
      pc.onicecandidate = ({ candidate }) => {
        peer
          .request(method, { type: "candidate", payload: candidate })
          .catch(() => {});
      };
      await pc.setLocalDescription(await pc.createOffer());
      const answer = await peer.request(method, {
        type: "init",
        payload: {
          protocolVersions: ["1.3", "1.2"],
          sendBeforeNomination: true,
          holdNomination: true,
          description: pc.localDescription,
        },
      });
      // Assert: werift は SPED を広告せず (相手は SPED 非対応として direct DTLS に fallback する)
      expect(answer.sped).toBe(false);

      // Act: DataChannel を開き、Chromium → werift ping、werift → Chromium pong
      await pc.setRemoteDescription(answer.description);
      await opened;
      await pingPong(channel);

      // Assert: werift は pair を選ばないまま、nomination 前の送信で通信した
      const werift = await requestWeriftStats(method);
      expect(werift.iceNominated).toBe(false);
      expect(werift.warpPreNominationSendUsed).toBe(true);
      expect(werift.tlsVersion).toBe("DTLS 1.3");
    } finally {
      pc.close();
    }
  }, 30_000);
});
