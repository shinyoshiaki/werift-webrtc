import { randomString } from "../src/utils";

describe("utils", () => {
  test("randomString", () => {
    expect(randomString(23).length).toBe(23);
  });
});
