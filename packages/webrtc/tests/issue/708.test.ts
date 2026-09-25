import { DEFAULT_SCTP_MTU } from "../../../sctp/src";
import { RTCPeerConnection } from "../../src";

describe("issue #708 SCTP outbound MTU", () => {
  test("normalizes and propagates the configured MTU", () => {
    const pc = new RTCPeerConnection({ sctp: { mtu: 1052 } });

    // Act: DataChannel に必要な SCTP transport を生成する。
    pc.createDataChannel("dc");

    // Assert: resolved config と low-level association に値が伝播する。
    expect(pc.getConfiguration().sctp.mtu).toBe(1052);
    expect(pc.sctpTransport!.sctp.mtu).toBe(1052);
  });

  test("supports omitted and empty SCTP configuration", () => {
    const omitted = new RTCPeerConnection();
    const empty = new RTCPeerConnection({ sctp: {} });

    // Act / Assert: どちらも既定 MTU に正規化される。
    expect(omitted.getConfiguration().sctp.mtu).toBe(DEFAULT_SCTP_MTU);
    expect(empty.getConfiguration().sctp.mtu).toBe(DEFAULT_SCTP_MTU);
  });

  test("enforces MTU immutability after transport creation", () => {
    const pc = new RTCPeerConnection({ sctp: { mtu: 1052 } });
    pc.createDataChannel("dc");

    // Act / Assert: 同値は許可し、異なる値は拒否する。
    expect(() => pc.setConfiguration({ sctp: { mtu: 1052 } })).not.toThrow();
    expect(() => pc.setConfiguration({ sctp: { mtu: 1191 } })).toThrow(
      "sctp.mtu cannot be changed after SCTP transport creation",
    );
  });

  test("allows changes before transport creation and clones returned config", () => {
    const pc = new RTCPeerConnection();

    // Act: transport 作成前に変更し、取得した snapshot を書き換える。
    pc.setConfiguration({ sctp: { mtu: 1052 } });
    const snapshot = pc.getConfiguration();
    snapshot.sctp.mtu = 1228;

    // Assert: snapshot の変更は内部 config に影響しない。
    expect(pc.getConfiguration().sctp.mtu).toBe(1052);
    expect(() => pc.setConfiguration({ sctp: { mtu: 31 } })).toThrow(
      "SCTP MTU is too small for a DATA chunk",
    );
  });

  test("preserves omitted MTU and resets an explicitly empty SCTP config", () => {
    const pc = new RTCPeerConnection({ sctp: { mtu: 1052 } });

    // Act / Assert: 省略時は現在値を保ち、空 object は既定値へ戻す。
    pc.setConfiguration({});
    expect(pc.getConfiguration().sctp.mtu).toBe(1052);
    pc.setConfiguration({ sctp: {} });
    expect(pc.getConfiguration().sctp.mtu).toBe(DEFAULT_SCTP_MTU);
  });

  test("rejects explicit empty SCTP config after transport creation when it would change MTU", () => {
    const pcCustom = new RTCPeerConnection({ sctp: { mtu: 1052 } });
    // Act: DataChannel に必要な SCTP transport を生成する。
    pcCustom.createDataChannel("dc");

    // Assert: 明示的な空指定は既定値への変更になるため拒否し、状態を維持する。
    expect(() => pcCustom.setConfiguration({ sctp: {} })).toThrow(
      "sctp.mtu cannot be changed after SCTP transport creation",
    );
    expect(pcCustom.getConfiguration().sctp.mtu).toBe(1052);
    expect(pcCustom.sctpTransport!.sctp.mtu).toBe(1052);

    const pcDefault = new RTCPeerConnection();
    // Act: 既定 MTU の transport に対して空指定を適用する。
    pcDefault.createDataChannel("dc");

    // Assert: 既定値と一致するため許可し、transport と一致を保つ。
    expect(() => pcDefault.setConfiguration({ sctp: {} })).not.toThrow();
    expect(pcDefault.getConfiguration().sctp.mtu).toBe(DEFAULT_SCTP_MTU);
    expect(pcDefault.sctpTransport!.sctp.mtu).toBe(DEFAULT_SCTP_MTU);
  });
});
