import {
  assertNegotiatedVersions,
  ensureDtlsPeer,
  peer,
  requestWeriftStats,
  waitForRtcpPath,
  waitVideoPlay,
} from "../dtls/fixture";
import {
  expectWeriftSped,
  iceServers,
  SPED_CASES,
  waitForInboundRtp,
} from "./fixture";

/**
 * Chromium with its SPED on against werift `sped: true`: after the DTLS 1.3
 * handshake inside ICE Binding, SRTP video and RTCP flow both ways.
 */
describe("Chromium SPED ↔ werift sped: true (media)", () => {
  for (const testCase of SPED_CASES) {
    for (const direction of ["Chromium offerer", "werift offerer"] as const) {
      it(`${testCase.name}: ${direction}`, async () => {
        // Arrange: Chromium のカメラ track と、remote video の再生待ち
        await ensureDtlsPeer();
        const method =
          direction === "Chromium offerer"
            ? "dtls_media_offer"
            : "dtls_media_answer";
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

          // Act: offer / answer を交換し、双方向の video を待つ
          if (direction === "Chromium offerer") {
            await pc.setLocalDescription(await pc.createOffer());
            const answer = await peer.request(method, {
              type: "init",
              payload: {
                protocolVersions: testCase.weriftVersions,
                sped: true,
                description: pc.localDescription,
              },
            });
            await pc.setRemoteDescription(answer.description);
          } else {
            const offer = await peer.request(method, {
              type: "init",
              payload: {
                protocolVersions: testCase.weriftVersions,
                sped: true,
              },
            });
            await pc.setRemoteDescription(offer.description);
            await pc.setLocalDescription(await pc.createAnswer());
            peer
              .request(method, { type: "answer", payload: pc.localDescription })
              .catch(() => {});
          }
          await played;

          // Assert: Chromium と werift の双方が RTP を受け、RTCP も通る
          await waitForInboundRtp(pc);
          expect(
            (await requestWeriftStats(method)).rtpPacketsReceived,
          ).toBeGreaterThan(0);
          await waitForRtcpPath(pc, method);
          // Assert: 双方 DTLS 1.3 で、werift は SPED で handshake した
          await assertNegotiatedVersions(pc, method, testCase);
          await expectWeriftSped(method);
        } finally {
          pc.close();
        }
      }, 50_000);
    }
  }
});
