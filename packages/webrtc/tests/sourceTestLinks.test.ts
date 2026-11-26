import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";

/**
 * src のコメントにある「テストへのリンク」が実在するテストを指していることを確かめる。
 * リンクの書式は `<パッケージからの相対パス>.test.ts "<describe / test のタイトル>"`
 * (例: `tests/issue/815.reset.test.ts "close fires on neither end ..."`)。
 * 対象は werift (packages/webrtc) と werift-sctp (packages/sctp) の src。
 */
const packagesDir = resolve(__dirname, "../..");
const scannedPackages = ["webrtc", "sctp"];
const LINK = /(tests\/[\w./-]+\.test\.ts) "([^"]+)"/g;

interface Link {
  source: string;
  line: number;
  testFile: string;
  title: string;
}

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return sourceFiles(path);
    return entry.name.endsWith(".ts") ? [path] : [];
  });
}

/** 各パッケージの src のコメント行から、テストへのリンクを集める。 */
function collectLinks(): Link[] {
  return scannedPackages.flatMap((name) => {
    const root = join(packagesDir, name);
    return sourceFiles(join(root, "src")).flatMap((source) =>
      readFileSync(source, "utf8")
        .split("\n")
        .flatMap((text, index) => {
          if (!/^\s*(\/\/|\/?\*)/.test(text)) return [];
          return [...text.matchAll(LINK)].map(([, testFile, title]) => ({
            source: relative(packagesDir, source),
            line: index + 1,
            testFile: join(root, testFile),
            title,
          }));
        }),
    );
  });
}

/** タイトルがテストファイル中の文字列リテラルとして現れるか。 */
function definesTitle(testFile: string, title: string) {
  const content = readFileSync(testFile, "utf8");
  return ['"', "'", "`"].some((quote) =>
    content.includes(`${quote}${title}${quote}`),
  );
}

describe("comments in src link to existing tests", () => {
  test("every linked test file exists and defines the linked title", () => {
    // Arrange: src のコメントから集めたリンク。
    const links = collectLinks();

    // Act: リンク先のファイルが無いもの、タイトルが見つからないものを集める。
    const broken = links
      .filter(
        ({ testFile, title }) =>
          !existsSync(testFile) || !definesTitle(testFile, title),
      )
      .map(({ source, line, testFile, title }) => {
        return `${source}:${line} -> ${relative(packagesDir, testFile)} "${title}"`;
      });

    // Assert: リンクは集まっており (書式が変わって 0 件になっていない)、壊れたものはない。
    expect(links.length).toBeGreaterThan(50);
    expect(broken).toEqual([]);
  });
});
