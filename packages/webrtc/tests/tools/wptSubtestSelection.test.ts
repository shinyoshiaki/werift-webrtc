import { expect, test } from "vitest";

import {
  createSubtestSelector,
  skippedSubtestRecords,
} from "../../tools/wpt-runner/subtestSelection";

const target = {
  file: "webrtc/RTCDtlsTransport-state.html",
  variant: "",
  skippedSubtests: [
    {
      name: "stop bundled transceiver retains dtls transport state",
      reason: "onended",
    },
  ],
};

test("skippedSubtests に挙げたサブテストだけ harness に登録しない", () => {
  // 実行: 対象ファイルのサブテスト選択関数を作る
  const select = createSubtestSelector(target);

  // 検証: 除外したサブテストは登録せず、それ以外は登録する
  expect(select("stop bundled transceiver retains dtls transport state")).toBe(
    false,
  );
  expect(select("DTLS transport goes to connected state")).toBe(true);
});

test("skippedSubtests を指定しない target はすべてのサブテストを登録する", () => {
  // 実行: 除外指定のない target の選択関数を作る
  const select = createSubtestSelector({});

  // 検証: どのサブテストも登録する（従来どおり）
  expect(select("any subtest")).toBe(true);
});

test("除外したサブテストは理由付きの SKIP として結果に残る", () => {
  // 実行: 除外したサブテストの結果レコードを作る
  const records = skippedSubtestRecords(target);

  // 検証: SKIP（回帰判定と baseline の対象外）で理由がメッセージに入る
  expect(records).toEqual([
    {
      file: "webrtc/RTCDtlsTransport-state.html",
      variant: "",
      subtest: "stop bundled transceiver retains dtls transport state",
      status: "SKIP",
      message: "onended",
    },
  ]);
});
