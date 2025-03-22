import { createSocket } from "dgram";
import { randomPort } from "../../common/src";
import { getGlobalIp, url2Address } from "../src";
import { createTurnClient } from "../src/turn/protocol";
import type { Address } from "../src/types/model";

const address: Address = url2Address("127.0.0.1:3478")!;
const username = "username";
const password = "password";

(async () => {
  const turn = await createTurnClient(
    { address, username, password },
    {
      transport: "udp",
    },
  );
  turn.onData.subscribe((data, addr) => {
    console.log("turn onData", data.toString(), addr);
  });

  console.log("turn", turn.relayedAddress, turn.mappedAddress);

  const ip = address[0] === "127.0.0.1" ? address[0] : await getGlobalIp();
  const port = await randomPort();
  const socket = createSocket("udp4");
  socket.bind(port);
  await turn.getChannel([ip, port]);

  setInterval(() => {
    socket.send(
      Buffer.from("ping"),
      turn.relayedAddress[1],
      turn.relayedAddress[0],
    );
  }, 1000);
})();
