import { DtlsVersion } from "../../src";
import { prepareIceCloseCounting } from "./warpArrange";

describe.each([
  { name: "DTLS 1.3", version: DtlsVersion.V1_3 },
  { name: "DTLS 1.2", version: DtlsVersion.V1_2 },
])(
  "$name (非 SPED): close で ICE Connection を 1 回だけ閉じる",
  ({ version }) => {
    test("ローカルで close すると Connection.close() と closed 通知は各 1 回", async () => {
      // Arrange: 接続済みの 2 peer と Connection.close() / closed 通知の計数
      const { offerer, answerer, counters, settle } =
        await prepareIceCloseCounting(version);
      try {
        // Act: offerer をローカルで close し、非同期の teardown を待つ
        await offerer.close();
        await settle();

        // Assert: offerer の Connection は 1 回だけ閉じられ、closed も 1 回だけ届く
        expect(counters[0].close).toHaveBeenCalledTimes(1);
        expect(counters[0].closedNotifications.count).toBe(1);
      } finally {
        await Promise.allSettled([offerer.close(), answerer.close()]);
      }
    }, 30_000);

    test("相手が close した後にローカルで close しても Connection.close() と closed 通知は各 1 回", async () => {
      // Arrange: 接続済みの 2 peer と Connection.close() / closed 通知の計数
      const { offerer, answerer, counters, settle } =
        await prepareIceCloseCounting(version);
      try {
        // Act: answerer が先に close し、その通知を受けてから offerer も close する
        await answerer.close();
        await settle();
        await offerer.close();
        await settle();

        // Assert: offerer の Connection は 1 回だけ閉じられ、closed も 1 回だけ届く
        expect(counters[0].close).toHaveBeenCalledTimes(1);
        expect(counters[0].closedNotifications.count).toBe(1);
      } finally {
        await Promise.allSettled([offerer.close(), answerer.close()]);
      }
    }, 30_000);
  },
);
