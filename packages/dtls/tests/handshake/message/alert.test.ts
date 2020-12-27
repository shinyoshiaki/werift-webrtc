import { Alert } from "../../../src/handshake/message/alert";

test("handshake_message_alert", () => {
  const raw = Buffer.from([0x02, 0x0a]);
  const c = Alert.deSerialize(raw);
  expect(raw).toEqual(c.serialize());
});
