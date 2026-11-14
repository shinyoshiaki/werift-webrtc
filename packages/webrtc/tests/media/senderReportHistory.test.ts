import { SenderReportHistory } from "../../src/media/sender/senderReportHistory";
import { dlsrUnits } from "../fixture";

describe("media/sender/senderReportHistory", () => {
  test("同じ LSR が複数あるときは DLSR 前までに送った最新の SR を選ぶ", () => {
    // Arrange: 同じ LSR の SR を t=10s, 11s, 12s に送る。
    const history = new SenderReportHistory();
    const lsr = 0x12348000;
    history.record(lsr, 10);
    history.record(lsr, 11);
    history.record(lsr, 12);

    // Act: t=12.3s に DLSR = 1s の RR を受け取る (受信側が SR を受けたのは t<=11.3s)。
    const rtt = history.roundTripTime(lsr, dlsrUnits(1), 12.3);

    // Assert: t=12s の SR (負の RTT) ではなく t=11s の SR を基準に 300ms になる。
    expect(rtt).toBeCloseTo(0.3, 6);
  });

  test("同じ LSR のどの SR でも負になる RTT は棄却する", () => {
    // Arrange: 同じ LSR の SR を t=10s, 11s に送る。
    const history = new SenderReportHistory();
    const lsr = 0x12348000;
    history.record(lsr, 10);
    history.record(lsr, 11);

    // Act: t=11.5s に DLSR = 2s の RR を受け取る。
    const rtt = history.roundTripTime(lsr, dlsrUnits(2), 11.5);

    // Assert: 照合できる SR が無いので undefined。
    expect(rtt).toBeUndefined();
  });

  test("LSR = 0 は記録があっても照合しない", () => {
    // Arrange: LSR = 0 の SR を記録する。
    const history = new SenderReportHistory();
    history.record(0, 10);

    // Act: LSR = 0 の RR を受け取る。
    const rtt = history.roundTripTime(0, 0, 10.1);

    // Assert: SR 未受信を表すので undefined。
    expect(rtt).toBeUndefined();
  });

  test("件数と保持時間の両方で有界になる", () => {
    // Arrange: 上限 4 件 / 10 秒の履歴に 1 秒間隔で 6 件記録する。
    const history = new SenderReportHistory(4, 10);
    for (let i = 0; i < 6; i++) {
      history.record(i + 1, i);
    }

    // Assert: 古い 2 件が件数上限で追い出される。
    expect(history.size).toBe(4);
    expect(history.roundTripTime(1, 0, 5.1)).toBeUndefined();
    expect(history.roundTripTime(3, 0, 5.1)).toBeCloseTo(3.1, 6);

    // Act: 最後の記録から 10 秒以上経ってから照合する。
    const rtt = history.roundTripTime(6, 0, 15.5);

    // Assert: 保持時間を過ぎたエントリはすべて消え、照合されない。
    expect(rtt).toBeUndefined();
    expect(history.size).toBe(0);
  });

  test("clear で履歴を空にする", () => {
    // Arrange: 1 件記録する。
    const history = new SenderReportHistory();
    history.record(0x00018000, 1);

    // Act: 履歴を消す。
    history.clear();

    // Assert: 以前の LSR は照合されない。
    expect(history.size).toBe(0);
    expect(history.roundTripTime(0x00018000, 0, 1.1)).toBeUndefined();
  });
});
