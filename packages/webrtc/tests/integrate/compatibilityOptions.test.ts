import {
  CertificateScopeModes,
  CompatibilityOptionValues,
  DeprecatedCompatibilityValues,
  KeyFrameRequestRoutingModes,
  MLineReuseModes,
  RTCPeerConnection,
  type RTCPeerConnectionConfig,
  TransceiverPairingModes,
} from "../../src";

/**
 * Every compatibility option takes `"standard"` (specifications / browsers)
 * and one value naming werift's own behavior in that option; the names up to
 * v0.27.0 that are not values any more are read as the current ones.
 */
const options = [
  {
    option: "certificateScope",
    own: "process",
    defaultValue: "process",
    changeable: false,
    aliases: { peerConnection: "standard" },
  },
  {
    option: "mLineReuse",
    own: "aggressive",
    defaultValue: "standard",
    changeable: false,
    aliases: { compatible: "standard" },
  },
  {
    option: "transceiverPairing",
    own: "byKind",
    defaultValue: "byKind",
    changeable: false,
    aliases: {},
  },
  {
    option: "keyFrameRequestRouting",
    own: "fallback",
    defaultValue: "fallback",
    changeable: true,
    aliases: { compatible: "fallback", strict: "standard" },
  },
] as const;

type CompatibilityOption = (typeof options)[number]["option"];

describe("compatibility options: standard and a named own behavior", () => {
  const pcs: RTCPeerConnection[] = [];
  const createPc = (config: RTCPeerConnectionConfig = {}) => {
    const pc = new RTCPeerConnection({ iceServers: [], ...config });
    pcs.push(pc);
    return pc;
  };
  const read = (pc: RTCPeerConnection, option: CompatibilityOption) =>
    pc.getConfiguration()[option];

  afterEach(async () => {
    await Promise.all(pcs.splice(0).map((pc) => pc.close()));
  });

  test("the exported value lists are standard and the option's own value", () => {
    // Assert: 各オプションの値は ["standard", 独自の挙動の名前]
    expect(CompatibilityOptionValues).toEqual(
      Object.fromEntries(
        options.map(({ option, own }) => [option, ["standard", own]]),
      ),
    );
    expect(CertificateScopeModes).toEqual(["standard", "process"]);
    expect(MLineReuseModes).toEqual(["standard", "aggressive"]);
    expect(TransceiverPairingModes).toEqual(["standard", "byKind"]);
    expect(KeyFrameRequestRoutingModes).toEqual(["standard", "fallback"]);
    expect(Object.keys(DeprecatedCompatibilityValues).sort()).toEqual(
      options
        .filter(({ aliases }) => Object.keys(aliases).length > 0)
        .map(({ option }) => option)
        .sort(),
    );
  });

  test.each(options)(
    "$option: default $defaultValue, standard / $own, other values are a TypeError",
    ({ option, own, defaultValue }) => {
      // Act: 既定・両方の値で作成する
      const defaultPc = createPc();
      const standardPc = createPc({ [option]: "standard" });
      const ownPc = createPc({ [option]: own });

      // Assert: 既定値と指定した値がそのまま読み返せる
      expect(read(defaultPc, option)).toBe(defaultValue);
      expect(read(standardPc, option)).toBe("standard");
      expect(read(ownPc, option)).toBe(own);

      // Assert: それ以外の値は生成時に TypeError (未リリースの旧名 "legacy" / "jsep" も含む)
      for (const value of [
        "any",
        "legacy",
        "jsep",
        "constructor",
        "toString",
      ]) {
        expect(() => createPc({ [option]: value as never })).toThrow(
          new TypeError(`${option} must be one of standard, ${own}`),
        );
      }
    },
  );

  test.each(
    options.flatMap(({ option, aliases }) =>
      Object.entries(aliases).map(([alias, value]) => ({
        option,
        alias,
        value,
      })),
    ),
  )(
    "$option: the v0.27.0 name $alias is read as $value",
    ({ option, alias, value }) => {
      // Act: 旧名で作成する
      const pc = createPc({ [option]: alias as never });

      // Assert: getConfiguration() は現在の名前を返す
      expect(read(pc, option)).toBe(value);
    },
  );

  test("a v0.27.0 name selects the same behavior as its current name", async () => {
    // Arrange: mLineReuse の旧名 "compatible" と現在の名前 "standard"
    const aliasPc = createPc({ mLineReuse: "compatible" });
    const standardPc = createPc({ mLineReuse: "standard" });
    aliasPc.addTransceiver("audio", { direction: "inactive" });
    standardPc.addTransceiver("audio", { direction: "inactive" });

    // Act
    const [aliasOffer, standardOffer] = await Promise.all([
      aliasPc.createOffer(),
      standardPc.createOffer(),
    ]);

    // Assert: どちらも受け入れた inactive m-line の port を保つ (standard の挙動)
    const port = (sdp: string) => sdp.match(/^m=audio (\d+)/m)?.[1];
    expect(port(aliasOffer.sdp)).toBe("9");
    expect(port(standardOffer.sdp)).toBe("9");
  });

  test.each(options)(
    "$option: setConfiguration() changes it only when changeable ($changeable)",
    ({ option, own, defaultValue, changeable, aliases }) => {
      // Arrange
      const pc = createPc();
      const other = defaultValue === "standard" ? own : "standard";
      const sameAlias = Object.entries(aliases).find(
        ([, value]) => value === defaultValue,
      )?.[0];

      // Act / Assert: 同じ値 (旧名を含む) の再設定は常に成功する
      expect(() =>
        pc.setConfiguration({ [option]: defaultValue }),
      ).not.toThrow();
      if (sameAlias) {
        expect(() =>
          pc.setConfiguration({ [option]: sameAlias as never }),
        ).not.toThrow();
      }
      expect(read(pc, option)).toBe(defaultValue);

      // Act / Assert: 別の値への変更は変更可能なオプションだけ成功する
      if (changeable) {
        pc.setConfiguration({ [option]: other as never });
        expect(read(pc, option)).toBe(other);
      } else {
        expect(() => pc.setConfiguration({ [option]: other })).toThrow(
          expect.objectContaining({
            name: "InvalidModificationError",
            message: `${option} cannot be changed`,
          }),
        );
        expect(read(pc, option)).toBe(defaultValue);
      }
    },
  );
});
