import { DTLS_IN_STUN_DATA } from "../../src/sped/draft00/constants";
import { classes, methods } from "../../src/stun/const";
import { Message } from "../../src/stun/message";
import { Transaction } from "../../src/stun/transaction";

describe("STUN Transaction frozen bytes", () => {
  it("再送は最初の serialize bytes を使い round-robin をやり直さない", async () => {
    // Arrange
    const sent: Buffer[] = [];
    const protocol = {
      sendStun: async (message: Message) => {
        sent.push(Buffer.from(message.bytes));
      },
      sendData: async () => {},
    };
    const request = new Message(methods.BINDING, classes.REQUEST);
    request.setAttribute("USERNAME", "a:b");
    const transaction = new Transaction(
      request,
      ["127.0.0.1", 1234],
      protocol as any,
      { retransmissions: 1, responseTimeout: 20 },
    );
    request.appendRawAttribute(DTLS_IN_STUN_DATA, Buffer.from([22, 1, 2]));

    // Act
    void transaction.run().catch(() => {});
    await new Promise((r) => setTimeout(r, 50));
    transaction.cancel();

    // Assert: 2 回とも同じ bytes。decorate 後の Message 変異は再送に出ない
    expect(sent.length).toBeGreaterThanOrEqual(2);
    expect(sent[0]!.equals(sent[1]!)).toBe(true);
    expect(sent[0]!.indexOf(Buffer.from([22, 1, 2]))).toBe(-1);
  });
});
