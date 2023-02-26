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
      console.log({ offer });

      const peer = new RTCPeerConnection({});

      const stream = await navigator.mediaDevices.getUserMedia({
        video: true,
        audio: true,
      });
      const [audio] = stream.getAudioTracks();
      const [video] = stream.getVideoTracks();
      peer.addTrack(audio);
      peer.addTrack(video);

      await peer.setRemoteDescription(offer);
      const answer = await peer.createAnswer();
      await peer.setLocalDescription(answer);
      socket.send(JSON.stringify(peer.localDescription));
    })();
  }, []);

  return <div></div>;
};

ReactDOM.render(<App />, document.getElementById("root"));
