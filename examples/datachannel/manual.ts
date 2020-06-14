import { RTCPeerConnection } from "../../src";
console.log("start");

(async () => {
  const data = process.argv[2];
  console.log(data);
  const offer = JSON.parse(data as string);
  console.log(offer);

  const pc = new RTCPeerConnection({
    stunServer: ["stun.l.google.com", 19302],
  });
  await pc.setRemoteDescription(offer);
  const answer = pc.createAnswer()!;
  await pc.setLocalDescription(answer);
  console.log(JSON.stringify(answer));

  pc.datachannel.subscribe((channel) => {
    channel.message.subscribe((data) => {
      console.log("answer message", data.toString());
      setInterval(() => channel.send(Buffer.from("pong")), 1000);
    });
  });
})();
