import assert from "node:assert/strict";
import test from "node:test";
import {
  extractMermaidCode,
  normalizeMermaidCode,
} from "../src/mermaidUtils.js";

test("extracts Mermaid code from fences and surrounding explanation", () => {
  const response = [
    "Here is the diagram:",
    "```mermaid",
    "flowchart TD",
    "  A[Start] --> B[Done]",
    "```",
    "This diagram shows the process.",
  ].join("\n");

  assert.equal(
    extractMermaidCode(response),
    "flowchart TD\n  A[Start] --> B[Done]"
  );
});

test("quotes flowchart labels containing Mermaid special characters", () => {
  const chart = [
    "flowchart TD",
    "  A[Inheritance & Contract] --> B[API (v2)]",
    "  B --> C[Rules {strict} and [optional]]",
    "  C --> D[Already valid]",
  ].join("\n");

  assert.equal(
    normalizeMermaidCode(chart),
    [
      "flowchart TD",
      '  A["Inheritance #amp; Contract"] --> B["API (v2)"]',
      '  B --> C["Rules {strict} and [optional]"]',
      "  C --> D[Already valid]",
    ].join("\n")
  );
});

test("preserves quoted labels and non-flowchart diagram syntax", () => {
  const chart = [
    "```",
    "sequenceDiagram",
    '  participant A as User (Admin) "quoted"',
    "  A->>B: Hello & welcome",
    "```",
  ].join("\n");

  assert.equal(normalizeMermaidCode(chart), [
    "sequenceDiagram",
    '  participant A as User (Admin) "quoted"',
    "  A->>B: Hello & welcome",
  ].join("\n"));
});
