import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  RULE_META,
  auditCodebaseClones,
  auditTranscriptsForBlindWrites,
  generateCanonicalHelperIndex,
  getDemoResult,
} from "../src/analyzer.mjs";

test("CLS001/CLS002/CLS003: detects multi-file Type-2 normalized structural clones and shingle near-duplicates while skipping <25 token getters (CLS008)", () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "clonesieve-test-1-"));
  const sharedBodyA = `
export function formatInvoiceRowA(rowData) {
  if (!rowData || typeof rowData !== "object") {
    throw new TypeError("Missing invoice row object");
  }
  const subtotalCents = Math.round(Number(rowData.unitPrice || 0) * Number(rowData.quantity || 1) * 100);
  const taxCents = Math.round(subtotalCents * Number(rowData.taxRate || 0.0825));
  const discountCents = Math.min(subtotalCents, Math.round(Number(rowData.discount || 0) * 100));
  const totalCents = subtotalCents + taxCents - discountCents;
  return {
    id: String(rowData.id || "inv_default"),
    subtotalCents,
    taxCents,
    discountCents,
    totalCents,
  };
}
export function tinyGetter(x) { return x + 1; }
`;
  const sharedBodyB = `
export function formatBillingEntryB(entryItem) {
  if (!entryItem || typeof entryItem !== "object") {
    throw new TypeError("Invalid billing entry payload");
  }
  const baseCents = Math.round(Number(entryItem.unitPrice || 0) * Number(entryItem.quantity || 1) * 100);
  const vatCents = Math.round(baseCents * Number(entryItem.taxRate || 0.15));
  const rebateCents = Math.min(baseCents, Math.round(Number(entryItem.discount || 0) * 100));
  const finalCents = baseCents + vatCents - rebateCents;
  return {
    id: String(entryItem.id || "bill_fallback"),
    baseCents,
    vatCents,
    rebateCents,
    finalCents,
  };
}
export function tinyGetter(y) { return y + 2; }
`;
  const sharedBodyC = sharedBodyA.replace("formatInvoiceRowA", "formatOrderLineC");

  fs.writeFileSync(path.join(tmpDir, "invoice.ts"), sharedBodyA, "utf8");
  fs.writeFileSync(path.join(tmpDir, "billing.ts"), sharedBodyB, "utf8");
  fs.writeFileSync(path.join(tmpDir, "order.ts"), sharedBodyC, "utf8");

  const report = auditCodebaseClones([tmpDir]);
  assert.equal(report.filesScanned, 3);
  assert.equal(report.metrics.multiFileExactCloneGroups, 1);
  assert.equal(report.metrics.totalExactCloneGroups, 1);
  assert.ok(report.metrics.shortBoilerplateFiltered >= 3, "Short getters should be filtered by CLS008");
  assert.ok(report.findings.some((f) => f.ruleId === "CLS001"));
});

test("CLS004 & CLS007: detects cross-file duplicate helper names and pass-through wrappers", () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "clonesieve-test-2-"));
  const file1 = `
export function getReviewCommentContext(payload) {
  const items = Array.isArray(payload?.comments) ? payload.comments : [];
  const filtered = items.filter((item) => Boolean(item && item.body && item.author));
  return filtered.map((item, idx) => ({
    index: idx,
    author: String(item.author).trim(),
    body: String(item.body).slice(0, 240),
  }));
}
`;
  const file2 = `
export function getReviewCommentContext(eventObj) {
  const entries = [];
  for (const raw of eventObj?.reviewThreads || []) {
    if (raw && raw.text && raw.reviewer) {
      entries.push({ user: raw.reviewer, comment: raw.text, created: raw.timestamp || 0 });
    }
  }
  return entries.sort((a, b) => a.created - b.created);
}
export function fetchReviewContextWrapper(eventObj) {
  return getReviewCommentContext(eventObj);
}
`;
  fs.writeFileSync(path.join(tmpDir, "github-a.ts"), file1, "utf8");
  fs.writeFileSync(path.join(tmpDir, "github-b.ts"), file2, "utf8");

  const report = auditCodebaseClones([tmpDir]);
  assert.equal(report.metrics.duplicateHelperNamesCount, 1);
  assert.ok(report.findings.some((f) => f.ruleId === "CLS004" && f.detail.includes("getReviewCommentContext")));
  assert.ok(report.findings.some((f) => f.ruleId === "CLS007"));
});

test("CLS005, CLS006 & CLS009: separates truly dead zero-caller orphan exports from internal-only over-exports and skips entrypoint conventions", () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "clonesieve-test-3-"));
  fs.writeFileSync(
    path.join(tmpDir, "metrics-helper.ts"),
    `
export function usedAcrossFiles(val) {
  return val * 2;
}
export function usedOnlyInternally(val) {
  return val + 10;
}
export function trulyDeadOrphanHelper(val) {
  return val - 99;
}
export function computeSummary(x) {
  return usedOnlyInternally(x);
}
`,
    "utf8"
  );
  fs.writeFileSync(
    path.join(tmpDir, "consumer.tsx"),
    `
import * as metrics from "./metrics-helper";
export function runConsumer() {
  return metrics.usedAcrossFiles(21) + metrics.computeSummary(5);
}
`,
    "utf8"
  );
  // index.ts entrypoint exports should be skipped by CLS009
  fs.writeFileSync(
    path.join(tmpDir, "index.ts"),
    `
export * from "./consumer";
export function publicSdkEntrypoint() {
  return 42;
}
`,
    "utf8"
  );

  const report = auditCodebaseClones([tmpDir]);
  assert.ok(
    report.findings.some((f) => f.ruleId === "CLS005" && f.detail.includes("trulyDeadOrphanHelper")),
    "trulyDeadOrphanHelper has 0 external and 0 internal callers"
  );
  assert.ok(
    report.findings.some((f) => f.ruleId === "CLS006" && f.detail.includes("usedOnlyInternally")),
    "usedOnlyInternally is called inside metrics-helper.ts"
  );
  assert.ok(report.metrics.entryAndConventionExportsFiltered >= 1, "index.ts entrypoint exports skipped");
  assert.ok(report.metrics.barrelReexportsFiltered >= 1, "export * from barrel recorded");
});

test("CLS010/CLS011/CLS012/CLS013: detects blind agent function additions & file writes before Grep/Glob search and deduplicates tool_use IDs", () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "clonesieve-test-4-"));
  const jsonlPath = path.join(tmpDir, "session-blind.jsonl");

  const blindToolCall = {
    type: "assistant",
    message: {
      id: "msg_01",
      content: [
        {
          type: "tool_use",
          id: "toolu_blind_1",
          name: "Write",
          input: {
            file_path: "/repo/src/utils.ts",
            content: "export function formatDuration(ms) {\n  return `${ms}ms`;\n}\n",
          },
        },
      ],
    },
  };
  const searchCall = {
    type: "assistant",
    message: {
      id: "msg_02",
      content: [
        {
          type: "tool_use",
          id: "toolu_grep_1",
          name: "Grep",
          input: { pattern: "formatDuration" },
        },
      ],
    },
  };
  const informedWriteCall = {
    type: "assistant",
    message: {
      id: "msg_03",
      content: [
        {
          type: "tool_use",
          id: "toolu_write_2",
          name: "Edit",
          input: {
            file_path: "/repo/src/existing.ts",
            new_string: "export function parseHeader(raw) {\n  return raw.trim();\n}\n",
          },
        },
      ],
    },
  };

  fs.writeFileSync(
    jsonlPath,
    [blindToolCall, blindToolCall, searchCall, informedWriteCall]
      .map((row) => JSON.stringify(row))
      .join("\n"),
    "utf8"
  );

  const stats = auditTranscriptsForBlindWrites([jsonlPath]);
  assert.equal(stats.sessionsScanned, 1);
  assert.equal(stats.totalWriteOrPatchCalls, 2);
  assert.equal(stats.writeBeforeRepoSearch, 1);
  assert.equal(stats.newHelperDefsInPatches, 2);
  assert.equal(stats.newHelperDefsWithoutSearch, 1);
  assert.equal(stats.genericUtilFilesCreated, 1);
  assert.equal(stats.duplicateStreamEventsSkipped, 1);
  assert.ok(stats.findings.some((f) => f.ruleId === "CLS010"));
  assert.ok(stats.findings.some((f) => f.ruleId === "CLS012"));
});

test("generateCanonicalHelperIndex and getDemoResult return verified 3,300-file + 153-session benchmark and 14 rules", () => {
  assert.equal(Object.keys(RULE_META).length, 14);
  const demo = getDemoResult();
  assert.equal(demo.filesScanned, 3300);
  assert.equal(demo.nonTrivialFunctions, 4544);
  assert.equal(demo.metrics.totalExactCloneGroups, 117);
  assert.equal(demo.metrics.duplicateHelperNamesCount, 370);
  assert.equal(demo.metrics.trulyDeadExportsCount, 163);
  assert.equal(demo.metrics.internalOnlyExportsCount, 381);
  assert.equal(demo.sessionsScanned, 153);
  assert.equal(demo.metrics.newHelperDefsWithoutSearchPct, 39.0);

  const indexObj = generateCanonicalHelperIndex(demo);
  assert.ok(indexObj.markdown.includes("Canonical Helper Registry"));
  assert.ok(indexObj.markdown.includes("getReviewCommentContext"));
});
