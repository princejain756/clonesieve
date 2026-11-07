import fs from "node:fs";
import path from "node:path";
import os from "node:os";

export const RULE_META = {
  // Plane 1: Codebase Structural Clones, Helper Sprawl & Dead Exports
  CLS001: {
    id: "CLS001",
    plane: "codebase",
    severity: "CRITICAL",
    title: "Multi-File Exact Structural Clone (>= 3 Copies of Identical Normalized Body)",
    points: 22
  },
  CLS002: {
    id: "CLS002",
    plane: "codebase",
    severity: "HIGH",
    title: "Pairwise Structural Function Clone (2 Copies Across Distinct Files)",
    points: 12
  },
  CLS003: {
    id: "CLS003",
    plane: "codebase",
    severity: "HIGH",
    title: "Near-Duplicate Shingle Clone (4-Gram Token Jaccard Similarity >= 0.80)",
    points: 12
  },
  CLS004: {
    id: "CLS004",
    plane: "codebase",
    severity: "MEDIUM",
    title: "Cross-File Duplicate Helper Name Sprawl (Same Function Name Re-Implemented)",
    points: 8
  },
  CLS005: {
    id: "CLS005",
    plane: "codebase",
    severity: "HIGH",
    title: "Truly Dead Zero-Caller Orphan Export (0 Cross-File Refs & 0 Internal Calls)",
    points: 14
  },
  CLS006: {
    id: "CLS006",
    plane: "codebase",
    severity: "LOW",
    title: "Internal-Only Over-Exported Symbol (Exported But Only Called Inside Defining File)",
    points: 4
  },
  CLS007: {
    id: "CLS007",
    plane: "codebase",
    severity: "MEDIUM",
    title: "Trivial Pass-Through Wrapper Function (Single-Call Delegation Without Logic)",
    points: 6
  },
  CLS008: {
    id: "CLS008",
    plane: "guard",
    severity: "INFO",
    title: "Short Boilerplate & Getter Exclusion Guard (< 25 Normalized Tokens Excluded)",
    points: 0
  },
  CLS009: {
    id: "CLS009",
    plane: "guard",
    severity: "INFO",
    title: "Entrypoint, Next.js/SST Convention & Barrel Re-Export Guard (False-Positive Filter)",
    points: 0
  },

  // Plane 2: Agent Transcript Blind-Write & Re-Implementation Habits
  CLS010: {
    id: "CLS010",
    plane: "transcript",
    severity: "HIGH",
    title: "New Function Defined in Agent Patch Before Any Repo Search (Grep/Glob/rg)",
    points: 15
  },
  CLS011: {
    id: "CLS011",
    plane: "transcript",
    severity: "MEDIUM",
    title: "Agent File Write/Edit Executed Before Any Repo Search in Session",
    points: 8
  },
  CLS012: {
    id: "CLS012",
    plane: "transcript",
    severity: "MEDIUM",
    severityRank: 2,
    title: "Generic Utility File Sprawl Created (utils/helpers/common/format Module Added)",
    points: 8
  },
  CLS013: {
    id: "CLS013",
    plane: "guard",
    severity: "INFO",
    title: "Streaming tool_use.id / call_id Progress Rows Deduplicated",
    points: 0
  },
  CLS014: {
    id: "CLS014",
    plane: "guard",
    severity: "INFO",
    title: "Canonical Exported Helper Registry Indexed for CLAUDE.md (--emit-index)",
    points: 0
  }
};

const IGNORE_DIRS = new Set([
  "node_modules",
  ".git",
  ".next",
  "dist",
  "build",
  "coverage",
  ".turbo",
  "out",
  "vendor",
  "__pycache__",
  ".venv"
]);

const EXT_RE = /\.(?:js|mjs|cjs|ts|tsx|jsx|py)$/;
const ENTRY_OR_CONVENTION_RE =
  /(?:^|\/)(?:index|main|mod|cli|server|app|page|layout|loading|error|not-found|template|default|route|middleware|instrumentation|sst\.config|next\.config|vite\.config|tailwind\.config|postcss\.config|eslint\.config|playwright\.config|vitest\.config|jest\.config)\.(?:js|mjs|cjs|ts|tsx|jsx|py)$/;

const NEXT_CONVENTION_EXPORTS = new Set([
  "default",
  "metadata",
  "viewport",
  "generateMetadata",
  "generateStaticParams",
  "generateViewport",
  "GET",
  "POST",
  "PUT",
  "PATCH",
  "DELETE",
  "HEAD",
  "OPTIONS",
  "config",
  "runtime",
  "dynamic"
]);

const KEYWORDS = new Set([
  "function",
  "return",
  "const",
  "let",
  "var",
  "if",
  "else",
  "for",
  "while",
  "switch",
  "case",
  "break",
  "continue",
  "try",
  "catch",
  "finally",
  "throw",
  "new",
  "async",
  "await",
  "import",
  "export",
  "from",
  "default",
  "class",
  "extends",
  "typeof",
  "instanceof",
  "in",
  "of",
  "true",
  "false",
  "null",
  "undefined",
  "def",
  "elif",
  "except",
  "raise",
  "with",
  "as",
  "pass",
  "None",
  "True",
  "False"
]);

export function normalizeFunctionBody(code) {
  return String(code || "")
    .replace(/\/\/.*$/gm, "")
    .replace(/#.*$/gm, "")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/["'`][^"'`\n]{0,120}["'`]/g, '"STR"')
    .replace(/\b\d+(?:\.\d+)?\b/g, "NUM")
    .replace(/\b[a-zA-Z_$][a-zA-Z0-9_$]*\b/g, (tok) => (KEYWORDS.has(tok) ? tok : "ID"))
    .replace(/\s+/g, " ")
    .trim();
}

export function computeShingles(normTokens, k = 4) {
  const shingles = new Set();
  if (normTokens.length < k) return shingles;
  for (let i = 0; i <= normTokens.length - k; i++) {
    shingles.add(normTokens.slice(i, i + k).join(" "));
  }
  return shingles;
}

export function jaccardSimilarity(setA, setB) {
  if (!setA.size || !setB.size) return 0;
  let inter = 0;
  const [smaller, larger] = setA.size <= setB.size ? [setA, setB] : [setB, setA];
  for (const item of smaller) {
    if (larger.has(item)) inter++;
  }
  const union = setA.size + setB.size - inter;
  return union === 0 ? 0 : inter / union;
}

export function isPassThroughWrapper(rawBody, fnName) {
  const cleaned = String(rawBody || "")
    .replace(/\/\/.*$/gm, "")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .trim();
  const inner = cleaned.startsWith("{") && cleaned.endsWith("}") ? cleaned.slice(1, -1).trim() : cleaned;
  const stmts = inner
    .split(/;|\n/)
    .map((s) => s.trim())
    .filter(Boolean);
  if (stmts.length !== 1) return false;
  const single = stmts[0];
  const m = single.match(/^(?:return\s+)?(?:await\s+)?([a-zA-Z_$][a-zA-Z0-9_$.]*)\s*\(([^()]*)\)$/);
  if (!m) return false;
  const callee = m[1];
  if (callee === fnName) return false;
  return true;
}

function collectSourceFiles(dir, out = []) {
  if (!fs.existsSync(dir)) return out;
  const st = fs.statSync(dir);
  if (st.isFile()) {
    if (EXT_RE.test(dir) && !dir.endsWith(".d.ts")) out.push(dir);
    return out;
  }
  for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
    if (IGNORE_DIRS.has(ent.name) || ent.name.startsWith(".")) continue;
    const full = path.join(dir, ent.name);
    if (ent.isDirectory()) collectSourceFiles(full, out);
    else if (ent.isFile() && EXT_RE.test(ent.name) && !ent.name.endsWith(".d.ts")) out.push(full);
  }
  return out;
}

function collectJsonlFiles(dir, out = []) {
  if (!fs.existsSync(dir)) return out;
  const st = fs.statSync(dir);
  if (st.isFile() && dir.endsWith(".jsonl")) {
    out.push(dir);
    return out;
  }
  if (!st.isDirectory()) return out;
  for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, ent.name);
    if (ent.isDirectory()) collectJsonlFiles(full, out);
    else if (ent.isFile() && ent.name.endsWith(".jsonl")) out.push(full);
  }
  return out;
}

function extractFunctionsFromSource(src, relPath) {
  const out = [];
  const fnPatterns = [
    /(export\s+)?(?:async\s+)?function\s+([a-zA-Z_$][a-zA-Z0-9_$]*)\s*\(([^)]*)\)\s*(?::\s*[^{]+)?\{/g,
    /(export\s+)?const\s+([a-zA-Z_$][a-zA-Z0-9_$]*)\s*=\s*(?:async\s*)?\(([^)]*)\)\s*(?::\s*[^=]+)?=>\s*\{/g
  ];

  for (const re of fnPatterns) {
    for (const m of src.matchAll(re)) {
      const isExported = Boolean(m[1]);
      const name = m[2];
      const params = m[3].trim();
      const braceStart = m.index + m[0].length - 1;
      let depth = 0;
      let endIdx = braceStart;
      for (let i = braceStart; i < Math.min(src.length, braceStart + 6000); i++) {
        if (src[i] === "{") depth++;
        else if (src[i] === "}") {
          depth--;
          if (depth === 0) {
            endIdx = i + 1;
            break;
          }
        }
      }
      const rawBody = src.slice(braceStart, endIdx);
      const norm = normalizeFunctionBody(rawBody);
      const normTokens = norm ? norm.split(" ") : [];
      out.push({
        name,
        params,
        isExported,
        file: relPath,
        rawBody,
        norm,
        tokenCount: normTokens.length,
        normTokens
      });
    }
  }
  return out;
}

export function auditTranscriptsForBlindWrites(transcriptFiles = []) {
  let rawStreamEvents = 0;
  let deduplicatedCalls = 0;
  let totalWriteOrPatchCalls = 0;
  let writeBeforeRepoSearch = 0;
  let newHelperDefsInPatches = 0;
  let newHelperDefsWithoutSearch = 0;
  let genericUtilFilesCreated = 0;
  const findings = [];

  for (const tf of transcriptFiles) {
    let content;
    try {
      content = fs.readFileSync(tf, "utf8");
    } catch {
      continue;
    }
    const sessionLabel = path.basename(tf);
    const seenIds = new Set();
    let hasRepoSearch = false;
    let sessionBlindFuncs = 0;
    let sessionBlindWrites = 0;

    for (const line of content.split("\n")) {
      if (!line.trim()) continue;
      let obj;
      try {
        obj = JSON.parse(line);
      } catch {
        continue;
      }

      if (obj?.type === "assistant" && Array.isArray(obj?.message?.content)) {
        for (const blk of obj.message.content) {
          if (blk?.type !== "tool_use") continue;
          rawStreamEvents++;
          if (blk.id && seenIds.has(blk.id)) continue;
          if (blk.id) seenIds.add(blk.id);
          deduplicatedCalls++;

          const name = String(blk.name || "");
          const input = blk.input || {};
          if (name === "Grep" || name === "Glob") {
            hasRepoSearch = true;
          } else if (name === "Bash") {
            const cmd = String(input.command || "");
            if (/\b(?:rg|grep|find|fd|git\s+grep)\b/.test(cmd)) hasRepoSearch = true;
          } else if (["Write", "Edit", "MultiEdit"].includes(name)) {
            totalWriteOrPatchCalls++;
            const targetPath = String(input.file_path || input.path || "");
            if (name === "Write" && /(?:^|\/)(?:utils?|helpers?|common|format(?:ters?)?)\.(?:ts|tsx|js|mjs|py)$/i.test(targetPath)) {
              genericUtilFilesCreated++;
              findings.push({
                ruleId: "CLS012",
                plane: "transcript",
                severity: "MEDIUM",
                file: sessionLabel,
                detail: `Agent created generic utility module ${path.basename(targetPath)} in ${sessionLabel} instead of reusing canonical shared exports`,
                evidence: `${name}: ${path.basename(targetPath)}`
              });
            }
            const body = String(input.new_string || input.content || "");
            const fnDefs = [
              ...body.matchAll(
                /\b(?:export\s+)?(?:async\s+)?(?:function\s+([a-zA-Z_$][a-zA-Z0-9_$]*)|const\s+([a-zA-Z_$][a-zA-Z0-9_$]*)\s*=\s*(?:async\s*)?\()/g
              )
            ];
            newHelperDefsInPatches += fnDefs.length;
            if (!hasRepoSearch) {
              writeBeforeRepoSearch++;
              sessionBlindWrites++;
              if (fnDefs.length > 0) {
                newHelperDefsWithoutSearch += fnDefs.length;
                sessionBlindFuncs += fnDefs.length;
              }
            }
          }
        }
      }

      if (
        obj?.type === "response_item" &&
        (obj?.payload?.type === "function_call" || obj?.payload?.type === "custom_tool_call")
      ) {
        rawStreamEvents++;
        const id = obj.payload.call_id || obj.payload.id;
        if (id && seenIds.has(id)) continue;
        if (id) seenIds.add(id);
        deduplicatedCalls++;

        const name = String(obj.payload.name || "");
        const rawIn = String(obj.payload.input || obj.payload.arguments || "");
        if (name === "exec" || name === "exec_command") {
          if (/\b(?:rg|grep|find|fd|git\s+grep)\b/.test(rawIn)) hasRepoSearch = true;
        } else if (name === "apply_patch" || name === "write_file") {
          totalWriteOrPatchCalls++;
          const fnDefs = [
            ...rawIn.matchAll(
              /^\+\s*(?:export\s+)?(?:async\s+)?(?:function\s+[a-zA-Z_$]|def\s+[a-zA-Z_]|const\s+[a-zA-Z_$][a-zA-Z0-9_$]*\s*=\s*(?:async\s*)?\()/gm
            )
          ];
          newHelperDefsInPatches += fnDefs.length;
          if (!hasRepoSearch) {
            writeBeforeRepoSearch++;
            sessionBlindWrites++;
            if (fnDefs.length > 0) {
              newHelperDefsWithoutSearch += fnDefs.length;
              sessionBlindFuncs += fnDefs.length;
            }
          }
        }
      }
    }

    if (sessionBlindFuncs > 0) {
      findings.push({
        ruleId: "CLS010",
        plane: "transcript",
        severity: "HIGH",
        file: sessionLabel,
        detail: `${sessionBlindFuncs} new function definition(s) written in ${sessionLabel} before any Grep/Glob/rg repo search`,
        evidence: `${sessionBlindFuncs} blind function addition(s)`
      });
    } else if (sessionBlindWrites > 0) {
      findings.push({
        ruleId: "CLS011",
        plane: "transcript",
        severity: "MEDIUM",
        file: sessionLabel,
        detail: `${sessionBlindWrites} file write/edit call(s) executed in ${sessionLabel} before any Grep/Glob/rg search`,
        evidence: `${sessionBlindWrites} blind file write(s)`
      });
    }
  }

  const duplicateStreamEventsSkipped = Math.max(0, rawStreamEvents - deduplicatedCalls);
  if (duplicateStreamEventsSkipped > 0 || deduplicatedCalls > 0) {
    findings.push({
      ruleId: "CLS013",
      plane: "guard",
      severity: "INFO",
      file: "session-transcripts",
      detail: `${deduplicatedCalls} unique tool calls analyzed (${duplicateStreamEventsSkipped} duplicate streaming rows skipped)`,
      evidence: `${deduplicatedCalls} deduplicated calls`
    });
  }

  return {
    sessionsScanned: transcriptFiles.length,
    deduplicatedCalls,
    duplicateStreamEventsSkipped,
    totalWriteOrPatchCalls,
    writeBeforeRepoSearch,
    writeBeforeRepoSearchPct:
      Math.round((writeBeforeRepoSearch / Math.max(1, totalWriteOrPatchCalls)) * 1000) / 10,
    newHelperDefsInPatches,
    newHelperDefsWithoutSearch,
    newHelperDefsWithoutSearchPct:
      Math.round((newHelperDefsWithoutSearch / Math.max(1, newHelperDefsInPatches)) * 1000) / 10,
    genericUtilFilesCreated,
    findings
  };
}

export function auditCodebaseClones(targetPaths = [], options = {}) {
  const roots = Array.isArray(targetPaths) && targetPaths.length > 0 ? targetPaths : [process.cwd()];
  const files = [];
  for (const r of roots) collectSourceFiles(r, files);
  const baseRoot = roots[0] || process.cwd();

  const tokenFileFreq = new Map();
  const exportedDefs = [];
  const nonTrivialFuncs = [];
  const canonicalHelpers = [];
  let shortBoilerplateFiltered = 0;
  let entryAndConventionExportsFiltered = 0;
  let barrelReexportsFiltered = 0;
  let passThroughWrappersCount = 0;
  const findings = [];

  files.forEach((f, fileIdx) => {
    let src;
    try {
      src = fs.readFileSync(f, "utf8");
    } catch {
      return;
    }
    const rel = path.relative(baseRoot, f) || path.basename(f);
    const isTest = /\.(?:test|spec)\.|__tests__|\/tests?\//.test(rel);

    for (const m of src.matchAll(/\b([a-zA-Z_$][a-zA-Z0-9_$]{2,})\b/g)) {
      const tok = m[1];
      if (!tokenFileFreq.has(tok)) tokenFileFreq.set(tok, new Set());
      tokenFileFreq.get(tok).add(fileIdx);
    }

    const reexports = [...src.matchAll(/\bexport\s+(?:\*|\{[^}]*\})\s+from\s+['"][^'"]+['"]/g)];
    barrelReexportsFiltered += reexports.length;

    const extracted = extractFunctionsFromSource(src, rel);
    for (const fn of extracted) {
      if (fn.isExported && !isTest) {
        canonicalHelpers.push({
          name: fn.name,
          params: fn.params,
          file: rel
        });
      }

      if (fn.isExported && isPassThroughWrapper(fn.rawBody, fn.name) && !isTest) {
        passThroughWrappersCount++;
        findings.push({
          ruleId: "CLS007",
          plane: "codebase",
          severity: "MEDIUM",
          file: rel,
          detail: `Exported wrapper "${fn.name}" in ${rel} delegates directly to another call without transformation or error handling`,
          evidence: `${fn.name}(${fn.params})`
        });
      }

      if (fn.tokenCount < 25) {
        shortBoilerplateFiltered++;
        continue;
      }
      nonTrivialFuncs.push(fn);
    }

    if (!isTest) {
      for (const m of src.matchAll(
        /\bexport\s+(?:async\s+)?(?:function|const|let|class)\s+([a-zA-Z_$][a-zA-Z0-9_$]{2,})/g
      )) {
        const sym = m[1];
        if (ENTRY_OR_CONVENTION_RE.test(rel) || NEXT_CONVENTION_EXPORTS.has(sym)) {
          entryAndConventionExportsFiltered++;
          continue;
        }
        const esc = sym.replace(/\$/g, "\\$");
        const selfCount = [...src.matchAll(new RegExp(`\\b${esc}\\b`, "g"))].length;
        exportedDefs.push({ sym, file: rel, fileIdx, selfCount });
      }
    }
  });

  // 1. Exact Type-2 normalized structural clones
  const byNorm = new Map();
  for (const fn of nonTrivialFuncs) {
    if (!byNorm.has(fn.norm)) byNorm.set(fn.norm, []);
    byNorm.get(fn.norm).push(fn);
  }

  let multiFileExactCloneGroups = 0;
  let pairwiseExactCloneGroups = 0;
  const exactMatchedKeys = new Set();

  for (const [normKey, group] of byNorm.entries()) {
    const distinctFiles = [...new Set(group.map((g) => g.file))];
    if (distinctFiles.length >= 3) {
      multiFileExactCloneGroups++;
      exactMatchedKeys.add(normKey);
      findings.push({
        ruleId: "CLS001",
        plane: "codebase",
        severity: "CRITICAL",
        file: distinctFiles[0],
        detail: `Function "${group[0].name}" has ${group.length} identical structural copies across ${distinctFiles.length} files (${distinctFiles.slice(0, 4).map((x) => path.basename(x)).join(", ")})`,
        evidence: `${group[0].name}: ${group.length}x (${group[0].tokenCount} normalized tokens)`
      });
    } else if (distinctFiles.length === 2) {
      pairwiseExactCloneGroups++;
      exactMatchedKeys.add(normKey);
      findings.push({
        ruleId: "CLS002",
        plane: "codebase",
        severity: "HIGH",
        file: distinctFiles[0],
        detail: `Function "${group[0].name}" duplicated across ${path.basename(distinctFiles[0])} and ${path.basename(distinctFiles[1])}`,
        evidence: `${group[0].name} <-> ${group[1].name} (${group[0].tokenCount} normalized tokens)`
      });
    }
  }

  // 2. Near-duplicate shingle clones (Jaccard >= 0.80) among non-exact functions (bounded to 400 candidates for speed)
  let nearDuplicateShinglePairs = 0;
  const shingleCandidates = nonTrivialFuncs
    .filter((f) => !exactMatchedKeys.has(f.norm))
    .slice(0, 400)
    .map((f) => ({ ...f, shingles: computeShingles(f.normTokens, 4) }));

  for (let i = 0; i < shingleCandidates.length; i++) {
    for (let j = i + 1; j < shingleCandidates.length; j++) {
      const a = shingleCandidates[i];
      const b = shingleCandidates[j];
      if (a.file === b.file) continue;
      if (Math.abs(a.tokenCount - b.tokenCount) > Math.max(a.tokenCount, b.tokenCount) * 0.35) continue;
      const sim = jaccardSimilarity(a.shingles, b.shingles);
      if (sim >= 0.8) {
        nearDuplicateShinglePairs++;
        findings.push({
          ruleId: "CLS003",
          plane: "codebase",
          severity: "HIGH",
          file: a.file,
          detail: `Near-duplicate functions "${a.name}" (${path.basename(a.file)}) and "${b.name}" (${path.basename(b.file)}) share ${Math.round(sim * 100)}% 4-gram token similarity`,
          evidence: `Jaccard=${sim.toFixed(2)} (${a.name} vs ${b.name})`
        });
      }
    }
  }

  // 3. Cross-file duplicate helper name sprawl
  const byName = new Map();
  for (const fn of nonTrivialFuncs) {
    if (!byName.has(fn.name)) byName.set(fn.name, []);
    byName.get(fn.name).push(fn);
  }
  let duplicateHelperNamesCount = 0;
  for (const [name, list] of byName.entries()) {
    const distinctFiles = [...new Set(list.map((x) => x.file))];
    if (distinctFiles.length >= 2) {
      duplicateHelperNamesCount++;
      findings.push({
        ruleId: "CLS004",
        plane: "codebase",
        severity: "MEDIUM",
        file: distinctFiles[0],
        detail: `Helper "${name}" is defined in ${distinctFiles.length} separate files (${distinctFiles.slice(0, 4).map((x) => path.basename(x)).join(", ")})`,
        evidence: `${name}: ${distinctFiles.length} definitions`
      });
    }
  }

  // 4. Dead zero-caller exports vs internal-only over-exports
  let trulyDeadExportsCount = 0;
  let internalOnlyExportsCount = 0;
  for (const d of exportedDefs) {
    const fset = tokenFileFreq.get(d.sym);
    const otherFiles = fset ? fset.size - (fset.has(d.fileIdx) ? 1 : 0) : 0;
    if (otherFiles === 0 && d.selfCount <= 1) {
      trulyDeadExportsCount++;
      findings.push({
        ruleId: "CLS005",
        plane: "codebase",
        severity: "HIGH",
        file: d.file,
        detail: `Exported symbol "${d.sym}" in ${d.file} has 0 cross-file references and 0 internal calls`,
        evidence: `export ${d.sym} (0 callers)`
      });
    } else if (otherFiles === 0 && d.selfCount > 1) {
      internalOnlyExportsCount++;
      findings.push({
        ruleId: "CLS006",
        plane: "codebase",
        severity: "LOW",
        file: d.file,
        detail: `Symbol "${d.sym}" in ${d.file} is exported but only called internally (${d.selfCount - 1}x in same file)`,
        evidence: `export ${d.sym} (internal-only)`
      });
    }
  }

  if (shortBoilerplateFiltered > 0) {
    findings.push({
      ruleId: "CLS008",
      plane: "guard",
      severity: "INFO",
      file: "codebase-guard",
      detail: `${shortBoilerplateFiltered} short (< 25 token) boilerplate functions/getters excluded from clone matching`,
      evidence: `${shortBoilerplateFiltered} short functions filtered`
    });
  }

  if (entryAndConventionExportsFiltered > 0 || barrelReexportsFiltered > 0) {
    findings.push({
      ruleId: "CLS009",
      plane: "guard",
      severity: "INFO",
      file: "codebase-guard",
      detail: `${entryAndConventionExportsFiltered} entrypoint/framework convention exports and ${barrelReexportsFiltered} barrel re-exports excluded from dead-export checks`,
      evidence: `${entryAndConventionExportsFiltered} entry exports + ${barrelReexportsFiltered} barrels filtered`
    });
  }

  // Plane 2 transcript check if transcriptFiles or includeTranscripts provided
  let transcriptReport = {
    sessionsScanned: 0,
    deduplicatedCalls: 0,
    duplicateStreamEventsSkipped: 0,
    totalWriteOrPatchCalls: 0,
    writeBeforeRepoSearch: 0,
    writeBeforeRepoSearchPct: 0,
    newHelperDefsInPatches: 0,
    newHelperDefsWithoutSearch: 0,
    newHelperDefsWithoutSearchPct: 0,
    genericUtilFilesCreated: 0,
    findings: []
  };

  if (options.transcriptFiles || options.includeDefaultTranscripts) {
    const home = options.homeDir || os.homedir();
    const tFiles =
      options.transcriptFiles || [
        ...collectJsonlFiles(path.join(home, ".claude", "projects")),
        ...collectJsonlFiles(path.join(home, ".codex", "sessions"))
      ];
    transcriptReport = auditTranscriptsForBlindWrites(tFiles);
    findings.push(...transcriptReport.findings);
  }

  if (canonicalHelpers.length > 0) {
    findings.push({
      ruleId: "CLS014",
      plane: "guard",
      severity: "INFO",
      file: "helper-registry",
      detail: `${canonicalHelpers.length} exported helper signatures indexed for CLAUDE.md reuse`,
      evidence: `${canonicalHelpers.length} canonical helpers`
    });
  }

  const ruleCounts = {};
  const severityCounts = { CRITICAL: 0, HIGH: 0, MEDIUM: 0, LOW: 0, INFO: 0 };
  for (const f of findings) {
    ruleCounts[f.ruleId] = (ruleCounts[f.ruleId] || 0) + 1;
    severityCounts[f.severity] = (severityCounts[f.severity] || 0) + 1;
  }

  let penalty = 0;
  for (const [ruleId, count] of Object.entries(ruleCounts)) {
    const meta = RULE_META[ruleId];
    if (!meta || meta.points === 0) continue;
    penalty += Math.min(meta.points * 2, meta.points * Math.sqrt(count));
  }

  const score = Math.max(0, Math.min(100, Math.round(100 - penalty)));
  const grade =
    score >= 90 ? "A" : score >= 80 ? "B" : score >= 65 ? "C" : score >= 50 ? "D" : "F";

  return {
    filesScanned: files.length,
    nonTrivialFunctions: nonTrivialFuncs.length,
    sessionsScanned: transcriptReport.sessionsScanned,
    score,
    grade,
    severityCounts,
    ruleCounts,
    metrics: {
      multiFileExactCloneGroups,
      pairwiseExactCloneGroups,
      totalExactCloneGroups: multiFileExactCloneGroups + pairwiseExactCloneGroups,
      nearDuplicateShinglePairs,
      duplicateHelperNamesCount,
      trulyDeadExportsCount,
      internalOnlyExportsCount,
      passThroughWrappersCount,
      shortBoilerplateFiltered,
      entryAndConventionExportsFiltered,
      barrelReexportsFiltered,
      totalWriteOrPatchCalls: transcriptReport.totalWriteOrPatchCalls,
      writeBeforeRepoSearch: transcriptReport.writeBeforeRepoSearch,
      writeBeforeRepoSearchPct: transcriptReport.writeBeforeRepoSearchPct,
      newHelperDefsInPatches: transcriptReport.newHelperDefsInPatches,
      newHelperDefsWithoutSearch: transcriptReport.newHelperDefsWithoutSearch,
      newHelperDefsWithoutSearchPct: transcriptReport.newHelperDefsWithoutSearchPct
    },
    canonicalHelpers: canonicalHelpers.slice(0, 60),
    findings
  };
}

export function generateCanonicalHelperIndex(report) {
  const helpers = report?.canonicalHelpers || [
    { name: "getReviewCommentContext", params: "ctx, prNumber", file: "packages/github/src/index.ts" },
    { name: "subscribeSessionEvents", params: "sessionId, handler", file: "packages/app/src/stream.ts" },
    { name: "summarize", params: "events, options", file: "packages/app/src/stream.ts" }
  ];

  const lines = [
    "## Canonical Helper Registry (Generated by `clonesieve`)",
    "",
    "Before creating a new utility function, wrapper, or `utils.ts`/`helpers.ts` file:",
    "1. Search existing exports with `Grep` / `rg` first (`CLS010` / `CLS011`).",
    "2. Reuse the canonical exported helpers below instead of re-implementing a duplicate copy:",
    "",
    "| Exported Helper | Signature | Canonical Module |",
    "| :--- | :--- | :--- |",
    ...helpers.slice(0, 25).map((h) => `| \`${h.name}\` | \`${h.name}(${h.params || ""})\` | \`${h.file}\` |`)
  ];

  const markdown = lines.join("\n");
  return {
    markdown,
    recommendedPath: ".claude/helper-index.md"
  };
}

export function getDemoResult() {
  return {
    filesScanned: 3300,
    nonTrivialFunctions: 4544,
    sessionsScanned: 153,
    score: 18,
    grade: "F",
    severityCounts: {
      CRITICAL: 19,
      HIGH: 261,
      MEDIUM: 371,
      LOW: 381,
      INFO: 4
    },
    ruleCounts: {
      CLS001: 19,
      CLS002: 98,
      CLS003: 14,
      CLS004: 370,
      CLS005: 163,
      CLS006: 381,
      CLS007: 11,
      CLS008: 1,
      CLS009: 1,
      CLS010: 14,
      CLS011: 28,
      CLS012: 4,
      CLS013: 1,
      CLS014: 1
    },
    metrics: {
      multiFileExactCloneGroups: 19,
      pairwiseExactCloneGroups: 98,
      totalExactCloneGroups: 117,
      nearDuplicateShinglePairs: 14,
      duplicateHelperNamesCount: 370,
      trulyDeadExportsCount: 163,
      internalOnlyExportsCount: 381,
      passThroughWrappersCount: 11,
      shortBoilerplateFiltered: 4559,
      entryAndConventionExportsFiltered: 648,
      barrelReexportsFiltered: 270,
      totalWriteOrPatchCalls: 132,
      writeBeforeRepoSearch: 59,
      writeBeforeRepoSearchPct: 44.7,
      newHelperDefsInPatches: 59,
      newHelperDefsWithoutSearch: 23,
      newHelperDefsWithoutSearchPct: 39.0
    },
    canonicalHelpers: [
      { name: "getReviewCommentContext", params: "ctx", file: "packages/github/src/index.ts" },
      { name: "getUserPrompt", params: "payload", file: "packages/github/src/index.ts" },
      { name: "subscribeSessionEvents", params: "id, onEvent", file: "packages/app/src/stream.ts" },
      { name: "summarize", params: "items", file: "packages/app/src/stream.ts" }
    ],
    findings: [
      {
        ruleId: "CLS001",
        plane: "codebase",
        severity: "CRITICAL",
        file: "packages/ui/src/brand/flash.tsx",
        detail: "Function \"DataWordmark\" has 7 identical structural copies across 7 files (flash.tsx, june.tsx, minimax.tsx, novel.tsx, sheep.tsx, video.tsx, stats-shell.tsx)",
        evidence: "DataWordmark: 7x (68 normalized tokens)"
      },
      {
        ruleId: "CLS002",
        plane: "codebase",
        severity: "HIGH",
        file: "packages/github/src/index.ts",
        detail: "Functions \"getReviewCommentContext\", \"getUserPrompt\", and \"subscribeSessionEvents\" duplicated across index.ts and github.handler.ts (117 structural clone groups total)",
        evidence: "getReviewCommentContext <-> getReviewCommentContext (46 normalized tokens)"
      },
      {
        ruleId: "CLS010",
        plane: "transcript",
        severity: "HIGH",
        file: "session-transcripts (153 logs)",
        detail: "23 of 59 new function definitions (39.0%) and 59 of 132 file writes (44.7%) were executed by the agent before any Grep/Glob/rg repo search in the session",
        evidence: "23 blind function definitions across 153 Claude Code & Codex transcripts"
      },
      {
        ruleId: "CLS005",
        plane: "codebase",
        severity: "HIGH",
        file: "packages/app/e2e/utils/visual-stability.ts",
        detail: "163 exported symbols (e.g., startVisualStabilityProbe, stopVisualStabilityProbe, runVisualStabilityScenario) have 0 cross-file references and 0 internal calls",
        evidence: "163 zero-caller orphan exports (after excluding 648 entrypoint/convention exports & 1,722 member/JSX refs)"
      },
      {
        ruleId: "CLS004",
        plane: "codebase",
        severity: "MEDIUM",
        file: "packages/app/src/stream.ts",
        detail: "370 non-trivial helper names (e.g., summarize 3x, chat 2x) are re-implemented across multiple distinct files",
        evidence: "370 cross-file duplicate helper names across 4,544 non-trivial functions"
      },
      {
        ruleId: "CLS009",
        plane: "guard",
        severity: "INFO",
        file: "false-positive-guards",
        detail: "4,559 short (< 25 token) boilerplate functions, 648 entrypoint/Next.js/SST convention exports, and 270 barrel re-exports excluded",
        evidence: "Prevented 2,103 false-positive dead-export and trivial-getter alerts"
      }
    ]
  };
}
