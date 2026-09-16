/** CSV is a human entry surface only; the receipt continues to bind the immutable pair hashes. */
import type { ConsistencyBlindReviewerSubmission, ConsistencyLabel, NegativeType } from "./a1-consistency-label-receipt.js";
import type { BlindWorklistRow } from "./a1-consistency-label-blind-worklist.js";

export const BLIND_LABEL_CSV_HEADERS = [
  "case_id", "pair_sha256", "statement", "source_text", "expected_consistency", "negative_type",
] as const;

type BlindLabelCsvRow = Record<(typeof BLIND_LABEL_CSV_HEADERS)[number], string>;

/** Defend spreadsheet viewers against formula execution while leaving the visible source literal. */
export function spreadsheetLiteral(value: string): string {
  return /^[\t\r\n ]*[=+\-@]/u.test(value) ? `'${value}` : value;
}

function csvCell(value: string): string {
  return `"${value.replaceAll('"', '""')}"`;
}

export function renderCsv(rows: readonly (readonly string[])[]): string {
  return `\uFEFF${rows.map((row) => row.map(csvCell).join(",")).join("\n")}\n`;
}

/** Strict enough for the CSV shape we create: quoted cells, escaped quotes, and embedded newlines. */
export function parseCsv(text: string): string[][] {
  const input = text.startsWith("\uFEFF") ? text.slice(1) : text;
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let quoted = false;
  for (let index = 0; index < input.length; index += 1) {
    const char = input[index]!;
    if (quoted) {
      if (char === '"') {
        if (input[index + 1] === '"') { cell += '"'; index += 1; }
        else quoted = false;
      } else cell += char;
      continue;
    }
    if (char === '"') {
      if (cell) throw new Error(`CSV 第 ${rows.length + 1} 行含未转义双引号`);
      quoted = true;
    } else if (char === ",") {
      row.push(cell); cell = "";
    } else if (char === "\n" || char === "\r") {
      if (char === "\r" && input[index + 1] === "\n") index += 1;
      row.push(cell); cell = "";
      if (row.some((value) => value)) rows.push(row);
      row = [];
    } else cell += char;
  }
  if (quoted) throw new Error("CSV 含未闭合的双引号");
  if (cell || row.length) { row.push(cell); rows.push(row); }
  return rows;
}

function expectedDisplay(value: string): string[] {
  const literal = spreadsheetLiteral(value);
  return literal === value ? [value] : [value, literal];
}

function validLabel(value: string): value is ConsistencyLabel {
  return value === "support" || value === "not_support" || value === "uncertain";
}

function validNegativeType(value: string): value is NegativeType {
  return value === "exaggeration" || value === "out_of_context" || value === "misattribution";
}

export function makeBlindLabelCsv(worklist: readonly BlindWorklistRow[]): string {
  const rows = [
    [...BLIND_LABEL_CSV_HEADERS],
    ...worklist.map((entry) => [
      entry.id, entry.pair_sha256, spreadsheetLiteral(entry.statement), spreadsheetLiteral(entry.source_text), "", "",
    ]),
  ];
  return renderCsv(rows);
}

function parsedRows(text: string): BlindLabelCsvRow[] {
  const rows = parseCsv(text);
  const [header, ...values] = rows;
  if (!header || header.length !== BLIND_LABEL_CSV_HEADERS.length
    || header.some((value, index) => value !== BLIND_LABEL_CSV_HEADERS[index])) {
    throw new Error(`CSV 表头必须精确为 ${BLIND_LABEL_CSV_HEADERS.join(",")}`);
  }
  return values.map((row, index) => {
    if (row.length !== header.length) throw new Error(`CSV 第 ${index + 2} 行列数不正确`);
    return Object.fromEntries(header.map((column, columnIndex) => [column, row[columnIndex]!])) as BlindLabelCsvRow;
  });
}

/**
 * Convert one completed CSV into one human submission. It validates both the pair hash and the
 * read-only statement/source cells, so a spreadsheet edit cannot silently change the evidence.
 */
export function blindLabelCsvToSubmission(
  worklist: readonly BlindWorklistRow[],
  csv: string,
  reviewerId: string,
): ConsistencyBlindReviewerSubmission {
  const normalizedReviewerId = reviewerId.trim();
  if (!normalizedReviewerId) throw new Error("reviewer_id 不可为空");
  const expected = new Map(worklist.map((entry) => [entry.id, entry]));
  if (expected.size !== worklist.length) throw new Error("blind worklist 含重复 id");
  const seen = new Set<string>();
  const decisions = parsedRows(csv).map((row, index) => {
    const caseId = row.case_id.trim();
    if (seen.has(caseId)) throw new Error(`CSV 含重复 case_id：${caseId}`);
    seen.add(caseId);
    const pair = expected.get(caseId);
    if (!pair) throw new Error(`CSV 含不属于 worklist 的 case_id：${caseId}`);
    if (row.pair_sha256.trim() !== pair.pair_sha256) throw new Error(`CSV 的 ${caseId} pair_sha256 不匹配`);
    if (!expectedDisplay(pair.statement).includes(row.statement)) throw new Error(`CSV 的 ${caseId} statement 已被修改`);
    if (!expectedDisplay(pair.source_text).includes(row.source_text)) throw new Error(`CSV 的 ${caseId} source_text 已被修改`);
    const label = row.expected_consistency.trim();
    const negativeType = row.negative_type.trim();
    if (!validLabel(label)) throw new Error(`CSV 的 ${caseId} 缺少或含无效 expected_consistency`);
    if (label === "not_support") {
      if (!validNegativeType(negativeType)) throw new Error(`CSV 的 ${caseId} 的 not_support 缺少或含无效 negative_type`);
      return { case_id: caseId, pair_sha256: pair.pair_sha256, expected_consistency: label, negative_type: negativeType };
    }
    if (negativeType) throw new Error(`CSV 的 ${caseId} 仅 not_support 可填写 negative_type`);
    return { case_id: caseId, pair_sha256: pair.pair_sha256, expected_consistency: label };
  });
  for (const id of expected.keys()) if (!seen.has(id)) throw new Error(`CSV 缺少 worklist 的 ${id}`);
  if (decisions.length !== worklist.length) throw new Error(`CSV 标注数 ${decisions.length}/${worklist.length} 不匹配`);
  return { reviewer_id: normalizedReviewerId, reviewer_kind: "human", blind_attestation: true, decisions };
}
