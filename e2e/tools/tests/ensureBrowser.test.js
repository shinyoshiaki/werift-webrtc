const assert = require("node:assert/strict");
const { test } = require("node:test");

const { canAutoDownloadGoogleChrome } = require("../../ensure-browser.js");

test("Chrome auto download is limited to Linux x64", () => {
  // Arrange / Act / Assert: 対応する OS・CPU の組み合わせだけ取得する
  assert.equal(canAutoDownloadGoogleChrome("linux", "x64"), true);
  assert.equal(canAutoDownloadGoogleChrome("linux", "arm64"), false);
  assert.equal(canAutoDownloadGoogleChrome("darwin", "x64"), false);
  assert.equal(canAutoDownloadGoogleChrome("darwin", "arm64"), false);
});
