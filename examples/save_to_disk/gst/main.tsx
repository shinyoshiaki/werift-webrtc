import React, { FC, useEffect } from "react";
import ReactDOM from "react-dom";

const App: FC = () => {
  useEffect(() => {
    (async () => {
      const socket = new WebSocket("ws://localhost:8888");
      await new Promise((r) => (socket.onopen = r));
      console.log("open websocket");

      const offer = await new Promise<any>(
        (r) => (socket.onmessage = (ev) => r(JSON.parse(ev.data)))
      );
      console.log("offer", offer.sdp);

      const peer = new RTCPeerConnection({});

      const [track] = (
        await navigator.mediaDevices.getUserMedia({
          video: { height: 512, width: 512 },
        })
      ).getTracks();

      peer.addTrack(track);

      await peer.setRemoteDescription(offer);
      const answer = await peer.createAnswer();
      await peer.setLocalDescription(answer);
      socket.send(JSON.stringify(peer.localDescription));
    })();
  }, []);

  return <div></div>;
};

ReactDOM.render(<App />, document.getElementById("root"));
