import assert from 'node:assert/strict';
import test from 'node:test';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { decodeSyntheticLedger, deriveSourceLedger, SOURCE_BINDINGS, SOURCE_REF, PARSER_VERSION } from './business-source-ledger-oracle.mjs';

const SCHEMA = 'src/lib/db/schema.ts', DEFINITIONS = 'src/lib/db/migration-definitions.ts';
const hash = text => createHash('sha256').update(Buffer.from(text, 'utf8')).digest('hex');
function pair(schema, definitions) { return { [SCHEMA]: schema, [DEFINITIONS]: definitions }; }
function fixture(sql, schema = 'export const SEED = "SELECT 1;";') {
  return pair(schema, `import { SEED } from './schema.js'; export const MIGRATIONS = [{version:'v1',sql:${sql}}];`);
}
function unresolved(texts, code) {
  const result = decodeSyntheticLedger(texts, ['v1']);
  assert.equal(result.completeLedger, false); assert.equal(result.qualification, false);
  assert.equal(result.rows[0].checksum, null); assert.match(result.unresolved[0].code, code);
}
test('literal SQL and UTF-8 checksum are source data, never golden', () => {
  const sql = "SELECT 'é😀';\n";
  const result = decodeSyntheticLedger(fixture(JSON.stringify(sql)), ['v1']);
  assert.deepEqual(result.rows, [{ordinal:1,version:'v1',sqlBytes:Buffer.byteLength(sql),checksum:hash(sql)}]);
  assert.equal(result.sourceBound, false); assert.equal(result.domain, 'synthetic-expression-tests');
  assert.equal(result.completeLedger, true); assert.equal(result.fullSemanticCompleteness, false);
  assert.equal(result.qualification, false); assert.equal(result.golden, 'UNKNOWN');
  assert.equal(result.expected_native_descriptor_sha256, null); assert.equal(result.parser.version, PARSER_VERSION);
});
test('cooked escapes and no-substitution template preserve newlines', () => {
  const schema = String.raw`export const SEED = "A\n\x42\u0043\u{1f600}";`;
  const result = decodeSyntheticLedger(fixture('SEED', schema), ['v1']);
  assert.equal(result.rows[0].checksum, hash('A\nBC😀'));
  const template = decodeSyntheticLedger(fixture('`A\nB`'), ['v1']);
  assert.equal(template.rows[0].checksum, hash('A\nB'));
});
test('immutable imports, aliases and const assertion resolve without imports executing', () => {
  const result = decodeSyntheticLedger(pair('export const ROOT="SELECT 1;"; export const ALIAS=ROOT;',
    `import { ALIAS as SQL } from './schema.js'; export const MIGRATIONS=[{version:'v1',sql:SQL}] as const;`), ['v1']);
  assert.equal(result.rows[0].checksum, hash('SELECT 1;')); assert.equal(result.completeLedger, true);
});
test('v17 string transform semantics are first literal occurrence, not regex/replaceAll', () => {
  // Manually justified: replacing the first of two identical literal substrings keeps the second.
  const result = decodeSyntheticLedger(pair('export const BASE="old old"; export const LEGACY=BASE.replace("old","new");',
    `import {LEGACY} from './schema.js'; export const MIGRATIONS=[{version:'v1',sql:LEGACY}];`), ['v1']);
  assert.equal(result.rows[0].checksum, hash('new old'));
  const absent = decodeSyntheticLedger(pair('export const BASE="old"; export const LEGACY=BASE.replace("absent","new");',
    `import {LEGACY} from './schema.js'; export const MIGRATIONS=[{version:'v1',sql:LEGACY}];`), ['v1']);
  assert.equal(absent.rows[0].checksum, hash('old'));
});
test('hidden suffix and unsupported operators do not silently truncate SQL', () => {
  for (const expression of ['SEED + "hidden"', 'SEED.trim()', 'SEED.replaceAll("SELECT","DROP")',
    'SEED.replace(/SELECT/g,"DROP")', 'SEED.replace("SELECT","$&")', 'SEED.replace("","x")',
    'SEED["replace"]("SELECT","DROP")', 'SEED.replace("SELECT",()=>"DROP")', 'SEED?.replace("SELECT","DROP")']) {
    unresolved(fixture(expression), /unsupported|unknown|literal/);
  }
});
test('template interpolation, arbitrary call, missing immutable identifier fail closed', () => {
  unresolved(fixture('`SELECT ${SEED}`'), /interpolation/);
  unresolved(fixture('process.env.SQL'), /unsupported/);
  unresolved(fixture('unknown()'), /unknown/);
  unresolved(fixture('MISSING'), /missing_identifier/);
});
test('complete syntax parse rejects malformed trailing source and runtime control flow', () => {
  assert.throws(() => decodeSyntheticLedger(fixture('SEED +'), ['v1']), /syntax/);
  const valid = fixture('SEED');
  valid[DEFINITIONS] += ' if (true) { throw new Error("hidden"); }';
  assert.throws(() => decodeSyntheticLedger(valid, ['v1']), /top_level/);
  const sideEffect = fixture('SEED'); sideEffect[DEFINITIONS] += ' unknown();';
  assert.throws(() => decodeSyntheticLedger(sideEffect, ['v1']), /top_level/);
  const unused = fixture('SEED'); unused[DEFINITIONS] += ' const HIDDEN=unknown();';
  const result = decodeSyntheticLedger(unused, ['v1']);
  assert.equal(result.completeLedger,false); assert.equal(result.qualification,false);
  assert.ok(result.unresolved.some(x=>x.identifier==='HIDDEN' && x.code==='unsupported_declaration_expression'));
});
test('duplicate ID, missing ID, duplicate property or definition never produce complete ledger', () => {
  assert.throws(() => decodeSyntheticLedger(pair('', "export const MIGRATIONS=[{version:'v1',sql:'A'},{version:'v1',sql:'B'}];"), ['v1']), /duplicate/);
  assert.throws(() => decodeSyntheticLedger(fixture('SEED'), ['v1','v2']), /version_order/);
  assert.throws(() => decodeSyntheticLedger(pair('', "export const MIGRATIONS=[{version:'v1',version:'v2',sql:'A'}];"), ['v1']), /property_shape/);
  assert.throws(() => decodeSyntheticLedger(pair('export const X="A"; export const X="B";', "export const MIGRATIONS=[];"), []), /duplicate_definition/);
  assert.throws(() => decodeSyntheticLedger(pair('', "export const MIGRATIONS=[{version:'v1'}];"), ['v1']), /property_missing/);
});
test('identifier/import cycles and namespace/path imports fail closed', () => {
  unresolved(fixture('SEED', 'export const SEED=OTHER; export const OTHER=SEED;'), /identifier_cycle/);
  assert.throws(() => decodeSyntheticLedger(pair(`import {MIGRATIONS} from './migration-definitions.js'; export const SEED='A';`,
    `import {SEED} from './schema.js'; export const MIGRATIONS=[{version:'v1',sql:SEED}];`), ['v1']), /import_cycle/);
  assert.throws(() => decodeSyntheticLedger(pair('', "import * as ns from './schema.js'; export const MIGRATIONS=[];"), []), /unsupported_import/);
  assert.throws(() => decodeSyntheticLedger(pair('', "import {x} from 'node:fs'; export const MIGRATIONS=[];"), []), /unsupported_import/);
});
test('unused missing identifiers, cycles and missing named exports prevent completeness', () => {
  for (const suffix of ['const UNUSED=MISSING;', 'const A=B; const B=A;']) {
    const texts = fixture('SEED'); texts[SCHEMA] += suffix;
    const result = decodeSyntheticLedger(texts, ['v1']);
    assert.equal(result.completeLedger,false); assert.equal(result.qualification,false);
    assert.ok(result.unresolved.some(x=>/missing_identifier|identifier_cycle/.test(x.code)));
    assert.equal(result.rows[0].checksum,hash('SELECT 1;'));
  }
  const texts = fixture('SEED'); texts[DEFINITIONS] += " import {MISSING as UNUSED} from './schema.js';";
  const result = decodeSyntheticLedger(texts,['v1']);
  assert.equal(result.completeLedger,false); assert.ok(result.unresolved.some(x=>/missing_export/.test(x.code)));
});
test('only actual definitions root exempts MIGRATIONS arrays; schema same-name call fails closed', () => {
  const valid = fixture('SEED');
  const control = decodeSyntheticLedger(valid,['v1']);
  assert.equal(control.completeLedger,true); assert.equal(control.qualification,false);
  const schemaArray = {...valid,[SCHEMA]:valid[SCHEMA]+' const MIGRATIONS=[unknown()];'};
  const rejected = decodeSyntheticLedger(schemaArray,['v1']);
  assert.equal(rejected.completeLedger,false); assert.equal(rejected.qualification,false);
  assert.equal(rejected.rows[0].checksum,control.rows[0].checksum);
  assert.ok(rejected.unresolved.some(x=>x.path===SCHEMA && x.identifier==='MIGRATIONS' &&
    (x.code==='unsupported_declaration_expression' || x.code.startsWith('unsupported_expression:'))));
});
test('frozen source identities are deep immutable and callers cannot choose hashes', () => {
  assert.throws(() => { SOURCE_BINDINGS[SCHEMA][0]='wrong'; }, TypeError);
  assert.throws(() => deriveSourceLedger({ref:'wrong',sources:{}}), /ref_drift/);
  assert.throws(() => deriveSourceLedger({ref:SOURCE_REF,sources:{}}), /source_input_set/);
  const sources = Object.fromEntries(Object.keys(SOURCE_BINDINGS).map(path=>[path,readFileSync(resolve(path))]));
  const altered = {...sources,[SCHEMA]:Buffer.from(sources[SCHEMA])}; altered[SCHEMA][0]^=1;
  assert.throws(() => deriveSourceLedger({ref:SOURCE_REF,sources:altered}), /hash_drift/);
  assert.throws(() => deriveSourceLedger({ref:SOURCE_REF,sources:{...sources,extra:Buffer.alloc(0)}}), /source_input_set/);
});
test('genuine pinned v17 source tail resolves but does not grant semantic/native qualification', () => {
  const sources = Object.fromEntries(Object.keys(SOURCE_BINDINGS).map(path=>[path,readFileSync(resolve(path))]));
  const result = deriveSourceLedger({ref:SOURCE_REF,sources});
  assert.equal(result.sourceBound,true); assert.equal(result.rows.length,48);
  assert.equal(result.rows[16].version,'20260823_17_integrity_anchors');
  assert.match(result.rows[16].checksum,/^[a-f0-9]{64}$/);
  assert.equal(result.fullSemanticCompleteness,false); assert.equal(result.qualification,false);
  assert.equal(result.golden,'UNKNOWN'); assert.equal(result.expected_native_descriptor_sha256,null);
  // Reachable unsupported interpolation stays explicit; no actual complete-ledger/native assertion.
  assert.equal(result.completeLedger,result.unresolved.length===0);
  assert.equal(result.completeLedger,false);
  assert.ok(result.unresolved.some(x=>x.path===SCHEMA && x.identifier==='citationCheckTableSql' && x.code==='unsupported_function_declaration'));
});
test('unpinned function declarations and function-binding collisions do not broaden grammar', () => {
  for (const declaration of ['export function citationCheckTableSql(){return "A";}',
    'export async function citationCheckTableSql(){return "A";}', 'export function* citationCheckTableSql(){yield "A";}',
    'export function OTHER(){return "A";}', 'const citationCheckTableSql="A"; export function citationCheckTableSql(){return "B";}',
    'import {SEED as citationCheckTableSql} from "./migration-definitions.js"; export function citationCheckTableSql(){return "A";}']) {
    const texts=fixture('SEED'); texts[SCHEMA]+=' '+declaration;
    assert.throws(()=>decodeSyntheticLedger(texts,['v1']),/unsupported_top_level|duplicate_definition/);
  }
  const texts=fixture('SEED'); texts[DEFINITIONS]+=' export function citationCheckTableSql(){return "A";}';
  assert.throws(()=>decodeSyntheticLedger(texts,['v1']),/unsupported_top_level/);
});
test('accessor inputs are rejected, not invoked to fabricate source facts', () => {
  let reads=0; const input={ref:SOURCE_REF}; Object.defineProperty(input,'sources',{enumerable:true,get(){reads++;return{};}});
  assert.throws(()=>deriveSourceLedger(input),/accessor/); assert.equal(reads,0);
});
