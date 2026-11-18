import remarkGfm from "remark-gfm";
import remarkParse from "remark-parse";
import { unified } from "unified";
import type { Issue } from "./errors.ts";

/**
 * Columns: side-by-side blocks, mainly for signature blocks.
 *
 *   <!-- columns -->
 *   First column
 *   <!-- column -->
 *   Second column
 *   <!-- /columns -->
 *
 * The markers are HTML comments, so other Markdown viewers hide them and show
 * the blocks one under the other.
 */
export const MAX_COLUMNS = 3;

/** The slice of an mdast node this module needs. */
interface MdNode {
  type: string;
  value?: string;
  children?: MdNode[];
  data?: Record<string, unknown>;
}

export interface ColumnNode {
  type: "column";
  children: MdNode[];
  data?: Record<string, unknown>;
}

export interface ColumnsNode {
  type: "columns";
  children: ColumnNode[];
  data?: Record<string, unknown>;
}

type Marker = "open" | "break" | "close" | "bad";

const MARKERS: Record<string, Marker> = { columns: "open", column: "break", "/columns": "close" };

/** Classify an HTML node. Null means it is not a column marker at all. */
function marker(node: MdNode): Marker | null {
  if (node.type !== "html" || typeof node.value !== "string") return null;
  const value = node.value.trim();
  const exact = /^<!--\s*([^\s]+)\s*-->$/.exec(value);
  if (exact && MARKERS[exact[1]!]) return MARKERS[exact[1]!]!;
  // A comment that was clearly meant as a marker, but is not one (typo, extra text).
  return /^<!--\s*\/?\s*colum/i.test(value) ? "bad" : null;
}

function wrap(columns: MdNode[][]): ColumnsNode {
  const count = Math.min(Math.max(columns.length, 1), MAX_COLUMNS);
  return {
    type: "columns",
    // remark-rehype turns unknown nodes into the element named by hName.
    data: { hName: "div", hProperties: { className: ["smd-columns", `smd-columns-${count}`] } },
    children: columns.map((children) => ({
      type: "column",
      data: { hName: "div", hProperties: { className: ["smd-column"] } },
      children,
    })),
  };
}

/**
 * Group the top-level nodes between column markers into one `columns` node.
 * Lenient on purpose: rendering never fails. `checkColumns` reports mistakes
 * when a template or document is saved.
 */
export function groupColumns(tree: { children: unknown[] }): void {
  const out: MdNode[] = [];
  let open: MdNode[][] | null = null;
  for (const node of tree.children as MdNode[]) {
    const kind = marker(node);
    if (kind === "open" && !open) open = [[]];
    else if (kind === "break" && open) open.push([]);
    else if (kind === "close" && open) {
      out.push(wrap(open));
      open = null;
    } else if (kind !== null) continue; // Stray or malformed marker: drop it.
    else if (open) open[open.length - 1]!.push(node);
    else out.push(node);
  }
  if (open) out.push(wrap(open));
  tree.children = out;
}

/** unified plugin form of `groupColumns`. */
export function remarkColumns() {
  return (tree: unknown): void => groupColumns(tree as { children: unknown[] });
}

const HINT = "Use <!-- columns -->, <!-- column --> between columns, and <!-- /columns -->, each on its own line";

/** Report column markers that would not render as the author expects. */
export function checkColumns(body: string): Issue[] {
  if (!body.includes("<!--")) return [];
  const issue = (message: string): Issue => ({ code: "TEMPLATE_INVALID", message });
  const issues: Issue[] = [];
  const tree = unified().use(remarkParse).use(remarkGfm).parse(body) as unknown as MdNode;

  let open = false;
  let count = 0;
  for (const node of tree.children ?? []) {
    const kind = marker(node);
    if (kind === null) {
      nested(node, issues);
    } else if (kind === "bad") {
      issues.push(issue(`Unknown column marker '${node.value!.trim()}'. ${HINT}`));
    } else if (kind === "open") {
      if (open) issues.push(issue("Columns cannot be nested. Close the block with <!-- /columns --> before starting another"));
      open = true;
      count = 1;
    } else if (!open) {
      issues.push(issue(`'${node.value!.trim()}' has no <!-- columns --> before it`));
    } else if (kind === "break") {
      count += 1;
      if (count === MAX_COLUMNS + 1) issues.push(issue(`A columns block can have at most ${MAX_COLUMNS} columns`));
    } else {
      open = false;
    }
  }
  if (open) issues.push(issue("A <!-- columns --> block is not closed. Add <!-- /columns --> after the last column"));
  return issues;
}

/** Markers only work at the top level, not inside lists, quotes, tables or paragraphs. */
function nested(node: MdNode, issues: Issue[]): void {
  for (const child of node.children ?? []) {
    if (marker(child) !== null) {
      issues.push({
        code: "TEMPLATE_INVALID",
        message: `Column marker '${child.value!.trim()}' must be on its own line, outside lists, quotes and tables`,
      });
    } else nested(child, issues);
  }
}
