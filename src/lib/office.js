import fs from "node:fs";
import path from "node:path";
import { Document, Packer, Paragraph } from "docx";
import ExcelJS from "exceljs";
import mammoth from "mammoth";
import { MAX_OFFICE_FILE_BYTES } from "./config.js";
import { assertInWorkspace, resolveUserPath } from "./paths.js";
import { clip } from "./text.js";

const MAX_ROWS = 200;
const MAX_COLUMNS = 50;

export async function readOfficeFile(input) {
  const target = assertInWorkspace(resolveUserPath(input));
  const stat = fs.statSync(target);
  if (stat.size > MAX_OFFICE_FILE_BYTES) throw new Error(`office file exceeds ${MAX_OFFICE_FILE_BYTES} byte limit`);
  const ext = path.extname(target).toLowerCase();
  if (ext === ".docx") {
    const result = await mammoth.extractRawText({ path: target });
    return { path: target, format: "docx", text: clip(result.value, 40_000), warnings: result.messages };
  }
  if (ext === ".xlsx") {
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.readFile(target);
    return {
      path: target,
      format: "xlsx",
      sheets: workbook.worksheets.map((sheet) => ({
        name: sheet.name,
        rowCount: sheet.rowCount,
        columnCount: sheet.columnCount,
        rows: sheet.getRows(1, Math.min(sheet.rowCount, MAX_ROWS))?.map((row) => row.values.slice(1, MAX_COLUMNS + 1).map(cellValue)) || [],
        truncated: sheet.rowCount > MAX_ROWS || sheet.columnCount > MAX_COLUMNS,
      })),
    };
  }
  if ([".txt", ".md", ".csv", ".tsv", ".json", ".xml", ".html", ".rtf"].includes(ext)) {
    return { path: target, format: ext.slice(1) || "text", text: clip(fs.readFileSync(target, "utf8"), 40_000) };
  }
  throw new Error(`unsupported office format ${ext || "(none)"}; supported: docx, xlsx, csv/tsv, and text`);
}

export async function writeOfficeFile(input, content) {
  const target = assertInWorkspace(resolveUserPath(input), { write: true });
  const ext = path.extname(target).toLowerCase();
  fs.mkdirSync(path.dirname(target), { recursive: true });
  const revalidated = assertInWorkspace(target, { write: true });
  if (revalidated !== target) throw new Error(`office write path changed during validation: ${target}`);

  if (ext === ".docx") {
    const paragraphs = String(content).split(/\r?\n/).map((text) => new Paragraph({ text }));
    const doc = new Document({ sections: [{ properties: {}, children: paragraphs }] });
    fs.writeFileSync(target, await Packer.toBuffer(doc));
    return { path: target, format: "docx", paragraphs: paragraphs.length };
  }
  if (ext === ".xlsx") {
    const workbook = new ExcelJS.Workbook();
    const parsed = parseWorkbookContent(content);
    for (const sheetInput of parsed) {
      const sheet = workbook.addWorksheet(sheetInput.name || "Sheet1");
      for (const row of sheetInput.rows) sheet.addRow(row.slice(0, MAX_COLUMNS));
    }
    await workbook.xlsx.writeFile(target);
    return { path: target, format: "xlsx", sheets: parsed.map((sheet) => ({ name: sheet.name, rows: sheet.rows.length })) };
  }
  if ([".txt", ".md", ".csv", ".tsv", ".json", ".xml", ".html", ".rtf", ""].includes(ext)) {
    fs.writeFileSync(target, String(content), "utf8");
    return { path: target, format: ext.slice(1) || "text", bytes: Buffer.byteLength(String(content)) };
  }
  throw new Error(`unsupported office write format ${ext}; supported: docx, xlsx, csv/tsv, and text`);
}

function parseWorkbookContent(content) {
  const source = String(content);
  try {
    const parsed = JSON.parse(source);
    if (Array.isArray(parsed)) {
      const rows = parsed.every(Array.isArray) ? parsed : parsed.map((item) => [item]);
      return [{ name: "Sheet1", rows }];
    }
    if (parsed && Array.isArray(parsed.sheets)) {
      return parsed.sheets.map((sheet, index) => ({
        name: String(sheet.name || `Sheet${index + 1}`).slice(0, 31),
        rows: Array.isArray(sheet.rows) ? sheet.rows.map((row) => Array.isArray(row) ? row : [row]) : [],
      }));
    }
  } catch {}
  return [{ name: "Sheet1", rows: parseDelimited(source) }];
}

function parseDelimited(source) {
  const delimiter = source.includes("\t") ? "\t" : ",";
  return source.split(/\r?\n/).filter((line) => line.length > 0).map((line) => line.split(delimiter));
}

function cellValue(value) {
  if (value instanceof Date) return value.toISOString();
  if (value && typeof value === "object") {
    if ("text" in value) return value.text;
    if ("result" in value) return value.result;
    if (Array.isArray(value.richText)) return value.richText.map((part) => part.text).join("");
    return JSON.stringify(value);
  }
  return value ?? null;
}
