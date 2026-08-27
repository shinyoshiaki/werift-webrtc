import { type Socket, createSocket } from "dgram";
import { Readable } from "stream";

import { createWebRtcDomException } from "../errors";

export type BinaryLike = Buffer | ArrayBuffer | ArrayBufferView;

export type UdpOrStreamSource =
  | { udp: { port: number; address?: string }; stream?: never }
  | {
      udp?: never;
      stream: Readable | ReadableStream<Uint8Array>;
    };

export function toBuffer(value: BinaryLike | string): Buffer {
  if (Buffer.isBuffer(value)) {
    return value;
  }
  if (typeof value === "string") {
    return Buffer.from(value);
  }
  if (ArrayBuffer.isView(value)) {
    return Buffer.from(value.buffer, value.byteOffset, value.byteLength);
  }
  return Buffer.from(new Uint8Array(value));
}

export async function openPacketSource(
  source: UdpOrStreamSource,
  onPacket: (packet: Buffer) => void,
  onError?: (error: DOMException) => void,
  signal?: AbortSignal,
): Promise<() => void> {
  throwIfAborted(signal);
  if ("udp" in source && source.udp) {
    return bindUdp(source.udp, onPacket, onError, signal);
  }
  return readLengthPrefixedStream(source.stream, onPacket, onError, signal);
}

export function throwIfAborted(signal?: AbortSignal) {
  if (signal?.aborted) {
    throw createWebRtcDomException("AbortError", "The operation was aborted");
  }
}

async function bindUdp(
  udp: { port: number; address?: string },
  onPacket: (packet: Buffer) => void,
  onError?: (error: DOMException) => void,
  signal?: AbortSignal,
) {
  const socket: Socket = createSocket("udp4");
  try {
    await new Promise<void>((resolve, reject) => {
      const onBindError = (error: Error) => {
        cleanup();
        reject(error);
      };
      const onListening = () => {
        cleanup();
        resolve();
      };
      const onAbort = () => {
        cleanup();
        socket.close();
        reject(
          createWebRtcDomException("AbortError", "The operation was aborted"),
        );
      };
      const cleanup = () => {
        socket.off("error", onBindError);
        socket.off("listening", onListening);
        signal?.removeEventListener("abort", onAbort);
      };
      if (signal?.aborted) {
        onAbort();
        return;
      }
      socket.once("error", onBindError);
      socket.once("listening", onListening);
      signal?.addEventListener("abort", onAbort, { once: true });
      if (signal?.aborted) {
        onAbort();
        return;
      }
      socket.bind(udp.port, udp.address ?? "0.0.0.0");
    });
  } catch (error) {
    socket.close();
    if (error instanceof DOMException && error.name === "AbortError") {
      throw error;
    }
    throw createWebRtcDomException(
      "NotReadableError",
      error instanceof Error ? error.message : "Failed to bind UDP socket",
    );
  }

  const onMessage = (message: Buffer) => {
    onPacket(Buffer.from(message));
  };
  const onSocketError = (error: Error) => {
    onError?.(
      createWebRtcDomException(
        "NotReadableError",
        error.message || "UDP socket error",
      ),
    );
  };
  const stop = () => {
    socket.off("message", onMessage);
    socket.off("error", onSocketError);
    signal?.removeEventListener("abort", stop);
    try {
      socket.close();
    } catch {
      // already closed
    }
  };
  socket.on("message", onMessage);
  socket.on("error", onSocketError);
  signal?.addEventListener("abort", stop, { once: true });
  if (signal?.aborted) {
    stop();
    throwIfAborted(signal);
  }

  return stop;
}

async function readLengthPrefixedStream(
  stream: Readable | ReadableStream<Uint8Array>,
  onPacket: (packet: Buffer) => void,
  onError?: (error: DOMException) => void,
  signal?: AbortSignal,
) {
  const abort = new AbortController();
  const onExternalAbort = () => abort.abort();
  if (signal?.aborted) {
    abort.abort();
  } else {
    signal?.addEventListener("abort", onExternalAbort, { once: true });
  }
  throwIfAborted(abort.signal);

  const run = (async () => {
    let pending = Buffer.alloc(0);
    for await (const chunk of iterateBytes(stream, abort.signal)) {
      pending = Buffer.concat([pending, chunk]);
      while (pending.length >= 4) {
        const size = pending.readUInt32BE(0);
        if (pending.length < 4 + size) {
          break;
        }
        onPacket(Buffer.from(pending.subarray(4, 4 + size)));
        pending = pending.subarray(4 + size);
      }
    }
  })();

  run.catch((error) => {
    const mapped = mapStreamError(error, abort.signal);
    if (mapped.name === "AbortError") {
      return;
    }
    onError?.(mapped);
  });

  return () => {
    signal?.removeEventListener("abort", onExternalAbort);
    abort.abort();
    if (stream instanceof Readable) {
      stream.destroy();
    }
  };
}

function mapStreamError(error: unknown, signal: AbortSignal) {
  if (
    signal.aborted ||
    (error instanceof DOMException && error.name === "AbortError") ||
    (error instanceof Error && error.name === "AbortError")
  ) {
    return createWebRtcDomException(
      "AbortError",
      error instanceof Error ? error.message : "The operation was aborted",
    );
  }
  return createWebRtcDomException(
    "NotReadableError",
    error instanceof Error ? error.message : "Failed to read media stream",
  );
}

async function* iterateBytes(
  stream: Readable | ReadableStream<Uint8Array>,
  signal: AbortSignal,
): AsyncGenerator<Buffer> {
  if (stream instanceof Readable) {
    const onAbort = () => {
      stream.destroy();
    };
    if (signal.aborted) {
      return;
    }
    signal.addEventListener("abort", onAbort, { once: true });
    try {
      for await (const chunk of stream) {
        if (signal.aborted) {
          return;
        }
        yield toBuffer(chunk);
      }
    } finally {
      signal.removeEventListener("abort", onAbort);
    }
    return;
  }

  if (signal.aborted) {
    return;
  }
  const reader = stream.getReader();
  const onAbort = () => {
    void reader.cancel().catch(() => undefined);
  };
  signal.addEventListener("abort", onAbort, { once: true });
  if (signal.aborted) {
    signal.removeEventListener("abort", onAbort);
    await reader.cancel().catch(() => undefined);
    return;
  }
  try {
    for (;;) {
      if (signal.aborted) {
        return;
      }
      const { done, value } = await reader.read();
      if (done) {
        return;
      }
      if (value) {
        yield Buffer.from(value.buffer, value.byteOffset, value.byteLength);
      }
    }
  } finally {
    signal.removeEventListener("abort", onAbort);
    try {
      reader.releaseLock();
    } catch {
      // cancel() already released the lock
    }
  }
}

export function encodeLengthPrefixed(packet: Buffer) {
  const header = Buffer.alloc(4);
  header.writeUInt32BE(packet.length, 0);
  return Buffer.concat([header, packet]);
}

export async function readEntireStream(
  stream: Readable | ReadableStream<Uint8Array>,
  signal: AbortSignal = new AbortController().signal,
) {
  const chunks: Buffer[] = [];
  try {
    for await (const chunk of iterateBytes(stream, signal)) {
      chunks.push(chunk);
    }
  } catch (error) {
    throw mapStreamError(error, signal);
  }
  if (signal.aborted) {
    throw createWebRtcDomException("AbortError", "The operation was aborted");
  }
  return Buffer.concat(chunks);
}

export function isWebmContainer(buffer: Buffer) {
  return (
    buffer.length >= 4 &&
    buffer[0] === 0x1a &&
    buffer[1] === 0x45 &&
    buffer[2] === 0xdf &&
    buffer[3] === 0xa3
  );
}
