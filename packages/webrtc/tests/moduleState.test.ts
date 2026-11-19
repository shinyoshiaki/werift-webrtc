import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";

/**
 * Runtime state belongs to the object whose lifetime it follows, not to the
 * module (root AGENTS.md, Don't). This test finds module-level mutable state
 * in `src`; a declaration that is process-wide by contract is listed in
 * {@link ALLOWED} with the reason, and also carries that reason as a comment
 * at its declaration.
 */
const SRC = join(__dirname, "../src");

const ALLOWED: Record<string, string> = {
  // 1 つの stream は 1 つの reader でしか読めないので、同じ stream を開く
  // register / track で hub を共有する必要がある
  "polyfill/sourceIo.ts: const streamHubs":
    "registry keyed by the application's stream",
  // certificateScope: "process" (既定) の公開されたキャッシュ
  "transport/dtls.ts: static localCertificate":
    "process-wide default certificate",
  "transport/dtls.ts: static localCertificatePromise":
    "process-wide default certificate",
};

const PATTERNS = [
  // モジュール最上位の let / var
  /^(?:export )?(let|var) (\w+)/,
  // モジュール最上位で生成するコレクション
  /^(?:export )?(const) (\w+)(?:\s*:[^=]+)?\s*=\s*new (?:Weak)?(?:Map|Set)\b/,
  // 書き換え可能な static フィールド (メソッドと readonly を除く)
  /^\s+(?:(?:public|private|protected) )?(static) (?!readonly\b|async\b|get\b|set\b)(\w+)\s*[?!]?\s*[:=](?!\s*(?:async\s*)?\()/,
];

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return sourceFiles(path);
    return entry.name.endsWith(".ts") ? [path] : [];
  });
}

function findModuleState() {
  const found: string[] = [];
  for (const file of sourceFiles(SRC)) {
    const lines = readFileSync(file, "utf8").split("\n");
    for (const line of lines) {
      for (const pattern of PATTERNS) {
        const match = pattern.exec(line);
        if (match) {
          found.push(`${relative(SRC, file)}: ${match[1]} ${match[2]}`);
        }
      }
    }
  }
  return found.sort();
}

describe("module-level state", () => {
  test("src に許可リスト外のモジュールスコープの可変状態がない", () => {
    // Act: src の全 .ts からモジュールスコープの可変状態を探す
    const found = findModuleState();

    // Assert: 見つかったものはすべて、理由を記した許可リストに載っている
    expect(found.filter((key) => !(key in ALLOWED))).toEqual([]);
  });

  test("許可リストの各項目は今も src に存在する", () => {
    // Act
    const found = new Set(findModuleState());

    // Assert: 消えた宣言を許可リストに残さない
    expect(Object.keys(ALLOWED).filter((key) => !found.has(key))).toEqual([]);
  });

  test("検出パターンはモジュールスコープの可変状態を見つける", () => {
    // Arrange: 検出すべき宣言と、対象外の宣言
    const detected = [
      "let counter = 0;",
      "export let factory = () => 1;",
      "const byTrack = new WeakMap<object, number>();",
      "const seen: Set<string> = new Set();",
      "  static cache?: string;",
      "  private static count = 0;",
    ];
    const ignored = [
      "const fqdn = new RegExp('x');",
      "  static readonly type = 13;",
      "  static async create() {",
      "  static create = (value: string) => value;",
      "  const local = new Map();",
    ];

    // Act
    const matches = (line: string) =>
      PATTERNS.some((pattern) => pattern.test(line));

    // Assert: 前者はすべて検出され、後者は検出されない
    expect(detected.filter((line) => !matches(line))).toEqual([]);
    expect(ignored.filter(matches)).toEqual([]);
  });
});
