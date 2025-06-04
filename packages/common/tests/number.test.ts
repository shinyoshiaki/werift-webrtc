import { uint32Add } from "../src/index.js";

describe("uint32Add", () => {
  it("rollover", () => {
    expect(uint32Add(4294967295, 1)).toBe(0);
  });

  it("not rollover", () => {
    expect(uint32Add(4294967294, 1)).toBe(4294967295);
  });
});
