import { resolvePionIceAgentBin } from "./resolve-pion-ice-agent-bin";

const localBin = "/repo/packages/ice/tools/pion-ice-agent/pion-ice-agent";

function input(
  extra: Partial<Parameters<typeof resolvePionIceAgentBin>[0]> = {},
): Parameters<typeof resolvePionIceAgentBin>[0] {
  return {
    override: undefined,
    required: false,
    autoBuild: false,
    localBin,
    exists: () => false,
    tryBuildLocal: () => undefined,
    ...extra,
  };
}

describe("resolvePionIceAgentBin", () => {
  it("REQUIRED=1 で binary 未指定なら throw し skip しない", () => {
    // Arrange: npm run test:pion-ice-agent 相当
    // Act / Assert
    expect(() => resolvePionIceAgentBin(input({ required: true }))).toThrow(
      /Pion ICE agent opt-in requires WERIFT_PION_ICE_AGENT or WERIFT_PION_ICE_AGENT_AUTO_BUILD=1/,
    );
  });

  it("既定 suite は env 未指定なら skip 用に undefined", () => {
    // Act
    const bin = resolvePionIceAgentBin(input());

    // Assert
    expect(bin).toBeUndefined();
  });

  it("REQUIRED=1 で存在しない override は throw", () => {
    const override = "/broken/agent";

    // Act / Assert
    expect(() =>
      resolvePionIceAgentBin(input({ override, required: true })),
    ).toThrow(`WERIFT_PION_ICE_AGENT does not exist: ${override}`);
  });

  it("既定 suite は欠けた explicit override を skip する", () => {
    // Act
    const bin = resolvePionIceAgentBin(input({ override: "/broken/agent" }));

    // Assert
    expect(bin).toBeUndefined();
  });

  it("REQUIRED=1 でも AUTO_BUILD なら local binary を使う", () => {
    // Act
    const bin = resolvePionIceAgentBin(
      input({
        required: true,
        autoBuild: true,
        exists: (path) => path === localBin,
      }),
    );

    // Assert
    expect(bin).toBe(localBin);
  });
});
