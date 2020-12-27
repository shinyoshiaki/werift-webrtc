import { createTurnEndpoint } from "../src/turn/turn";

(async () => {
  const turn1 = await createTurnEndpoint(
    ["127.0.0.1", 55555],
    "username",
    "password",
    6
  );
  console.log("turn1", turn1.relayedAddress, turn1.mappedAddress);
  const turn2 = await createTurnEndpoint(
    ["127.0.0.1", 55555],
    "username",
    "password",
    6
  );
  console.log("turn2", turn2.relayedAddress, turn2.mappedAddress);

  // await turn1.sendData(Buffer.from("bind channel"), turn2.mappedAddress!);
  // await turn2.sendData(Buffer.from("bind channel"), turn1.mappedAddress!);

  setInterval(() => {
    turn2.sendData(Buffer.from("ping"), turn1.mappedAddress!);
  }, 5000);
})();
