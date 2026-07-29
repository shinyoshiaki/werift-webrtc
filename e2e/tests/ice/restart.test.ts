import { peer, sleep, waitVideoPlay } from "../fixture";
import { createNativeCandidateQueue } from "../nativeCandidateQueue";

const ice_restart_web_trigger_label = "ice_restart_web_trigger";
const ice_restart_node_trigger_label = "ice_restart_node_trigger";

describe("ice/restart", () => {
  it(ice_restart_web_trigger_label, async () => {
    if (!peer.connected) await new Promise<void>((r) => peer.on("open", r));
    await sleep(100);

    const pc = new RTCPeerConnection({
      iceServers: [{ urls: "stun:stun.l.google.com:19302" }],
    });
    const candidates = createNativeCandidateQueue(pc);
    // pc.oniceconnectionstatechange = () => {
    //   console.log("ice connection state change", pc.iceConnectionState);
    // };
    pc.onicecandidate = ({ candidate }) => {
      if (candidate) {
        peer
          .request(ice_restart_web_trigger_label, {
            type: "candidate",
            payload: candidate ?? null,
          })
          .catch(() => {});
      }
    };

    const [track] = (
      await navigator.mediaDevices.getUserMedia({ video: true })
    ).getTracks();
    pc.addTrack(track);

    peer.on("request", async (request, accept) => {
      if (request.method !== ice_restart_web_trigger_label + "ice") {
        return;
      }
      const candidate = request.data.candidate;
      await candidates.add(candidate);
      accept();
    });

    const offer = await peer.request(ice_restart_web_trigger_label, {
      type: "init",
    });
    await pc.setRemoteDescription(offer);
    await candidates.flush();
    await pc.setLocalDescription(await pc.createAnswer());

    peer
      .request(ice_restart_web_trigger_label, {
        type: "answer",
        payload: pc.localDescription,
      })
      .catch(() => {});

    const remote = pc.getTransceivers().map((t) => t.receiver.track)[0];
    await waitVideoPlay(remote);

    {
      // Browser initiates ICE restart; apply the answer so both sides share
      // the new credentials and can re-nominate a pair.
      const offer = await pc.createOffer({ iceRestart: true });
      await pc.setLocalDescription(offer);
      const answer = await peer.request(ice_restart_web_trigger_label, {
        type: "offer",
        payload: pc.localDescription,
      });
      await pc.setRemoteDescription(answer);
      await candidates.flush();
    }

    await waitVideoPlay(remote);

    await peer.request(ice_restart_web_trigger_label, {
      type: "fin",
    });
  }, 20_000);

  it(ice_restart_node_trigger_label, async () => {
    if (!peer.connected) await new Promise<void>((r) => peer.on("open", r));
    await sleep(100);

    const pc = new RTCPeerConnection({
      iceServers: [{ urls: "stun:stun.l.google.com:19302" }],
    });
    const candidates = createNativeCandidateQueue(pc);
    // pc.oniceconnectionstatechange = () => {
    //   console.log("ice connection state change", pc.iceConnectionState);
    // };
    pc.onicecandidate = ({ candidate }) => {
      if (candidate) {
        peer
          .request(ice_restart_node_trigger_label, {
            type: "candidate",
            payload: candidate ?? null,
          })
          .catch(() => {});
      }
    };

    const [track] = (
      await navigator.mediaDevices.getUserMedia({ video: true })
    ).getTracks();
    pc.addTrack(track);

    peer.on("request", async (request, accept) => {
      if (request.method !== ice_restart_node_trigger_label + "ice") {
        return;
      }
      const candidate = request.data.candidate;
      await candidates.add(candidate);
      accept();
    });

    const offer = await peer.request(ice_restart_node_trigger_label, {
      type: "init",
    });
    await pc.setRemoteDescription(offer);
    await candidates.flush();
    await pc.setLocalDescription(await pc.createAnswer());

    peer
      .request(ice_restart_node_trigger_label, {
        type: "answer",
        payload: pc.localDescription,
      })
      .catch(() => {});

    const remote = pc.getTransceivers().map((t) => t.receiver.track)[0];
    await waitVideoPlay(remote);

    {
      const offer = await peer.request(ice_restart_node_trigger_label, {
        type: "restart",
      });
      await pc.setRemoteDescription(offer);
      await candidates.flush();
      await pc.setLocalDescription(await pc.createAnswer());
    }

    peer
      .request(ice_restart_node_trigger_label, {
        type: "answer",
        payload: pc.localDescription,
      })
      .catch(() => {});

    await waitVideoPlay(remote);

    await peer.request(ice_restart_node_trigger_label, {
      type: "fin",
    });
  }, 20_000);
});
