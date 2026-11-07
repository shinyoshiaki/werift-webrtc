import { CandidatePairState, classes, methods } from "../src";

describe("packages/ice/tests/const.test.ts", () => {
  test("CandidatePairState keeps its values", () => {
    // Act / Assert: const オブジェクト化しても公開値は変わっていない
    expect(CandidatePairState.FROZEN).toBe(0);
    expect(CandidatePairState.WAITING).toBe(1);
    expect(CandidatePairState.IN_PROGRESS).toBe(2);
    expect(CandidatePairState.SUCCEEDED).toBe(3);
    expect(CandidatePairState.FAILED).toBe(4);
  });

  test("STUN classes and methods keep their values", () => {
    // Act / Assert: ice-server から再 export される STUN 定数の値は変わっていない
    expect(classes.REQUEST).toBe(0x000);
    expect(classes.RESPONSE).toBe(0x100);
    expect(classes.ERROR).toBe(0x110);
    expect(methods.BINDING).toBe(0x1);
    expect(methods.ALLOCATE).toBe(0x3);
    expect(methods.CHANNEL_BIND).toBe(0x9);
  });
});
