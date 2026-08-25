import { SPED_OUTER_MTU } from "../../src/sped/draft00/constants";
import { defaultSpedDtlsMtu } from "../../src/sped/draft00/mtu";

describe("SPED MTU", () => {
  it("defaultSpedDtlsMtu は 1200 から STUN overhead を引く", () => {
    // Arrange / Act
    const mtu = defaultSpedDtlsMtu();

    // Assert: HMAC-SHA1 Binding を載せる分だけ 1200 より小さい
    expect(mtu).toBeLessThan(SPED_OUTER_MTU);
    expect(mtu).toBeGreaterThan(800);
  });
});
