// Shared by the RTCRtpScriptTransform worker and the createEncodedStreams()
// fallback: copy each encoded audio frame out *before* NetEQ, then pass it on
// unchanged so the native <audio> path keeps working for comparison.

export type EncodedAudioFrameMessage = {
  data: ArrayBuffer;
  rtpTimestamp: number;
  sequenceNumber?: number;
  /** CSRC list; the example carries the track generation in csrc[0] */
  contributingSources: number[];
  receiveTime?: number;
};

export function forwardEncodedFrames(
  readable: ReadableStream<any>,
  writable: WritableStream<any>,
  post: (frame: EncodedAudioFrameMessage) => void,
) {
  return readable
    .pipeThrough(
      new TransformStream({
        transform(frame, controller) {
          const metadata = frame.getMetadata();
          post({
            data: frame.data.slice(0),
            // rtpTimestamp is newer; older Chrome only has frame.timestamp
            rtpTimestamp: metadata.rtpTimestamp ?? frame.timestamp,
            sequenceNumber: metadata.sequenceNumber,
            contributingSources: metadata.contributingSources ?? [],
            receiveTime: metadata.receiveTime,
          });
          controller.enqueue(frame);
        },
      }),
    )
    .pipeTo(writable);
}
