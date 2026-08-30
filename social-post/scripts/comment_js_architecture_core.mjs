/** Pure parsing, graph, role, and evidence primitives for the JS architecture gate. */

import { createHash } from "node:crypto";
import { extname, posix } from "node:path";

import {
  ALLOWED_ROLE_TARGETS,
  EXPECTED_INVENTORY,
  EXPECTED_MODULE_ROLES,
  FIXTURE_ALLOWED_NODE_IMPORTS,
  FIXTURE_ALLOWED_PROCESS_MEMBERS,
  FIXTURE_E2E_DIRECT_TARGETS,
  FIXTURE_EVIDENCE_FORBIDDEN_NODE_IMPORTS,
  FIXTURE_EVIDENCE_MODULE_CLOSURE,
  FIXTURE_FS_PROMISES_BINDINGS,
  FIXTURE_PUBLIC_FUNCTIONS,
  REVIEWED_EXTERNAL_DYNAMIC_IMPORTS,
  REVIEWED_EXTERNAL_IMPORTS,
  REQUIRED_EDGES,
  moduleRoleFor,
} from "./comment_js_architecture_contract.mjs";
import { loaderSyntaxAt } from "./comment_js_architecture_loaders.mjs";

export function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function canonicalValue(value) {
  if (Array.isArray(value)) return value.map(canonicalValue);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.keys(value).sort().map(
      (key) => [key, canonicalValue(value[key])],
    ));
  }
  return value;
}

export function digest(value) {
  return sha256(JSON.stringify(canonicalValue(value)));
}

function quotedEnd(source, start, quote) {
  let index = start + 1;
  while (index < source.length) {
    if (source[index] === "\\") index += 2;
    else if (source[index] === quote) return index + 1;
    else index += 1;
  }
  return source.length;
}

function commentEnd(source, start) {
  if (source[start + 1] === "/") {
    const end = source.indexOf("\n", start + 2);
    return end === -1 ? source.length : end;
  }
  const end = source.indexOf("*/", start + 2);
  return end === -1 ? source.length : end + 2;
}

function regularExpressionEnd(source, start) {
  let index = start + 1;
  let inCharacterClass = false;
  while (index < source.length) {
    const char = source[index];
    if (char === "\\") index += 2;
    else if (char === "[") {
      inCharacterClass = true;
      index += 1;
    } else if (char === "]") {
      inCharacterClass = false;
      index += 1;
    } else if (char === "/" && !inCharacterClass) {
      index += 1;
      while (/[A-Za-z]/u.test(source[index] ?? "")) index += 1;
      return index;
    } else index += 1;
  }
  return source.length;
}

function templateExpressionEnd(source, start) {
  let index = start;
  let depth = 1;
  let canStartExpression = true;
  while (index < source.length) {
    const char = source[index];
    if (/\s/u.test(char)) index += 1;
    else if (char === "'" || char === "\"") {
      index = quotedEnd(source, index, char);
      canStartExpression = false;
    } else if (char === "`") {
      index = templateLiteral(source, index).end;
      canStartExpression = false;
    }
    else if (char === "/" && ["/", "*"].includes(source[index + 1])) {
      index = commentEnd(source, index);
    } else if (char === "/" && canStartExpression) {
      index = regularExpressionEnd(source, index);
      canStartExpression = false;
    } else if (char === "{") {
      depth += 1;
      index += 1;
      canStartExpression = true;
    } else if (char === "}") {
      depth -= 1;
      if (depth === 0) return index;
      index += 1;
      canStartExpression = false;
    } else if (/[A-Za-z0-9_$]/u.test(char)) {
      while (/[A-Za-z0-9_$]/u.test(source[index] ?? "")) index += 1;
      canStartExpression = false;
    } else {
      canStartExpression = ![")", "]"].includes(char);
      index += char === "\\" ? 2 : 1;
    }
  }
  return source.length;
}

function templateLiteral(source, start) {
  const expressions = [];
  let index = start + 1;
  while (index < source.length) {
    if (source[index] === "\\") {
      index += 2;
    } else if (source[index] === "`") {
      return { end: index + 1, expressions };
    } else if (source[index] === "$" && source[index + 1] === "{") {
      const expressionStart = index + 2;
      const expressionEnd = templateExpressionEnd(source, expressionStart);
      expressions.push(source.slice(expressionStart, expressionEnd));
      index = expressionEnd < source.length ? expressionEnd + 1 : expressionEnd;
    } else index += 1;
  }
  return { end: source.length, expressions };
}

function tokenize(source) {
  const tokens = [];
  let index = 0;
  let line = 1;
  let lineStart = true;
  const advance = () => {
    const char = source[index];
    index += 1;
    if (char === "\n") {
      line += 1;
      lineStart = true;
    }
    return char;
  };
  const skipQuoted = (quote, emitToken = false) => {
    const startLine = line;
    const startsLine = lineStart;
    let value = "";
    advance();
    lineStart = false;
    while (index < source.length) {
      const char = advance();
      if (char === "\\") {
        if (index < source.length) value += advance();
      } else if (char === quote) {
        break;
      } else {
        value += char;
      }
    }
    if (emitToken) {
      tokens.push({ type: "string", value, line: startLine, lineStart: startsLine });
    }
  };
  while (index < source.length) {
    const char = source[index];
    if (/\s/u.test(char)) {
      advance();
      continue;
    }
    if (char === "/" && source[index + 1] === "/") {
      while (index < source.length && source[index] !== "\n") advance();
      continue;
    }
    if (char === "/" && source[index + 1] === "*") {
      advance();
      advance();
      while (index < source.length
             && !(source[index] === "*" && source[index + 1] === "/")) advance();
      if (index < source.length) {
        advance();
        advance();
      }
      continue;
    }
    if (char === "'" || char === "\"") {
      skipQuoted(char, true);
      lineStart = false;
      continue;
    }
    if (char === "`") {
      const template = templateLiteral(source, index);
      for (const expression of template.expressions) tokens.push(...tokenize(expression));
      while (index < template.end) advance();
      lineStart = false;
      continue;
    }
    const startsLine = lineStart;
    if (/[A-Za-z_$]/u.test(char)) {
      let value = "";
      const tokenLine = line;
      while (index < source.length && /[A-Za-z0-9_$]/u.test(source[index])) {
        value += advance();
      }
      tokens.push({ type: "identifier", value, line: tokenLine, lineStart: startsLine });
      lineStart = false;
      continue;
    }
    tokens.push({ type: "punct", value: advance(), line, lineStart: startsLine });
    lineStart = false;
  }
  return tokens;
}

function findFromSpecifier(tokens, start, current) {
  for (let cursor = start; cursor < tokens.length; cursor += 1) {
    const token = tokens[cursor];
    if (token.type === "punct" && token.value === ";") break;
    if (token.type === "identifier" && token.value === "from"
        && tokens[cursor + 1]?.type === "string") {
      return { kind: "static", specifier: tokens[cursor + 1].value, line: current.line };
    }
  }
  return null;
}

export function parseStaticModuleSpecifiers(source) {
  const tokens = tokenize(source);
  const found = [];
  for (let index = 0; index < tokens.length; index += 1) {
    const current = tokens[index];
    const loader = loaderSyntaxAt(tokens, index);
    if (loader) {
      const argument = loader.argumentOffset === null
        ? null : tokens[index + loader.argumentOffset];
      found.push({
        kind: loader.kind,
        specifier: argument?.type === "string" ? argument.value : null,
        line: current.line,
      });
      continue;
    }
    if (current.type !== "identifier") continue;
    const next = tokens[index + 1];
    if (current.value === "import") {
      if (!next || (next.type === "punct" && next.value === ".")) continue;
      if (next.type === "punct" && next.value === "(") {
        found.push({
          kind: "dynamic",
          specifier: tokens[index + 2]?.type === "string"
            ? tokens[index + 2].value : null,
          line: current.line,
        });
      } else if (next.type === "string") {
        found.push({ kind: "static", specifier: next.value, line: current.line });
      } else {
        const specifier = findFromSpecifier(tokens, index + 1, current);
        if (specifier) found.push(specifier);
      }
    } else if (current.value === "export" && next?.type === "punct"
               && ["*", "{"].includes(next.value)) {
      const specifier = findFromSpecifier(tokens, index + 1, current);
      if (specifier) found.push(specifier);
    }
  }
  return found;
}

function namedImportBindings(source, wantedSpecifier) {
  const tokens = tokenize(source);
  const records = [];
  for (let index = 0; index < tokens.length; index += 1) {
    if (tokens[index]?.type !== "identifier" || tokens[index].value !== "import") continue;
    const next = tokens[index + 1];
    if (!next || (next.type === "punct" && ["(", "."].includes(next.value))) continue;
    let fromIndex = -1;
    for (let cursor = index + 1; cursor < tokens.length; cursor += 1) {
      const token = tokens[cursor];
      if (token.type === "punct" && token.value === ";") break;
      if (token.type === "identifier" && token.value === "from"
          && tokens[cursor + 1]?.type === "string") {
        fromIndex = cursor;
        break;
      }
    }
    const directSpecifier = next.type === "string" ? next.value : null;
    const specifier = fromIndex >= 0 ? tokens[fromIndex + 1].value : directSpecifier;
    if (specifier !== wantedSpecifier) continue;
    if (fromIndex < 0 || next.type !== "punct" || next.value !== "{") {
      records.push({ style: "non-named", bindings: [], line: tokens[index].line });
      continue;
    }
    const bindings = [];
    for (let cursor = index + 2; cursor < fromIndex; cursor += 1) {
      const token = tokens[cursor];
      if (token.type !== "identifier" || token.value === "as") continue;
      if (tokens[cursor - 1]?.type === "identifier"
          && tokens[cursor - 1].value === "as") continue;
      bindings.push(token.value);
    }
    records.push({ style: "named", bindings: [...new Set(bindings)].sort(), line: tokens[index].line });
  }
  return records;
}

function exportSurface(source) {
  const tokens = tokenize(source);
  const names = [];
  const unsafe = [];
  for (let index = 0; index < tokens.length; index += 1) {
    if (tokens[index]?.type !== "identifier" || tokens[index].value !== "export") continue;
    let cursor = index + 1;
    if (tokens[cursor]?.type === "identifier" && tokens[cursor].value === "async") cursor += 1;
    if (tokens[cursor]?.type !== "identifier" || tokens[cursor].value !== "function") {
      unsafe.push({ line: tokens[index].line, token: tokens[cursor]?.value ?? null });
      continue;
    }
    const name = tokens[cursor + 1];
    if (name?.type === "identifier") names.push(name.value);
    else unsafe.push({ line: tokens[index].line, token: "anonymous-function" });
  }
  return { names: [...new Set(names)].sort(), unsafe };
}

function unreviewedNodeGlobalReferences(path, source) {
  const tokens = tokenize(source);
  const allowedProcessMembers = new Set(FIXTURE_ALLOWED_PROCESS_MEMBERS[path] ?? []);
  const references = [];
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (token?.type !== "identifier") continue;
    if (["global", "globalThis"].includes(token.value)) {
      references.push({ global: token.value, member: null, line: token.line });
      continue;
    }
    if (token.value !== "process") continue;
    const previous = tokens[index - 1];
    const guardedTypeof = previous?.type === "identifier" && previous.value === "typeof";
    if (guardedTypeof && allowedProcessMembers.has("typeof")) continue;
    const dot = tokens[index + 1];
    const member = tokens[index + 2];
    const exactMember = dot?.type === "punct" && dot.value === "."
      && member?.type === "identifier" ? member.value : null;
    if (!exactMember || !allowedProcessMembers.has(exactMember)) {
      references.push({ global: "process", member: exactMember, line: token.line });
    }
  }
  return references;
}

export function evaluateFixtureWriteAuthority(inventory) {
  const findings = [];
  const byPath = new Map(inventory.map((entry) => [entry.path, entry]));
  for (const path of FIXTURE_EVIDENCE_MODULE_CLOSURE) {
    const entry = byPath.get(path);
    if (!entry || typeof entry.source !== "string") continue;
    const legacyFs = namedImportBindings(entry.source, "node:fs");
    const promiseFs = namedImportBindings(entry.source, "node:fs/promises");
    const expected = FIXTURE_FS_PROMISES_BINDINGS[path] ?? null;
    const globalReferences = unreviewedNodeGlobalReferences(path, entry.source);
    if (globalReferences.length > 0) {
      findings.push(finding(
        "fixture-evidence-node-global-authority-unreviewed",
        "fixture evidence module referenced Node globals outside the exact process guard/member allowance",
        [path], { path, observed: globalReferences },
      ));
    }
    if (legacyFs.length > 0 || (expected === null && promiseFs.length > 0)) {
      findings.push(finding(
        "fixture-evidence-fs-authority-unreviewed",
        "fixture evidence module acquired filesystem authority outside the fixed helpers",
        [path], { path },
      ));
      continue;
    }
    if (expected !== null) {
      const valid = promiseFs.length === 1 && promiseFs[0].style === "named"
        && JSON.stringify(promiseFs[0].bindings) === JSON.stringify([...expected].sort());
      if (!valid) {
        findings.push(finding(
          "fixture-evidence-fs-bindings-drift",
          "fixture evidence filesystem bindings differ from the exact reviewed least-authority set",
          [path], { path, expected: [...expected].sort(), observed: promiseFs },
        ));
      }
    }
  }
  for (const [path, expected] of Object.entries(FIXTURE_PUBLIC_FUNCTIONS)) {
    const entry = byPath.get(path);
    if (!entry || typeof entry.source !== "string") continue;
    const observed = exportSurface(entry.source);
    if (observed.unsafe.length > 0
        || JSON.stringify(observed.names) !== JSON.stringify([...expected].sort())) {
      findings.push(finding(
        "fixture-public-function-surface-drift",
        "fixture evidence module exports differ from the exact reviewed public surface",
        [path], { path, expected: [...expected].sort(), observed },
      ));
    }
  }
  return findings;
}

export function resolveImport(sourcePath, specifier, moduleSet) {
  if (!specifier.startsWith(".")) return null;
  const base = posix.normalize(posix.join(posix.dirname(sourcePath), specifier));
  const candidates = extname(base)
    ? [base] : [`${base}.mjs`, `${base}.js`, posix.join(base, "index.mjs")];
  return candidates.find((candidate) => moduleSet.has(candidate)) ?? base;
}

export function isReviewedExternalDynamicImport(source, parsed) {
  if (parsed?.kind !== "dynamic" || typeof parsed.specifier !== "string") return false;
  return (REVIEWED_EXTERNAL_DYNAMIC_IMPORTS[source] ?? []).includes(parsed.specifier);
}

function externalImportKey(row) {
  return `${row?.source ?? ""}\u0000${row?.specifier ?? ""}\u0000${row?.kind ?? ""}`;
}

export function evaluateReviewedExternalImports(observedImports) {
  const observed = Array.isArray(observedImports) ? observedImports : [];
  const findings = [];
  const expectedKeys = new Set();
  const reviewedSources = new Set(REVIEWED_EXTERNAL_IMPORTS.map((row) => row.source));
  const reviewedSpecifiers = new Set(REVIEWED_EXTERNAL_IMPORTS.map((row) => row.specifier));
  for (const expected of REVIEWED_EXTERNAL_IMPORTS) {
    const key = externalImportKey(expected);
    if (expectedKeys.has(key) || expected.count !== 1) {
      findings.push(finding(
        "reviewed-external-import-contract-invalid",
        "each reviewed external import contract must be unique with cardinality exactly one",
        [expected.source], { expected },
      ));
    }
    expectedKeys.add(key);
  }
  for (const row of observed) {
    if (expectedKeys.has(externalImportKey(row))) continue;
    if (reviewedSources.has(row?.source) || reviewedSpecifiers.has(row?.specifier)) {
      findings.push(finding(
        "reviewed-external-import-drift",
        "reviewed external import source, specifier, or kind drifted",
        [row?.source ?? "<unknown>"], {
          observed: {
            source: row?.source ?? null,
            specifier: row?.specifier ?? null,
            kind: row?.kind ?? null,
            line: row?.line ?? null,
          },
        },
      ));
    }
  }
  const dependencies = REVIEWED_EXTERNAL_IMPORTS.map((expected) => {
    const count = observed.filter((row) => externalImportKey(row) === externalImportKey(expected))
      .length;
    if (count !== 1) {
      findings.push(finding(
        "reviewed-external-import-cardinality",
        "reviewed external import must occur exactly once",
        [expected.source], { expected_count: 1, observed_count: count, expected },
      ));
    }
    return {
      source: expected.source,
      specifier: expected.specifier,
      kind: expected.kind,
      count,
    };
  });
  return { findings, dependencies };
}

function tarjan(modules, edges) {
  const adjacency = new Map(modules.map((modulePath) => [modulePath, []]));
  for (const edge of edges) {
    if (adjacency.has(edge.source) && adjacency.has(edge.target)) {
      adjacency.get(edge.source).push(edge.target);
    }
  }
  let nextIndex = 0;
  const indices = new Map();
  const low = new Map();
  const stack = [];
  const onStack = new Set();
  const components = [];
  const visit = (node) => {
    indices.set(node, nextIndex);
    low.set(node, nextIndex);
    nextIndex += 1;
    stack.push(node);
    onStack.add(node);
    for (const target of adjacency.get(node)) {
      if (!indices.has(target)) {
        visit(target);
        low.set(node, Math.min(low.get(node), low.get(target)));
      } else if (onStack.has(target)) {
        low.set(node, Math.min(low.get(node), indices.get(target)));
      }
    }
    if (low.get(node) !== indices.get(node)) return;
    const component = [];
    while (stack.length) {
      const member = stack.pop();
      onStack.delete(member);
      component.push(member);
      if (member === node) break;
    }
    components.push(component.sort());
  };
  for (const modulePath of [...modules].sort()) {
    if (!indices.has(modulePath)) visit(modulePath);
  }
  return components;
}

export function finding(code, message, paths, details = {}) {
  return { status: "FAIL", code, message, paths: [...paths].sort(), details };
}

export function evaluateInventoryManifest(discovered) {
  const discoveredSet = new Set(discovered);
  const expectedSet = new Set(EXPECTED_INVENTORY);
  const findings = [];
  for (const path of EXPECTED_INVENTORY) {
    if (!discoveredSet.has(path)) {
      findings.push(finding(
        "closed-inventory-member-missing", "reviewed JavaScript inventory member is missing",
        [path], { path },
      ));
    }
  }
  for (const path of [...discoveredSet].sort()) {
    if (!expectedSet.has(path)) {
      findings.push(finding(
        "closed-inventory-member-unreviewed",
        "auto-discovered JavaScript module is not in the reviewed exact manifest",
        [path], { path },
      ));
    }
  }
  return findings;
}

export function evaluateModuleRoles(inventory) {
  const findings = [];
  for (const entry of inventory) {
    const expected = moduleRoleFor(entry.path);
    if (expected === null) {
      findings.push(finding(
        "module-role-unreviewed", "module has no exact reviewed role", [entry.path],
        { path: entry.path, observed_role: entry.role ?? null },
      ));
    } else if (entry.role !== expected) {
      findings.push(finding(
        "module-role-misclassified", "module role differs from exact reviewed role",
        [entry.path], { path: entry.path, expected_role: expected, observed_role: entry.role },
      ));
    }
  }
  return findings;
}

export function importPolicyFinding(source, parsed) {
  if (FIXTURE_EVIDENCE_MODULE_CLOSURE.includes(source)
      && FIXTURE_EVIDENCE_FORBIDDEN_NODE_IMPORTS.includes(parsed.specifier)) {
    return finding(
      "fixture-evidence-forbidden-node-import",
      "fixture evidence closure may not acquire process, worker, VM, or loader authority",
      [source], { source, specifier: parsed.specifier, line: parsed.line },
    );
  }
  if (FIXTURE_EVIDENCE_MODULE_CLOSURE.includes(source)
      && typeof parsed.specifier === "string" && parsed.specifier.startsWith("node:")) {
    const allowed = FIXTURE_ALLOWED_NODE_IMPORTS[source] ?? [];
    if (parsed.kind !== "static" || !allowed.includes(parsed.specifier)) {
      return finding(
        "fixture-evidence-node-import-unreviewed",
        "fixture evidence closure may use only its exact reviewed static node imports",
        [source], { source, specifier: parsed.specifier, kind: parsed.kind, line: parsed.line },
      );
    }
  }
  if (parsed.kind === "loader-reference") {
    return finding(
      "loader-shaped-reference-not-allowed",
      "loader-shaped bare or member references can hide executable aliases",
      [source], { source, specifier: parsed.specifier, line: parsed.line },
    );
  }
  if (parsed.kind === "dynamic") {
    if (isReviewedExternalDynamicImport(source, parsed)) return null;
    return finding(
      "dynamic-import-not-allowed",
      "dynamic import is not statically provable inside the closed JavaScript inventory",
      [source], { source, specifier: parsed.specifier, line: parsed.line },
    );
  }
  if (parsed.kind === "create-require") {
    return finding(
      "create-require-loader-not-allowed",
      "createRequire can hide loaders outside the closed JavaScript inventory",
      [source], { source, specifier: parsed.specifier, line: parsed.line },
    );
  }
  if (parsed.kind === "require"
      && !(typeof parsed.specifier === "string" && parsed.specifier.startsWith("node:"))) {
    return finding(
      "require-loader-not-allowed",
      "executable require is not statically provable inside the closed JavaScript inventory",
      [source], { source, specifier: parsed.specifier, line: parsed.line },
    );
  }
  if (["eval-loader", "function-loader"].includes(parsed.kind)) {
    return finding(
      `${parsed.kind}-not-allowed`,
      "eval and Function loaders are outside the closed static JavaScript graph",
      [source], { source, specifier: parsed.specifier, line: parsed.line },
    );
  }
  if (!parsed.specifier.startsWith(".") && !parsed.specifier.startsWith("node:")) {
    return finding(
      "external-static-import-not-allowed",
      "non-node bare imports are outside the closed JavaScript inventory",
      [source], { source, specifier: parsed.specifier, line: parsed.line },
    );
  }
  return null;
}

function boundaryFindings(edge) {
  const sourceRole = moduleRoleFor(edge.source);
  const targetRole = moduleRoleFor(edge.target);
  const findings = [];
  if (sourceRole === null || targetRole === null) return findings;
  if (sourceRole === "e2e" && !FIXTURE_E2E_DIRECT_TARGETS.includes(edge.target)) {
    findings.push(finding(
      "fixture-e2e-direct-target-unreviewed",
      "fixture E2E may import only its exact reviewed direct targets",
      [edge.source, edge.target], { edge },
    ));
  }
  if (!ALLOWED_ROLE_TARGETS[sourceRole]?.has(targetRole)) {
    findings.push(finding(
      "role-boundary-violation",
      `JavaScript ${sourceRole} module may not import ${targetRole} module`,
      [edge.source, edge.target], { edge, source_role: sourceRole, target_role: targetRole },
    ));
  }
  if (sourceRole === "production" && targetRole === "test") {
    findings.push(finding(
      "production-imports-test", "production module imports a test module",
      [edge.source, edge.target], { edge },
    ));
  }
  if (targetRole === "fixture-testonly"
      && !["fixture-testonly", "test", "e2e"].includes(sourceRole)) {
    findings.push(finding(
      "fixture-testonly-imported-outside-test",
      "fixture_testonly may only be imported within fixture, test, or E2E modules",
      [edge.source, edge.target], { edge },
    ));
  }
  return findings;
}

function requiredEdgeResults(moduleSet, edgeKeys, findings) {
  return REQUIRED_EDGES.map(([source, target]) => {
    const present = moduleSet.has(source) && moduleSet.has(target)
      && edgeKeys.has(`${source}\u0000${target}`);
    if (!present) {
      findings.push(finding(
        "missing-required-edge", "required JavaScript architecture edge is missing",
        [source, target], { source, target },
      ));
    }
    return { source, target, present };
  });
}

function fixtureEvidenceClosureFindings(modules, edges) {
  const findings = [];
  const root = "scripts/comment_fixture_browser_e2e.mjs";
  const adjacency = new Map(modules.map((module) => [module, []]));
  for (const edge of edges) adjacency.get(edge.source)?.push(edge.target);
  const reached = new Set();
  const pending = [root];
  while (pending.length) {
    const current = pending.pop();
    if (reached.has(current)) continue;
    reached.add(current);
    for (const target of adjacency.get(current) || []) pending.push(target);
  }
  const expected = new Set(FIXTURE_EVIDENCE_MODULE_CLOSURE);
  for (const module of [...reached].sort()) {
    if (!expected.has(module)) {
      findings.push(finding(
        "fixture-evidence-closure-unreviewed",
        "fixture E2E reaches a module outside the exact reviewed evidence closure",
        [root, module], { root, module },
      ));
    }
  }
  for (const module of [...expected].sort()) {
    if (!reached.has(module)) {
      findings.push(finding(
        "fixture-evidence-closure-member-missing",
        "fixture evidence closure no longer reaches a required reviewed module",
        [root, module], { root, module },
      ));
    }
  }
  return findings;
}

export function evaluateArchitecture(modules, edges) {
  const moduleSet = new Set(modules);
  const findings = [];
  const edgeKeys = new Set(edges.map((edge) => `${edge.source}\u0000${edge.target}`));
  const components = tarjan(modules, edges);
  const cycles = components.filter((component) => (
    component.length > 1 || edgeKeys.has(`${component[0]}\u0000${component[0]}`)
  ));
  for (const component of cycles) {
    findings.push(finding(
      "dependency-cycle", "static JavaScript module cycle detected", component,
      { strongly_connected_component: component },
    ));
  }
  for (const edge of edges) {
    findings.push(...boundaryFindings(edge));
    if (edge.source === "scripts/comment_chrome_send.mjs"
        && edge.target === "scripts/comment_chrome_claim_bridge.mjs") {
      findings.push(finding(
        "send-imports-claim-bridge", "send must not reverse-import claim_bridge",
        [edge.source, edge.target], { edge },
      ));
    }
  }
  findings.push(...fixtureEvidenceClosureFindings(modules, edges));
  const required = requiredEdgeResults(moduleSet, edgeKeys, findings);
  return { findings, required, cycles, components };
}

export const ROLE_POLICY_EVIDENCE = Object.freeze({
  expected_module_roles: EXPECTED_MODULE_ROLES,
  allowed_role_targets: Object.fromEntries(Object.entries(ALLOWED_ROLE_TARGETS).map(
    ([role, targets]) => [role, [...targets].sort()],
  )),
  fixture_e2e_direct_targets: FIXTURE_E2E_DIRECT_TARGETS,
  fixture_evidence_module_closure: FIXTURE_EVIDENCE_MODULE_CLOSURE,
  fixture_evidence_forbidden_node_imports: FIXTURE_EVIDENCE_FORBIDDEN_NODE_IMPORTS,
  reviewed_external_dynamic_imports: REVIEWED_EXTERNAL_DYNAMIC_IMPORTS,
  reviewed_external_imports: REVIEWED_EXTERNAL_IMPORTS,
  fixture_fs_promises_bindings: FIXTURE_FS_PROMISES_BINDINGS,
  fixture_public_functions: FIXTURE_PUBLIC_FUNCTIONS,
});
