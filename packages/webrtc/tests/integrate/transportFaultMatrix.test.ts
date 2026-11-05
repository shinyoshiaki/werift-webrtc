import { describe, expect, test } from "vitest";
import { SCTP_STATE } from "../../../sctp/src";
import { DtlsVersion, RTCPeerConnection } from "../../src";
import { awaitMessage } from "../utils";
import {
  connectDualFamilyDataChannelPeers,
  type SctpFaultScenario,
  runSctpFaultScenario,
  selectedPairOf,
} from "./warpArrange";

/**
 * SCTP 開始中の障害注入と ICE restart で、PeerConnection が一時的にも
 * failed にならず DataChannel が通ること。sped:false の既定経路と、SPED
 * (early outbound 無効 / 有効) の両方で、SPED/early 用の cancel・revoke・
 * attempt 付け替えが認証後の通常の SCTP 開始を中断しないことを確認する。
 * `warp` との connectionState 遷移の比較は reviews/epic4-warp-verification.md。
 */
const scenarios: Omit<
  SctpFaultScenario,
  "answererRole" | "protocolVersions" | "sped"
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
  s: Omit<SctpFaultScenario, "answererRole" | "protocolVersions" | "sped">,
) =>
  [
    `restart=${s.restartAt}`,
    s.drop ? `drop=${s.drop}` : undefined,
    s.failSend ? `failSend=${s.failSend}` : undefined,
  ]
    .filter(Boolean)
    .join(" ");

const transports = [
  { name: "sped:false dtls=default", dtls13: false },
  {
    name: "sped:false dtls=1.3",
    protocolVersions: [DtlsVersion.V1_3],
    dtls13: true,
  },
  { name: "SPED early=off", sped: { early: false }, dtls13: true },
  { name: "SPED early=on", sped: { early: true }, dtls13: true },
] as const;

describe.each(transports)(
  "$name は SCTP 障害注入と ICE restart で failed にならない",
  ({ dtls13, ...transport }) => {
    describe.each(["client", "server"] as const)("answerer DTLS=%s", (role) => {
      test.concurrent.each(scenarios.map((s) => [label(s), s] as const))(
        "%s",
        async (_name, scenario) => {
          // Arrange / Act: 2 peer で障害を 1 件注入し、指定時点で restart する
          const result = await runSctpFaultScenario({
            ...scenario,
            answererRole: role,
            protocolVersions:
              "protocolVersions" in transport
                ? [...transport.protocolVersions]
                : undefined,
            sped: "sped" in transport ? transport.sped : undefined,
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

describe.each([
  { name: "sped:false", config: () => ({ iceServers: [] }) },
  {
    name: "SPED",
    config: () => ({
      iceServers: [],
      sped: true,
      dtls: { protocolVersions: [DtlsVersion.V1_3] },
    }),
  },
])("$name: 認証後の ICE restart", ({ config }) => {
  test("新しい selected pair (別の 5-tuple) へ移り、同じ SCTP association を維持する", async () => {
    // Arrange: 127.0.0.1 / ::1 の 2 socket を持つ接続済み 2 peer と DataChannel
    const { offerer, answerer, dc1, dc2, restartOntoOtherFamily } =
      await connectDualFamilyDataChannelPeers(config());
    const states: string[] = [];
    for (const pc of [offerer, answerer]) {
      pc.connectionStateChange.subscribe((s) => states.push(s));
    }
    try {
      const before = [offerer, answerer].map(selectedPairOf);
      const associations = [offerer, answerer].map((pc) => pc.sctp!.sctp);

      // Act: offerer が ICE restart して再交渉する (旧経路の family の候補は渡さない)
      await restartOntoOtherFamily();
      const after = [offerer, answerer].map(selectedPairOf);
      dc1.send("after-restart-1");
      const toAnswerer = await awaitMessage(dc2);
      dc2.send("after-restart-2");
      const toOfferer = await awaitMessage(dc1);

      // Assert: 両側とも新しい generation の、旧経路とは別の 5-tuple の pair を選択している
      const tuple = ({ pair }: ReturnType<typeof selectedPairOf>) =>
        `${pair!.localCandidate.host}:${pair!.localCandidate.port}->${pair!.remoteAddr.join(":")}`;
      after.forEach((selected, i) => {
        expect(selected.generation).toBe(before[i].generation + 1);
        expect(selected.pair).not.toBe(before[i].pair);
        expect(tuple(selected)).not.toBe(tuple(before[i]));
      });
      // Assert: SCTP association は作り直されず ESTABLISHED のまま通信できる
      [offerer, answerer].forEach((pc, i) => {
        expect(pc.sctp!.sctp).toBe(associations[i]);
        expect(pc.sctp!.sctp.associationState).toBe(SCTP_STATE.ESTABLISHED);
      });
      expect(toAnswerer).toBe("after-restart-1");
      expect(toOfferer).toBe("after-restart-2");
      // Assert: restart 中も failed にならない
      expect(states).not.toContain("failed");
    } finally {
      await Promise.allSettled([offerer.close(), answerer.close()]);
    }
  }, 30_000);
});
