import { expect, test, vi } from "vitest";

import { ensureWptCheckout } from "../../tools/wpt-runner/submodule";

test("WPT runner skips submodule initialization when the checkout already exists", async () => {
  const updateSubmodule = vi.fn();

  // 実行: 既に webrtc WPT checkout が存在する状態で初期化を試みる。
  const updated = await ensureWptCheckout("/repo", "/repo/third_party/wpt", {
    async hasWptWebrtcDirectory() {
      return true;
    },
    updateSubmodule,
  });

  // 検証: 追加の git submodule update は走らず、そのまま継続できる。
  expect(updated).toBe(false);
  expect(updateSubmodule).not.toHaveBeenCalled();
});

test("WPT runner initializes the submodule when the checkout is missing", async () => {
  const updateSubmodule = vi.fn();
  let hasCheckout = false;

  // 実行: checkout 不在時に submodule 初期化を行い、その後の存在確認まで進める。
  const updated = await ensureWptCheckout("/repo", "/repo/third_party/wpt", {
    async hasWptWebrtcDirectory() {
      return hasCheckout;
    },
    updateSubmodule(root) {
      updateSubmodule(root);
      hasCheckout = true;
    },
  });

  // 検証: 不在時だけ初期化が実行され、成功後は true が返る。
  expect(updated).toBe(true);
  expect(updateSubmodule).toHaveBeenCalledWith("/repo");
});

test("WPT runner fails when the checkout is still missing after initialization", async () => {
  const updateSubmodule = vi.fn();

  // 実行: 初期化しても checkout が現れない異常系を発生させる。
  const run = ensureWptCheckout("/repo", "/repo/third_party/wpt", {
    async hasWptWebrtcDirectory() {
      return false;
    },
    updateSubmodule,
  });

  // 検証: runner は不完全な checkout のまま続行せず、明示的に失敗させる。
  await expect(run).rejects.toThrow(
    "WPT checkout is still missing after submodule initialization",
  );
  expect(updateSubmodule).toHaveBeenCalledWith("/repo");
});
