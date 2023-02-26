import React, { FC, useEffect, useRef } from "react";
import ReactDOM from "react-dom";

const App: FC = () => {
  const videoElm = useRef<HTMLVideoElement>(null);

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

      videoElm.current.srcObject = new MediaStream([video]);

      await peer.setRemoteDescription(offer);
      const answer = await peer.createAnswer();
      await peer.setLocalDescription(answer);
      socket.send(JSON.stringify(peer.localDescription));
    })();
  }, []);

  return (
    <div>
      <video muted autoPlay ref={videoElm} />
    </div>
  );
};

ReactDOM.render(<App />, document.getElementById("root"));
