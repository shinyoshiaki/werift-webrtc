import {
  assertNegotiatedVersions,
  BROWSER_DTLS_CASES,
  ensureDtlsPeer,
  hasSpedOption,
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
        // Assert: Chromium の SPED は無効 (chromiumLaunch.ts) なので広告しない
        expect(hasSpedOption(pc.localDescription?.sdp)).toBe(false);

        const answer = await peer.request(method, {
          type: "init",
          payload: {
            protocolVersions: testCase.weriftVersions,
            sped: testCase.weriftSped,
            description: pc.localDescription,
          },
        });
        // Assert: werift は sped: true のときだけ SPED を広告する
        expect(answer.sped).toBe(testCase.weriftSped === true);
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
          payload: {
            protocolVersions: testCase.weriftVersions,
            sped: testCase.weriftSped,
          },
        });
        // Assert: werift は sped: true のときだけ SPED を広告する
        expect(offer.sped).toBe(testCase.weriftSped === true);
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
      // Assert: werift は SPED を広告するが、Chromium の SPED は無効なので
      // direct DTLS に fallback する
      expect(answer.sped).toBe(true);

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
