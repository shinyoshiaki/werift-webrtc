import { Connection } from "../src";

test("example", async () => {
  const a = new Connection(true, {
    stunServer: ["stun.l.google.com", 19302],
  });
  const b = new Connection(false, {
    stunServer: ["stun.l.google.com", 19302],
  });

  // # invite
  await a.gatherCandidates();
  b.remoteCandidates = a.localCandidates;
  b.remoteUsername = a.localUserName;
  b.remotePassword = a.localPassword;

  // # accept
  await b.gatherCandidates();
  a.remoteCandidates = b.localCandidates;
  a.remoteUsername = b.localUserName;
  a.remotePassword = b.localPassword;

  // # connect
  await Promise.all([a.connect(), b.connect()]);

  // # send data a -> b
  await a.send(Buffer.from("howdee"));
  let data = (await b.onData.asPromise()).toString();
  expect(data).toBe("howdee");

  // # send data b -> a
  await b.send(Buffer.from("gotcha"));
  data = (await a.onData.asPromise()).toString();
  expect(data).toBe("gotcha");

  await a.close();
  await b.close();
});
