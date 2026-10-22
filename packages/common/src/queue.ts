/**
 * FIFO queue with amortized O(1) `shift()`.
 *
 * `Array.prototype.shift()` copies the backing store once the array is large
 * (V8 large object space), which makes draining a long queue quadratic.
 * This queue keeps a head index into a plain array instead and compacts the
 * consumed prefix lazily, so indexed access (`at`) stays O(1).
 */
export class FifoQueue<T> implements Iterable<T> {
  private items: T[] = [];
  private head = 0;
  /** Total number of elements removed from the front (for stable iteration). */
  private removed = 0;

  constructor(items?: Iterable<T>) {
    if (items) {
      for (const item of items) this.items.push(item);
    }
  }

  get length() {
    return this.items.length - this.head;
  }

  push(...items: T[]) {
    for (const item of items) this.items.push(item);
    return this.length;
  }

  /** Removes and returns the first element. */
  shift(): T | undefined {
    if (this.head >= this.items.length) return undefined;
    const item = this.items[this.head];
    this.items[this.head] = undefined as T;
    this.head++;
    this.removed++;
    this.compact();
    return item;
  }

  /** Puts an element back to the front of the queue. */
  unshift(item: T) {
    this.removed--;
    if (this.head > 0) {
      this.head--;
      this.items[this.head] = item;
    } else {
      this.items.unshift(item);
    }
    return this.length;
  }

  /** First element, without removing it. */
  peek(): T | undefined {
    return this.head < this.items.length ? this.items[this.head] : undefined;
  }

  /** Last element, without removing it. */
  last(): T | undefined {
    return this.length > 0 ? this.items[this.items.length - 1] : undefined;
  }

  /** Element at `index` from the front (negative index counts from the back). */
  at(index: number): T | undefined {
    const length = this.length;
    const i = index < 0 ? length + index : index;
    if (i < 0 || i >= length) return undefined;
    return this.items[this.head + i];
  }

  findIndex(predicate: (item: T, index: number) => boolean) {
    for (let i = this.head; i < this.items.length; i++) {
      if (predicate(this.items[i], i - this.head)) return i - this.head;
    }
    return -1;
  }

  /** Returns a new queue with the elements that satisfy `predicate`. */
  filter(predicate: (item: T, index: number) => boolean) {
    const queue = new FifoQueue<T>();
    for (let i = this.head; i < this.items.length; i++) {
      const item = this.items[i];
      if (predicate(item, i - this.head)) queue.items.push(item);
    }
    return queue;
  }

  forEach(callback: (item: T, index: number) => void) {
    for (let i = this.head; i < this.items.length; i++) {
      callback(this.items[i], i - this.head);
    }
  }

  clear() {
    this.removed += this.length;
    this.reset();
  }

  toArray(): T[] {
    return this.items.slice(this.head);
  }

  /**
   * Iterates from the front. Safe against `shift()` while iterating (e.g.
   * across an `await`): elements removed meanwhile are skipped and iteration
   * continues with the current front instead of jumping over live elements.
   */
  *[Symbol.iterator](): Iterator<T> {
    let position = this.removed;
    while (true) {
      const index = Math.max(0, position - this.removed);
      if (index >= this.length) return;
      position = this.removed + index + 1;
      yield this.items[this.head + index];
    }
  }

  private reset() {
    this.items = [];
    this.head = 0;
  }

  private compact() {
    if (this.head === this.items.length) {
      this.reset();
    } else if (this.head >= 1024 && this.head * 2 >= this.items.length) {
      // Drop the consumed prefix once it dominates the backing array; each
      // element is moved at most once per compaction, so shift stays O(1) amortized.
      this.items = this.items.slice(this.head);
      this.head = 0;
    }
  }
}
