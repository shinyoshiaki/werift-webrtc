import React, { FC, useEffect, useRef, useState } from "react";

const App: FC = () => {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  const connect = async () => {
    const socket = new WebSocket("ws://localhost:8888");
    await new Promise((r) => socket.addEventListener("open", r));

    const peer = new RTCPeerConnection({
      iceServers: [{ urls: "stun:stun.l.google.com:19302" }],
    });
    peer.onicecandidate = ({ candidate }) => {
      if (!candidate) {
        socket.send(JSON.stringify(peer.localDescription));
      }
    };

    peer.ondatachannel = (ev) => {
      const channel = ev.channel;
      console.log(
        channel.ordered,
        channel.maxRetransmits,
        channel.maxPacketLifeTime
      );

      const canvas = canvasRef.current!;
      const ctx = canvas.getContext("2d")!;
      const image = new Image(480, 320);
      image.onload = () => {
        ctx.drawImage(image, 0, 0);
      };

      channel.onmessage = (ev) => {
        const data = ev.data;
        console.log(data);
        const blob = new Blob([data], { type: "image/webp" });
        const url = URL.createObjectURL(blob);
        image.src = url;
      };
    };
    socket.onmessage = async (ev) => {
      const offer = JSON.parse(ev.data);
      console.log(offer.sdp);
      await peer.setRemoteDescription(offer);
      const answer = await peer.createAnswer();
      await peer.setLocalDescription(answer);
    };
  };

  useEffect(() => {
    connect();
  }, []);

  return (
    <div>
      <canvas ref={canvasRef} width={480} height={320} />
    </div>
  );
};

export default App;
