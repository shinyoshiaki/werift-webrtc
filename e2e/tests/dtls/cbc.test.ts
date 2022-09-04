import { peer, sleep } from "../fixture";

describe("datachannel", () => {
  fit(
    "answer",
    async () =>
      new Promise<void>(async (done) => {
        const name = "dtls_cbc_answer";

        if (!peer.connected) await new Promise<void>((r) => peer.on("open", r));
        await sleep(100);

        const pc = new RTCPeerConnection({
          iceServers: [{ urls: "stun:stun.l.google.com:19302" }],
        });
        const offer = await peer.request(name, { type: "init" });
        await pc.setRemoteDescription(offer);
        await pc.setLocalDescription(await pc.createAnswer());

        pc.ondatachannel = ({ channel }) => {
          channel.onmessage = ({ data }) => {
            expect(data).toBe("ping" + "pong");
            pc.close();
            done();
          };
          channel.send("ping");
        };

        pc.onicecandidate = ({ candidate }) => {
          peer
            .request(name, {
              type: "candidate",
              payload: candidate,
            })
            .catch(() => {});
        };

        peer
          .request(name, {
            type: "answer",
            payload: pc.localDescription,
          })
          .catch(() => {});
      }),
    10 * 1000
  );

  it(
    "offer",
    async () =>
      new Promise<void>(async (done) => {
        const name = "dtls_cbc_offer";
        if (!peer.connected) await new Promise<void>((r) => peer.on("open", r));
        await sleep(100);

        const pc = new RTCPeerConnection({
          iceServers: [{ urls: "stun:stun.l.google.com:19302" }],
        });
        const channel = pc.createDataChannel("dc");
        channel.onopen = () => {
          channel.send("ping");
        };
        channel.onmessage = ({ data }) => {
          expect(data).toBe("ping" + "pong");
          done();
        };
        pc.onicecandidate = ({ candidate }) => {
          peer
            .request(name, {
              type: "candidate",
              payload: candidate,
            })
            .catch(() => {});
        };

        await pc.setLocalDescription(await pc.createOffer());
        const answer = await peer.request(name, {
          type: "init",
          payload: pc.localDescription,
        });
        await pc.setRemoteDescription(answer);
      }),
    10 * 1000
  );
});
