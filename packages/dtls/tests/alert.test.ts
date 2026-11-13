import { X509Certificate } from "node:crypto";
import { setTimeout } from "timers/promises";
import { AlertDesc, AlertLevel, ContentType, DtlsAlertError } from "../src";
import {
  HashAlgorithm,
  NamedCurveAlgorithm,
  SignatureAlgorithm,
} from "../src/cipher/const";
import { CipherContext } from "../src/context/cipher";
import { Alert } from "../src/handshake/message/alert";
import { Certificate } from "../src/handshake/message/certificate";
import { DtlsRandom } from "../src/handshake/random";
import { createPlaintext } from "../src/record/builder";
import { certPem } from "./fixture";
import {
  connectDtlsPair,
  createClientHelloHandshake,
  createDtlsPair,
  createEpoch0HandshakeRecord,
  createMultiAlertRecord,
  sentRecords,
} from "./utils";

const alertRecords = (datagrams: Buffer[]) =>
  sentRecords(datagrams).filter((r) => r.contentType === ContentType.alert);

describe("DTLS alert", () => {
  test("close({ notify: true }) は epoch 1 で暗号化した close_notify を送り、相手の onClose が 1 回だけ発火する", async () => {
    // Arrange
    const pair = createDtlsPair();
    await connectDtlsPair(pair);
    const onClose = vi.fn();
    const onError = vi.fn();
    const onAlert = vi.fn();
    pair.server.onClose.subscribe(onClose);
    pair.server.onError.subscribe(onError);
    pair.server.onAlert.subscribe(onAlert);

    // Act: client が close_notify を送ってから閉じ、さらに重複して close する
    await pair.client.close({ notify: true });
    await pair.client.close({ notify: true });
    await setTimeout(20);

    // Assert: 暗号化された alert record が 1 つだけ送られ、transport は閉じている
    const records = alertRecords(pair.clientTransport.sent);
    expect(records).toHaveLength(1);
    expect(records[0].epoch).toBe(1);
    expect(records[0].fragment.length).toBeGreaterThan(2);
    expect(pair.clientTransport.closed).toBe(true);
    expect(pair.clientTransport.closeCount).toBe(1);
    // Assert: server は close_notify を受け取り onClose だけが 1 回発火する
    expect(onAlert).toHaveBeenCalledWith({
      level: AlertLevel.warning,
      description: AlertDesc.CloseNotify,
    });
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(onError).not.toHaveBeenCalled();
    // Assert: server は close_notify を 1 回だけ返し、その後は application data を送らない
    expect(alertRecords(pair.serverTransport.sent)).toHaveLength(1);
    const sentBefore = pair.serverTransport.sent.length;
    await pair.server.send(Buffer.from("after close"));
    expect(pair.serverTransport.sent.length).toBe(sentBefore);
  });

  test.each([
    ["fatal alert", AlertLevel.fatal, AlertDesc.InternalError],
    ["close_notify", AlertLevel.warning, AlertDesc.CloseNotify],
  ] as const)(
    "handshake 中に %s を送ると、再送期限を過ぎても handshake record を送らない",
    async (_, level, description) => {
      // Arrange: server は応答しないので client の ClientHello は再送され続ける
      const pair = createDtlsPair();
      pair.clientTransport.peer = undefined;
      void pair.client.connect().catch(() => undefined);
      await setTimeout(50);
      const handshakesBefore = sentRecords(pair.clientTransport.sent).filter(
        (r) => r.contentType === ContentType.handshake,
      ).length;

      try {
        // Act: handshake 中に終端 alert を送り、最初の再送期限（500ms）と次の期限（1500ms）を過ぎるまで待つ
        await pair.client.sendAlert(level, description);
        const sentAfterAlert = pair.clientTransport.sent.length;
        await setTimeout(1700);

        // Assert: alert の前に ClientHello は送られていた
        expect(handshakesBefore).toBeGreaterThan(0);
        // Assert: alert の後は record が 1 つも送られない（再送も止まっている）
        expect(pair.clientTransport.sent.length).toBe(sentAfterAlert);
        // Assert: 最後に送った record は alert
        const records = sentRecords(pair.clientTransport.sent);
        expect(records.at(-1)?.contentType).toBe(ContentType.alert);
      } finally {
        await pair.client.close();
        await pair.server.close();
      }
    },
  );

  test("close() は従来どおり alert を送らずにすぐ閉じる", async () => {
    // Arrange
    const pair = createDtlsPair();
    await connectDtlsPair(pair);

    // Act: 引数なしで close する
    await pair.client.close();

    // Assert: alert は送られず transport は閉じている
    expect(alertRecords(pair.clientTransport.sent)).toHaveLength(0);
    expect(pair.clientTransport.closed).toBe(true);
  });

  test("確立後に受けた fatal alert は onError に DtlsAlertError として渡り、transport が閉じる", async () => {
    // Arrange
    const pair = createDtlsPair();
    await connectDtlsPair(pair);
    const errors: Error[] = [];
    const onClose = vi.fn();
    const onData = vi.fn();
    pair.client.onError.subscribe((e) => errors.push(e));
    pair.client.onClose.subscribe(onClose);
    pair.client.onData.subscribe(onData);

    // Act: server が fatal alert を送る（その後の application data は送られない）
    await pair.server.sendAlert(AlertLevel.fatal, AlertDesc.InternalError);
    await pair.server.send(Buffer.from("after fatal"));
    await setTimeout(20);

    // Assert: client は受信 alert の詳細付きでエラーを受け取る
    expect(errors).toHaveLength(1);
    const error = errors[0] as DtlsAlertError;
    expect(error).toBeInstanceOf(DtlsAlertError);
    expect(error.source).toBe("remote");
    expect(error.level).toBe(AlertLevel.fatal);
    expect(error.description).toBe(AlertDesc.InternalError);
    expect(error.alertDescName).toBe("InternalError");
    // Assert: close 扱いにはならず、client の transport が閉じ、データも届かない
    expect(onClose).not.toHaveBeenCalled();
    expect(onData).not.toHaveBeenCalled();
    expect(pair.clientTransport.closed).toBe(true);
    // Assert: fatal alert には応答しない
    expect(alertRecords(pair.clientTransport.sent)).toHaveLength(0);
  });

  test("epoch > 0 の alert は先頭バイトに関係なく復号し、復号できない record は破棄する", async () => {
    // Arrange: 平文として読むと close_notify になる、epoch 1 の偽 record
    const pair = createDtlsPair();
    await connectDtlsPair(pair);
    const onError = vi.fn();
    const onClose = vi.fn();
    const received: string[] = [];
    pair.client.onError.subscribe(onError);
    pair.client.onClose.subscribe(onClose);
    pair.client.onData.subscribe((data) => received.push(data.toString()));
    const [forged] = createPlaintext({
      ...pair.server.dtls,
      epoch: 1,
    } as typeof pair.server.dtls)(
      [
        {
          type: ContentType.alert,
          fragment: Buffer.concat([
            new Alert(AlertLevel.warning, AlertDesc.CloseNotify).serialize(),
            Buffer.alloc(30),
          ]),
        },
      ],
      1000,
    );

    // Act: 偽 record を受信させ、その後に application data を受信させる
    pair.client.transport.socket.onData(forged.serialize(), {} as any);
    await pair.server.send(Buffer.from("still open"));
    await setTimeout(20);

    // Assert: 偽 record は復号に失敗して破棄され、接続は続いている
    expect(onClose).not.toHaveBeenCalled();
    expect(onError).not.toHaveBeenCalled();
    expect(received).toEqual(["still open"]);

    // Act: 正規の（暗号化された）close_notify を受信させる
    await pair.server.sendAlert(AlertLevel.warning, AlertDesc.CloseNotify);
    await setTimeout(20);

    // Assert: 正規の close_notify は復号されて onClose が 1 回発火する
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  test("確立後に届いた epoch 0 の平文 close_notify / fatal alert は破棄し、接続を終了しない", async () => {
    // Arrange: 確立済みの pair と、鍵なしで作れる epoch 0 の平文 alert
    const pair = createDtlsPair();
    await connectDtlsPair(pair);
    const onError = vi.fn();
    const onClose = vi.fn();
    const received: string[] = [];
    pair.client.onError.subscribe(onError);
    pair.client.onClose.subscribe(onClose);
    pair.client.onData.subscribe((data) => received.push(data.toString()));
    const plainAlert = (description: number, level: number) =>
      createPlaintext({
        ...pair.server.dtls,
        epoch: 0,
      } as typeof pair.server.dtls)(
        [
          {
            type: ContentType.alert,
            fragment: new Alert(level, description).serialize(),
          },
        ],
        5000,
      )[0].serialize();

    // Act: 平文の close_notify と fatal alert を注入し、その後に正規データを送る
    pair.client.transport.socket.onData(
      plainAlert(AlertDesc.CloseNotify, AlertLevel.warning),
      {} as any,
    );
    pair.client.transport.socket.onData(
      plainAlert(AlertDesc.InternalError, AlertLevel.fatal),
      {} as any,
    );
    await pair.server.send(Buffer.from("still open"));
    await setTimeout(20);

    // Assert: 注入された alert は無視され、接続は続いている
    expect(onClose).not.toHaveBeenCalled();
    expect(onError).not.toHaveBeenCalled();
    expect(pair.clientTransport.closed).toBe(false);
    expect(received).toEqual(["still open"]);
  });

  test("handshake 中の fatal alert は平文で送られ、相手の onError に受信 alert が渡る（client 側の証明書検証失敗）", async () => {
    // Arrange: client が server 証明書を拒否する
    const pair = createDtlsPair({
      client: { verifyRemoteCertificate: () => false },
    });
    const clientErrors: Error[] = [];
    const serverErrors: Error[] = [];
    const onConnect = vi.fn();
    pair.client.onError.subscribe((e) => clientErrors.push(e));
    pair.server.onError.subscribe((e) => serverErrors.push(e));
    pair.client.onConnect.subscribe(onConnect);
    pair.server.onConnect.subscribe(onConnect);

    // Act: handshake を始める
    await pair.client.connect();
    await setTimeout(100);

    // Assert: client は flight5 を送らず、平文の bad_certificate を 1 回だけ送る
    const records = sentRecords(pair.clientTransport.sent);
    expect(
      records.some((r) => r.contentType === ContentType.changeCipherSpec),
    ).toBe(false);
    const alerts = records.filter((r) => r.contentType === ContentType.alert);
    expect(alerts).toHaveLength(1);
    expect(alerts[0].epoch).toBe(0);
    expect(Alert.deSerialize(alerts[0].fragment)).toEqual(
      new Alert(AlertLevel.fatal, AlertDesc.BadCertificate),
    );
    // Assert: client はローカル、server はリモートの DtlsAlertError を受け取り、どちらも接続しない
    expect(clientErrors).toHaveLength(1);
    expect((clientErrors[0] as DtlsAlertError).source).toBe("local");
    expect(serverErrors).toHaveLength(1);
    expect((serverErrors[0] as DtlsAlertError).source).toBe("remote");
    expect((serverErrors[0] as DtlsAlertError).description).toBe(
      AlertDesc.BadCertificate,
    );
    expect(onConnect).not.toHaveBeenCalled();
    expect(pair.clientTransport.closed).toBe(true);
    expect(pair.serverTransport.closed).toBe(true);
  });

  test("server 側の証明書検証が throw すると Finished を送らずに bad_certificate を送り、client は接続しない", async () => {
    // Arrange: server が client 証明書を要求し、検証で throw する
    const reason = new Error("fingerprint mismatch");
    const pair = createDtlsPair({
      server: {
        certificateRequest: true,
        verifyRemoteCertificate: () => {
          throw reason;
        },
      },
    });
    const clientErrors: Error[] = [];
    const serverErrors: Error[] = [];
    const onConnect = vi.fn();
    pair.client.onError.subscribe((e) => clientErrors.push(e));
    pair.server.onError.subscribe((e) => serverErrors.push(e));
    pair.client.onConnect.subscribe(onConnect);
    pair.server.onConnect.subscribe(onConnect);

    // Act: handshake を始める
    await pair.client.connect();
    await setTimeout(100);

    // Assert: server は ChangeCipherSpec / Finished を送らず、平文の bad_certificate を送る
    const records = sentRecords(pair.serverTransport.sent);
    expect(
      records.some((r) => r.contentType === ContentType.changeCipherSpec),
    ).toBe(false);
    const alerts = records.filter((r) => r.contentType === ContentType.alert);
    expect(alerts).toHaveLength(1);
    expect(alerts[0].epoch).toBe(0);
    // Assert: server のエラーは検証の例外を reason に持ち、client は受信 alert を受け取る
    expect(serverErrors).toHaveLength(1);
    expect((serverErrors[0] as DtlsAlertError).source).toBe("local");
    expect((serverErrors[0] as DtlsAlertError).reason).toBe(reason);
    expect(clientErrors).toHaveLength(1);
    expect((clientErrors[0] as DtlsAlertError).source).toBe("remote");
    expect((clientErrors[0] as DtlsAlertError).description).toBe(
      AlertDesc.BadCertificate,
    );
    expect(onConnect).not.toHaveBeenCalled();
  });

  test("検証が true を返せば通常どおり接続する", async () => {
    // Arrange
    const verified: Buffer[] = [];
    const pair = createDtlsPair({
      client: {
        verifyRemoteCertificate: (cert) => {
          verified.push(cert);
          return true;
        },
      },
      server: {
        certificateRequest: true,
        verifyRemoteCertificate: (cert) => {
          verified.push(cert);
          return true;
        },
      },
    });

    // Act: 接続する
    await connectDtlsPair(pair);

    // Assert: 両側で 1 回ずつ証明書が検証される
    expect(verified).toHaveLength(2);
  });

  test("送信が終わらない・失敗する・close 後でも有限時間で close し reject しない", async () => {
    // Arrange
    const pair = createDtlsPair();
    await connectDtlsPair(pair);
    pair.clientTransport.sendBehavior = "hang";
    pair.serverTransport.sendBehavior = "reject";

    // Act: 送信が返らない側は timeout、失敗する側は即座に close まで進む
    const started = Date.now();
    await pair.client.close({ notify: true, timeoutMs: 50 });
    await pair.server.close({ notify: true });
    // close 後の送信は何もしない
    const sentAfterClose = pair.serverTransport.sent.length;
    await pair.server.sendAlert(AlertLevel.fatal, AlertDesc.InternalError);

    // Assert: どちらも閉じ、待ち時間は上限内で、close 後には何も送らない
    expect(Date.now() - started).toBeLessThan(1000);
    expect(pair.clientTransport.closed).toBe(true);
    expect(pair.serverTransport.closed).toBe(true);
    expect(pair.serverTransport.sent.length).toBe(sentAfterClose);
  });
});

describe("DTLS 同時 close", () => {
  test("公開 sendAlert() で fatal alert を送ると、送信側も onError（local）で終了し、送信完了後に transport を閉じる", async () => {
    // Arrange: 送信完了を制御できる transport
    const pair = createDtlsPair();
    await connectDtlsPair(pair);
    const errors: Error[] = [];
    pair.server.onError.subscribe((e) => errors.push(e));
    let release!: () => void;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    const realSend = pair.serverTransport.send.bind(pair.serverTransport);
    pair.serverTransport.send = async (data: Buffer) => {
      await gate;
      return realSend(data);
    };

    // Act: fatal alert を送り、送信完了前の状態を観測してから送信を完了させる
    const sending = pair.server.sendAlert(
      AlertLevel.fatal,
      AlertDesc.InternalError,
    );
    const errorsBeforeSent = errors.length;
    await setTimeout(30);
    const closedBeforeSent = pair.serverTransport.closed;
    release();
    await sending;
    // 重複送信しても何も起きない
    await pair.server.sendAlert(AlertLevel.fatal, AlertDesc.InternalError);

    // Assert: onError は同期で 1 回だけ、送信した alert の local エラーとして発火する
    expect(errorsBeforeSent).toBe(1);
    expect(errors).toHaveLength(1);
    const error = errors[0] as DtlsAlertError;
    expect(error).toBeInstanceOf(DtlsAlertError);
    expect(error.source).toBe("local");
    expect(error.description).toBe(AlertDesc.InternalError);
    // Assert: transport は送信完了前には閉じず、送信完了で sendAlert が resolve した時点で閉じている
    expect(closedBeforeSent).toBe(false);
    expect(pair.serverTransport.closed).toBe(true);
    expect(pair.serverTransport.closeCount).toBe(1);
    // Assert: alert は 1 回だけ送られ、終了後の application data は送られない
    expect(alertRecords(pair.serverTransport.sent)).toHaveLength(1);
    expect(pair.server.terminated).toBe(true);
  });

  test("close({ notify: true }) が重なっても、先の close_notify の送信完了まで transport を閉じない", async () => {
    // Arrange: 送信完了を制御できる transport
    const pair = createDtlsPair();
    await connectDtlsPair(pair);
    let release!: () => void;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    const realSend = pair.clientTransport.send.bind(pair.clientTransport);
    pair.clientTransport.send = async (data: Buffer) => {
      await gate;
      return realSend(data);
    };

    // Act: close を 2 回重ねて呼び、送信完了前の状態を観測する
    const first = pair.client.close({ notify: true });
    const second = pair.client.close({ notify: true });
    await setTimeout(30);
    const closedBeforeSent = pair.clientTransport.closed;
    release();
    await Promise.all([first, second]);

    // Assert: 送信完了前は閉じず、完了後に閉じて alert は 1 回だけ送られる
    expect(closedBeforeSent).toBe(false);
    expect(pair.clientTransport.closed).toBe(true);
    expect(alertRecords(pair.clientTransport.sent)).toHaveLength(1);
  });
});

describe("DTLS close_notify への返信", () => {
  test("受信した close_notify への返信が送信中の間、alertFlushed() は決着しない", async () => {
    // Arrange: server の送信完了を制御する
    const pair = createDtlsPair();
    await connectDtlsPair(pair);
    let release!: () => void;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    const realSend = pair.serverTransport.send.bind(pair.serverTransport);
    pair.serverTransport.send = async (data: Buffer) => {
      await gate;
      return realSend(data);
    };
    let closedAt: boolean | undefined;
    pair.server.onClose.subscribe(() => {
      closedAt = true;
    });

    // Act: client が close_notify を送り、server が返信を送信中の状態を観測する
    void pair.client.close({ notify: true });
    await setTimeout(30);
    let flushed = false;
    const flushing = pair.server.alertFlushed().then(() => {
      flushed = true;
    });
    await setTimeout(30);
    const flushedBeforeSent = flushed;
    release();
    await flushing;

    // Assert: onClose は発火済みでも返信送信完了までは flush されず、完了後に決着する
    expect(closedAt).toBe(true);
    expect(flushedBeforeSent).toBe(false);
    expect(flushed).toBe(true);
  });
});

describe("DTLS alert のリスナー例外", () => {
  test("onAlert が例外を投げても、受信した close_notify で返信・onClose が行われる", async () => {
    // Arrange: server の onAlert は例外を投げる
    const pair = createDtlsPair();
    await connectDtlsPair(pair);
    const onClose = vi.fn();
    pair.server.onAlert.subscribe(() => {
      throw new Error("listener failed");
    });
    pair.server.onClose.subscribe(onClose);

    // Act: client が close_notify を送る
    await pair.client.sendAlert(AlertLevel.warning, AlertDesc.CloseNotify);
    await setTimeout(20);

    // Assert: server は終了し、close_notify を返して onClose が 1 回発火する
    expect(pair.server.terminated).toBe(true);
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(alertRecords(pair.serverTransport.sent)).toHaveLength(1);
  });

  test("onAlert / onError が例外を投げても、受信した fatal alert で onError が発火し transport が閉じる", async () => {
    // Arrange: client の onAlert と最初の onError リスナーは例外を投げる
    const pair = createDtlsPair();
    await connectDtlsPair(pair);
    const errors: Error[] = [];
    pair.client.onAlert.subscribe(() => {
      throw new Error("listener failed");
    });
    pair.client.onError.subscribe((e) => {
      errors.push(e);
      throw new Error("listener failed");
    });

    // Act: server が fatal alert を送る
    await pair.server.sendAlert(AlertLevel.fatal, AlertDesc.InternalError);
    await setTimeout(20);

    // Assert: client は終了し、受信 alert の onError が 1 回発火して transport が閉じる
    expect(pair.client.terminated).toBe(true);
    expect(errors).toHaveLength(1);
    expect((errors[0] as DtlsAlertError).source).toBe("remote");
    expect(pair.clientTransport.closed).toBe(true);
  });

  test("onError が例外を投げても、公開 sendAlert() の fatal alert は reject せず送信後に transport を閉じる", async () => {
    // Arrange: server の onError は例外を投げる
    const pair = createDtlsPair();
    await connectDtlsPair(pair);
    pair.server.onError.subscribe(() => {
      throw new Error("listener failed");
    });

    // Act: server が fatal alert を送る
    const result = await pair.server
      .sendAlert(AlertLevel.fatal, AlertDesc.InternalError)
      .then(
        () => "resolved",
        () => "rejected",
      );

    // Assert: reject せず、alert を 1 回送って transport が閉じる
    expect(result).toBe("resolved");
    expect(alertRecords(pair.serverTransport.sent)).toHaveLength(1);
    expect(pair.serverTransport.closed).toBe(true);
  });
});

describe("DTLS イベントの購読者ごとの例外隔離", () => {
  test("先に登録した onClose / onError のリスナーが例外を投げても、後のリスナーが呼ばれる", async () => {
    // Arrange: server の onClose、client の onError で 1 番目のリスナーが例外を投げる
    const closePair = createDtlsPair();
    await connectDtlsPair(closePair);
    const laterClose = vi.fn();
    closePair.server.onClose.subscribe(() => {
      throw new Error("listener failed");
    });
    closePair.server.onClose.subscribe(laterClose);
    const errorPair = createDtlsPair();
    await connectDtlsPair(errorPair);
    const laterError = vi.fn();
    errorPair.client.onError.subscribe(() => {
      throw new Error("listener failed");
    });
    errorPair.client.onError.subscribe(laterError);

    // Act: close_notify と fatal alert をそれぞれ送る
    await closePair.client.sendAlert(AlertLevel.warning, AlertDesc.CloseNotify);
    await errorPair.server.sendAlert(AlertLevel.fatal, AlertDesc.InternalError);
    await setTimeout(20);

    // Assert: 後から登録したリスナーも 1 回ずつ呼ばれる
    expect(laterClose).toHaveBeenCalledTimes(1);
    expect(laterError).toHaveBeenCalledTimes(1);
  });
});

describe("1 つの record に入った複数の alert", () => {
  const userCanceled = {
    level: AlertLevel.warning,
    description: AlertDesc.UserCanceled,
  };
  const closeNotify = {
    level: AlertLevel.warning,
    description: AlertDesc.CloseNotify,
  };
  const fatal = {
    level: AlertLevel.fatal,
    description: AlertDesc.InternalError,
  };
  const protections = [
    ["平文（handshake 前・epoch 0）", false],
    ["暗号化（確立後・epoch 1）", true],
  ] as const;
  const cases = [
    ["warning の後の close_notify", [userCanceled, closeNotify], "close"],
    ["warning の後の fatal alert", [userCanceled, fatal], "fatal"],
    ["close_notify の後の fatal alert", [closeNotify, fatal], "close"],
    ["fatal alert の後の close_notify", [fatal, closeNotify], "fatal"],
  ] as const;

  describe.each(protections)("%s", (_, established) => {
    test.each(cases)(
      "%s は先頭から順に処理し、最初の終端 alert で処理を止める",
      async (_, alerts, outcome) => {
        // Arrange: 複数の alert を 1 つの record に詰めて client に届ける
        const pair = createDtlsPair();
        if (established) await connectDtlsPair(pair);
        const received: number[] = [];
        const onClose = vi.fn();
        const errors: Error[] = [];
        pair.client.onAlert.subscribe((a) => received.push(a.description));
        pair.client.onClose.subscribe(onClose);
        pair.client.onError.subscribe((e) => errors.push(e));
        const record = createMultiAlertRecord(pair.server, [...alerts]);
        const sentBefore = alertRecords(pair.clientTransport.sent).length;

        try {
          // Act: record を受信させる
          pair.client.transport.socket.onData(record, {} as any);
          await setTimeout(20);

          // Assert: 最初の終端 alert までが順に onAlert へ渡り、それ以降は処理されない
          const terminal = alerts.findIndex(
            (a) => a.description === AlertDesc.CloseNotify || a.level === 2,
          );
          expect(received).toEqual(
            alerts.slice(0, terminal + 1).map((a) => a.description),
          );
          expect(pair.client.terminated).toBe(true);
          if (outcome === "close") {
            // Assert: close_notify で閉じ、close_notify を 1 回だけ返し、onError は発火しない
            expect(onClose).toHaveBeenCalledTimes(1);
            expect(errors).toHaveLength(0);
            expect(alertRecords(pair.clientTransport.sent)).toHaveLength(
              sentBefore + 1,
            );
          } else {
            // Assert: fatal alert で onError（remote）が 1 回だけ発火し、応答せず transport を閉じる
            expect(onClose).not.toHaveBeenCalled();
            expect(errors).toHaveLength(1);
            expect((errors[0] as DtlsAlertError).source).toBe("remote");
            expect((errors[0] as DtlsAlertError).description).toBe(
              AlertDesc.InternalError,
            );
            expect(alertRecords(pair.clientTransport.sent)).toHaveLength(
              sentBefore,
            );
            expect(pair.clientTransport.closed).toBe(true);
          }
        } finally {
          await pair.client.close();
          await pair.server.close();
        }
      },
    );
  });
});

describe("datagram の末尾が壊れている場合", () => {
  test.each([
    ["13 byte に満たない末尾", Buffer.alloc(5)],
    [
      "fragment 長より 1 byte 短い record",
      Buffer.concat([
        Buffer.from([ContentType.alert, 0xfe, 0xfd, 0, 1, 0, 0, 0, 0, 0, 9]),
        Buffer.from([0x00, 0x04, 1, 2, 3]),
      ]),
    ],
  ])(
    "%s があっても受信処理は例外を投げず、前にある正規の close_notify を処理する",
    async (_, broken) => {
      // Arrange: 確立済みの pair と、正規の暗号化 close_notify の後に壊れた末尾を付けた datagram
      const pair = createDtlsPair();
      await connectDtlsPair(pair);
      const onClose = vi.fn();
      pair.client.onClose.subscribe(onClose);
      const datagram = Buffer.concat([
        createMultiAlertRecord(pair.server, [
          { level: AlertLevel.warning, description: AlertDesc.CloseNotify },
        ]),
        broken,
      ]);

      try {
        // Act: 壊れた末尾だけの datagram と、正規 record 付きの datagram を受信させる
        const receiveBrokenOnly = () =>
          pair.client.transport.socket.onData(broken, {} as any);
        const receiveDatagram = () =>
          pair.client.transport.socket.onData(datagram, {} as any);

        // Assert: どちらも例外を投げない
        expect(receiveBrokenOnly).not.toThrow();
        expect(pair.client.terminated).toBe(false);
        expect(receiveDatagram).not.toThrow();
        await setTimeout(20);

        // Assert: 壊れた末尾の前にある close_notify は処理され、onClose が 1 回発火する
        expect(onClose).toHaveBeenCalledTimes(1);
      } finally {
        await pair.client.close();
        await pair.server.close();
      }
    },
  );
});

describe("送信中の alert と close()", () => {
  test("公開 sendAlert() の fatal alert の直後に close() を呼んでも、送信完了まで transport を閉じず相手に届く", async () => {
    // Arrange: client の送信完了を制御する
    const pair = createDtlsPair();
    await connectDtlsPair(pair);
    const serverErrors: Error[] = [];
    pair.server.onError.subscribe((e) => serverErrors.push(e));
    let release!: () => void;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    const realSend = pair.clientTransport.send.bind(pair.clientTransport);
    pair.clientTransport.send = async (data: Buffer) => {
      await gate;
      return realSend(data);
    };

    // Act: fatal alert を送り、完了を待たずに close() する
    void pair.client.sendAlert(AlertLevel.fatal, AlertDesc.InternalError);
    const closing = pair.client.close();
    await setTimeout(30);
    const closedBeforeSent = pair.clientTransport.closed;
    release();
    await closing;
    await setTimeout(20);

    // Assert: 送信完了前は閉じず、alert は相手に届いて onError（remote）が発火する
    expect(closedBeforeSent).toBe(false);
    expect(pair.clientTransport.closed).toBe(true);
    expect(serverErrors).toHaveLength(1);
    expect((serverErrors[0] as DtlsAlertError).source).toBe("remote");
  });

  test("onClose の中で close() を呼んでも、受信した close_notify への返信は相手に届く", async () => {
    // Arrange: server の送信は UDP のように後の tick で完了し、server は onClose で close() する
    const pair = createDtlsPair();
    await connectDtlsPair(pair);
    const realSend = pair.serverTransport.send.bind(pair.serverTransport);
    pair.serverTransport.send = async (data: Buffer) => {
      await setTimeout(5);
      return realSend(data);
    };
    pair.server.onClose.subscribe(() => {
      void pair.server.close();
    });
    const clientAlerts: number[] = [];
    pair.client.onAlert.subscribe((a) => clientAlerts.push(a.description));

    // Act: client が close_notify だけを送る（返信を受け取れるよう transport は閉じない）
    await pair.client.sendAlert(AlertLevel.warning, AlertDesc.CloseNotify);
    await setTimeout(30);

    // Assert: server は返信の close_notify を送ってから閉じ、client に届く
    expect(alertRecords(pair.serverTransport.sent)).toHaveLength(1);
    expect(pair.serverTransport.closed).toBe(true);
    expect(clientAlerts).toEqual([AlertDesc.CloseNotify]);
  });
});

describe("close_notify を送った後の handshake", () => {
  test("handshake record が再び届いても、server は record を送らず onConnect も再び発火しない", async () => {
    // Arrange: 確立後、client の flight 5 を記録しておき、server は close_notify を送る（相手には届けない）
    const pair = createDtlsPair();
    const flight5 = (() => {
      const before = pair.clientTransport.sent.length;
      return () => pair.clientTransport.sent.slice(before);
    })();
    await connectDtlsPair(pair);
    const clientHandshakeDatagrams = flight5().filter((d) =>
      sentRecords([d]).some((r) => r.contentType === ContentType.handshake),
    );
    const onConnect = vi.fn();
    pair.server.onConnect.subscribe(onConnect);
    pair.serverTransport.peer = undefined;
    await pair.server.sendAlert(AlertLevel.warning, AlertDesc.CloseNotify);
    const sentAfterAlert = pair.serverTransport.sent.length;

    try {
      // Act: client の handshake datagram を再び server に届ける
      for (const datagram of clientHandshakeDatagrams) {
        pair.server.transport.socket.onData(datagram, {} as any);
      }
      await setTimeout(1200);

      // Assert: 再送の対象になる handshake は残っていた
      expect(clientHandshakeDatagrams.length).toBeGreaterThan(0);
      // Assert: close_notify の後は record を 1 つも送らず、onConnect も発火しない
      expect(pair.serverTransport.sent.length).toBe(sentAfterAlert);
      expect(onConnect).not.toHaveBeenCalled();
    } finally {
      await pair.client.close();
      await pair.server.close();
    }
  });
});

describe("未知の level の alert", () => {
  test.each([0, 3])(
    "level %i の alert は warning として無視せず fatal として扱い、transport を閉じる",
    async (level) => {
      // Arrange: 確立済みの pair
      const pair = createDtlsPair();
      await connectDtlsPair(pair);
      const errors: Error[] = [];
      pair.client.onError.subscribe((e) => errors.push(e));
      const record = createMultiAlertRecord(pair.server, [
        { level, description: AlertDesc.HandshakeFailure },
      ]);

      try {
        // Act: 未知の level の alert を受信させる
        pair.client.transport.socket.onData(record, {} as any);
        await setTimeout(20);

        // Assert: onError（remote）が 1 回発火し、受信した level と description が渡り、応答せずに閉じる
        expect(errors).toHaveLength(1);
        const error = errors[0] as DtlsAlertError;
        expect(error.source).toBe("remote");
        expect(error.level).toBe(level);
        expect(error.description).toBe(AlertDesc.HandshakeFailure);
        expect(error.message).toContain(`level ${level}`);
        expect(alertRecords(pair.clientTransport.sent)).toHaveLength(0);
        expect(pair.clientTransport.closed).toBe(true);
      } finally {
        await pair.client.close();
        await pair.server.close();
      }
    },
  );
});

describe("Finished と alert が同じ datagram に入っている場合", () => {
  test.each([
    ["close_notify", AlertLevel.warning, AlertDesc.CloseNotify],
    ["fatal alert", AlertLevel.fatal, AlertDesc.InternalError],
  ] as const)(
    "client は Finished に続く %s を処理し、状態とイベントは 1 回ずつになる",
    async (_, level, description) => {
      // Arrange: server の Finished（epoch 1 の handshake record）を保留し、
      // server が接続した直後に送る alert と 1 つの datagram にまとめて client へ届ける
      const pair = createDtlsPair();
      const events: string[] = [];
      pair.client.onConnect.subscribe(() => events.push("connect"));
      pair.client.onClose.subscribe(() => events.push("close"));
      pair.client.onError.subscribe(() => events.push("error"));
      let held: Buffer | undefined;
      const send = pair.serverTransport.send;
      pair.serverTransport.send = async (data: Buffer) => {
        const contentType = data[0];
        const epoch = data.readUInt16BE(3);
        if (contentType === ContentType.handshake && epoch === 1) {
          held = data;
          return;
        }
        if (contentType === ContentType.alert && held) {
          const datagram = Buffer.concat([held, data]);
          held = undefined;
          pair.serverTransport.sent.push(datagram);
          setImmediate(() =>
            pair.clientTransport.onData(datagram, pair.serverTransport.address),
          );
          return;
        }
        return send(data);
      };
      const serverConnected = pair.server.onConnect.asPromise();
      void pair.client.connect().catch(() => undefined);
      await serverConnected;

      // Act: server が接続直後に alert を送る（Finished と同じ datagram で届く）
      await pair.server.sendAlert(level, description);
      await setTimeout(50);

      // Assert: datagram には Finished と alert の 2 record が入っていた
      const datagram = pair.serverTransport.sent.at(-1)!;
      expect(sentRecords([datagram]).map((r) => r.contentType)).toEqual([
        ContentType.handshake,
        ContentType.alert,
      ]);
      // Assert: client は終了し、終了イベントはちょうど 1 回、connect は高々 1 回
      expect(pair.client.terminated).toBe(true);
      const ending = level === AlertLevel.fatal ? "error" : "close";
      expect(events.filter((e) => e === ending)).toHaveLength(1);
      expect(events.filter((e) => e !== ending && e !== "connect")).toEqual([]);
      expect(events.filter((e) => e === "connect").length).toBeLessThanOrEqual(
        1,
      );
      // Assert: connect が発火した場合は終了イベントより前
      if (events.includes("connect")) {
        expect(events.indexOf("connect")).toBeLessThan(events.indexOf(ending));
      }
    },
  );
});

describe("close_notify を受けた後に届く application data", () => {
  test.each(["同じ datagram", "後の datagram"] as const)(
    "%s で届いた application data は onData に渡らず、onClose は 1 回だけ",
    async (placement) => {
      // Arrange: 接続済みの組で、client の文脈で close_notify と application data の record を作る
      const pair = createDtlsPair();
      await connectDtlsPair(pair);
      const onData = vi.fn();
      const onClose = vi.fn();
      pair.server.onData.subscribe(onData);
      pair.server.onClose.subscribe(onClose);
      const closeNotify = createMultiAlertRecord(pair.client, [
        { level: AlertLevel.warning, description: AlertDesc.CloseNotify },
      ]);
      const [dataPacket] = createPlaintext(pair.client.dtls)(
        [{ type: ContentType.applicationData, fragment: Buffer.from("late") }],
        ++pair.client.dtls.recordSequenceNumber,
      );
      const data = pair.client.cipher.encryptPacket(dataPacket).serialize();
      const from = pair.clientTransport.address;

      // Act: close_notify と application data を指定の並びで server に届ける
      if (placement === "同じ datagram") {
        pair.serverTransport.onData(Buffer.concat([closeNotify, data]), from);
      } else {
        pair.serverTransport.onData(closeNotify, from);
        pair.serverTransport.onData(data, from);
      }
      await setTimeout(20);

      // Assert: close_notify で終了し、後の application data は処理されない
      expect(onClose).toHaveBeenCalledTimes(1);
      expect(onData).not.toHaveBeenCalled();
      expect(pair.server.terminated).toBe(true);
    },
  );
});

describe("確立後に注入された平文（epoch 0）の handshake record", () => {
  test("client に別の証明書の Certificate を注入しても、証明書は変わらず接続とデータ通信が続く", async () => {
    // Arrange: client は server の本来の証明書だけを受け入れる。接続後に別の証明書を用意する
    const expected = new X509Certificate(certPem).raw;
    const pair = createDtlsPair({
      client: {
        verifyRemoteCertificate: (certificate) => certificate.equals(expected),
      },
    });
    await connectDtlsPair(pair);
    const onError = vi.fn();
    const onClose = vi.fn();
    pair.client.onError.subscribe(onError);
    pair.client.onClose.subscribe(onClose);
    const other = await CipherContext.createSelfSignedCertificateWithKey(
      { signature: SignatureAlgorithm.ecdsa_3, hash: HashAlgorithm.sha256_4 },
      NamedCurveAlgorithm.secp256r1_23,
    );
    const certificate = new Certificate([
      new X509Certificate(other.certPem).raw,
    ]).toFragment();
    certificate.message_seq = 2;
    const injected = createEpoch0HandshakeRecord(
      pair.server,
      certificate.serialize(),
    );

    // Act: 平文の Certificate を client に届け、その後に双方向でデータを送る
    pair.clientTransport.onData(injected, pair.serverTransport.address);
    await setTimeout(50);
    const toServer = pair.server.onData.asPromise();
    const toClient = pair.client.onData.asPromise();
    await pair.client.send(Buffer.from("ping"));
    await pair.server.send(Buffer.from("pong"));

    // Assert: 接続は終了せず、alert も送らず、保持する証明書も変わらない
    expect(pair.client.terminated).toBe(false);
    expect(onError).not.toHaveBeenCalled();
    expect(onClose).not.toHaveBeenCalled();
    expect(alertRecords(pair.clientTransport.sent)).toHaveLength(0);
    expect(Buffer.from(pair.client.remoteCertificate!).equals(expected)).toBe(
      true,
    );
    // Assert: データ通信は双方向に続く
    expect(String((await toServer)[0])).toBe("ping");
    expect(String((await toClient)[0])).toBe("pong");
  });

  test("server に ClientHello を注入しても、セッションはリセットされずデータ通信が続く", async () => {
    // Arrange
    const pair = createDtlsPair();
    await connectDtlsPair(pair);
    const cipherBefore = pair.server.cipher;
    const hello = createClientHelloHandshake({ random: new DtlsRandom() });
    const injected = createEpoch0HandshakeRecord(
      pair.client,
      hello.serialize(),
    );

    // Act: 平文の ClientHello を server に届け、その後に双方向でデータを送る
    pair.serverTransport.onData(injected, pair.clientTransport.address);
    await setTimeout(50);
    const toServer = pair.server.onData.asPromise();
    const toClient = pair.client.onData.asPromise();
    await pair.client.send(Buffer.from("ping"));
    await pair.server.send(Buffer.from("pong"));

    // Assert: server は接続済みのまま、セッション（鍵）も作り直されない
    expect(pair.server.connected).toBe(true);
    expect(pair.server.cipher).toBe(cipherBefore);
    expect(pair.server.terminated).toBe(false);
    // Assert: データ通信は双方向に続く
    expect(String((await toServer)[0])).toBe("ping");
    expect(String((await toClient)[0])).toBe("pong");
  });
});
