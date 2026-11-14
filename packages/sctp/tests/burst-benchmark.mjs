import { measureBurstTransfer } from "./utils.ts";

// Arrange: 各 message count の実行経路を事前に温め、測定順の偏りを避ける。
await measureBurstTransfer(1_000, 1_000);
await measureBurstTransfer(4_000, 1_000);
await measureBurstTransfer(16_000, 1_000);

// Act: N / 4N の CPU 時間比を交互の順番で 5 組計測する。
const ratios = [];
for (let i = 0; i < 5; i++) {
  const smallFirst = i % 2 === 0;
  const small = await measureBurstTransfer(smallFirst ? 4_000 : 16_000, 1_000);
  const large = await measureBurstTransfer(smallFirst ? 16_000 : 4_000, 1_000);
  ratios.push(
    (smallFirst ? large : small).cpuElapsedMs /
      Math.max((smallFirst ? small : large).cpuElapsedMs, 1),
  );
}
const medianRatio = [...ratios].sort((a, b) => a - b)[
  Math.floor(ratios.length / 2)
];

// Assert: 呼び出し元へ計測結果だけを返す。
console.log(JSON.stringify({ ratios, medianRatio }));
