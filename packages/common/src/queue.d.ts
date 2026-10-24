/**
 * FIFO queue with amortized O(1) `shift()`.
 *
 * `Array.prototype.shift()` copies the backing store once the array is large
 * (V8 large object space), which makes draining a long queue quadratic.
 * This queue keeps a head index into a plain array instead and compacts the
 * consumed prefix lazily, so indexed access (`at`) stays O(1).
 */
export declare class FifoQueue<T> implements Iterable<T> {
  private items;
  private head;
  /** Total number of elements removed from the front (for stable iteration). */
  private removed;
  constructor(items?: Iterable<T>);
  get length(): number;
  push(...items: T[]): number;
  /** Removes and returns the first element. */
  shift(): T | undefined;
  /** Puts an element back to the front of the queue. */
  unshift(item: T): number;
  /** First element, without removing it. */
  peek(): T | undefined;
  /** Last element, without removing it. */
  last(): T | undefined;
  /** Element at `index` from the front (negative index counts from the back). */
  at(index: number): T | undefined;
  findIndex(predicate: (item: T, index: number) => boolean): number;
  /** Returns a new queue with the elements that satisfy `predicate`. */
  filter(predicate: (item: T, index: number) => boolean): FifoQueue<T>;
  forEach(callback: (item: T, index: number) => void): void;
  clear(): void;
  toArray(): T[];
  /**
   * Iterates from the front. Safe against `shift()` while iterating (e.g.
   * across an `await`): elements removed meanwhile are skipped and iteration
   * continues with the current front instead of jumping over live elements.
   */
  [Symbol.iterator](): Iterator<T>;
  private reset;
  private compact;
}
