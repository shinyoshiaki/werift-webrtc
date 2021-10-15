export class PromiseQueue {
  queue: { promise: () => Promise<any>; done: () => void }[] = [];
  running = false;

  push = (promise: () => Promise<any>) =>
    new Promise<void>((r) => {
      this.queue.push({ promise, done: r });
      if (!this.running) this.run();
    });

  private async run() {
    const task = this.queue.shift();
    if (task) {
      this.running = true;
      await task.promise();
      task.done();

      this.run();
    } else {
      this.running = false;
    }
  }
}
