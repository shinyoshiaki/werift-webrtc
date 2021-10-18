import React, { FC, useEffect } from "react";
import ReactDOM from "react-dom";

const App: FC = () => {
  useEffect(() => {
    const sender = async (tracks: MediaStreamTrack[]) => {
      const sender = new WebSocket("ws://localhost:8888");
      const peer = new RTCPeerConnection({});

      const offer = await new Promise<any>(
        (r) => (sender.onmessage = (ev) => r(JSON.parse(ev.data)))
      );

      peer.onicecandidate = ({ candidate }) => {
        if (!candidate) {
          const sdp = JSON.stringify(peer.localDescription);
          console.log("sender", peer.localDescription.sdp);
          sender.send(sdp);
        }
      };

      await peer.setRemoteDescription(offer);

      const video = tracks.find((t) => t.kind === "video")!;
      peer.addTrack(video);
      const audio = tracks.find((t) => t.kind === "audio")!;
      peer.addTrack(audio);

      const play = document.createElement("audio");
      play.srcObject = new MediaStream([audio]);
      play.muted = true;
      play.play();

      const answer = await peer.createAnswer();
      await peer.setLocalDescription(answer);
    };

    (async () => {
      const receiver = new WebSocket("ws://localhost:8887");
      const peer = new RTCPeerConnection({});

      const offer = await new Promise<any>(
        (r) => (receiver.onmessage = (ev) => r(JSON.parse(ev.data)))
      );

      peer.onicecandidate = ({ candidate }) => {
        if (!candidate) {
          const sdp = JSON.stringify(peer.localDescription);
          console.log(peer.localDescription.sdp);
          receiver.send(sdp);
        }
      };

      peer.ontrack = () => {
        console.warn("ontrack");
      };

      await peer.setRemoteDescription(offer);
      const answer = await peer.createAnswer();
      await peer.setLocalDescription(answer);

      peer.onconnectionstatechange = () => {
        if (peer.connectionState === "connected") {
          sender(peer.getReceivers().map((r) => r.track));
        }
      };
    })();
  }, []);

  return <div>lipsync</div>;
};

ReactDOM.render(<App />, document.getElementById("root"));
