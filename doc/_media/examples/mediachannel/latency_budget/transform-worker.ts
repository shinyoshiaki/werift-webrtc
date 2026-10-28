import { forwardEncodedFrames } from "./encodedFrames";

// RTCRtpScriptTransform entry point (receiver side).
(self as any).onrtctransform = (event: any) => {
  const { readable, writable } = event.transformer;
  void forwardEncodedFrames(readable, writable, (frame) =>
    (self as any).postMessage(frame, [frame.data]),
  );
};
