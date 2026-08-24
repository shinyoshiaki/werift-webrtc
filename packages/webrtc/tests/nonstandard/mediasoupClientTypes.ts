import "../../src/polyfill";
import type { Device } from "mediasoup-client";

/** Node `lib: ["esnext"]` で polyfill 後に navigator.userAgent と Device を参照できることの型スモーク。 */
export function readInstalledUserAgent(): string {
  const userAgent: string = navigator.userAgent;
  return userAgent;
}

export type AutodetectedDevice = Awaited<ReturnType<typeof Device.factory>>;
