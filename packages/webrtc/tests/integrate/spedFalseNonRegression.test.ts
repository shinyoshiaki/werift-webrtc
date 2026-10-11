import { describe, expect, test } from "vitest";
import { DtlsVersion } from "../../src";
import {
  type SpedFalseFaultScenario,
  runSpedFalseFaultScenario,
} from "./warpArrange";

/**
 * sped:false (既定経路) の非回帰。SPED/early 用の cancel・revoke・attempt
 * 付け替えが既定経路に作用しないことを、障害注入と ICE restart の組み合わせで
 * 確認する。同じシナリオを `warp` でも実行し、connectionState 遷移を比較した
 * 結果は reviews/epic4-warp-verification.md に記録している。
 */
const scenarios: Omit<
  SpedFalseFaultScenario,
  "answererRole" | "protocolVersions"
>[] = [
  { restartAt: "dtls-connecting" },
  { restartAt: "cookie-wait" },
  { restartAt: "cookie-wait", drop: "INIT_ACK" },
  { restartAt: "cookie-echoed" },
  { restartAt: "cookie-echoed", drop: "COOKIE_ACK" },
  { restartAt: "none", drop: "INIT_ACK" },
  { restartAt: "none", drop: "COOKIE_ACK" },
  { restartAt: "none", failSend: "INIT" },
  { restartAt: "none", failSend: "INIT_ACK" },
  { restartAt: "none", failSend: "COOKIE_ECHO" },
  { restartAt: "cookie-wait", failSend: "INIT_ACK" },
];

const label = (
  s: Omit<SpedFalseFaultScenario, "answererRole" | "protocolVersions">,
) =>
  [
    `restart=${s.restartAt}`,
    s.drop ? `drop=${s.drop}` : undefined,
    s.failSend ? `failSend=${s.failSend}` : undefined,
  ]
    .filter(Boolean)
    .join(" ");

const versions = [
  { name: "default", protocolVersions: undefined, dtls13: false },
  { name: "1.3", protocolVersions: [DtlsVersion.V1_3], dtls13: true },
] as const;

describe.each(versions)(
  "sped:false (dtls=$name) の既定経路は障害注入と ICE restart で failed にならない",
  ({ protocolVersions, dtls13 }) => {
    describe.each(["client", "server"] as const)("answerer DTLS=%s", (role) => {
      test.each(scenarios.map((s) => [label(s), s] as const))(
        "%s",
        async (_name, scenario) => {
          // Arrange / Act: 既定設定の 2 peer で障害を 1 件注入し、指定時点で restart する
          const result = await runSpedFalseFaultScenario({
            ...scenario,
            answererRole: role,
            protocolVersions: protocolVersions && [...protocolVersions],
          });

          try {
            // Assert: 注入した障害が実際に発生している
            if (scenario.drop) expect(result.faults.dropped).toBe(true);
            if (scenario.failSend) expect(result.faults.failed).toBe(true);
            if (scenario.restartAt !== "none") {
              expect(result.restarted).toBe(true);
            }
            // Assert: 想定した DTLS version で接続している
            expect(result.dtls13).toBe(dtls13);
            // Assert: 一時的にも failed にならず、DataChannel が双方向に通る
            expect(result.states.offerer).not.toContain("failed");
            expect(result.states.answerer).not.toContain("failed");
            expect(result.delivered).toBe(true);
            expect(result.messages).toEqual(["from-answerer", "from-offerer"]);
            expect(result.states.offerer.at(-1)).toBe("connected");
            expect(result.states.answerer.at(-1)).toBe("connected");
          } finally {
            await result.close();
          }
        },
        30_000,
      );
    });
  },
);
