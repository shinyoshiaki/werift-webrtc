import { SCTP_STATE, WEBRTC_PPID } from "../src";

describe("packages/sctp/tests/const.test.ts", () => {
  test("SCTP_STATE keeps its values", () => {
    // Act / Assert: const オブジェクト化しても公開値は変わっていない
    expect(SCTP_STATE.CLOSED).toBe(1);
    expect(SCTP_STATE.ESTABLISHED).toBe(4);
    expect(SCTP_STATE.SHUTDOWN_ACK_SENT).toBe(8);
  });

  test("WEBRTC_PPID keeps its values", () => {
    // Act / Assert: const オブジェクト化しても公開値は変わっていない
    expect(WEBRTC_PPID.DCEP).toBe(50);
    expect(WEBRTC_PPID.STRING).toBe(51);
    expect(WEBRTC_PPID.BINARY).toBe(53);
    expect(WEBRTC_PPID.STRING_EMPTY).toBe(56);
    expect(WEBRTC_PPID.BINARY_EMPTY).toBe(57);
  });
});
