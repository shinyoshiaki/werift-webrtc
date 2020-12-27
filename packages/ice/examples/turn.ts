import { createSocket } from "dgram";
import { createTurnEndpoint } from "../src/turn/turn";

const socket = createSocket("udp4");
socket.bind();

(async () => {
  const turn = await createTurnEndpoint(
    ["127.0.0.1", 55555],
    "username",
    "password",
    6
  );

  console.log("connected", turn.relayedAddress, turn.mappedAddress);

  turn.onData.subscribe(([data]) => {
    console.log("onData", data.toString());
  });

  turn.sendData(Buffer.from("bind channel"), [
    "127.0.0.1",
    socket.address().port,
  ]);

  setInterval(() => {
    socket.send(
      Buffer.from("hi"),
      turn.relayedAddress![1],
      turn.relayedAddress![0]
    );
  }, 1500);
})();
