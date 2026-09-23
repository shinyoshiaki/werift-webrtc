import {
  decoratePendingSpedResponse,
  getConnectionSpedRuntime,
  prepareConnectionSped,
} from "../../src/internal/sped-bind";
import {
  DTLS_IN_STUN_ACK,
  DTLS_IN_STUN_DATA,
} from "../../src/sped/draft00/constants";
import { classes, methods } from "../../src/stun/const";
import { Message, parseMessage } from "../../src/stun/message";
import { getRawAttributeValue } from "../../src/stun/rawAttributeValue";
import { attachTestSped, preparePrestartSpedBinding } from "./helpers";

describe("SPED pre-start capability advertisement", () => {
  it("DTLS 開始前は空 DATA のみを返し、開始後の再送で初めて inject/ACK する", async () => {
    // Arrange: DTLS runtime をまだ接続せず、SPED の opt-in だけを設定する。
    const { connection, hello, receive } = preparePrestartSpedBinding();
    prepareConnectionSped(connection);
    const injected: Buffer[] = [];
    try {
      // Act: 認証済みの実 Binding Request に、未処理の DTLS flight を載せる。
      const response = await receive();
      const authenticated = parseMessage(
        response!.bytes,
        Buffer.from(connection.localPassword),
      )!;

      // Assert: MI に保護された対応通知を返し、まだ ACK/inject しない。
      expect(authenticated.messageClass).toBe(classes.RESPONSE);
      expect(getRawAttributeValue(authenticated, DTLS_IN_STUN_DATA)).toEqual(
        Buffer.alloc(0),
      );
      expect(
        getRawAttributeValue(authenticated, DTLS_IN_STUN_ACK),
      ).toBeUndefined();
      expect(getConnectionSpedRuntime(connection)).toBeUndefined();

      // Act: runtime を接続して同じ flight の再送を受ける。
      attachTestSped(connection, {
        inject: async (bytes) => {
          injected.push(bytes);
        },
      });
      const afterStart = await receive();

      // Assert: 開始後の実受信で初めて flight を処理し、ACK を返す。
      expect(injected).toEqual([hello]);
      expect(
        getRawAttributeValue(afterStart!, DTLS_IN_STUN_ACK)?.length,
      ).toBeGreaterThan(0);
    } finally {
      await connection.close();
    }
  });

  it.each(["no-opt-in", "local-relay", "remote-relay", "turn"])(
    "%s の Binding には開始前の対応通知を付けない",
    async (mode) => {
      // Arrange: 通常 ICE または SPED 対象外の経路を用意する。
      const { connection, protocol, pair, receive } =
        preparePrestartSpedBinding();
      if (mode !== "no-opt-in") prepareConnectionSped(connection);
      if (mode === "local-relay") protocol.localCandidate.type = "relay";
      if (mode === "remote-relay") pair.remoteCandidate.type = "relay";
      if (mode === "turn") protocol.type = "turn";
      try {
        // Act: 同じ有効な認証済み Binding を対象外経路から受ける。
        const response = await receive();
        // Assert: 応答自体は維持し、SPED DATA/ACK を追加しない。
        expect(response?.messageClass).toBe(classes.RESPONSE);
        expect(
          getRawAttributeValue(response!, DTLS_IN_STUN_DATA),
        ).toBeUndefined();
        expect(
          getRawAttributeValue(response!, DTLS_IN_STUN_ACK),
        ).toBeUndefined();
      } finally {
        await connection.close();
      }
    },
  );

  it("HMAC が不正な Binding には対応通知も ICE 応答も返さない", async () => {
    // Arrange: opt-in 済みでも認証を通過していない peer を用意する。
    const { connection, receive } = preparePrestartSpedBinding();
    prepareConnectionSped(connection);
    try {
      // Act: 誤った鍵で署名した request を受信する。
      const response = await receive("wrong-password");
      // Assert: SPED の準備によって既存の ICE 認証境界を変えない。
      expect(response).toBeUndefined();
    } finally {
      await connection.close();
    }
  });

  it.each([false, true])(
    "未確定 UDP prflx では認証済み DATA の有無に合わせて通知する (DATA=%s)",
    async (withData) => {
      // Arrange: 後から relay と分かる可能性のある prflx 経路を用意する。
      const { connection, pair, receive } = preparePrestartSpedBinding();
      pair.remoteCandidate.type = "prflx";
      prepareConnectionSped(connection);
      try {
        // Act: SPED 属性がある場合とない場合の認証済み request を受ける。
        const response = await receive(undefined, withData);
        // Assert: 相手の対応通知があるときだけ、空 DATA で応答する。
        expect(getRawAttributeValue(response!, DTLS_IN_STUN_DATA)).toEqual(
          withData ? Buffer.alloc(0) : undefined,
        );
        expect(
          getRawAttributeValue(response!, DTLS_IN_STUN_ACK),
        ).toBeUndefined();
      } finally {
        await connection.close();
      }
    },
  );

  it.each(["attach", "close"])(
    "%s 後に開始前の対応通知を残さない",
    async (action) => {
      // Arrange: opt-in 通知だけを用意し、DTLS は開始していない。
      const { connection, pair } = preparePrestartSpedBinding();
      prepareConnectionSped(connection);
      const response = new Message(methods.BINDING, classes.RESPONSE);
      try {
        // Act: runtime への引き継ぎ、または ICE の終了を実行する。
        if (action === "attach") attachTestSped(connection);
        else await connection.close();
        decoratePendingSpedResponse(connection, response, pair, response);
        // Assert: 後続の状態は runtime が所有し、準備用の通知は破棄済みとなる。
        expect(
          getRawAttributeValue(response, DTLS_IN_STUN_DATA),
        ).toBeUndefined();
      } finally {
        await connection.close();
      }
    },
  );
});
