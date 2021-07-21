import { expose, workerThreadsExposer } from "airpc";
import { RTCPeerConnection } from "../../packages/webrtc/src";
import WebSocket from "ws";

export class ClientWorker {
  async ready() {}

  async test() {
    const pc = new RTCPeerConnection();
    pc.connectionStateChange
      .watch((s) => s === "connected")
      .then(() => console.log("connected"));
    const ws = new WebSocket("ws://127.0.0.1:8888");

    ws.onmessage = async (ev) => {
      const sdp = JSON.parse(ev.data as string);
      await pc.setRemoteDescription(sdp);
      await pc.setLocalDescription(await pc.createAnswer());
      ws.send(JSON.stringify(pc.localDescription));
    };
  }
}

expose(new ClientWorker(), workerThreadsExposer());
