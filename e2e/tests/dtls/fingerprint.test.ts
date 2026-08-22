import {
  casesForCurrentChromium,
  ensureDtlsPeer,
  getChromiumDtlsStats,
  peer,
  requestWeriftStats,
} from "./fixture";

const iceServers = [{ urls: "stun:stun.l.google.com:19302" }];

function wait(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

describe("dtls parameterized fingerprint", () => {
  for (const testCase of casesForCurrentChromium()) {
    it(`${testCase.name} Chromium offerer fingerprint mismatch`, async () => {
      await ensureDtlsPeer();
      const method = "dtls_fingerprint_offer";
      const pc = new RTCPeerConnection({ iceServers });
      try {
        const channel = pc.createDataChannel("dc");
        let opened = false;
        channel.onopen = () => {
          opened = true;
        };
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
            mutateFingerprint: true,
          },
        });
        await pc.setRemoteDescription(answer.description);

        const started = Date.now();
        let werift = await requestWeriftStats(method);
        while (werift.dtlsState !== "failed" && Date.now() - started < 15_000) {
          await wait(200);
          werift = await requestWeriftStats(method);
        }

        // Assert: mismatch で failed。DataChannel は open しない。
        expect(werift.dtlsState).toBe("failed");
        expect(werift.lastError?.message ?? "").toMatch(/fingerprint/i);
        expect(opened).toBe(false);
        expect(channel.readyState).not.toBe("open");
        expect(werift.connectionState).not.toBe("connected");
      } finally {
        pc.close();
      }
    }, 30_000);

    it(`${testCase.name} werift offerer fingerprint mismatch`, async () => {
      await ensureDtlsPeer();
      const method = "dtls_fingerprint_answer";
      const pc = new RTCPeerConnection({ iceServers });
      try {
        let opened = false;
        pc.ondatachannel = ({ channel }) => {
          channel.onopen = () => {
            opened = true;
          };
        };
        pc.onicecandidate = ({ candidate }) => {
          peer
            .request(method, { type: "candidate", payload: candidate })
            .catch(() => {});
        };

        const offer = await peer.request(method, {
          type: "init",
          payload: {
            protocolVersions: testCase.weriftVersions,
            mutateFingerprint: true,
          },
        });
        await pc.setRemoteDescription(offer.description);
        await pc.setLocalDescription(await pc.createAnswer());
        peer
          .request(method, { type: "answer", payload: pc.localDescription })
          .catch(() => {});

        const started = Date.now();
        let chromium = await getChromiumDtlsStats(pc);
        while (
          chromium.dtlsState !== "failed" &&
          pc.connectionState !== "failed" &&
          Date.now() - started < 15_000
        ) {
          await wait(200);
          chromium = await getChromiumDtlsStats(pc);
        }

        expect(opened).toBe(false);
        expect(
          chromium.dtlsState === "failed" ||
            pc.connectionState === "failed" ||
            pc.connectionState === "disconnected",
        ).toBe(true);
        expect(chromium.dtlsState).not.toBe("connected");
      } finally {
        pc.close();
      }
    }, 30_000);
  }
});
