import { syncBuiltinESMExports } from "node:module";
import osModule from "node:os";
import { vi } from "vitest";
import type { IceGatheringErrorInfo } from "../../src/gatheringError";
import type { Connection } from "../../src/ice";

/**
 * Shared Arrange for the interface enumeration failure tests
 * (interface-enumeration.test.ts, mdns-enumeration.test.ts).
 *
 * `osModule` (the default export) is the CommonJS `os` module, the object
 * multicast-dns gets from `require("os")`. Spying on it and calling
 * `syncBuiltinESMExports()` also changes what `import * as os from
 * "node:os"` of werift sees, so one stub covers both.
 */

/** The `SystemError` Node.js throws where `AF_NETLINK` is denied. */
export function enumerationError() {
  return Object.assign(
    new Error(
      "A system error occurred: uv_interface_addresses returned Unknown system error 97 (Unknown system error 97)",
    ),
    { code: "ERR_SYSTEM_ERROR", errno: 97, syscall: "uv_interface_addresses" },
  );
}

type Interfaces = ReturnType<typeof import("node:os").networkInterfaces>;

/**
 * Replace `os.networkInterfaces()` for every caller (werift and
 * multicast-dns alike): it throws `error` while failing (the default), or
 * returns `interfaces` (the real ones when not given) after `succeed()`.
 * `restore()` brings the real function back.
 */
export function stubNetworkInterfaces(error: Error = enumerationError()) {
  const actual = osModule.networkInterfaces.bind(osModule);
  let result: (() => Interfaces) | undefined;
  const spy = vi.spyOn(osModule, "networkInterfaces").mockImplementation(() => {
    if (!result) throw error;
    return result();
  });
  syncBuiltinESMExports();
  return {
    error,
    spy,
    /** Throw `error` from now on. */
    fail: () => {
      result = undefined;
    },
    /** Return `interfaces` (the real ones when not given) from now on. */
    succeed: (interfaces?: Interfaces) => {
      result = interfaces ? () => interfaces : actual;
    },
    restore: () => {
      spy.mockRestore();
      syncBuiltinESMExports();
    },
  };
}

/**
 * Count `uncaughtException` / `unhandledRejection` while the test runs (a
 * crash of the process outside the test framework).
 */
export function trackUncaught() {
  const uncaught: unknown[] = [];
  const onError = (error: unknown) => uncaught.push(error);
  process.on("uncaughtException", onError);
  process.on("unhandledRejection", onError);
  return {
    uncaught,
    dispose: () => {
      process.off("uncaughtException", onError);
      process.off("unhandledRejection", onError);
    },
  };
}

/** Every `onGatheringError` of `connection`, in order. */
export function recordGatheringErrors(connection: Connection) {
  const errors: IceGatheringErrorInfo[] = [];
  connection.onGatheringError.subscribe((info) => errors.push(info));
  return errors;
}

/** The reasons of `errors`, in order. */
export const reasonsOf = (errors: IceGatheringErrorInfo[]) =>
  errors.map(({ reason }) => reason);
