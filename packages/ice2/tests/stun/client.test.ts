import { StunClient } from "../../src/stun/client";

describe("stun/client", () => {
  it(
    "binding",
    async () => {
      const stun = new StunClient(["stun.l.google.com", 19302]);
      await stun.connect();
      const res = await stun.binding();
      console.log(res);
    },
    60_000 * 60
  );
});
