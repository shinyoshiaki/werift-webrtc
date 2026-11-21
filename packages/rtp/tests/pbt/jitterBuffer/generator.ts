/**
 * 欠落・重複・入れ替わりを含む到着順を乱数で作る。
 * 各パケットは本来の位置から最大 maxDelay パケット分だけ遅れて届く。
 * 先頭パケットは基準になるため必ず最初に届く。
 */
export function createRandomJitterOrder({
  count,
  rng,
  lossRate,
  duplicateRate,
  maxDelay,
  duplicateMaxDelay = maxDelay,
}: {
  count: number;
  rng: () => number;
  lossRate: number;
  duplicateRate: number;
  maxDelay: number;
  duplicateMaxDelay?: number;
}) {
  const keyed: { index: number; key: number }[] = [{ index: 0, key: -1 }];
  const received = new Set<number>([0]);
  for (let index = 1; index < count; index++) {
    if (rng() < lossRate) {
      continue;
    }
    received.add(index);
    keyed.push({ index, key: index + rng() * maxDelay });
    if (rng() < duplicateRate) {
      keyed.push({ index, key: index + rng() * duplicateMaxDelay });
    }
  }
  keyed.sort((a, b) => a.key - b.key);
  return {
    order: keyed.map((k) => k.index),
    received: [...received].sort((a, b) => a - b),
  };
}
