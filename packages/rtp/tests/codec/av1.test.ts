import { AV1RtpPayload } from "../../src";
import { load } from "../utils";

describe("packages/rtp/tests/codec/av1.test.ts", () => {
  test("todo", () => {
    const packet = load("dump_0.av1");
    const dec = AV1RtpPayload.deSerialize(packet);
  });
});
