import { ReadableStream } from "stream/web";

export class SourceStream<T> {
  readable: ReadableStream<T>;
  write!: (chunk: T) => void;

  constructor() {
    this.readable = new ReadableStream({
      start: (controller) => {
        this.write = (chunk) => controller.enqueue(chunk);
      },
    });
  }
}
