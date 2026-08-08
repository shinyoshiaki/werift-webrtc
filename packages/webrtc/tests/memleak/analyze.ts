/**
 * ヒープスナップショットの解析（リーク箇所の特定）。
 * 早期/後期スナップショットを比較し、クラス別に増加したノード数を抽出する。
 *
 * 深い dominator tree 解析は行わず、軽量な「コンストラクタ名別ノード数」比較に限定する。
 */
import { readFileSync } from "node:fs";

export type ClassCount = {
  name: string;
  count: number;
  selfSize: number;
};

export type ClassDelta = {
  name: string;
  earlyCount: number;
  lateCount: number;
  delta: number;
  earlySelfSize: number;
  lateSelfSize: number;
  selfSizeDelta: number;
};

export type LeakAnalysis = {
  earlySnapshot: string;
  lateSnapshot: string;
  topIncreases: ClassDelta[];
  summary: string;
};

type HeapSnapshotJson = {
  snapshot: {
    meta: {
      node_fields: string[];
      node_types: (string[] | string)[];
    };
  };
  nodes: number[];
  strings: string[];
};

/** object / native 型など「名前付きオブジェクト」として集計する type */
const NAMED_OBJECT_TYPES = new Set([
  "object",
  "native",
  "closure",
  "code",
  "array",
]);

/**
 * .heapsnapshot (JSON) をパースし、コンストラクタ名別のノード数と self_size 合計を返す。
 */
export function countNodesByClass(
  snapshotPath: string,
): Map<string, ClassCount> {
  const raw = readFileSync(snapshotPath, "utf8");
  const snap = JSON.parse(raw) as HeapSnapshotJson;
  const fields = snap.snapshot.meta.node_fields;
  const typeFieldIndex = fields.indexOf("type");
  const nameFieldIndex = fields.indexOf("name");
  const selfSizeIndex = fields.indexOf("self_size");
  const fieldCount = fields.length;

  const nodeTypes = snap.snapshot.meta.node_types[0];
  if (!Array.isArray(nodeTypes)) {
    throw new Error("unexpected heap snapshot node_types format");
  }

  const counts = new Map<string, ClassCount>();
  const nodes = snap.nodes;
  const strings = snap.strings;

  for (let i = 0; i < nodes.length; i += fieldCount) {
    const typeIndex = nodes[i + typeFieldIndex];
    const typeName = nodeTypes[typeIndex] ?? "unknown";

    let name: string;
    if (typeName === "string") {
      // 文字列は内容ではなく型として集約（ユニーク文字列爆発を避ける）
      name = "string";
    } else if (typeName === "array") {
      name = "Array";
    } else if (NAMED_OBJECT_TYPES.has(typeName)) {
      const nameIndex = nodes[i + nameFieldIndex];
      name = strings[nameIndex] ?? "(unknown)";
    } else {
      continue;
    }

    // システム内部や無意味な名前は除外してトリアージしやすくする
    if (!name || name.startsWith("(") || name.startsWith("system /")) {
      continue;
    }

    const selfSize = nodes[i + selfSizeIndex] ?? 0;
    const existing = counts.get(name);
    if (existing) {
      existing.count += 1;
      existing.selfSize += selfSize;
    } else {
      counts.set(name, { name, count: 1, selfSize });
    }
  }

  return counts;
}

/**
 * 早期スナップショットと後期スナップショットを比較し、増加量上位の型を返す。
 */
export function compareSnapshots(
  earlySnapshot: string,
  lateSnapshot: string,
  options: { topN?: number; minDelta?: number } = {},
): LeakAnalysis {
  const topN = options.topN ?? 20;
  const minDelta = options.minDelta ?? 1;

  const early = countNodesByClass(earlySnapshot);
  const late = countNodesByClass(lateSnapshot);

  const names = new Set([...early.keys(), ...late.keys()]);
  const deltas: ClassDelta[] = [];

  for (const name of names) {
    const e = early.get(name);
    const l = late.get(name);
    const earlyCount = e?.count ?? 0;
    const lateCount = l?.count ?? 0;
    const delta = lateCount - earlyCount;
    if (delta < minDelta) continue;
    deltas.push({
      name,
      earlyCount,
      lateCount,
      delta,
      earlySelfSize: e?.selfSize ?? 0,
      lateSelfSize: l?.selfSize ?? 0,
      selfSizeDelta: (l?.selfSize ?? 0) - (e?.selfSize ?? 0),
    });
  }

  deltas.sort((a, b) => {
    if (b.delta !== a.delta) return b.delta - a.delta;
    return b.selfSizeDelta - a.selfSizeDelta;
  });

  const topIncreases = deltas.slice(0, topN);
  const summary =
    topIncreases.length === 0
      ? "クラス別ノード数の有意な増加は検出されませんでした。"
      : `増加上位: ${topIncreases
          .slice(0, 5)
          .map((d) => `${d.name}(+${d.delta})`)
          .join(", ")}`;

  return {
    earlySnapshot,
    lateSnapshot,
    topIncreases,
    summary,
  };
}

/**
 * 既に読み込んだ ClassCount マップ同士を比較（ユニットテスト用）。
 */
export function compareClassCounts(
  early: Map<string, ClassCount>,
  late: Map<string, ClassCount>,
  options: { topN?: number; minDelta?: number } = {},
): ClassDelta[] {
  const topN = options.topN ?? 20;
  const minDelta = options.minDelta ?? 1;
  const names = new Set([...early.keys(), ...late.keys()]);
  const deltas: ClassDelta[] = [];
  for (const name of names) {
    const e = early.get(name);
    const l = late.get(name);
    const earlyCount = e?.count ?? 0;
    const lateCount = l?.count ?? 0;
    const delta = lateCount - earlyCount;
    if (delta < minDelta) continue;
    deltas.push({
      name,
      earlyCount,
      lateCount,
      delta,
      earlySelfSize: e?.selfSize ?? 0,
      lateSelfSize: l?.selfSize ?? 0,
      selfSizeDelta: (l?.selfSize ?? 0) - (e?.selfSize ?? 0),
    });
  }
  deltas.sort((a, b) => b.delta - a.delta);
  return deltas.slice(0, topN);
}
