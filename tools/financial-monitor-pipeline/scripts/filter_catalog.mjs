import fs from "node:fs/promises";
import { FileBlob, SpreadsheetFile, Workbook } from "@oai/artifact-tool";

const inputPath = "/Users/syscap/Downloads/Catalogo_EEFF_Drive.xlsx";
const outputDir = "/Users/syscap/Documents/New project 2/outputs/catalogo_eeff_filtrado";
const outputPath = `${outputDir}/Catalogo_EEFF_filtrado_sin_modelo_financiero.xlsx`;

const input = await FileBlob.load(inputPath);
const sourceWorkbook = await SpreadsheetFile.importXlsx(input);
const sourceSheet = sourceWorkbook.worksheets.getItem("Catálogo EEFF");
const used = sourceSheet.getUsedRange(true);
const sourceRows = used.values;

const headers = sourceRows[0];
const rows = sourceRows.slice(1).filter((row) => {
  const tipo = String(row[2] ?? "").toLowerCase();
  return !tipo.includes("modelo financiero");
});

const clientCounts = new Map();
const typeCounts = new Map();
const formatCounts = new Map();

for (const row of rows) {
  const client = row[1] || "(sin cliente)";
  const type = row[2] || "(sin tipo)";
  const format = row[4] || "(sin formato)";
  clientCounts.set(client, (clientCounts.get(client) ?? 0) + 1);
  typeCounts.set(type, (typeCounts.get(type) ?? 0) + 1);
  formatCounts.set(format, (formatCounts.get(format) ?? 0) + 1);
}

const sortedEntries = (map) =>
  [...map.entries()].sort((a, b) => b[1] - a[1] || String(a[0]).localeCompare(String(b[0])));

const workbook = Workbook.create();
const catalog = workbook.worksheets.add("Catalogo Filtrado");
const summary = workbook.worksheets.add("Resumen");

catalog.showGridLines = false;
summary.showGridLines = false;

const catalogData = [headers, ...rows.map((row, index) => [index + 1, ...row.slice(1)])];
catalog.getRangeByIndexes(0, 0, catalogData.length, headers.length).values = catalogData;

const catalogRange = catalog.getRangeByIndexes(0, 0, catalogData.length, headers.length);
catalogRange.format = {
  font: { name: "Aptos", size: 10, color: "#111827" },
};
catalog.getRange("A1:F1").format = {
  fill: "#1F4E78",
  font: { bold: true, color: "#FFFFFF" },
};
catalog.getRange("A1:F1").format.borders = { preset: "bottom", style: "medium", color: "#163A5A" };
catalog.getRange("A:F").format.autofitColumns();
catalog.getRange("A:A").format.columnWidth = 8;
catalog.getRange("B:B").format.columnWidth = 26;
catalog.getRange("C:C").format.columnWidth = 30;
catalog.getRange("D:D").format.columnWidth = 18;
catalog.getRange("E:E").format.columnWidth = 14;
catalog.getRange("F:F").format.columnWidth = 76;
catalog.getRange("F:F").format.wrapText = true;
catalog.freezePanes.freezeRows(1);
catalog.tables.add(`A1:F${catalogData.length}`, true, "CatalogoFiltrado");

const summaryRows = [
  ["Metrica", "Valor"],
  ["Total filas originales", sourceRows.length - 1],
  ["Excluidas Modelo Financiero", sourceRows.length - 1 - rows.length],
  ["Filas procesables", rows.length],
  ["Clientes procesables", clientCounts.size],
  ["Formatos procesables", formatCounts.size],
  [],
  ["Formato", "# Documentos"],
  ...sortedEntries(formatCounts),
  [],
  ["Tipo de Documento", "# Documentos"],
  ...sortedEntries(typeCounts),
  [],
  ["Cliente", "# Documentos"],
  ...sortedEntries(clientCounts),
];

summary.getRangeByIndexes(0, 0, summaryRows.length, 2).values = summaryRows;
summary.getRange("A1:B1").format = {
  fill: "#1F4E78",
  font: { bold: true, color: "#FFFFFF" },
};
summary.getRange("A8:B8").format = {
  fill: "#EAF2F8",
  font: { bold: true, color: "#111827" },
};

const typeHeaderRow = 8 + formatCounts.size + 2;
const clientHeaderRow = typeHeaderRow + typeCounts.size + 2;
summary.getRange(`A${typeHeaderRow}:B${typeHeaderRow}`).format = {
  fill: "#EAF2F8",
  font: { bold: true, color: "#111827" },
};
summary.getRange(`A${clientHeaderRow}:B${clientHeaderRow}`).format = {
  fill: "#EAF2F8",
  font: { bold: true, color: "#111827" },
};
summary.getRange("A:B").format.autofitColumns();
summary.getRange("A:A").format.columnWidth = 34;
summary.getRange("B:B").format.columnWidth = 16;
summary.freezePanes.freezeRows(1);

await fs.mkdir(outputDir, { recursive: true });

const preview = await workbook.render({
  sheetName: "Catalogo Filtrado",
  range: "A1:F20",
  scale: 1,
  format: "png",
});
await fs.writeFile(`${outputDir}/preview_catalogo.png`, new Uint8Array(await preview.arrayBuffer()));

const errors = await workbook.inspect({
  kind: "match",
  searchTerm: "#REF!|#DIV/0!|#VALUE!|#NAME\\?|#N/A",
  options: { useRegex: true, maxResults: 100 },
  summary: "formula error scan",
});
console.log(errors.ndjson);
console.log(
  JSON.stringify({
    originalRows: sourceRows.length - 1,
    excludedModeloFinanciero: sourceRows.length - 1 - rows.length,
    filteredRows: rows.length,
    clients: clientCounts.size,
    outputPath,
  }),
);

const output = await SpreadsheetFile.exportXlsx(workbook);
await output.save(outputPath);
