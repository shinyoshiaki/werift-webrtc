import { peer, sleep } from "../fixture";

describe("datachannel/close", () => {
  it(
    "datachannel_close_server_create",
    async () =>
      new Promise<void>(async (r) => {
        const label = "datachannel_close_server_answer";

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
            console.log("onclose");
            r();
          };
          channel.send("ping");
        };

        pc.onicecandidate = ({ candidate }) => {
          peer.request(label, {
            type: "candidate",
            payload: candidate,
          });
        };

        peer.request(label, {
          type: "answer",
          payload: pc.localDescription,
        });
      }),
    300 * 1000
  );

  fit(
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
          peer.request(label, {
            type: "candidate",
            payload: candidate,
          });
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
            console.warn("onmessage");
            r();
            channel.close();
          };
        });

        Promise.all([
          new Promise<void>((r) => {
            channel.onclose = () => {
              console.warn("onclose");
              r();
            };
          }),
          peer.request(label, { type: "done" }),
        ]).then(() => {
          console.log("done");
          done();
        });
      }),
    600 * 1000
  );

  fit(
    "datachannel_close_client_create_server_close",
    async () =>
      new Promise<void>(async (done) => {
        const label = "datachannel_close_client_create_server_close";
        if (!peer.connected) await new Promise<void>((r) => peer.on("open", r));
        await sleep(100);

        const pc = new RTCPeerConnection({
          iceServers: [{ urls: "stun:stun.l.google.com:19302" }],
        });
        pc.onicecandidate = ({ candidate }) => {
          peer.request(label, {
            type: "candidate",
            payload: candidate,
          });
        };
        const channel = pc.createDataChannel("dc");
        channel.onopen = () => {
          channel.send("hello");
        };
        channel.onclose = () => {
          console.warn("onclose");
          done();
        };

        await pc.setLocalDescription(await pc.createOffer());
        const answer = await peer.request(label, {
          type: "init",
          payload: pc.localDescription,
        });
        pc.setRemoteDescription(answer);
      }),
    600 * 1000
  );
});
