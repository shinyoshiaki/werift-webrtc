import { setTimeout } from "timers/promises";
import { AlertDesc, AlertLevel, ContentType, DtlsAlertError } from "../src";
import { Alert } from "../src/handshake/message/alert";
import { createPlaintext } from "../src/record/builder";
import { connectDtlsPair, createDtlsPair, sentRecords } from "./utils";

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
