// Upstream WPT JavaScript tests (`*.window.js`, `*.any.js`). wptserve serves
// each as a generated HTML page (`foo.window.html`, `foo.any.html`); this
// builds the same window-scope page so the runner executes it like any
// `.html` target. Only targets listed in `wpt/allowlist.json` are run (the
// other upstream `.window.js` files need BFCache, idlharness or large-buffer
// support the Node.js runner does not have).
// https://web-platform-tests.org/writing-tests/testharness.html#auto-generated-test-boilerplate

const JS_TEST_SUFFIXES = [".window.js", ".any.js"] as const;

export function isWptJsTestFile(file: string) {
  return JS_TEST_SUFFIXES.some((suffix) => file.endsWith(suffix));
}

export interface WptScriptMetadata {
  title?: string;
  timeout?: string;
  scripts: string[];
}

/**
 * The leading `// META: key=value` lines (wptserve `read_script_metadata`:
 * reading stops at the first line that is not one).
 */
export function readWptScriptMetadata(source: string): WptScriptMetadata {
  const metadata: WptScriptMetadata = { scripts: [] };
  for (const line of source.split(/\r?\n/)) {
    const match = line.match(/^\/\/\s*META:\s*(\w+)=(.*)$/);
    if (!match) break;
    const [, key, value] = match;
    switch (key) {
      case "title":
        metadata.title = value.trim();
        break;
      case "timeout":
        metadata.timeout = value.trim();
        break;
      case "script":
        metadata.scripts.push(value.trim());
        break;
    }
  }
  return metadata;
}

/**
 * The window-scope page wptserve generates for `file` (path relative to the
 * WPT root). wptserve loads the test with `<script src>`; here its source is
 * inlined, because the runner reads each `src` script asynchronously and the
 * page's load event (which lets testharness complete) would fire before the
 * test registers its later subtests.
 */
export function buildWptJsTestHtml(file: string, source: string) {
  if (/<\/script/i.test(source)) {
    throw new Error(
      `${file}: cannot inline a test source containing </script>`,
    );
  }
  const metadata = readWptScriptMetadata(source);
  const lines = ["<!doctype html>", '<meta charset="utf-8">'];
  if (metadata.title !== undefined) {
    lines.push(`<title>${metadata.title}</title>`);
  }
  if (metadata.timeout === "long") {
    lines.push('<meta name="timeout" content="long">');
  }
  if (file.endsWith(".any.js")) {
    lines.push(
      "<script>self.GLOBAL = { isWindow: () => true, isWorker: () => false, isShadowRealm: () => false };</script>",
    );
  }
  lines.push(
    '<script src="/resources/testharness.js"></script>',
    '<script src="/resources/testharnessreport.js"></script>',
    ...metadata.scripts.map((src) => `<script src="${src}"></script>`),
    '<div id="log"></div>',
    `<script>\n${source}\n</script>`,
  );
  return `${lines.join("\n")}\n`;
}
