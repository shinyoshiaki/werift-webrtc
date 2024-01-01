import { StunAgent } from "../../src/stun/agent";
import { UdpTransport } from "../../src/udp";

describe("stun/client", () => {
  it(
    "binding",
    async () => {
      const transport = await UdpTransport.init("udp4");
      const stun = new StunAgent(["stun.l.google.com", 19302], transport);
      await stun.setup();
      const res = await stun.binding();
      console.log(res);
      const [address, port] = res;
      expect(address).toMatch(/^(?:[0-9]{1,3}\.){3}[0-9]{1,3}$/);
      expect(port).toBeGreaterThan(0);
    },
    60_000 * 60,
  );
});
