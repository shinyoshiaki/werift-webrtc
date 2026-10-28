self.onrtctransform = ({ transformer }) => {
  const inspect = new TransformStream({
    transform(frame, controller) {
      const metadata = frame.getMetadata?.() ?? {};
      const payload = frame.data.slice().buffer;
      self.postMessage({
        type: "frame",
        metadata,
        timestamp: metadata.rtpTimestamp ?? frame.timestamp,
        payload,
      }, [payload]);
      controller.enqueue(frame);
    },
  });
  transformer.readable.pipeThrough(inspect).pipeTo(transformer.writable);
};
