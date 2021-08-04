import React, { FC, useEffect, useRef } from "react";
import ReactDOM from "react-dom";
import { createTestTrack } from "./util";

const App: FC = () => {
  const localVideoRef = useRef<HTMLVideoElement>(null);

  useEffect(() => {
    (async () => {
      const socket = new WebSocket("ws://localhost:8888");

      const offer = await new Promise<any>(
        (r) => (socket.onmessage = (ev) => r(JSON.parse(ev.data)))
      );
      console.log("offer", offer.sdp);

      const peer = new RTCPeerConnection({});

      const track = createTestTrack(320, 320);
      localVideoRef.current.srcObject = new MediaStream([track]);

      peer.addTrack(track);

      await peer.setRemoteDescription(offer);
      const answer = await peer.createAnswer();
      await peer.setLocalDescription(answer);
      socket.send(JSON.stringify(peer.localDescription));
    })();
  }, []);

  return (
    <div>
      <video autoPlay ref={localVideoRef} />
    </div>
  );
};

ReactDOM.render(<App />, document.getElementById("root"));
