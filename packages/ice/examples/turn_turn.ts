import { createTurnClient } from "../src/turn/protocol";
import type { Address } from "../src/types/model";
import { url2Address } from "../src/utils";

const address: Address = url2Address("127.0.0.1:3478")!;
const username = "username";
const password = "password";

(async () => {
  const receiver = await createTurnClient(
    { address, username, password },
    { transport: "udp" },
  );

  const sender = await createTurnClient(
    { address, username, password },
    { transport: "udp" },
  );

  await sender.getChannel(receiver.relayedAddress).catch((e) => e);
  await receiver.getChannel(sender.relayedAddress).catch((e) => e);

  receiver.onData.subscribe((data, addr) => {
    console.log("receiver onData", data.toString(), addr);
    receiver.sendData(
      Buffer.from("pong " + new Date().toISOString()),
      sender.relayedAddress,
    );
  });
  sender.onData.subscribe((data, addr) => {
    console.log("sender onData", data.toString(), addr);
  });

  setInterval(async () => {
    await sender.sendData(
      Buffer.from("ping " + new Date().toISOString()),
      receiver.relayedAddress,
    );
  }, 2000);
})();
