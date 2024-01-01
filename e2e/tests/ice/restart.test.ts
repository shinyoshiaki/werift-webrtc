import { peer, sleep, waitVideoPlay } from "../fixture";

describe("ice/restart", () => {
  it(
    "answer",
    async () =>
      new Promise<void>(async (done) => {
        const label = "ice_restart_answer";

        if (!peer.connected) await new Promise<void>((r) => peer.on("open", r));
        await sleep(100);

        const pc = new RTCPeerConnection({
          iceServers: [{ urls: "stun:stun.l.google.com:19302" }],
        });
        pc.ondatachannel = ({ channel }) => {
          channel.onmessage = async ({ data }) => {
            if (data === "ping" + "pong") {
              const offer = await peer.request(label, {
                type: "restart",
              });
              await pc.setRemoteDescription(offer);
              await pc.setLocalDescription(await pc.createAnswer());

              peer
                .request(label, {
                  type: "answer",
                  payload: pc.localDescription,
                })
                .catch(() => {});
            }

            if (data === "ping" + "pong" + "pang") {
              console.log(data);
              pc.close();
              done();
            }
          };
          channel.send("ping");
        };
        pc.ontrack = (ev) => {
          waitVideoPlay(ev.track);
        };
        pc.onicecandidate = ({ candidate }) => {
          if (candidate) {
            peer
              .request(label, {
                type: "candidate",
                payload: candidate,
              })
              .catch(() => {});
          }
        };
        peer.on("request", async (request, accept) => {
          if (request.method !== label) return;
          const candidate = request.data;
          await pc.addIceCandidate(candidate).catch(() => {});
          accept();
        });

        const offer = await peer.request(label, {
          type: "init",
        });
        await pc.setRemoteDescription(offer);
        await pc.setLocalDescription(await pc.createAnswer());

        peer
          .request(label, {
            type: "answer",
            payload: pc.localDescription,
          })
          .catch(() => {});
      }),
    10 * 1000,
  );

  it(
    "offer",
    async () =>
      new Promise<void>(async (done) => {
        const label = "ice_trickle_offer";

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
          pc.close();
          done();
        };
        pc.onicecandidate = ({ candidate }) => {
          peer
            .request(label, {
              type: "candidate",
              payload: candidate,
            })
            .catch(() => {});
        };
        peer.on("request", async (request, accept) => {
          if (request.method !== label) return;
          const candidate = request.data;
          await pc.addIceCandidate(candidate).catch(() => {});
          accept();
        });

        await pc.setLocalDescription(await pc.createOffer());
        const answer = await peer.request(label, {
          type: "init",
          payload: pc.localDescription,
        });
        await pc.setRemoteDescription(answer);
      }),
    10 * 1000,
  );
});
