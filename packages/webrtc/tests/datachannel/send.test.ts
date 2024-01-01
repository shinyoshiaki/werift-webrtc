import { awaitMessage, createDataChannelPair } from "../utils";

jest.setTimeout(15_000);

const helloString = "hello";
const unicodeString = "世界你好";
const helloBuffer = Buffer.from([0x68, 0x65, 0x6c, 0x6c, 0x6f]);

describe.each([{}, { negotiated: true, id: 0 }])(
  "datachannel/send",
  (options) => {
    const mode = `${options.negotiated ? "negotiated " : ""}datachannel`;

    test(`${mode} should be able to send simple string and receive as string`, async () => {
      return createDataChannelPair(options)
        .then(([channel1, channel2]) => {
          channel1.send(helloString);
          return awaitMessage(channel2);
        })
        .then((message) => {
          expect(typeof message).toBe("string");
          expect(message).toBe(helloString);
        });
    });

    test(`${mode} should be able to send Uint8Array message and receive as ArrayBuffer`, async () => {
      return createDataChannelPair(options)
        .then(([channel1, channel2]) => {
          channel1.send(helloBuffer);
          return awaitMessage(channel2);
        })
        .then((messageBuffer) => {
          expect(messageBuffer instanceof Buffer).toBeTruthy();

          expect(messageBuffer).toEqual(helloBuffer);
        });
    });

    test(`${mode} sending multiple messages with different types should succeed and be received`, async () =>
      new Promise<void>(async (done) => {
        const receivedMessages: any[] = [];

        const onMessage = (data: any) => {
          receivedMessages.push(data);

          if (receivedMessages.length === 3) {
            expect(receivedMessages[0]).toEqual(helloBuffer);
            expect(receivedMessages[1]).toBe(unicodeString);
            expect(receivedMessages[2]).toEqual(helloBuffer);

            done();
          }
        };

        createDataChannelPair(options).then(([channel1, channel2]) => {
          channel2.onMessage.subscribe(onMessage);

          channel1.send(helloBuffer);
          channel1.send(unicodeString);
          channel1.send(helloBuffer);
        });
      }));
  },
);
