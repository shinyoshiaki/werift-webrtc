import { forwardEncodedFrames } from "./encodedFrames";
import { SendGate } from "./sendGate";

// RTCRtpScriptTransform entry point. Receiver: copy frames out before NetEQ.
// Sender ({ side: "sender" }): the SendGate, closed by a "close" message.
(self as any).onrtctransform = (event: any) => {
  const { readable, writable, options } = event.transformer;
  if (options?.side === "sender") {
    const gate = new SendGate((message) => self.postMessage(message), options);
    self.onmessage = ({ data }) => {
      if (data.type === "close") gate.close(data.releaseHeldAfterMs);
    };
    void gate.pipe(readable, writable);
    return;
  }
  void forwardEncodedFrames(readable, writable, (frame) =>
    (self as any).postMessage(frame, [frame.data]),
  );
};
