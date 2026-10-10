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
  const forceCheckoutSubmodule = vi.fn();
  const cloneCheckout = vi.fn();
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
    forceCheckoutSubmodule,
    cloneCheckout,
  });

  // 検証: 不在時だけ初期化が実行され、成功後は true が返る。
  expect(updated).toBe(true);
  expect(updateSubmodule).toHaveBeenCalledWith("/repo");
  expect(forceCheckoutSubmodule).not.toHaveBeenCalled();
  expect(cloneCheckout).not.toHaveBeenCalled();
});

test("WPT runner fails when the checkout is still missing after initialization", async () => {
  const updateSubmodule = vi.fn();
  const forceCheckoutSubmodule = vi.fn();
  const cloneCheckout = vi.fn();

  // 実行: 初期化しても checkout が現れない異常系を発生させる。
  const run = ensureWptCheckout("/repo", "/repo/third_party/wpt", {
    async hasWptWebrtcDirectory() {
      return false;
    },
    updateSubmodule,
    forceCheckoutSubmodule,
    cloneCheckout,
  });

  // 検証: runner は不完全な checkout のまま続行せず、明示的に失敗させる。
  await expect(run).rejects.toThrow(
    "WPT checkout is still missing after submodule initialization",
  );
  expect(updateSubmodule).toHaveBeenCalledWith("/repo");
  expect(forceCheckoutSubmodule).toHaveBeenCalledWith(
    "/repo",
    "/repo/third_party/wpt",
  );
  expect(cloneCheckout).toHaveBeenCalledWith("/repo", "/repo/third_party/wpt");
});

test("WPT runner falls back to git clone when submodule initialization fails", async () => {
  const updateSubmodule = vi.fn(() => {
    throw new Error("pathspec did not match");
  });
  const forceCheckoutSubmodule = vi.fn(() => {
    throw new Error("gitdir missing");
  });
  const cloneCheckout = vi.fn();
  let hasCheckout = false;

  const updated = await ensureWptCheckout("/repo", "/repo/third_party/wpt", {
    async hasWptWebrtcDirectory() {
      return hasCheckout;
    },
    updateSubmodule,
    forceCheckoutSubmodule,
    cloneCheckout(_root, _wptRoot) {
      cloneCheckout(_root, _wptRoot);
      hasCheckout = true;
    },
  });

  expect(updated).toBe(true);
  expect(updateSubmodule).toHaveBeenCalledWith("/repo");
  expect(forceCheckoutSubmodule).toHaveBeenCalledWith(
    "/repo",
    "/repo/third_party/wpt",
  );
  expect(cloneCheckout).toHaveBeenCalledWith("/repo", "/repo/third_party/wpt");
});

test("WPT runner force-checkouts when submodule update leaves the working tree empty", async () => {
  const updateSubmodule = vi.fn();
  const forceCheckoutSubmodule = vi.fn();
  const cloneCheckout = vi.fn();
  let hasCheckout = false;

  // 実行: submodule update は成功したが webrtc ディレクトリが空のままの worktree を再現する。
  const updated = await ensureWptCheckout("/repo", "/repo/third_party/wpt", {
    async hasWptWebrtcDirectory() {
      return hasCheckout;
    },
    updateSubmodule,
    forceCheckoutSubmodule(root, wptRoot) {
      forceCheckoutSubmodule(root, wptRoot);
      hasCheckout = true;
    },
    cloneCheckout,
  });

  // 検証: 空の作業ツリーに対して checkout -f が走り、clone には落ちない。
  expect(updated).toBe(true);
  expect(updateSubmodule).toHaveBeenCalledWith("/repo");
  expect(forceCheckoutSubmodule).toHaveBeenCalledWith(
    "/repo",
    "/repo/third_party/wpt",
  );
  expect(cloneCheckout).not.toHaveBeenCalled();
});
