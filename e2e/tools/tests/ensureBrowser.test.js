const assert = require("node:assert/strict");
const { test } = require("node:test");

const {
  canAutoDownloadGoogleChrome,
  resolveChromeExecutable,
} = require("../../browser-paths.js");

test("Chrome auto download is limited to Linux x64", () => {
  // Arrange / Act / Assert: 対応する OS・CPU の組み合わせだけ取得する
  assert.equal(canAutoDownloadGoogleChrome("linux", "x64"), true);
  assert.equal(canAutoDownloadGoogleChrome("linux", "arm64"), false);
  assert.equal(canAutoDownloadGoogleChrome("darwin", "x64"), false);
  assert.equal(canAutoDownloadGoogleChrome("darwin", "arm64"), false);
});

test("unsupported platforms ignore the extracted Linux cache", () => {
  // Arrange: キャッシュと system chromium だけが存在する環境
  const exists = (p) =>
    p.includes(".cache/google-chrome") || p === "/usr/bin/chromium";
  const base = { env: {}, exists };
  // Act / Assert: Linux x64 はキャッシュ優先、それ以外は system のみ
  assert.match(
    resolveChromeExecutable({ ...base, platform: "linux", arch: "x64" }),
    /\.cache\/google-chrome/,
  );
  for (const [platform, arch] of [
    ["darwin", "arm64"],
    ["darwin", "x64"],
    ["linux", "arm64"],
  ]) {
    assert.equal(
      resolveChromeExecutable({ ...base, platform, arch }),
      "/usr/bin/chromium",
    );
  }
  // 明示指定 (CHROME_BIN) は常に尊重する
  assert.equal(
    resolveChromeExecutable({
      env: { CHROME_BIN: "/opt/chrome" },
      exists: () => true,
      platform: "darwin",
      arch: "arm64",
    }),
    "/opt/chrome",
  );
});
