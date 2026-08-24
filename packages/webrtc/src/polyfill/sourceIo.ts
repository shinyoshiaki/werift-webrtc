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
): Promise<() => void> {
  if ("udp" in source && source.udp) {
    return bindUdp(source.udp, onPacket, onError);
  }
  return readLengthPrefixedStream(source.stream, onPacket, onError);
}

async function bindUdp(
  udp: { port: number; address?: string },
  onPacket: (packet: Buffer) => void,
  onError?: (error: DOMException) => void,
) {
  const socket: Socket = createSocket("udp4");
  try {
    await new Promise<void>((resolve, reject) => {
      const onError = (error: Error) => {
        socket.off("listening", onListening);
        reject(error);
      };
      const onListening = () => {
        socket.off("error", onError);
        resolve();
      };
      socket.once("error", onError);
      socket.once("listening", onListening);
      socket.bind(udp.port, udp.address ?? "0.0.0.0");
    });
  } catch (error) {
    socket.close();
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
  socket.on("message", onMessage);
  socket.on("error", onSocketError);

  return () => {
    socket.off("message", onMessage);
    socket.off("error", onSocketError);
    try {
      socket.close();
    } catch {
      // already closed
    }
  };
}

async function readLengthPrefixedStream(
  stream: Readable | ReadableStream<Uint8Array>,
  onPacket: (packet: Buffer) => void,
  onError?: (error: DOMException) => void,
) {
  const abort = new AbortController();
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
    for await (const chunk of stream) {
      if (signal.aborted) {
        return;
      }
      yield toBuffer(chunk);
    }
    return;
  }

  const reader = stream.getReader();
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
    reader.releaseLock();
  }
}

export function encodeLengthPrefixed(packet: Buffer) {
  const header = Buffer.alloc(4);
  header.writeUInt32BE(packet.length, 0);
  return Buffer.concat([header, packet]);
}

export async function readEntireStream(
  stream: Readable | ReadableStream<Uint8Array>,
) {
  const chunks: Buffer[] = [];
  if (stream instanceof Readable) {
    for await (const chunk of stream) {
      chunks.push(toBuffer(chunk));
    }
    return Buffer.concat(chunks);
  }

  const reader = stream.getReader();
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }
      if (value) {
        chunks.push(
          Buffer.from(value.buffer, value.byteOffset, value.byteLength),
        );
      }
    }
  } finally {
    reader.releaseLock();
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
