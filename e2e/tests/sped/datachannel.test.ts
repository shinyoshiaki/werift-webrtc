import {
  assertNegotiatedVersions,
  ensureDtlsPeer,
  peer,
  pingPong,
  waitForChannelOpen,
} from "../dtls/fixture";
import {
  expectWeriftSped,
  hasSpedOption,
  iceServers,
  SPED_CASES,
} from "./fixture";

/**
 * Chromium with its SPED on against werift `sped: true`, in both offer
 * directions: the DTLS 1.3 handshake runs inside the ICE Binding exchange of
 * both ends and the DataChannel carries messages both ways.
 */
describe("Chromium SPED ↔ werift sped: true (DataChannel)", () => {
  for (const testCase of SPED_CASES) {
    it(`${testCase.name}: Chromium offerer → werift answerer`, async () => {
      // Arrange: SPED を有効にした Chromium の offer
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
        // Assert: Chromium は SPED を広告している
        expect(hasSpedOption(pc.localDescription?.sdp)).toBe(true);

        // Act: werift (sped: true) が answer を返す
        const answer = await peer.request(method, {
          type: "init",
          payload: {
            protocolVersions: testCase.weriftVersions,
            sped: true,
            description: pc.localDescription,
          },
        });
        // Assert: werift の answer も SPED を広告する
        expect(hasSpedOption(answer.description.sdp)).toBe(true);

        // Act: DataChannel を開き、Chromium → werift ping、werift → Chromium pong
        await pc.setRemoteDescription(answer.description);
        await opened;
        await pingPong(channel);

        // Assert: 双方 DTLS 1.3 で、werift は SPED で handshake した
        await assertNegotiatedVersions(pc, method, testCase);
        await expectWeriftSped(method);
      } finally {
        pc.close();
      }
    }, 30_000);

    it(`${testCase.name}: werift offerer → Chromium answerer`, async () => {
      // Arrange: werift (sped: true) の offer
      await ensureDtlsPeer();
      const method = "dtls_datachannel_answer";
      const pc = new RTCPeerConnection({ iceServers });
      try {
        const remoteChannel = new Promise<RTCDataChannel>((resolve, reject) => {
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
          payload: { protocolVersions: testCase.weriftVersions, sped: true },
        });
        // Assert: werift の offer は SPED を広告している
        expect(hasSpedOption(offer.description.sdp)).toBe(true);

        // Act: Chromium が answer する
        await pc.setRemoteDescription(offer.description);
        await pc.setLocalDescription(await pc.createAnswer());
        // Assert: Chromium の answer も SPED を広告する (offer に sped があるときだけ)
        expect(hasSpedOption(pc.localDescription?.sdp)).toBe(true);

        // Act: DataChannel を開き、往復する
        peer
          .request(method, { type: "answer", payload: pc.localDescription })
          .catch(() => {});
        const channel = await remoteChannel;
        await waitForChannelOpen(channel);
        await pingPong(channel);

        // Assert: 双方 DTLS 1.3 で、werift は SPED で handshake した
        await assertNegotiatedVersions(pc, method, testCase);
        await expectWeriftSped(method);
      } finally {
        pc.close();
      }
    }, 30_000);
  }
});
