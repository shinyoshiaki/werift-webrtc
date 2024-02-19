import { peer, sleep } from "../fixture";

describe("datachannel/close", () => {
  it("datachannel_close_server_create_close", async () =>
    new Promise<void>(async (done) => {
      const label = "datachannel_close_server_create_close";

      if (!peer.connected) await new Promise<void>((r) => peer.on("open", r));
      await sleep(100);

      const pc = new RTCPeerConnection({
        iceServers: [{ urls: "stun:stun.l.google.com:19302" }],
      });
      const offer = await peer.request(label, {
        type: "init",
      });
      await pc.setRemoteDescription(offer);
      await pc.setLocalDescription(await pc.createAnswer());

      pc.ondatachannel = ({ channel }) => {
        channel.onclose = () => {
          pc.close();
          done();
        };
        channel.send("ping");
      };

      pc.onicecandidate = ({ candidate }) => {
        peer
          .request(label, {
            type: "candidate",
            payload: candidate,
          })
          .catch(() => {});
      };

      peer
        .request(label, {
          type: "answer",
          payload: pc.localDescription,
        })
        .catch(() => {});
    }));

  it("datachannel_close_server_create_client_close", async () =>
    new Promise<void>(async (done) => {
      const label = "datachannel_close_server_create_client_close";

      if (!peer.connected) await new Promise<void>((r) => peer.on("open", r));
      await sleep(100);

      const pc = new RTCPeerConnection({
        iceServers: [{ urls: "stun:stun.l.google.com:19302" }],
      });
      pc.onicecandidate = ({ candidate }) => {
        peer
          .request(label, {
            type: "candidate",
            payload: candidate,
          })
          .catch(() => {});
      };

      const offer = await peer.request(label, {
        type: "init",
      });
      await pc.setRemoteDescription(offer);
      await pc.setLocalDescription(await pc.createAnswer());

      pc.ondatachannel = ({ channel }) => {
        channel.onmessage = () => {
          Promise.all([
            peer.request(label, { type: "done" }),
            new Promise<void>((r) => {
              channel.onclose = () => {
                r();
              };
              setTimeout(() => channel.close(), 500);
            }),
          ]).then(() => done());
        };
      };

      peer
        .request(label, {
          type: "answer",
          payload: pc.localDescription,
        })
        .catch(() => {});
    }));

  it(
    "datachannel_close_client_create_close",
    async () =>
      new Promise<void>(async (done) => {
        const label = "datachannel_close_client_create_close";
        if (!peer.connected) await new Promise<void>((r) => peer.on("open", r));
        await sleep(100);

        const pc = new RTCPeerConnection({
          iceServers: [{ urls: "stun:stun.l.google.com:19302" }],
        });
        pc.onicecandidate = ({ candidate }) => {
          peer
            .request(label, {
              type: "candidate",
              payload: candidate,
            })
            .catch(() => {});
        };
        const channel = pc.createDataChannel("dc");

        await pc.setLocalDescription(await pc.createOffer());
        const answer = await peer.request(label, {
          type: "init",
          payload: pc.localDescription,
        });
        pc.setRemoteDescription(answer);

        await new Promise<void>((r) => {
          channel.onmessage = () => {
            r();
          };
        });

        Promise.all([
          new Promise<void>((r) => {
            channel.onclose = () => {
              r();
            };
            channel.close();
          }),
          peer.request(label, { type: "done" }),
        ]).then(() => {
          done();
        });
      }),
    30 * 1000,
  );

  it("datachannel_close_client_create_server_close", async () =>
    new Promise<void>(async (done) => {
      const label = "datachannel_close_client_create_server_close";
      if (!peer.connected) await new Promise<void>((r) => peer.on("open", r));
      await sleep(100);

      const pc = new RTCPeerConnection({
        iceServers: [{ urls: "stun:stun.l.google.com:19302" }],
      });
      pc.onicecandidate = ({ candidate }) => {
        peer
          .request(label, {
            type: "candidate",
            payload: candidate,
          })
          .catch(() => {});
      };
      const channel = pc.createDataChannel("dc");
      channel.onopen = () => {
        channel.send("hello");
      };
      channel.onclose = () => {
        done();
      };

      await pc.setLocalDescription(await pc.createOffer());
      const answer = await peer.request(label, {
        type: "init",
        payload: pc.localDescription,
      });
      pc.setRemoteDescription(answer);
    }));
});
