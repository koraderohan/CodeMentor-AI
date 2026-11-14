const DIAGRAM_START = /^\s*(?:flowchart|graph|classDiagram|sequenceDiagram|stateDiagram(?:-v2)?|erDiagram|journey|gantt|pie|quadrantChart|gitGraph|mindmap|timeline|zenuml|sankey-beta|xychart-beta|block-beta|packet-beta|architecture-beta|kanban|requirementDiagram)\b/i;

function escapeLabelText(value) {
  return value
    .replaceAll("&", "#amp;")
    .replaceAll('"', "#quot;")
    .replaceAll("<", "#lt;")
    .replaceAll(">", "#gt;");
}

function needsQuotedLabel(value) {
  return /[&()[\]{}"'<>|:;#]/u.test(value);
}

function findClosingDelimiter(line, start) {
  const pairs = { "[": "]", "(": ")", "{": "}" };
  const stack = [pairs[line[start]]];
  let quote = false;

  for (let index = start + 1; index < line.length; index += 1) {
    const character = line[index];

    if (character === '"' && line[index - 1] !== "\\") {
      quote = !quote;
      continue;
    }

    if (quote) continue;

    if (pairs[character]) {
      stack.push(pairs[character]);
    } else if (character === stack[stack.length - 1]) {
      stack.pop();

      if (stack.length === 0) return index;
    }
  }

  return -1;
}

function quoteFlowchartLabels(line) {
  let result = "";

  for (let index = 0; index < line.length; index += 1) {
    const character = line[index];
    const isDelimiter = character === "[" || character === "(" || character === "{";
    const previous = line[index - 1];

    if (
      !isDelimiter ||
      !previous ||
      !/[A-Za-z0-9_)\]]/u.test(previous)
    ) {
      result += character;
      continue;
    }

    const closingIndex = findClosingDelimiter(line, index);

    if (closingIndex === -1) {
      result += character;
      continue;
    }

    let label = line.slice(index + 1, closingIndex);
    let wrapper = "";

    if (
      label.length >= 2 &&
      label[0] === character &&
      label[label.length - 1] === { "[": "]", "(": ")", "{": "}" }[character]
    ) {
      wrapper = label[0];
      label = label.slice(1, -1);
    }

    if (label.startsWith('"') && label.endsWith('"')) {
      result += line.slice(index, closingIndex + 1);
    } else if (needsQuotedLabel(label)) {
      const quoted = `"${escapeLabelText(label)}"`;
      result += `${character}${wrapper}${quoted}${wrapper}${{ "[": "]", "(": ")", "{": "}" }[character]}`;
    } else {
      result += line.slice(index, closingIndex + 1);
    }

    index = closingIndex;
  }

  return result;
}

export function extractMermaidCode(value) {
  if (typeof value !== "string") return "";

  const content = value.replace(/\r\n?/gu, "\n").trim();
  const fenced = content.match(/```(?:mermaid)?\s*\n?([\s\S]*?)```/iu);
  const withoutFences = fenced ? fenced[1].trim() : content;
  const lines = withoutFences.split("\n");
  const firstDiagramLine = lines.findIndex((line) => DIAGRAM_START.test(line));

  if (firstDiagramLine === -1) return withoutFences;

  return lines.slice(firstDiagramLine).join("\n").trim();
}

export function normalizeMermaidCode(value) {
  const chart = extractMermaidCode(value);

  if (!/^\s*(?:flowchart|graph)\b/iu.test(chart)) {
    return chart;
  }

  return chart
    .split("\n")
    .map((line) => quoteFlowchartLabels(line))
    .join("\n");
}
