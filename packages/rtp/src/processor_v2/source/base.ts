import { ReadableStream, ReadableStreamController } from "stream/web";

export class SourceStream<T> {
  readable: ReadableStream<T>;
  write!: (chunk: T) => void;
  protected controller!: ReadableStreamController<T>;

  constructor() {
    this.readable = new ReadableStream({
      start: (controller) => {
        this.controller = controller;
        this.write = (chunk) => controller.enqueue(chunk);
      },
    });
  }
}
