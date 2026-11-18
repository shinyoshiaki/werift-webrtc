import dns from "node:dns";
import dnsPromises from "node:dns/promises";
import { syncBuiltinESMExports } from "node:module";

/**
 * テストを公開ネットワークから切り離す vitest setup。
 *
 * `iceServers` に STUN がない構成 (既定設定・`iceServers: []`) は、組み込みの
 * 公開 STUN サーバー (`DEFAULT_STUN_SERVER_URL`) にフォールバックする
 * (`iceUseDefaultStunServer`)。そのサーバーに届かない CI では、gather が
 * STUN の応答を待って peer ごとに約 5 秒止まり、接続するテストが一斉に
 * timeout する。テスト中はこのホスト名の名前解決だけを ENOTFOUND にして、
 * DNS のないオフライン環境と同じ経路 (server-reflexive candidate なしで即座に
 * gather 完了) を通す。src の既定値とフォールバック設定 (`connection.stunServer`)
 * はそのまま検査できる。
 *
 * src を import すると、各テストファイルの `vi.mock` より先にモジュールが
 * 読み込まれてモックが効かなくなるので、ホスト名は定数で持つ。
 * `DEFAULT_STUN_SERVER_URL` との一致は tests/integrate/defaultStun.test.ts が確認する。
 */
export const HERMETIC_DEFAULT_STUN_HOST = "stun.l.google.com";
const host = HERMETIC_DEFAULT_STUN_HOST;

const notFound = () =>
  Object.assign(new Error(`getaddrinfo ENOTFOUND ${host}`), {
    code: "ENOTFOUND",
    hostname: host,
  });

const lookupPromise = dnsPromises.lookup;
const hermeticLookupPromise = ((hostname: string, ...rest: unknown[]) =>
  hostname === host
    ? Promise.reject(notFound())
    : (lookupPromise as (...args: unknown[]) => Promise<unknown>)(
        hostname,
        ...rest,
      )) as typeof dnsPromises.lookup;
dnsPromises.lookup = hermeticLookupPromise;
dns.promises.lookup = hermeticLookupPromise;

const lookupCallback = dns.lookup;
dns.lookup = ((hostname: string, ...rest: unknown[]) => {
  if (hostname !== host) {
    return (lookupCallback as (...args: unknown[]) => void)(hostname, ...rest);
  }
  const callback = rest[rest.length - 1] as (error: Error) => void;
  process.nextTick(() => callback(notFound()));
}) as typeof dns.lookup;

// `import * as dns from "node:dns/promises"` などの ESM 名前付き export にも反映する。
syncBuiltinESMExports();
