#!/usr/bin/env node
/**
 * Detect import() / late import declarations in source and hoist them to the
 * file header. Literal dynamic imports without an allow comment are treated as
 * misplaced static imports.
 *
 * Allow a genuine dynamic import with a reason comment on the same statement
 * or the immediately preceding line:
 *
 *   // hoist-imports-allow: load native binding only when present
 *   const native = await import("./optional-native.node");
 *
 * Non-literal specifiers (`import(url)`) are left alone (cannot be static).
 *
 * Usage:
 *   node ./scripts/hoist-imports.mjs           # check (exit 1 on hits)
 *   node ./scripts/hoist-imports.mjs --fix     # rewrite files
 */
import { readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { extname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const ts = require("typescript");

const ALLOW_RE = /hoist-imports-allow:\s*\S/;
const ROOT = join(fileURLToPath(new URL(".", import.meta.url)), "..");
const SCAN_DIRS = ["packages", "examples", "e2e", "scripts", "import-test"];
const SKIP_DIR = new Set([
  "node_modules",
  "lib",
  "dist",
  "build",
  "coverage",
  "third_party",
  ".git",
  ".sak-context",
]);
const EXTS = new Set([".ts", ".tsx", ".mts", ".cts", ".js", ".mjs", ".cjs"]);
const SCRIPT_KIND = {
  ".ts": ts.ScriptKind.TS,
  ".tsx": ts.ScriptKind.TSX,
  ".mts": ts.ScriptKind.TS,
  ".cts": ts.ScriptKind.TS,
  ".js": ts.ScriptKind.JS,
  ".mjs": ts.ScriptKind.JS,
  ".cjs": ts.ScriptKind.JS,
};

const fix = process.argv.includes("--fix");
const SCAN_FROM_CLI = process.argv.slice(2).filter((a) => a !== "--fix");

function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    if (SKIP_DIR.has(name) || name.startsWith(".")) continue;
    const path = join(dir, name);
    const st = statSync(path);
    if (st.isDirectory()) {
      walk(path, out);
      continue;
    }
    if (EXTS.has(extname(name))) out.push(path);
  }
  return out;
}

function listFiles() {
  const files = [];
  const dirs = SCAN_FROM_CLI.length ? SCAN_FROM_CLI : SCAN_DIRS;
  for (const dir of dirs) {
    const abs = dir.startsWith("/") ? dir : join(ROOT, dir);
    try {
      const st = statSync(abs);
      if (st.isDirectory()) walk(abs, files);
      else if (st.isFile() && EXTS.has(extname(abs))) files.push(abs);
    } catch {
      // optional tree
    }
  }
  return files.filter((f) => !f.includes(`${join("scripts", "hoist-imports")}`));
}

function commentHasAllow(text) {
  return ALLOW_RE.test(text);
}

function nodeAllowed(sf, node) {
  const text = sf.getFullText();
  const ranges = [
    ...(ts.getLeadingCommentRanges(text, node.getFullStart()) ?? []),
    ...(ts.getTrailingCommentRanges(text, node.end) ?? []),
  ];
  if (ranges.some((r) => commentHasAllow(text.slice(r.pos, r.end)))) return true;
  // Immediately preceding line (comment not attached as JSDoc/leading trivia).
  const start = node.getStart(sf);
  const lineStart = text.lastIndexOf("\n", start - 1) + 1;
  const prevNl = text.lastIndexOf("\n", lineStart - 2);
  const prevLine = text.slice(prevNl + 1, lineStart);
  return commentHasAllow(prevLine);
}

function specifierOfImportCall(node) {
  if (
    !ts.isCallExpression(node) ||
    node.expression.kind !== ts.SyntaxKind.ImportKeyword
  ) {
    return undefined;
  }
  const arg = node.arguments[0];
  if (!arg || !ts.isStringLiteralLike(arg)) return undefined;
  return arg.text;
}

function unwrapAwait(expr) {
  return ts.isAwaitExpression(expr) ? expr.expression : expr;
}

function namedBindingsFromPattern(pattern) {
  if (!ts.isObjectBindingPattern(pattern)) return undefined;
  const names = [];
  for (const el of pattern.elements) {
    if (el.dotDotDotToken || !el.name || !ts.isIdentifier(el.name)) {
      return undefined;
    }
    if (el.propertyName && !ts.isIdentifier(el.propertyName)) return undefined;
    const imported = el.propertyName
      ? el.propertyName.text
      : el.name.text;
    const local = el.name.text;
    if (imported !== local) return undefined;
    names.push(local);
  }
  return names;
}

function collectExistingImports(sf) {
  /** @type {Map<string, { named: Set<string>, types: Set<string>, ns: string[], defaults: string[], nodes: any[] }>} */
  const map = new Map();
  const ensure = (spec) => {
    if (!map.has(spec)) {
      map.set(spec, {
        named: new Set(),
        types: new Set(),
        ns: [],
        defaults: [],
        nodes: [],
      });
    }
    return map.get(spec);
  };

  for (const stmt of sf.statements) {
    if (!ts.isImportDeclaration(stmt) || !ts.isStringLiteralLike(stmt.moduleSpecifier)) {
      continue;
    }
    const spec = stmt.moduleSpecifier.text;
    const rec = ensure(spec);
    rec.nodes.push(stmt);
    const clause = stmt.importClause;
    if (!clause) continue;
    const typeOnly = !!clause.isTypeOnly;
    if (clause.name) rec.defaults.push(clause.name.text);
    const nb = clause.namedBindings;
    if (!nb) continue;
    if (ts.isNamespaceImport(nb)) {
      rec.ns.push(nb.name.text);
      continue;
    }
    for (const el of nb.elements) {
      const local = el.name.text;
      if (typeOnly || el.isTypeOnly) rec.types.add(local);
      else rec.named.add(local);
    }
  }
  return map;
}

function leadingImportEnd(sf) {
  let last = 0;
  for (const stmt of sf.statements) {
    if (ts.isImportDeclaration(stmt) || ts.isImportEqualsDeclaration(stmt)) {
      last = stmt.end;
      continue;
    }
    break;
  }
  if (last > 0) return last;
  const trivia = sf.getFullText().slice(0, sf.statements[0]?.getStart(sf) ?? 0);
  return trivia.length;
}

function importTypeInfo(node) {
  if (!ts.isImportTypeNode(node) || node.isTypeOf) return undefined;
  const arg = node.argument;
  if (!ts.isLiteralTypeNode(arg) || !ts.isStringLiteralLike(arg.literal)) {
    return undefined;
  }
  if (!node.qualifier || !ts.isIdentifier(node.qualifier)) return undefined;
  return { specifier: arg.literal.text, name: node.qualifier.text, node };
}

function consumeTrailingNl(text, end) {
  if (text.startsWith("\r\n", end)) return end + 2;
  if (text[end] === "\n") return end + 1;
  return end;
}

/** Whole-line span so removing a statement does not leave its indent behind. */
function statementSpan(sf, stmt) {
  const text = sf.getFullText();
  let start = stmt.getStart(sf);
  const lineStart = text.lastIndexOf("\n", start - 1) + 1;
  if (text.slice(lineStart, start).trim() === "") start = lineStart;
  return { start, end: consumeTrailingNl(text, stmt.end) };
}

function importElementText(el) {
  const local = el.name.text;
  const imported = el.propertyName ? el.propertyName.getText() : local;
  const typePrefix = el.isTypeOnly ? "type " : "";
  if (imported !== local) return `${typePrefix}${imported} as ${local}`;
  return `${typePrefix}${local}`;
}

function sortImportNames(names) {
  return [...new Set(names)].sort((a, b) =>
    a.replace(/^type /, "").localeCompare(b.replace(/^type /, "")),
  );
}

/**
 * Splice newly hoisted names into an existing import from the same module
 * (original offsets — apply in the same edit pass as removals).
 */
function mergeIntoExistingEdits(existing, needed) {
  const edits = [];
  for (const [spec, extra] of needed) {
    const rec = existing.get(spec);
    if (!rec) continue;
    const values = [...(extra.values ?? [])].filter(
      (n) => !rec.named.has(n) && !rec.types.has(n),
    );
    const types = [...(extra.types ?? [])].filter(
      (n) => !rec.named.has(n) && !rec.types.has(n) && !values.includes(n),
    );
    const valueNode = rec.nodes.find((n) => {
      const c = n.importClause;
      return (
        c &&
        !c.isTypeOnly &&
        c.namedBindings &&
        ts.isNamedImports(c.namedBindings)
      );
    });
    const typeNode = rec.nodes.find((n) => {
      const c = n.importClause;
      return (
        c?.isTypeOnly &&
        c.namedBindings &&
        ts.isNamedImports(c.namedBindings)
      );
    });
    if (valueNode && (values.length || types.length)) {
      const nb = valueNode.importClause.namedBindings;
      const next = sortImportNames([
        ...nb.elements.map(importElementText),
        ...values,
        ...types.map((t) => `type ${t}`),
      ]);
      extra.values = new Set();
      extra.types = new Set();
      edits.push({
        start: nb.getStart(),
        end: nb.end,
        text: `{ ${next.join(", ")} }`,
        message: `merge named imports ${spec}`,
      });
    } else if (typeNode && types.length && !values.length) {
      const nb = typeNode.importClause.namedBindings;
      const next = sortImportNames([
        ...nb.elements.map((el) => el.name.text),
        ...types,
      ]);
      extra.types = new Set();
      edits.push({
        start: nb.getStart(),
        end: nb.end,
        text: `{ ${next.join(", ")} }`,
        message: `merge type imports ${spec}`,
      });
    }
  }
  return edits;
}

function analyze(sf) {
  const existing = collectExistingImports(sf);
  const moduleNames = new Set();
  for (const rec of existing.values()) {
    for (const n of rec.named) moduleNames.add(n);
    for (const n of rec.types) moduleNames.add(n);
    for (const n of rec.ns) moduleNames.add(n);
    for (const n of rec.defaults) moduleNames.add(n);
  }

  /** @type {{ start: number, end: number, kind: string, message: string }[]} */
  const removals = [];
  /** @type {{ start: number, end: number, text: string, message: string }[]} */
  const replacements = [];
  /** @type {Map<string, { values: Set<string>, types: Set<string>, namespace?: string }>} */
  const needed = new Map();
  /** @type {any[]} */
  const lateImports = [];
  /** @type {{ line: number, message: string }[]} */
  const unfixable = [];

  const need = (spec) => {
    if (!needed.has(spec)) {
      needed.set(spec, { values: new Set(), types: new Set() });
    }
    return needed.get(spec);
  };

  const alreadyHas = (spec, name) => {
    const rec = existing.get(spec);
    if (rec && (rec.named.has(name) || rec.types.has(name))) return true;
    const extra = needed.get(spec);
    return !!(extra && (extra.values.has(name) || extra.types.has(name)));
  };

  let seenNonImport = false;
  for (const stmt of sf.statements) {
    if (ts.isImportDeclaration(stmt) || ts.isImportEqualsDeclaration(stmt)) {
      if (seenNonImport) lateImports.push(stmt);
      continue;
    }
    seenNonImport = true;
  }

  const visit = (node) => {
    const inline = importTypeInfo(node);
    if (inline && !nodeAllowed(sf, node)) {
      if (!alreadyHas(inline.specifier, inline.name) && moduleNames.has(inline.name)) {
        // Same local name already bound; just use it.
      } else if (!alreadyHas(inline.specifier, inline.name)) {
        need(inline.specifier).types.add(inline.name);
        moduleNames.add(inline.name);
      }
      replacements.push({
        start: node.getStart(sf),
        end: node.end,
        text: inline.name,
        message: `inline import type ${inline.specifier}#${inline.name}`,
      });
    }

    const spec = specifierOfImportCall(node);
    if (spec !== undefined) {
      if (nodeAllowed(sf, node)) {
        // intentional dynamic import
      } else {
        const awaitOrCall = ts.isAwaitExpression(node.parent)
          ? node.parent
          : node;
        const init = awaitOrCall.parent;
        if (
          ts.isVariableDeclaration(init) &&
          init.initializer &&
          unwrapAwait(init.initializer) === node &&
          ts.isVariableDeclarationList(init.parent) &&
          init.parent.declarations.length === 1 &&
          ts.isVariableStatement(init.parent.parent)
        ) {
          const stmt = init.parent.parent;
          const binding = init.name;
          if (ts.isIdentifier(binding)) {
            need(spec).namespace = binding.text;
            moduleNames.add(binding.text);
            removals.push({
              ...statementSpan(sf, stmt),
              kind: "dynamic",
              message: `dynamic import ${spec} as namespace ${binding.text}`,
            });
          } else {
            const names = namedBindingsFromPattern(binding);
            if (names) {
              for (const n of names) {
                if (!alreadyHas(spec, n)) need(spec).values.add(n);
                moduleNames.add(n);
              }
              removals.push({
                ...statementSpan(sf, stmt),
                kind: "dynamic",
                message: `dynamic import ${spec} { ${names.join(", ")} }`,
              });
            } else {
              const { line } = sf.getLineAndCharacterOfPosition(node.getStart(sf));
              unfixable.push({
                line: line + 1,
                message: `dynamic import of "${spec}" is not a simple binding (add // hoist-imports-allow: <reason>)`,
              });
            }
          }
        } else {
          const { line } = sf.getLineAndCharacterOfPosition(node.getStart(sf));
          unfixable.push({
            line: line + 1,
            message: `dynamic import of "${spec}" is not a statement-level binding (add // hoist-imports-allow: <reason>)`,
          });
        }
      }
    }

    ts.forEachChild(node, visit);
  };

  visit(sf);

  for (const stmt of lateImports) {
    const spec = ts.isStringLiteralLike(stmt.moduleSpecifier)
      ? stmt.moduleSpecifier.text
      : "<unknown>";
    removals.push({
      ...statementSpan(sf, stmt),
      kind: "late",
      message: `late import ${spec}`,
    });
    // Re-emit the original import text at the header.
    const rec = need(
      ts.isStringLiteralLike(stmt.moduleSpecifier)
        ? stmt.moduleSpecifier.text
        : spec,
    );
    rec.raw = rec.raw ?? [];
    rec.raw.push(sf.getFullText().slice(stmt.getStart(sf), stmt.end));
  }

  return { existing, needed, removals, replacements, unfixable, lateImports };
}

function formatNamedList(names, typeOnlyEach = false) {
  const sorted = [...names].sort((a, b) => a.localeCompare(b));
  const inner = sorted
    .map((n) => (typeOnlyEach ? `type ${n}` : n))
    .join(", ");
  return `{ ${inner} }`;
}

function extraImportLines(existing, needed) {
  const lines = [];
  const byName = (a, b) =>
    a.replace(/^type /, "").localeCompare(b.replace(/^type /, ""));
  for (const [spec, extra] of needed) {
    const rec = existing.get(spec);
    const have = rec ? new Set([...rec.named, ...rec.types]) : new Set();
    if (extra.raw) {
      for (const raw of extra.raw) lines.push(raw);
    }
    if (extra.namespace && !(rec && rec.ns.includes(extra.namespace))) {
      lines.push(`import * as ${extra.namespace} from ${JSON.stringify(spec)};`);
    }
    const values = [...(extra.values ?? [])].filter((n) => !have.has(n));
    const types = [...(extra.types ?? [])].filter(
      (n) => !have.has(n) && !values.includes(n),
    );
    if (values.length) {
      const named = [...values, ...types.map((t) => `type ${t}`)].sort(byName);
      lines.push(`import { ${named.join(", ")} } from ${JSON.stringify(spec)};`);
      continue;
    }
    if (types.length) {
      lines.push(
        `import type ${formatNamedList(types)} from ${JSON.stringify(spec)};`,
      );
    }
  }
  return lines;
}

function applyEdits(text, removals, replacements) {
  const edits = [
    ...removals.map((r) => ({ start: r.start, end: r.end, text: "" })),
    ...replacements.map((r) => ({ start: r.start, end: r.end, text: r.text })),
  ].sort((a, b) => b.start - a.start || b.end - a.end);

  // Drop overlapping removals (inner already covered).
  const kept = [];
  for (const e of edits) {
    if (kept.some((k) => e.start >= k.start && e.end <= k.end && (e.start !== k.start || e.end !== k.end) && k.text === "")) {
      continue;
    }
    kept.push(e);
  }

  let out = text;
  for (const e of kept) {
    out = out.slice(0, e.start) + e.text + out.slice(e.end);
  }
  return out;
}

function insertHeader(text, sf, lines) {
  if (!lines.length) return text;
  const end = leadingImportEnd(sf);
  const prefix = text.slice(0, end);
  const nl = prefix.endsWith("\n") ? "" : "\n";
  return prefix + nl + lines.join("\n") + "\n" + text.slice(end);
}

function processFile(path) {
  const text = readFileSync(path, "utf8");
  const sf = ts.createSourceFile(
    path,
    text,
    ts.ScriptTarget.Latest,
    true,
    SCRIPT_KIND[extname(path)] ?? ts.ScriptKind.TS,
  );
  const result = analyze(sf);
  const hits = [
    ...result.removals.map((r) => r.message),
    ...result.replacements.map((r) => r.message),
    ...result.unfixable.map((u) => u.message),
  ];
  if (!hits.length) {
    return { path, changed: false, hits, unfixable: result.unfixable };
  }

  if (!fix) {
    return { path, changed: false, hits, unfixable: result.unfixable };
  }

  const mergeEdits = mergeIntoExistingEdits(result.existing, result.needed);
  const lines = extraImportLines(result.existing, result.needed);
  let next = applyEdits(text, result.removals, [
    ...result.replacements,
    ...mergeEdits,
  ]);
  const headerLines = lines;
  if (headerLines.length) {
    const sf2 = ts.createSourceFile(
      path,
      next,
      ts.ScriptTarget.Latest,
      true,
      SCRIPT_KIND[extname(path)] ?? ts.ScriptKind.TS,
    );
    next = insertHeader(next, sf2, headerLines);
  }

  if (next !== text) {
    writeFileSync(path, next);
    return { path, changed: true, hits, unfixable: [] };
  }
  return { path, changed: false, hits, unfixable: [] };
}

function rel(path) {
  return relative(ROOT, path).split("\\").join("/");
}

const files = listFiles();
let dirty = 0;
let changed = 0;
let blocked = 0;

for (const file of files) {
  const result = processFile(file);
  if (!result.hits.length) continue;
  dirty++;
  const loc = rel(result.path);
  if (result.unfixable.length && (fix || !result.hits.length)) {
    blocked++;
  }
  for (const u of result.unfixable) {
    console.error(`${loc}:${u.line}: ${u.message}`);
    blocked++;
  }
  if (!result.unfixable.length) {
    for (const h of result.hits) {
      console.log(`${fix ? (result.changed ? "fixed" : "ok") : "need"}  ${loc}: ${h}`);
    }
  }
  if (result.changed) changed++;
}

if (!fix && dirty) {
  console.error(
    `\nhoist-imports: ${dirty} file(s) have in-body imports. Run \`node ./scripts/hoist-imports.mjs --fix\`.`,
  );
  process.exit(1);
}

if (fix && blocked) {
  console.error(
    `\nhoist-imports: ${blocked} dynamic import(s) need // hoist-imports-allow: <reason>`,
  );
  process.exit(1);
}

console.log(
  fix
    ? `hoist-imports: rewrote ${changed} file(s)`
    : "hoist-imports: all imports are at the file header",
);
