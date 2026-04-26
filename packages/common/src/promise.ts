export class PromiseQueue {
  queue: {
    promise: () => Promise<unknown>;
    done: (...args: any[]) => void;
    failed: (...args: any[]) => void;
  }[] = [];
  running = false;

  push = <T>(promise: () => Promise<T>) =>
    new Promise<T>((r, f) => {
      this.queue.push({ promise, done: r, failed: f });
      if (!this.running) {
        this.run();
      }
    });

  private async run() {
    const task = this.queue.shift();
    if (task) {
      this.running = true;

      try {
        const res = await task.promise();
        task.done(res);
      } catch (error) {
        task.failed(error);
      }

      this.run();
    } else {
      this.running = false;
    }
  }

  cancel() {
    this.queue = [];
  }
}
