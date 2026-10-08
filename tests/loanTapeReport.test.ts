import assert from 'node:assert/strict';
import test from 'node:test';
import { importLoanTapeSheets, type SheetInput } from '../src/lib/loanTapeImport';
import { buildCockpitData, buildVintage } from '../src/lib/loanTapeCockpit';
import { buildLoanTapeReportSheets, analyzePortfolio, buildLoanTapeInsights } from '../src/lib/loanTapeReport';
import { buildChartXml } from '../src/lib/xlsxCharts';

const header = ['id_credito', 'nombre_cliente', 'producto', 'monto_autorizado', 'fecha_apertura', 'dias_vencido', 'capital_vencido', 'capital_vigente', 'interes_ordinario_anual'];
const sheet: SheetInput = {
  name: 'Hoja 1',
  rows: [
    header,
    [1, 'CLIENTE A', 'Arrendamiento puro', 1000000, '2025-02-25', 0, 0, 800000, '24%'],
    [2, 'CLIENTE B', 'Arrendamiento puro', 500000, '2025-03-10', 45, 0, 300000, '30%'],
    [3, 'CLIENTE C', 'CREDIPYME', 700000, '2025-04-01', 120, 200000, 0, '18%'],
    [4, 'CLIENTE D', 'CREDIPYME', 900000, '2025-05-01', 0, 0, 600000, '21%'],
  ],
};

test('loan tape Excel report carries native charts, Axcess insights, buckets and rate analysis', () => {
  const res = importLoanTapeSheets([sheet], '260531 - Loan Tape - Test.xlsx');
  const tapes: any[] = [{ id: 't1', clientId: 'c1', name: 'Test', uploadDate: '2026-06-02', fileName: '260531 - Loan Tape - Test.xlsx', tapeType: 'credito', extractedData: { _standardized: res.standardized } }];
  const data = buildCockpitData(tapes);
  const focus = data.periods[data.periods.length - 1];
  const vintage = buildVintage(data, focus);
  const sheets = buildLoanTapeReportSheets('Test', data.periods, { data, vintage, snapshot: {}, focusPeriod: focus, focusLabel: data.labels[data.labels.length - 1] });

  const names = sheets.map(s => s.name);
  for (const expected of ['Portada', 'Insights', 'Concentraciones', 'Calidad y DPD', 'Tasas']) assert.ok(names.includes(expected), `missing sheet ${expected}`);
  const chartCount = sheets.reduce((n, s) => n + (s.charts?.length || 0), 0);
  assert.ok(chartCount >= 10, `expected native charts, got ${chartCount}`);

  const a = analyzePortfolio(data, focus)!;
  assert.equal(a.dpd.length, 6);
  assert.ok(a.rateBuckets.length > 0 && a.sizeOutstanding.length > 0);
  assert.ok(buildLoanTapeInsights(a, data).length >= 12);

  const firstChart = sheets.flatMap(sh => sh.charts || [])[0];
  const xml = buildChartXml(firstChart);
  assert.match(xml, /<c:chartSpace/);
  assert.match(xml, /1430E6|1B5BF5|16B7EA|128A48|C2271C/);
  assert.equal(sheets.every(sh => !sh.images?.length), true, 'no PNG pictures: charts must be native');
});

test('Excel workbook XML follows the OOXML element order Excel requires (no "corrupt file" repair prompt)', async () => {
  const { buildWorkbookBuffer } = await import('../src/lib/export');
  const JSZip = (await import('jszip')).default;
  const res = importLoanTapeSheets([sheet], '260531 - Loan Tape - Test.xlsx');
  const tapes: any[] = [{ id: 't1', clientId: 'c1', name: 'Test', uploadDate: '2026-06-02', fileName: '260531 - Loan Tape - Test.xlsx', tapeType: 'credito', extractedData: { _standardized: res.standardized } }];
  const data = buildCockpitData(tapes);
  const focus = data.periods[data.periods.length - 1];
  const sheets = buildLoanTapeReportSheets('Test', data.periods, { data, vintage: buildVintage(data, focus), snapshot: {}, focusPeriod: focus, focusLabel: data.labels[data.labels.length - 1] });
  const zip = await JSZip.loadAsync(await buildWorkbookBuffer(sheets));

  const WORKSHEET_ORDER = ['sheetPr', 'dimension', 'sheetViews', 'sheetFormatPr', 'cols', 'sheetData', 'sheetCalcPr', 'sheetProtection', 'protectedRanges', 'scenarios', 'autoFilter', 'sortState', 'dataConsolidate', 'customSheetViews', 'mergeCells', 'phoneticPr', 'conditionalFormatting', 'dataValidations', 'hyperlinks', 'printOptions', 'pageMargins', 'pageSetup', 'headerFooter', 'rowBreaks', 'colBreaks', 'customProperties', 'cellWatches', 'ignoredErrors', 'smartTags', 'drawing', 'legacyDrawing', 'legacyDrawingHF', 'drawingHF', 'picture', 'oleObjects', 'controls', 'webPublishItems', 'tableParts', 'extLst'];
  const SHEETPR_ORDER = ['tabColor', 'outlinePr', 'pageSetUpPr'];
  const topLevel = (xml: string, parent: string) => {
    const inner = xml.match(new RegExp(`<${parent}[^>]*>([\\s\\S]*)</${parent}>`))![1];
    const names: string[] = [];
    let depth = 0;
    for (const m of inner.matchAll(/<(\/?)([A-Za-z0-9:]+)([^>]*?)(\/?)>/g)) {
      if (m[1]) { depth -= 1; continue; }
      if (depth === 0) names.push(m[2]);
      if (!m[4]) depth += 1;
    }
    return names;
  };
  const inOrder = (names: string[], order: string[]) => names.every((n, i) => i === 0 || order.indexOf(n) >= order.indexOf(names[i - 1]));

  const sheetFiles = Object.keys(zip.files).filter(f => /^xl\/worksheets\/sheet\d+\.xml$/.test(f));
  assert.ok(sheetFiles.length >= 5);
  for (const f of sheetFiles) {
    const xml = await zip.file(f)!.async('string');
    assert.ok(inOrder(topLevel(xml, 'worksheet'), WORKSHEET_ORDER), `${f}: worksheet children out of order: ${topLevel(xml, 'worksheet').join(',')}`);
    const pr = xml.match(/<sheetPr>[\s\S]*?<\/sheetPr>/);
    if (pr) assert.ok(inOrder(topLevel(pr[0], 'sheetPr'), SHEETPR_ORDER), `${f}: sheetPr children out of order: ${pr[0]}`);
  }
  for (const f of Object.keys(zip.files).filter(f => f.endsWith('.xml') || f.endsWith('.rels'))) {
    const xml = await zip.file(f)!.async('string');
    assert.equal(/>NaN<|>Infinity<|>-Infinity</.test(xml), false, `${f} contains NaN/Infinity`);
  }
});
