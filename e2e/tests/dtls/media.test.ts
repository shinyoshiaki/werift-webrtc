import {
  assertNegotiatedVersions,
  casesForCurrentChromium,
  ensureDtlsPeer,
  getChromiumDtlsStats,
  peer,
  requestWeriftStats,
  waitForRtcpPath,
  waitVideoPlay,
} from "./fixture";

const iceServers = [{ urls: "stun:stun.l.google.com:19302" }];

async function waitForInboundRtp(pc: RTCPeerConnection, timeoutMs = 20_000) {
  const started = Date.now();
  for (;;) {
    const stats = await getChromiumDtlsStats(pc);
    if (stats.inboundRtpPackets > 0) {
      return stats;
    }
    if (Date.now() - started > timeoutMs) {
      throw new Error("chromium inbound-rtp packetsReceived stayed 0");
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
}

describe("dtls parameterized media", () => {
  for (const testCase of casesForCurrentChromium()) {
    it(`${testCase.name} Chromium offerer media`, async () => {
      await ensureDtlsPeer();
      const method = "dtls_media_offer";
      const pc = new RTCPeerConnection({ iceServers });
      try {
        const played = new Promise<void>((resolve, reject) => {
          const timer = setTimeout(
            () => reject(new Error("remote video timeout")),
            20_000,
          );
          pc.ontrack = async ({ track }) => {
            try {
              await waitVideoPlay(track);
              clearTimeout(timer);
              resolve();
            } catch (error) {
              clearTimeout(timer);
              reject(error);
            }
          };
        });
        const [track] = (
          await navigator.mediaDevices.getUserMedia({ video: true })
        ).getTracks();
        pc.addTrack(track);
        pc.onicecandidate = ({ candidate }) => {
          peer
            .request(method, { type: "candidate", payload: candidate })
            .catch(() => {});
        };

        await pc.setLocalDescription(await pc.createOffer());
        const answer = await peer.request(method, {
          type: "init",
          payload: {
            protocolVersions: testCase.weriftVersions,
            description: pc.localDescription,
          },
        });
        await pc.setRemoteDescription(answer.description);
        await played;

        // Act: Chromium inbound RTP と werift RTP/RTCP を待つ。
        const chromium = await waitForInboundRtp(pc);
        const werift = await requestWeriftStats(method);

        // Assert: version と media 経路。
        expect(chromium.tlsVersion).toBe(testCase.expectedChromiumVersion);
        expect(werift.tlsVersion).toBe(testCase.expectedWeriftVersion);
        expect(werift.rtpPacketsReceived).toBeGreaterThan(0);
        await waitForRtcpPath(pc, method);
        await assertNegotiatedVersions(pc, method, testCase);
      } finally {
        pc.close();
      }
    }, 50_000);

    it(`${testCase.name} werift offerer media`, async () => {
      await ensureDtlsPeer();
      const method = "dtls_media_answer";
      const pc = new RTCPeerConnection({ iceServers });
      try {
        const played = new Promise<void>((resolve, reject) => {
          const timer = setTimeout(
            () => reject(new Error("remote video timeout")),
            20_000,
          );
          pc.ontrack = async ({ track }) => {
            try {
              await waitVideoPlay(track);
              clearTimeout(timer);
              resolve();
            } catch (error) {
              clearTimeout(timer);
              reject(error);
            }
          };
        });
        const [track] = (
          await navigator.mediaDevices.getUserMedia({ video: true })
        ).getTracks();
        pc.addTrack(track);
        pc.onicecandidate = ({ candidate }) => {
          peer
            .request(method, { type: "candidate", payload: candidate })
            .catch(() => {});
        };

        const offer = await peer.request(method, {
          type: "init",
          payload: { protocolVersions: testCase.weriftVersions },
        });
        await pc.setRemoteDescription(offer.description);
        await pc.setLocalDescription(await pc.createAnswer());
        peer
          .request(method, { type: "answer", payload: pc.localDescription })
          .catch(() => {});
        await played;

        const chromium = await waitForInboundRtp(pc);
        const werift = await requestWeriftStats(method);
        expect(chromium.tlsVersion).toBe(testCase.expectedChromiumVersion);
        expect(werift.tlsVersion).toBe(testCase.expectedWeriftVersion);
        expect(werift.rtpPacketsReceived).toBeGreaterThan(0);
        await waitForRtcpPath(pc, method);
        await assertNegotiatedVersions(pc, method, testCase);
      } finally {
        pc.close();
      }
    }, 50_000);
  }
});
