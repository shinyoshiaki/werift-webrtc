import { bufferArrayXor } from "../src";

describe("binary", () => {
  test("bufferArrayXor", () => {
    const xored = bufferArrayXor([
      Buffer.from([0, 0, 1, 1, 1, 0, 1, 1]),
      Buffer.from([0, 1, 0, 1, 0, 0, 1, 1]),
      Buffer.from([0, 0, 1, 1, 0, 1, 0, 0]),
    ]);
    expect(xored.equals(Buffer.from([0, 1, 0, 1, 1, 1, 0, 0]))).toBeTruthy();
  });
});
