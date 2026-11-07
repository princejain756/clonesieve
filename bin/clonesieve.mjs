#!/usr/bin/env node

import path from "node:path";
import {
  RULE_META,
  auditCodebaseClones,
  generateCanonicalHelperIndex,
  getDemoResult,
} from "../src/analyzer.mjs";

const ANSI = {
  reset: "\x1b[0m",
  bold: "\x1b[1m",
  dim: "\x1b[2m",
  red: "\x1b[31m",
  green: "\x1b[32m",
  yellow: "\x1b[33m",
  blue: "\x1b[34m",
  magenta: "\x1b[35m",
  cyan: "\x1b[36m",
};

function severityBadge(severity) {
  const s = String(severity || "").toUpperCase();
  if (s === "CRITICAL") return `${ANSI.red}${ANSI.bold}[CRIT]${ANSI.reset}`;
  if (s === "HIGH") return `${ANSI.yellow}${ANSI.bold}[HIGH]${ANSI.reset}`;
  if (s === "MEDIUM") return `${ANSI.cyan}[MED ]${ANSI.reset}`;
  if (s === "LOW") return `${ANSI.blue}[LOW ]${ANSI.reset}`;
  return `${ANSI.dim}[INFO]${ANSI.reset}`;
}

function gradeBadge(grade, score) {
  const color = score >= 85 ? ANSI.green : score >= 70 ? ANSI.yellow : ANSI.red;
  return `${color}${ANSI.bold}${grade} (${score}/100)${ANSI.reset}`;
}

function printHelp() {
  console.log(`${ANSI.bold}clonesieve v0.1.0${ANSI.reset} - Codebase Structural Clone, Duplicate Helper & Dead-Export Auditor

${ANSI.bold}USAGE${ANSI.reset}
  npx clonesieve [path...] [options]

${ANSI.bold}OPTIONS${ANSI.reset}
  --demo                 Run against built-in 3,300-file + 153-session benchmark dataset
  --json                 Emit structured JSON report
  --emit-index           Print markdown Canonical Helper Index for CLAUDE.md / AGENTS.md
  --with-transcripts     Also scan ~/.claude/projects and ~/.codex/sessions for blind writes
  --fail-on <severity>   Exit 1 if findings >= severity (critical|high|medium|low)
  --rules                List all 14 CloneSieve rules (CLS001-CLS014)
  -v, --version          Print version
  -h, --help             Show this help message
`);
}

function printRules() {
  console.log(`${ANSI.bold}CloneSieve Rules (CLS001 - CLS014)${ANSI.reset}\n`);
  for (const rule of Object.values(RULE_META)) {
    console.log(
      `  ${severityBadge(rule.severity)} ${ANSI.bold}${rule.id}${ANSI.reset} (${rule.plane})\n` +
        `         ${ANSI.dim}${rule.title}${ANSI.reset}`
    );
  }
}

function renderReport(report) {
  const m = report.metrics || {};
  console.log(
    `\n${ANSI.bold}CloneSieve v0.1.0${ANSI.reset}  ${ANSI.dim}Structural Function Clone, Duplicate Helper & Dead-Export Auditor${ANSI.reset}`
  );
  console.log(`${ANSI.dim}${"─".repeat(86)}${ANSI.reset}`);
  console.log(
    `  ${ANSI.bold}Files Scanned:${ANSI.reset} ${report.filesScanned.toLocaleString()}   ` +
      `${ANSI.bold}Functions (>=25 tok):${ANSI.reset} ${report.nonTrivialFunctions.toLocaleString()}   ` +
      `${ANSI.bold}Sessions:${ANSI.reset} ${report.sessionsScanned}   ` +
      `${ANSI.bold}Score:${ANSI.reset} ${gradeBadge(report.grade, report.score)}`
  );
  console.log(
    `  ${ANSI.bold}Exact Clone Groups:${ANSI.reset} ${ANSI.red}${ANSI.bold}${m.totalExactCloneGroups || 0}${ANSI.reset} (${m.multiFileExactCloneGroups || 0} >=3x, ${m.pairwiseExactCloneGroups || 0} 2x)   ` +
      `${ANSI.bold}Dup Helper Names:${ANSI.reset} ${ANSI.yellow}${ANSI.bold}${m.duplicateHelperNamesCount || 0}${ANSI.reset}   ` +
      `${ANSI.bold}Dead Orphan Exports:${ANSI.reset} ${ANSI.red}${ANSI.bold}${m.trulyDeadExportsCount || 0}${ANSI.reset}   ` +
      `${ANSI.bold}Internal-Only Exports:${ANSI.reset} ${ANSI.cyan}${m.internalOnlyExportsCount || 0}${ANSI.reset}`
  );
  console.log(
    `  ${ANSI.bold}False-Positive Guards:${ANSI.reset} ` +
      `${ANSI.green}${(m.shortBoilerplateFiltered || 0).toLocaleString()} short (<25 tok) functions skipped${ANSI.reset}, ` +
      `${ANSI.green}${m.entryAndConventionExportsFiltered || 0} entrypoint/framework exports skipped${ANSI.reset}, ` +
      `${ANSI.green}${m.barrelReexportsFiltered || 0} barrel re-exports skipped${ANSI.reset}`
  );

  if (report.sessionsScanned > 0) {
    console.log(
      `  ${ANSI.bold}Agent Transcripts (${report.sessionsScanned} sessions):${ANSI.reset} ` +
        `${ANSI.yellow}${ANSI.bold}${m.newHelperDefsWithoutSearch}/${m.newHelperDefsInPatches} (${m.newHelperDefsWithoutSearchPct}%)${ANSI.reset} new functions & ` +
        `${ANSI.yellow}${ANSI.bold}${m.writeBeforeRepoSearch}/${m.totalWriteOrPatchCalls} (${m.writeBeforeRepoSearchPct}%)${ANSI.reset} file writes before any Grep/Glob search`
    );
  }
  console.log(`${ANSI.dim}${"─".repeat(86)}${ANSI.reset}\n`);

  if (!report.findings || report.findings.length === 0) {
    console.log(`  ${ANSI.green}${ANSI.bold}✓ Zero structural clones or dead orphan exports detected.${ANSI.reset}\n`);
    return;
  }

  console.log(`${ANSI.bold}TOP FINDINGS${ANSI.reset}`);
  for (const f of report.findings.slice(0, 10)) {
    console.log(
      `  ${severityBadge(f.severity)} ${ANSI.bold}${f.ruleId}${ANSI.reset}  ${ANSI.magenta}${f.file}${ANSI.reset}  ${ANSI.dim}[${f.evidence}]${ANSI.reset}`
    );
    console.log(`         ${f.detail}`);
  }
  console.log("");
}

function shouldFail(findings, failOn) {
  if (!failOn) return false;
  const rank = { INFO: 0, LOW: 1, MEDIUM: 2, HIGH: 3, CRITICAL: 4 };
  const threshold = rank[String(failOn).toUpperCase()] ?? 3;
  return findings.some((f) => (rank[String(f.severity).toUpperCase()] ?? 0) >= threshold);
}

function main() {
  const args = process.argv.slice(2);
  if (args.includes("-h") || args.includes("--help")) {
    printHelp();
    process.exit(0);
  }
  if (args.includes("-v") || args.includes("--version")) {
    console.log("0.1.0");
    process.exit(0);
  }
  if (args.includes("--rules")) {
    printRules();
    process.exit(0);
  }

  const isDemo = args.includes("--demo");
  const isJson = args.includes("--json");
  const emitIndex = args.includes("--emit-index");
  const withTranscripts = args.includes("--with-transcripts");
  const failOnIdx = args.indexOf("--fail-on");
  const failOn = failOnIdx !== -1 ? args[failOnIdx + 1] : null;

  const targets = args.filter(
    (a, idx) => !a.startsWith("-") && (failOnIdx === -1 || idx !== failOnIdx + 1)
  );

  let report;
  if (isDemo) {
    report = getDemoResult();
  } else {
    const resolvedTargets = targets.length > 0 ? targets.map((t) => path.resolve(t)) : [process.cwd()];
    report = auditCodebaseClones(resolvedTargets, {
      includeDefaultTranscripts: withTranscripts,
    });
  }

  if (emitIndex) {
    const idx = generateCanonicalHelperIndex(report);
    console.log(idx.markdown);
    process.exit(0);
  }

  if (isJson) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    renderReport(report);
  }

  if (shouldFail(report.findings, failOn)) {
    process.exit(1);
  }
}

main();
