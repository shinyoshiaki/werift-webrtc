import { StunAgent } from "../../src/stun/agent";

describe("stun/client", () => {
  it(
    "binding",
    async () => {
      const stun = new StunAgent(["stun.l.google.com", 19302]);
      await stun.setup();
      const res = await stun.binding();
      console.log(res);
    },
    60_000 * 60
  );
});
