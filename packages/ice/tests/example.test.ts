import { getHostAddresses } from "../src";
import {
  createLocalStunServer,
  createTestConnection,
  inviteAccept,
} from "./utils";

const localStunHost = getHostAddresses(true, false)[0];
const testWithLocalStun = localStunHost ? test : test.skip;

testWithLocalStun("example", async () => {
  const server = await createLocalStunServer(localStunHost!);
  const stunServer = server.address!;
  const a = createTestConnection(true, { stunServer });
  const b = createTestConnection(false, { stunServer });

  try {
    await inviteAccept(a, b);

    // # connect
    await Promise.all([a.connect(), b.connect()]);

    // # send data a -> b
    await a.send(Buffer.from("howdee"));
    let [data] = await b.onData.asPromise();
    expect(data.toString()).toBe("howdee");

    // # send data b -> a
    await b.send(Buffer.from("gotcha"));
    [data] = await a.onData.asPromise();
    expect(data.toString()).toBe("gotcha");
  } finally {
    await a.close();
    await b.close();
    await server.close();
  }
});
