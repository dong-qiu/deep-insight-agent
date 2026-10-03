import { existsSync, lstatSync, readFileSync, realpathSync } from "node:fs";
import { dirname, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";

// GitHub heading IDs: inline formatting is removed and duplicate slugs receive suffixes.
export function anchors(text) {
  const result = new Set(), lines = prose(text, false).split("\n");
  for (let i = 0; i < lines.length; i++) {
    const match = /^#{1,6} +(.+?) *#*$/.exec(lines[i]);
    const heading = match?.[1] ?? (lines[i].trim() && /^\s{0,3}(?:=+|-+)\s*$/.test(lines[i + 1] ?? "") ? lines[i].trim() : undefined);
    if (heading === undefined) continue;
    const slug = heading.toLowerCase().replace(/<[^>]*>/g, "").replace(/\[([^\]]+)\]\([^)]*\)/g, "$1").replace(/[^\p{L}\p{N}_\-\s]/gu, "").replace(/\s/g, "-");
    let candidate = slug, count = 0;
    while (result.has(candidate)) candidate = `${slug}-${++count}`;
    result.add(candidate);
  }
  for (const match of prose(text).matchAll(/<(?:a|h[1-6])\b[^>]*\b(?:id|name)=["']([^"']+)["']/gi)) result.add(match[1]);
  return result;
}

function prose(text, stripInline = true) {
  const lines = text.split("\n"), output = []; let fence, indented = false, list = false, previousBlank = true;
  for (const line of lines) {
    const blank = !line.trim();
    if (!fence && /^\s{0,3}(?:[-+*]|\d+[.)])\s/.test(line)) list = true;
    else if (!fence && !blank && /^\S/.test(line)) list = false;
    const codeIndent = list ? /^(?: {8}|\t\t)/ : /^(?: {4}|\t)/;
    if (!fence && codeIndent.test(line) && (indented || previousBlank)) {
      output.push(""); indented = true; previousBlank = false; continue;
    }
    if (!blank) indented = false;
    const m = /^\s{0,3}(`{3,}|~{3,})/.exec(line);
    if (m) {
      if (!fence) fence = m[1];
      else if (m[1][0] === fence[0] && m[1].length >= fence.length) fence = undefined;
      output.push("");
    } else output.push(fence ? "" : line);
    previousBlank = blank;
  }
  if (fence) throw new Error("unclosed fenced block");
  const result = output.join("\n");
  // Match complete delimiter runs of equal length, including multiline code spans.
  return stripInline ? result.replace(/(?<!`)(`+)(?!`)[\s\S]*?(?<!`)\1(?!`)/g, m => m.replace(/[^\n]/g, " ")) : result;
}

export function checkDocuments(root, scope) {
  if (scope.mode !== "docs" || !scope.changes?.length) throw new Error("docs check requires a nonempty docs scope");
  const files = [...new Set(scope.changes.filter(c => c.newMode !== "000000").map(c => c.paths.at(-1)))];
  // Recheck inbound links too: deletion/rename/heading removal must not leave dangling links.
  const targets = new Set(scope.changes.flatMap(c => c.paths));
  const candidates = execFileSync("git", ["ls-files", "-z"], { cwd: root, encoding: "utf8" }).split("\0");
  const check = new Set([...files, ...candidates.filter(p => p.endsWith(".md"))]);
  for (const file of check) {
    const abs = resolve(root, file);
    if (!existsSync(abs)) continue;
    if (!lstatSync(abs).isFile() || lstatSync(abs).isSymbolicLink()) throw new Error(`nonordinary document: ${file}`);
    const text = readFileSync(abs, "utf8"), body = prose(text);
    if (files.includes(file)) {
      if (!text.endsWith("\n") || /\r|\t|[ \t]+$/m.test(text)) throw new Error(`format: ${file}`);
      if (!/^# +\S|^\S[^\n]*\n={2,}\s*$/m.test(body)) throw new Error(`missing title: ${file}`);
      if (file.startsWith("docs/verify/") && !/^## +\S|^\S[^\n]*\n-{2,}\s*$/m.test(body)) throw new Error(`missing receipt sections: ${file}`);
      if (/docs\/verify\/pr-delivery-efficiency-\d+-/.test(file)) {
        for (const section of ["范围", "本地验证", "独立审查", "证据与限制", "回退"]) {
          if (!body.includes(`## ${section}\n`)) throw new Error(`receipt missing ${section}: ${file}`);
        }
      }
    }
    const destination = link => link.replace(/^<|>$/g, "");
    const refs = new Map([...body.matchAll(/^\s{0,3}\[([^\]]+)\]:\s*(<[^>\n]+>|\S+)/gm)].map(m => [m[1].toLowerCase(), destination(m[2])]));
    const links = [...body.matchAll(/!?\[[^\]]*\]\(\s*(<[^>]+>|[^\s)]+)(?:\s+["'][^)]*)?\s*\)/g)].map(m => m[1].replace(/^<|>$/g, ""));
    for (const m of body.matchAll(/\[([^\]]+)\]\[([^\]]*)\]/g)) {
      const link = refs.get((m[2] || m[1]).toLowerCase());
      if (!link && files.includes(file)) throw new Error(`undefined link reference: ${file}`);
      if (link) links.push(link);
    }
    links.push(...refs.values());
    for (const link of links) {
      if (/^(?:[a-z][a-z0-9+.-]*:|\/\/)/i.test(link)) continue;
      const [path, hash] = link.split("#");
      const target = path ? resolve(dirname(abs), decodeURIComponent(path.split("?")[0])) : abs;
      if (!files.includes(file) && !targets.has(relative(root, target))) continue;
      if (!existsSync(target)) throw new Error(`broken link: ${file} -> ${link}`);
      const rel = relative(realpathSync(root), realpathSync(target));
      if (rel.startsWith("..") || rel.startsWith("/")) throw new Error(`link outside repository: ${file}`);
      if (hash && target.endsWith(".md") && !anchors(readFileSync(target, "utf8")).has(decodeURIComponent(hash))) throw new Error(`broken anchor: ${file} -> ${link}`);
    }
  }
  return files.length;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const scope = JSON.parse(readFileSync(process.argv[2], "utf8"));
  const started = Date.now();
  const count = checkDocuments(process.cwd(), scope);
  console.log(`Documentation only: ${count} files; elapsed_ms=${Date.now() - started}; no build/Docker evidence`);
}
