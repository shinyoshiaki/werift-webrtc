import { Connection } from "../../src";
import { sleep } from "../../tests/utils";
import { assertCandidateTypes } from "../utils";

describe("IceTrickleTest", () => {
  test("test_trickle_connect", async () => {
    const a = new Connection(true);
    const b = new Connection(false);

    await a.gatherCandidates();
    b.remoteUsername = a.localUserName;
    b.remotePassword = a.localPassword;

    await b.gatherCandidates();
    a.remoteUsername = b.localUserName;
    a.remotePassword = b.localPassword;

    assertCandidateTypes(a, ["host"]);
    assertCandidateTypes(b, ["host"]);

    let candidate = a.getDefaultCandidate(1)!;
    expect(candidate).not.toBeUndefined();
    expect(candidate.type).toBe("host");

    candidate = a.getDefaultCandidate(2)!;
    expect(candidate).toBeUndefined();

    const addCandidatesLater = async (a: Connection, b: Connection) => {
      await sleep(100);
      for (const candidate of b.localCandidates) {
        a.addRemoteCandidate(candidate);
        await sleep(100);
      }
      a.addRemoteCandidate(undefined);
    };

    await Promise.all([
      a.connect(),
      b.connect(),
      addCandidatesLater(a, b),
      addCandidatesLater(b, a),
    ]);

    // # send data a -> b
    await a.send(Buffer.from("howdee"));
    let [data] = await b.onData.asPromise();
    expect(data.toString()).toBe("howdee");

    // # send data b -> a
    await b.send(Buffer.from("gotcha"));
    [data] = await a.onData.asPromise();
    expect(data.toString()).toBe("gotcha");

    await a.close();
    await b.close();
  });
});
