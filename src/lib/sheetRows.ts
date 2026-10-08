// Excel files exported from accounting/ERP tools often declare a used range like A1:BP1048576 (formatting applied to whole
// columns). `sheet_to_json` walks every declared row, so a 35 KB file with 16 real rows takes ~45 s and freezes the tab.
// Trim the range to the last cell that actually holds a value before converting.

type CellMap = Record<string, any>;

export function trimSheetRange(XLSX: any, sheet: CellMap): void {
  const ref = sheet['!ref'];
  if (!ref) return;
  const declared = XLSX.utils.decode_range(ref);
  if (declared.e.r < 5000) return; // small ranges are cheap; leave them untouched
  let maxR = -1, maxC = -1, minR = Infinity, minC = Infinity;
  for (const key of Object.keys(sheet)) {
    if (key.charCodeAt(0) === 33) continue; // '!ref', '!merges', …
    const cell = sheet[key];
    if (!cell || cell.v === undefined || cell.v === null || cell.v === '') continue;
    const { r, c } = XLSX.utils.decode_cell(key);
    if (r > maxR) maxR = r; if (c > maxC) maxC = c;
    if (r < minR) minR = r; if (c < minC) minC = c;
  }
  if (maxR < 0) { sheet['!ref'] = 'A1'; return; }
  sheet['!ref'] = XLSX.utils.encode_range({ s: { r: Math.min(declared.s.r, minR), c: Math.min(declared.s.c, minC) }, e: { r: maxR, c: maxC } });
}

export function sheetToRows<T = any[]>(XLSX: any, sheet: CellMap, opts: Record<string, unknown> = {}): T[] {
  trimSheetRange(XLSX, sheet);
  return XLSX.utils.sheet_to_json(sheet, opts) as T[];
}
