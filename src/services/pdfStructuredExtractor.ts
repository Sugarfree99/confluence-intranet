/**
 * Structured PDF extractor.
 *
 * Uses pdfjs-dist to read each page's text items with their (x, y, font-size)
 * positions and any AcroForm widget annotations. From this we reconstruct:
 *   - Headings   (font size relative to page median)
 *   - Paragraphs (lines with one column)
 *   - Tables     (groups of consecutive lines that share >=2 column gaps)
 *   - Forms      (AcroForm widget annotations -> labelled inputs)
 *
 * Output is two strings:
 *   - text: plain text (one line per visual line, blank line between blocks).
 *           Used for chunking / embeddings.
 *   - html: semantic HTML using <h1>-<h3>, <p>, <table>/<tr>/<td>,
 *           <form>/<label>/<input>. Used for inline rendering in /doc/:slug.
 */

import * as path from "path";

// pdfjs-dist v3 ships a Node-friendly CommonJS legacy build.
// eslint-disable-next-line @typescript-eslint/no-var-requires
const pdfjsLib = require("pdfjs-dist/legacy/build/pdf.js");

// Absolute path to the bundled standard font data. pdfjs needs this to
// resolve font metrics for Type1 / TrueType fonts in many PDFs.
const STANDARD_FONT_DATA_URL = path.join(
  path.dirname(require.resolve("pdfjs-dist/package.json")),
  "standard_fonts",
  path.sep
);

export interface StructuredPdfResult {
  text: string;
  html: string;
  pages: number;
}

interface TextItem {
  str: string;
  x: number;
  y: number;
  width: number;
  height: number;
  fontSize: number;
  hasEOL: boolean;
}

interface Line {
  y: number;
  fontSize: number;
  items: TextItem[]; // sorted by x
}

interface Annotation {
  subtype?: string;
  fieldType?: string;
  fieldName?: string;
  fieldValue?: unknown;
  alternativeText?: string;
  rect?: number[];
  options?: Array<{ exportValue?: string; displayValue?: string }>;
  multiLine?: boolean;
  checkBox?: boolean;
  radioButton?: boolean;
  pushButton?: boolean;
  combo?: boolean;
  readOnly?: boolean;
}

function escapeHtml(value: string): string {
  return String(value || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/** Group raw text items into visual lines by Y coordinate. */
function groupIntoLines(items: TextItem[]): Line[] {
  if (items.length === 0) return [];

  // PDF coordinates: larger y is higher on the page. Sort top-to-bottom.
  const sorted = [...items].sort((a, b) => b.y - a.y);

  const lines: Line[] = [];
  for (const it of sorted) {
    if (!it.str || !it.str.trim()) continue;
    // Tolerance: half the item's height -> robust to subscript/superscript drift.
    const tol = Math.max(2, it.height * 0.5);
    const last = lines[lines.length - 1];
    if (last && Math.abs(last.y - it.y) <= tol) {
      last.items.push(it);
      // Track the dominant font size of the line.
      if (it.fontSize > last.fontSize) last.fontSize = it.fontSize;
    } else {
      lines.push({ y: it.y, fontSize: it.fontSize, items: [it] });
    }
  }

  for (const ln of lines) {
    ln.items.sort((a, b) => a.x - b.x);
  }
  return lines;
}

/**
 * Detect column boundaries within a line by looking at gaps between
 * consecutive items. A "gap" larger than ~1.5x the item's height is
 * considered a column break.
 */
function splitLineIntoCells(line: Line): string[] {
  const cells: string[] = [];
  let current: string[] = [];
  let prevEndX = -Infinity;
  let prevHeight = 0;

  for (const item of line.items) {
    const gap = item.x - prevEndX;
    const threshold = Math.max(prevHeight, item.height) * 1.8;
    if (current.length > 0 && gap > threshold) {
      cells.push(current.join(" ").replace(/\s+/g, " ").trim());
      current = [];
    }
    current.push(item.str);
    prevEndX = item.x + item.width;
    prevHeight = item.height;
  }
  if (current.length > 0) {
    cells.push(current.join(" ").replace(/\s+/g, " ").trim());
  }
  return cells.filter((c) => c.length > 0);
}

/** Median helper. */
function median(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? (sorted[mid - 1] + sorted[mid]) / 2
    : sorted[mid];
}

interface Block {
  type: "heading" | "paragraph" | "table";
  level?: 1 | 2 | 3;
  text?: string;
  rows?: string[][];
}

/**
 * Walk the lines of a single page and emit semantic blocks. Consecutive
 * multi-cell lines collapse into a single <table>; single-cell lines
 * become paragraphs (or headings if the font is unusually large).
 */
function linesToBlocks(lines: Line[], bodyFontSize: number): Block[] {
  const blocks: Block[] = [];

  let tableBuf: string[][] | null = null;
  const flushTable = () => {
    if (tableBuf && tableBuf.length >= 2) {
      blocks.push({ type: "table", rows: tableBuf });
    } else if (tableBuf && tableBuf.length === 1) {
      // Only one multi-cell line -> treat as paragraph with tabs collapsed.
      blocks.push({ type: "paragraph", text: tableBuf[0].join("  ") });
    }
    tableBuf = null;
  };

  for (const ln of lines) {
    const cells = splitLineIntoCells(ln);
    if (cells.length === 0) continue;

    if (cells.length >= 2) {
      if (!tableBuf) tableBuf = [];
      tableBuf.push(cells);
      continue;
    }

    flushTable();

    const text = cells[0];
    // Heading heuristic: font size noticeably larger than the body text.
    const ratio = bodyFontSize > 0 ? ln.fontSize / bodyFontSize : 1;
    if (ratio >= 1.6) blocks.push({ type: "heading", level: 1, text });
    else if (ratio >= 1.3) blocks.push({ type: "heading", level: 2, text });
    else if (ratio >= 1.15) blocks.push({ type: "heading", level: 3, text });
    else blocks.push({ type: "paragraph", text });
  }
  flushTable();

  return blocks;
}

/**
 * Render AcroForm widget annotations as a disabled <form> mirroring the
 * field layout of the PDF. Read-only by design — this is a preview, not a
 * submission surface.
 */
function renderForm(annotations: Annotation[]): { html: string; text: string } {
  const widgets = annotations.filter(
    (a) => a.subtype === "Widget" && a.fieldType
  );
  if (widgets.length === 0) return { html: "", text: "" };

  // Sort top-to-bottom, left-to-right by their rect.
  widgets.sort((a, b) => {
    const ay = a.rect ? -a.rect[3] : 0; // top
    const by = b.rect ? -b.rect[3] : 0;
    if (ay !== by) return ay - by;
    const ax = a.rect ? a.rect[0] : 0;
    const bx = b.rect ? b.rect[0] : 0;
    return ax - bx;
  });

  const parts: string[] = [];
  const textLines: string[] = [];

  for (const w of widgets) {
    const name = w.fieldName || w.alternativeText || "";
    const labelText = (w.alternativeText || w.fieldName || "Fält").toString();
    const value =
      typeof w.fieldValue === "string"
        ? w.fieldValue
        : Array.isArray(w.fieldValue)
        ? w.fieldValue.join(", ")
        : w.fieldValue == null
        ? ""
        : String(w.fieldValue);
    const safeLabel = escapeHtml(labelText);
    const safeName = escapeHtml(name);
    const safeValue = escapeHtml(value);

    switch (w.fieldType) {
      case "Tx": {
        // Text field
        if (w.multiLine) {
          parts.push(
            `<div class="pdf-field"><label>${safeLabel}</label>` +
              `<textarea name="${safeName}" disabled>${safeValue}</textarea></div>`
          );
        } else {
          parts.push(
            `<div class="pdf-field"><label>${safeLabel}</label>` +
              `<input type="text" name="${safeName}" value="${safeValue}" disabled /></div>`
          );
        }
        textLines.push(`${labelText}: ${value}`);
        break;
      }
      case "Btn": {
        if (w.checkBox) {
          const checked = value && value !== "Off" ? " checked" : "";
          parts.push(
            `<div class="pdf-field pdf-field-check"><label>` +
              `<input type="checkbox" name="${safeName}"${checked} disabled />` +
              ` ${safeLabel}</label></div>`
          );
          textLines.push(
            `[${checked ? "x" : " "}] ${labelText}`
          );
        } else if (w.radioButton) {
          parts.push(
            `<div class="pdf-field pdf-field-check"><label>` +
              `<input type="radio" name="${safeName}" disabled />` +
              ` ${safeLabel}</label></div>`
          );
          textLines.push(`( ) ${labelText}`);
        }
        // Push buttons are skipped — they have no value to preview.
        break;
      }
      case "Ch": {
        // Choice (dropdown / list)
        const opts = (w.options || [])
          .map((o) => {
            const v = escapeHtml(o.exportValue || o.displayValue || "");
            const d = escapeHtml(o.displayValue || o.exportValue || "");
            const sel = (o.exportValue || o.displayValue) === value ? " selected" : "";
            return `<option value="${v}"${sel}>${d}</option>`;
          })
          .join("");
        parts.push(
          `<div class="pdf-field"><label>${safeLabel}</label>` +
            `<select name="${safeName}" disabled>${opts}</select></div>`
        );
        textLines.push(`${labelText}: ${value}`);
        break;
      }
      case "Sig": {
        parts.push(
          `<div class="pdf-field pdf-field-sig"><label>${safeLabel}</label>` +
            `<span class="pdf-signature">${safeValue || "(signatur)"}</span></div>`
        );
        textLines.push(`${labelText}: (signatur)`);
        break;
      }
    }
  }

  if (parts.length === 0) return { html: "", text: "" };
  return {
    html:
      `<h2 class="pdf-form-heading">Formulärfält</h2>` +
      `<form class="pdf-form" onsubmit="return false">${parts.join("")}</form>`,
    text: textLines.join("\n"),
  };
}

/** Render a list of blocks as HTML and a plain-text representation. */
function renderBlocks(blocks: Block[]): { html: string; text: string } {
  const htmlParts: string[] = [];
  const textParts: string[] = [];

  for (const b of blocks) {
    if (b.type === "heading" && b.text) {
      const lvl = b.level || 2;
      htmlParts.push(`<h${lvl}>${escapeHtml(b.text)}</h${lvl}>`);
      textParts.push(b.text);
      textParts.push("");
    } else if (b.type === "paragraph" && b.text) {
      htmlParts.push(`<p>${escapeHtml(b.text)}</p>`);
      textParts.push(b.text);
    } else if (b.type === "table" && b.rows && b.rows.length > 0) {
      // Normalize row widths so every row has the same column count.
      const cols = Math.max(...b.rows.map((r) => r.length));
      const headerCells = b.rows[0]
        .concat(Array(cols - b.rows[0].length).fill(""))
        .map((c) => `<th>${escapeHtml(c)}</th>`)
        .join("");
      const bodyRows = b.rows
        .slice(1)
        .map((r) => {
          const cells = r
            .concat(Array(cols - r.length).fill(""))
            .map((c) => `<td>${escapeHtml(c)}</td>`)
            .join("");
          return `<tr>${cells}</tr>`;
        })
        .join("");
      htmlParts.push(
        `<table class="pdf-table"><thead><tr>${headerCells}</tr></thead>` +
          `<tbody>${bodyRows}</tbody></table>`
      );
      textParts.push(b.rows.map((r) => r.join("\t")).join("\n"));
    }
    if (b.type === "paragraph") textParts.push("");
  }

  return { html: htmlParts.join(""), text: textParts.join("\n") };
}

/**
 * Main entry point: take a PDF buffer and return both a plain-text
 * representation (for embeddings) and a semantic HTML rendering (for
 * inline preview). Tables and AcroForm fields are reconstructed; plain
 * paragraphs/headings are inferred from font-size heuristics.
 */
export async function extractStructuredPdf(
  buffer: Buffer
): Promise<StructuredPdfResult> {
  // pdfjs wants a Uint8Array, not a Node Buffer (it does duck-type checks).
  const data = new Uint8Array(
    buffer.buffer,
    buffer.byteOffset,
    buffer.byteLength
  );
  const loadingTask = pdfjsLib.getDocument({
    data,
    standardFontDataUrl: STANDARD_FONT_DATA_URL,
    disableFontFace: true,
    useSystemFonts: false,
    isEvalSupported: false,
  });
  const pdf = await loadingTask.promise;

  const pageCount: number = pdf.numPages;
  const pageHtml: string[] = [];
  const pageText: string[] = [];

  for (let p = 1; p <= pageCount; p++) {
    const page = await pdf.getPage(p);

    const [textContent, annotations] = await Promise.all([
      page.getTextContent(),
      page.getAnnotations(),
    ]);

    const items: TextItem[] = (textContent.items || [])
      .filter((it: any) => typeof it.str === "string")
      .map((it: any) => {
        // transform = [a, b, c, d, e, f]; e=x, f=y. Font size ~= sqrt(a*a+b*b).
        const tx = it.transform || [1, 0, 0, 1, 0, 0];
        const fontSize = Math.hypot(tx[0], tx[1]) || it.height || 0;
        return {
          str: it.str,
          x: tx[4],
          y: tx[5],
          width: it.width || 0,
          height: it.height || fontSize,
          fontSize,
          hasEOL: !!it.hasEOL,
        };
      });

    const lines = groupIntoLines(items);
    const bodyFontSize = median(
      lines.map((l) => l.fontSize).filter((s) => s > 0)
    );
    const blocks = linesToBlocks(lines, bodyFontSize);

    const { html: blockHtml, text: blockText } = renderBlocks(blocks);
    const { html: formHtml, text: formText } = renderForm(annotations);

    const pageInner =
      (pageCount > 1 ? `<h2 class="pdf-page-heading">Sida ${p}</h2>` : "") +
      blockHtml +
      formHtml;
    pageHtml.push(`<section class="pdf-page">${pageInner}</section>`);

    const pageTextOut = [blockText, formText].filter((s) => s.trim()).join("\n\n");
    if (pageTextOut.trim()) pageText.push(pageTextOut);
  }

  // Best-effort cleanup so the worker can shut down.
  try {
    await pdf.cleanup();
    await pdf.destroy();
  } catch {
    /* ignore */
  }

  return {
    pages: pageCount,
    html: pageHtml.join(""),
    text: pageText.join("\n\n").trim(),
  };
}
