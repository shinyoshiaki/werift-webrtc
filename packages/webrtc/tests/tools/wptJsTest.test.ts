import { readFileSync } from "fs";
import { resolve } from "path";
import { expect, test } from "vitest";

import {
  buildWptJsTestHtml,
  isWptJsTestFile,
  readWptScriptMetadata,
} from "../../tools/wpt-runner/jsTestLogic";

const SOURCE = [
  "// META: title=RTCDataChannel.prototype.send with large string",
  "// META: script=RTCPeerConnection-helper.js",
  "// META: script=/common/utils.js",
  "// META: timeout=long",
  "'use strict';",
  "// META: script=ignored-after-the-header.js",
  "test(() => {}, 'x');",
].join("\n");

test(".window.js と .any.js だけを JavaScript テストとして扱う", () => {
  // 実行 / 検証: 拡張子で判定する
  expect(isWptJsTestFile("webrtc/RTCDataChannel-binaryType.window.js")).toBe(
    true,
  );
  expect(isWptJsTestFile("webrtc/foo.any.js")).toBe(true);
  expect(isWptJsTestFile("webrtc/RTCPeerConnection-helper.js")).toBe(false);
  expect(isWptJsTestFile("webrtc/toJSON.html")).toBe(false);
});

test("先頭の META 行だけを読み、最初の非 META 行で止まる", () => {
  // 実行: メタデータを読む
  const metadata = readWptScriptMetadata(SOURCE);

  // 検証: title / timeout / script を順に読み、本文の後の META は無視する
  expect(metadata).toEqual({
    title: "RTCDataChannel.prototype.send with large string",
    timeout: "long",
    scripts: ["RTCPeerConnection-helper.js", "/common/utils.js"],
  });
});

test("生成ページは testharness、META script、テスト本文の順に並ぶ", () => {
  // 実行: window スコープのページを生成する
  const html = buildWptJsTestHtml("webrtc/foo.window.js", SOURCE);

  // 検証: wptserve の自動生成ページと同じ順で、本文はインラインで最後に置く
  const order = [
    "<title>RTCDataChannel.prototype.send with large string</title>",
    '<meta name="timeout" content="long">',
    '<script src="/resources/testharness.js"></script>',
    '<script src="/resources/testharnessreport.js"></script>',
    '<script src="RTCPeerConnection-helper.js"></script>',
    '<script src="/common/utils.js"></script>',
    `<script>\n${SOURCE}\n</script>`,
  ].map((part) => html.indexOf(part));
  expect(order.every((index) => index >= 0)).toBe(true);
  expect([...order].sort((a, b) => a - b)).toEqual(order);
  // 検証: .window.js には any 用の GLOBAL を入れない
  expect(html).not.toContain("self.GLOBAL");
});

test(".any.js は window スコープの GLOBAL を testharness より前に定義する", () => {
  // 実行: .any.js のページを生成する
  const html = buildWptJsTestHtml("webrtc/foo.any.js", "test(() => {});");

  // 検証: GLOBAL.isWindow() が true になる定義が testharness の前にある
  expect(html.indexOf("isWindow: () => true")).toBeGreaterThan(-1);
  expect(html.indexOf("isWindow: () => true")).toBeLessThan(
    html.indexOf("/resources/testharness.js"),
  );
});

test("</script> を含む本文はインライン化できないので拒否する", () => {
  // 実行 / 検証: 生成ページが壊れる入力は例外にする
  expect(() =>
    buildWptJsTestHtml("webrtc/foo.window.js", "const s = '</script>';"),
  ).toThrow(/cannot inline/);
});

test("固定版 WPT の RTCDataChannel-binaryType.window.js から実行可能なページを生成できる", () => {
  // 準備: submodule の固定版ファイル (未取得なら読み込みで失敗させる)
  const path = resolve(
    __dirname,
    "../../../../third_party/wpt/webrtc/RTCDataChannel-binaryType.window.js",
  );
  const source = readFileSync(path, "utf8");

  // 実行: ページを生成する
  const html = buildWptJsTestHtml(
    "webrtc/RTCDataChannel-binaryType.window.js",
    source,
  );

  // 検証: 本文がそのまま入り、無効値は無視される (例外にしない) と検証する版である
  expect(html).toContain(source);
  expect(source).toContain("should be ignored");
});
