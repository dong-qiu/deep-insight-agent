import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import ts from 'typescript';

export const SOURCE_REF = '7dce90023f81282e6f017cb6490b33805f3461b5';
export const PARSER_VERSION = '6.0.3';
export const SOURCE_BINDINGS = Object.freeze(Object.fromEntries(Object.entries({
  'src/lib/db/schema.ts': ['8b83a8fc65c38c0267a0e0d45c9f2648b057205ea225dc3fa505fdd6b977e840', 88032],
  'src/lib/db/migration-definitions.ts': ['05e411380c333df9975914c3e1916467acb1180270de741cf3d0a19de23afc07', 40243],
  'src/lib/db/migration-runner.ts': ['f468ca2f622e4a8d0a5e7182807f2169de654493354bdec746b4f7da71af53be', 17794],
  'package-lock.json': ['63427dc25bd41f83b2db7c4842966df364b73d110d7c95c8f693b77eaebbcad2', 331379],
}).map(([path, identity]) => [path, Object.freeze(identity)])));
const SCHEMA = 'src/lib/db/schema.ts';
const DEFINITIONS = 'src/lib/db/migration-definitions.ts';
const TRANSFORM = Object.freeze({
  name: 'INTEGRITY_ANCHOR_LEGACY_SCHEMA_SQL', receiver: 'INTEGRITY_ANCHOR_SCHEMA_SQL',
  searchSHA: '6d0c2a4403784733f2a15bae2cd443e680d630321a45bf04ce1dbaf89daa96d6',
  replacementSHA: 'a1b338ef64d7b3f706f927e4e7e55a41ba0386ecbf30ec264e2cc4b326e5f973',
});
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
function fail(code) { throw new Error(code); }
function plainData(value) {
  assert.ok(value && Object.getPrototypeOf(value) === Object.prototype, 'plain_data_required');
  for (const d of Object.values(Object.getOwnPropertyDescriptors(value))) assert.ok('value' in d, 'accessor_rejected');
}
function unwrap(node) {
  // Only the data-only const assertion is accepted; casts/calls are not executable recovery.
  if (ts.isAsExpression(node)) {
    if (!ts.isTypeReferenceNode(node.type) || !ts.isIdentifier(node.type.typeName) || node.type.typeName.text !== 'const') fail('unsupported_assertion');
    return unwrap(node.expression);
  }
  return node;
}
function propertyName(node) {
  if (ts.isIdentifier(node) || ts.isStringLiteral(node)) return node.text;
  fail('computed_property_rejected');
}
function literal(node) {
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) return node.text;
  fail('literal_required');
}
function supportedShape(input, owner, path, production) {
  const node = unwrap(input);
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node) || ts.isIdentifier(node)) return true;
  if (path === DEFINITIONS && owner === 'MIGRATIONS' && ts.isArrayLiteralExpression(node)) return true;
  if (!ts.isCallExpression(node)) return false;
  const call = node.expression;
  const shape = !node.questionDotToken && !node.typeArguments?.length && ts.isPropertyAccessExpression(call) && !call.questionDotToken &&
    call.name.text === 'replace' && ts.isIdentifier(call.expression) && node.arguments.length === 2 &&
    node.arguments.every(arg => ts.isStringLiteral(arg) || ts.isNoSubstitutionTemplateLiteral(arg));
  if (!shape) return false;
  const search = literal(node.arguments[0]), replacement = literal(node.arguments[1]);
  if (!search || replacement.includes('$')) return false;
  return !production || (path === SCHEMA && owner === TRANSFORM.name && call.expression.text === TRANSFORM.receiver &&
    sha(Buffer.from(search)) === TRANSFORM.searchSHA && sha(Buffer.from(replacement)) === TRANSFORM.replacementSHA);
}
function parseModules(texts, production) {
  assert.equal(ts.version, PARSER_VERSION, 'parser_version_drift');
  plainData(texts);
  assert.deepEqual(Object.keys(texts).sort(), [DEFINITIONS, SCHEMA].sort(), 'module_set');
  const modules = new Map();
  let bytes = 0, nodes = 0;
  for (const [path, text] of Object.entries(texts)) {
    assert.equal(typeof text, 'string', 'source_text_required');
    bytes += Buffer.byteLength(text);
    assert.ok(bytes <= 1048576, 'source_byte_budget');
    const file = ts.createSourceFile(path, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
    if (file.parseDiagnostics.length) fail('source_syntax_error');
    function count(node) { if (++nodes > 20000) fail('source_node_budget'); ts.forEachChild(node, count); }
    count(file);
    const definitions = new Map(), imports = new Map(), exported = new Set(), unsupported = [];
    function reserve(name) { if (definitions.has(name) || imports.has(name)) fail('duplicate_definition:' + name); }
    for (const statement of file.statements) {
      if (ts.isInterfaceDeclaration(statement) || ts.isTypeAliasDeclaration(statement)) continue;
      if (ts.isImportDeclaration(statement)) {
        const specifier = literal(statement.moduleSpecifier), target = specifier === './schema.js' ? SCHEMA : specifier === './migration-definitions.js' ? DEFINITIONS : null;
        if (!target || statement.importClause?.name || !statement.importClause?.namedBindings || !ts.isNamedImports(statement.importClause.namedBindings)) fail('unsupported_import');
        for (const item of statement.importClause.namedBindings.elements) {
          if (statement.importClause.isTypeOnly || item.isTypeOnly) continue;
          reserve(item.name.text);
          imports.set(item.name.text, { target, name: item.propertyName?.text ?? item.name.text });
        }
        continue;
      }
      if (ts.isFunctionDeclaration(statement)) {
        // Recognize this pinned binding as unsupported data; never execute its body/defaults.
        const name = statement.name?.text, start = statement.getStart(file);
        if (!production || path !== SCHEMA || name !== 'citationCheckTableSql' || statement.asteriskToken ||
          statement.modifiers?.length !== 1 || statement.modifiers[0].kind !== ts.SyntaxKind.ExportKeyword ||
          start !== 47815 || statement.end !== 48742 ||
          sha(Buffer.from(text.slice(start, statement.end))) !== 'c87dacd68e869b4147c44339f9c18315b0d9970ff03b30f03ffaeec71dfce48d') fail('unsupported_top_level');
        reserve(name); definitions.set(name, statement); exported.add(name);
        unsupported.push({ version: null, path, identifier: name, code: 'unsupported_function_declaration' });
        continue;
      }
      if (!ts.isVariableStatement(statement) || !(statement.declarationList.flags & ts.NodeFlags.Const)) fail('unsupported_top_level');
      if (statement.modifiers?.some(m => ![ts.SyntaxKind.ExportKeyword].includes(m.kind))) fail('unsupported_modifier');
      for (const declaration of statement.declarationList.declarations) {
        if (!ts.isIdentifier(declaration.name) || !declaration.initializer) fail('unsupported_declaration');
        const name = declaration.name.text;
        reserve(name); definitions.set(name, declaration.initializer);
        if (!supportedShape(declaration.initializer, name, path, production)) unsupported.push({ version: null, path, identifier: name, code: 'unsupported_declaration_expression' });
        if (statement.modifiers?.some(m => m.kind === ts.SyntaxKind.ExportKeyword)) exported.add(name);
      }
    }
    modules.set(path, { file, definitions, imports, exported, unsupported });
  }
  function visit(path, stack = []) {
    if (stack.includes(path)) fail('import_cycle');
    for (const { target } of modules.get(path).imports.values()) visit(target, [...stack, path]);
  }
  for (const path of modules.keys()) visit(path);
  return modules;
}
function interpret(texts, { production, expectedVersions = null }) {
  const modules = parseModules(texts, production), cache = new Map(), unresolved = [...modules.values()].flatMap(m => m.unsupported);
  function resolve(path, name, stack = []) {
    const key = path + ':' + name;
    if (stack.includes(key)) fail('identifier_cycle:' + key);
    if (cache.has(key)) return cache.get(key);
    const module = modules.get(path), imported = module.imports.get(name);
    let value;
    if (imported) {
      if (!modules.get(imported.target).exported.has(imported.name)) fail('missing_export:' + imported.name);
      value = resolve(imported.target, imported.name, [...stack, key]);
    } else {
      if (!module.definitions.has(name)) fail('missing_identifier:' + name);
      value = expression(path, name, module.definitions.get(name), [...stack, key]);
    }
    cache.set(key, value); return value;
  }
  function expression(path, owner, input, stack) {
    const node = unwrap(input);
    if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) return node.text;
    if (ts.isIdentifier(node)) return resolve(path, node.text, stack);
    if (ts.isTemplateExpression(node)) fail('interpolation_rejected');
    if (ts.isCallExpression(node)) {
      const call = node.expression;
      if (node.questionDotToken || node.typeArguments?.length || !ts.isPropertyAccessExpression(call) || call.questionDotToken || call.name.text !== 'replace' || !ts.isIdentifier(call.expression) || node.arguments.length !== 2) fail('unknown_call');
      const search = literal(node.arguments[0]), replacement = literal(node.arguments[1]);
      if (!search || replacement.includes('$')) fail('unsupported_replace_semantics');
      if (production && (path !== SCHEMA || owner !== TRANSFORM.name || call.expression.text !== TRANSFORM.receiver || sha(Buffer.from(search)) !== TRANSFORM.searchSHA || sha(Buffer.from(replacement)) !== TRANSFORM.replacementSHA)) fail('transform_identity_drift');
      const value = resolve(path, call.expression.text, stack);
      // Literal-string replace substitutes the FIRST occurrence only. No regex/function evaluation.
      const index = value.indexOf(search);
      return index < 0 ? value : value.slice(0, index) + replacement + value.slice(index + search.length);
    }
    fail('unsupported_expression:' + ts.SyntaxKind[node.kind]);
  }
  const module = modules.get(DEFINITIONS), root = module.definitions.get('MIGRATIONS');
  if (!module.exported.has('MIGRATIONS') || !root) fail('missing_migrations');
  const array = unwrap(root);
  if (!ts.isArrayLiteralExpression(array)) fail('migration_array_required');
  const ids = new Set(), rows = [];
  for (const [index, element] of array.elements.entries()) {
    if (!ts.isObjectLiteralExpression(element)) fail('migration_object_required');
    const props = new Map();
    for (const p of element.properties) {
      if (!ts.isPropertyAssignment(p)) fail('migration_property_required');
      const name = propertyName(p.name);
      if (!['version', 'sql'].includes(name) || props.has(name)) fail('migration_property_shape');
      props.set(name, p.initializer);
    }
    if (props.size !== 2) fail('migration_property_missing');
    const version = literal(props.get('version'));
    if (!version || ids.has(version)) fail('duplicate_or_empty_version');
    ids.add(version);
    const row = { ordinal: index + 1, version, sqlBytes: null, checksum: null };
    try {
      const sql = expression(DEFINITIONS, 'MIGRATIONS', props.get('sql'), []);
      assert.equal(typeof sql, 'string');
      row.sqlBytes = Buffer.byteLength(sql); row.checksum = sha(Buffer.from(sql, 'utf8'));
    } catch (error) { unresolved.push({ version, code: error.message }); }
    rows.push(row);
  }
  if (production && (rows.length !== 48 || rows.some((r, i) => !/^\d{8}_\d{2}_/.test(r.version) || Number(r.version.split('_')[1]) !== i + 1))) fail('migration_order_or_count');
  if (expectedVersions && JSON.stringify(rows.map(r => r.version)) !== JSON.stringify(expectedVersions)) fail('expected_version_order');
  // Entire immutable symbol graph is checked, not only SQL-reachable names.
  for (const [path, module] of modules) {
    for (const name of [...module.definitions.keys(), ...module.imports.keys()]) {
      if (path === DEFINITIONS && name === 'MIGRATIONS' && module.definitions.has(name)) continue;
      try { resolve(path, name); }
      catch (error) { unresolved.push({ version: null, path, identifier: name, code: error.message }); }
    }
  }
  return { domain: production ? 'immutable-source-ledger' : 'synthetic-expression-tests', sourceBound: production,
    rows, unresolved, completeLedger: unresolved.length === 0, fullSemanticCompleteness: false,
    qualification: false, golden: 'UNKNOWN', expected_native_descriptor_sha256: null,
    parser: { name: 'typescript', version: ts.version }, checksumAlgorithm: 'sha256(exact cooked UTF-8 SQL)' };
}
export function decodeSyntheticLedger(texts, expectedVersions) {
  assert.ok(Array.isArray(expectedVersions) && expectedVersions.every(v => typeof v === 'string'), 'synthetic_expected_versions');
  return interpret(texts, { production: false, expectedVersions });
}
export function deriveSourceLedger(input) {
  plainData(input); assert.deepEqual(Object.keys(input).sort(), ['ref', 'sources']);
  assert.equal(input.ref, SOURCE_REF, 'source_ref_drift'); plainData(input.sources);
  assert.deepEqual(Object.keys(input.sources).sort(), Object.keys(SOURCE_BINDINGS).sort(), 'source_input_set');
  const data = {};
  for (const [path, [digest, bytes]] of Object.entries(SOURCE_BINDINGS)) {
    const raw = input.sources[path]; assert.ok(Buffer.isBuffer(raw), 'source_buffer_required');
    assert.equal(raw.length, bytes, 'source_byte_drift'); assert.equal(sha(raw), digest, 'source_hash_drift');
    const text = raw.toString('utf8'); assert.ok(Buffer.from(text).equals(raw), 'source_utf8_invalid'); data[path] = text;
  }
  const lock = JSON.parse(data['package-lock.json']);
  assert.equal(lock.packages?.['node_modules/typescript']?.version, PARSER_VERSION, 'lock_parser_drift');
  return { ...interpret({ [SCHEMA]: data[SCHEMA], [DEFINITIONS]: data[DEFINITIONS] }, { production: true }),
    sourceRef: SOURCE_REF, sourceIdentities: Object.entries(SOURCE_BINDINGS).map(([path, [sha256, bytes]]) => ({ path, sha256, bytes })) };
}
