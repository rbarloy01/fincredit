// Native Excel charts for ExcelJS workbooks.
// ExcelJS has no chart API, so charts are written as DrawingML chart parts and injected into the
// finished .xlsx (a zip) — they are real, editable Excel charts bound to worksheet cells, not pictures.

export type ChartKind = 'column' | 'bar' | 'line' | 'pie' | 'doughnut';
export type ChartGrouping = 'clustered' | 'stacked' | 'percentStacked';

export interface ChartRange {
  sheet: string;
  col: number;      // 1-indexed
  rowStart: number; // 1-indexed, inclusive
  rowEnd: number;   // 1-indexed, inclusive
}

export interface ChartSeriesSpec {
  name: string;
  values: ChartRange;
  cache: Array<number | null>;
  color?: string;
  pointColors?: string[];
  as?: 'bar' | 'line';        // combo charts: draw this series as a line over the bars
  secondaryAxis?: boolean;    // combo charts: plot on the right-hand axis
  labels?: boolean;
  numFmt?: string;
}

export interface ChartSpec {
  title: string;
  kind: ChartKind;
  grouping?: ChartGrouping;
  categories: ChartRange;
  categoryCache: string[];
  series: ChartSeriesSpec[];
  anchor: { col: number; row: number; cols: number; rows: number }; // 0-indexed top-left, size in cells
  yFmt?: string;
  y2Fmt?: string;
  legend?: 'b' | 'r' | 't' | 'none';
  gapWidth?: number;
}

// Axcess palette: deep/blue/cyan from the brand gradient, ink/muted for text, semantic colours for quality.
export const AXC = {
  deep: '1430E6',
  blue: '1B5BF5',
  cyan: '16B7EA',
  sky: '8FB4FF',
  ink: '0E1B3D',
  muted: '5D6B8A',
  line: 'E1E7F5',
  green: '128A48',
  amber: 'E8A317',
  orange: 'EA6A1F',
  red: 'C2271C',
  darkRed: '7F1D1D',
};

// Brand-first ordering for multi-series charts.
export const AXC_SERIES = [AXC.deep, AXC.cyan, AXC.blue, AXC.sky, AXC.ink, AXC.muted, '7A5CFF', '00A3A3'];

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

function colLetter(n: number): string {
  let s = '';
  while (n > 0) { const m = (n - 1) % 26; s = String.fromCharCode(65 + m) + s; n = Math.floor((n - 1) / 26); }
  return s;
}

function refOf(r: ChartRange): string {
  const c = colLetter(r.col);
  return `'${r.sheet.replace(/'/g, "''")}'!$${c}$${r.rowStart}:$${c}$${r.rowEnd}`;
}

const txPr = (size: number, color: string, bold = false) =>
  `<c:txPr><a:bodyPr/><a:lstStyle/><a:p><a:pPr><a:defRPr sz="${size}" b="${bold ? 1 : 0}"><a:solidFill><a:srgbClr val="${color}"/></a:solidFill><a:latin typeface="Arial"/></a:defRPr></a:pPr><a:endParaRPr lang="es-MX"/></a:p></c:txPr>`;

const fill = (color: string) => `<a:solidFill><a:srgbClr val="${color}"/></a:solidFill>`;

function strCache(values: string[]): string {
  return `<c:strCache><c:ptCount val="${values.length}"/>${values.map((v, i) => `<c:pt idx="${i}"><c:v>${esc(v)}</c:v></c:pt>`).join('')}</c:strCache>`;
}

function numCache(values: Array<number | null>, fmt: string): string {
  return `<c:numCache><c:formatCode>${esc(fmt)}</c:formatCode><c:ptCount val="${values.length}"/>${values.map((v, i) => (v === null || !Number.isFinite(v) ? '' : `<c:pt idx="${i}"><c:v>${v}</c:v></c:pt>`)).join('')}</c:numCache>`;
}

function serXml(spec: ChartSpec, s: ChartSeriesSpec, idx: number, kind: 'bar' | 'line' | 'pie', color: string): string {
  const fmt = s.numFmt || 'General';
  const sp = kind === 'line'
    ? `<c:spPr><a:ln w="28575" cap="rnd">${fill(color)}<a:round/></a:ln></c:spPr><c:marker><c:symbol val="circle"/><c:size val="6"/><c:spPr>${fill(color)}<a:ln w="9525">${fill('FFFFFF')}</a:ln></c:spPr></c:marker>`
    : `<c:spPr>${fill(color)}</c:spPr>${kind === 'bar' ? '<c:invertIfNegative val="0"/>' : ''}`;
  const dPts = (s.pointColors || []).map((pc, i) => `<c:dPt><c:idx val="${i}"/>${kind === 'bar' ? '<c:invertIfNegative val="0"/>' : ''}<c:bubble3D val="0"/><c:spPr>${fill(pc)}${kind === 'pie' ? `<a:ln w="12700">${fill('FFFFFF')}</a:ln>` : ''}</c:spPr></c:dPt>`).join('');
  const labelPos = spec.kind === 'doughnut' ? '' : kind === 'line' ? '<c:dLblPos val="t"/>' : kind === 'pie' ? '<c:dLblPos val="outEnd"/>' : (spec.grouping && spec.grouping !== 'clustered' ? '<c:dLblPos val="ctr"/>' : '<c:dLblPos val="outEnd"/>');
  const dLbls = s.labels
    ? `<c:dLbls><c:numFmt formatCode="${esc(kind === 'pie' ? '0.0%' : fmt)}" sourceLinked="0"/><c:spPr><a:noFill/><a:ln><a:noFill/></a:ln></c:spPr>${txPr(800, AXC.ink, true)}${labelPos}<c:showLegendKey val="0"/><c:showVal val="${kind === 'pie' ? 0 : 1}"/><c:showCatName val="0"/><c:showSerName val="0"/><c:showPercent val="${kind === 'pie' ? 1 : 0}"/><c:showBubbleSize val="0"/></c:dLbls>`
    : '';
  return `<c:ser><c:idx val="${idx}"/><c:order val="${idx}"/><c:tx><c:v>${esc(s.name)}</c:v></c:tx>${sp}${dPts}${dLbls}`
    + `<c:cat><c:strRef><c:f>${esc(refOf(spec.categories))}</c:f>${strCache(spec.categoryCache)}</c:strRef></c:cat>`
    + `<c:val><c:numRef><c:f>${esc(refOf(s.values))}</c:f>${numCache(s.cache, fmt)}</c:numRef></c:val>`
    + (kind === 'line' ? '<c:smooth val="0"/>' : '')
    + `</c:ser>`;
}

function axes(spec: ChartSpec, withSecondary: boolean): string {
  const horizontal = spec.kind === 'bar';
  const gridLine = `<c:majorGridlines><c:spPr><a:ln w="6350">${fill(AXC.line)}</a:ln></c:spPr></c:majorGridlines>`;
  const axisLn = `<c:spPr><a:ln w="9525">${fill('C9D2E8')}</a:ln></c:spPr>`;
  const yFmt = spec.yFmt || (spec.grouping === 'percentStacked' ? '0%' : 'General');
  const cat = `<c:catAx><c:axId val="111"/><c:scaling><c:orientation val="${horizontal ? 'maxMin' : 'minMax'}"/></c:scaling><c:delete val="0"/><c:axPos val="${horizontal ? 'l' : 'b'}"/><c:numFmt formatCode="General" sourceLinked="0"/><c:majorTickMark val="none"/><c:minorTickMark val="none"/><c:tickLblPos val="low"/>${axisLn}${txPr(800, AXC.muted)}<c:crossAx val="222"/><c:crosses val="autoZero"/><c:auto val="1"/><c:lblAlgn val="ctr"/><c:lblOffset val="100"/><c:noMultiLvlLbl val="0"/></c:catAx>`;
  const val = `<c:valAx><c:axId val="222"/><c:scaling><c:orientation val="minMax"/></c:scaling><c:delete val="0"/><c:axPos val="${horizontal ? 'b' : 'l'}"/>${gridLine}<c:numFmt formatCode="${esc(yFmt)}" sourceLinked="0"/><c:majorTickMark val="none"/><c:minorTickMark val="none"/><c:tickLblPos val="nextTo"/><c:spPr><a:ln><a:noFill/></a:ln></c:spPr>${txPr(800, AXC.muted)}<c:crossAx val="111"/><c:crosses val="${horizontal ? 'max' : 'autoZero'}"/><c:crossBetween val="between"/></c:valAx>`;
  if (!withSecondary) return cat + val;
  const cat2 = `<c:catAx><c:axId val="333"/><c:scaling><c:orientation val="minMax"/></c:scaling><c:delete val="1"/><c:axPos val="b"/><c:majorTickMark val="none"/><c:minorTickMark val="none"/><c:tickLblPos val="nextTo"/><c:crossAx val="444"/><c:crosses val="autoZero"/><c:auto val="1"/><c:lblAlgn val="ctr"/><c:lblOffset val="100"/><c:noMultiLvlLbl val="0"/></c:catAx>`;
  const val2 = `<c:valAx><c:axId val="444"/><c:scaling><c:orientation val="minMax"/></c:scaling><c:delete val="0"/><c:axPos val="r"/><c:numFmt formatCode="${esc(spec.y2Fmt || '0%')}" sourceLinked="0"/><c:majorTickMark val="none"/><c:minorTickMark val="none"/><c:tickLblPos val="nextTo"/><c:spPr><a:ln><a:noFill/></a:ln></c:spPr>${txPr(800, AXC.muted)}<c:crossAx val="333"/><c:crosses val="max"/><c:crossBetween val="between"/></c:valAx>`;
  return cat + val + cat2 + val2;
}

export function buildChartXml(spec: ChartSpec): string {
  const isPie = spec.kind === 'pie' || spec.kind === 'doughnut';
  const palette = AXC_SERIES;
  const colorOf = (s: ChartSeriesSpec, i: number) => s.color || palette[i % palette.length];

  let plot = '';
  if (isPie) {
    const s = spec.series[0];
    const body = serXml(spec, { ...s, pointColors: s.pointColors || spec.categoryCache.map((_, i) => palette[i % palette.length]) }, 0, 'pie', colorOf(s, 0));
    plot = spec.kind === 'doughnut'
      ? `<c:doughnutChart><c:varyColors val="1"/>${body}<c:firstSliceAng val="0"/><c:holeSize val="58"/></c:doughnutChart>`
      : `<c:pieChart><c:varyColors val="1"/>${body}<c:firstSliceAng val="0"/></c:pieChart>`;
  } else {
    const barSeries = spec.series.map((s, i) => ({ s, i })).filter(({ s }) => spec.kind === 'line' ? false : s.as !== 'line');
    const lineSeries = spec.series.map((s, i) => ({ s, i })).filter(({ s }) => spec.kind === 'line' || s.as === 'line');
    const secondary = lineSeries.some(({ s }) => s.secondaryAxis);
    const grouping = spec.grouping || 'clustered';
    if (barSeries.length) {
      const overlap = grouping === 'clustered' ? '' : '<c:overlap val="100"/>';
      plot += `<c:barChart><c:barDir val="${spec.kind === 'bar' ? 'bar' : 'col'}"/><c:grouping val="${grouping}"/><c:varyColors val="0"/>${barSeries.map(({ s, i }) => serXml(spec, s, i, 'bar', colorOf(s, i))).join('')}<c:gapWidth val="${spec.gapWidth ?? 60}"/>${overlap}<c:axId val="111"/><c:axId val="222"/></c:barChart>`;
    }
    const plainLines = lineSeries.filter(({ s }) => !s.secondaryAxis);
    const secLines = lineSeries.filter(({ s }) => s.secondaryAxis);
    const lineGrouping = '<c:grouping val="standard"/>';
    if (plainLines.length) {
      plot += `<c:lineChart>${lineGrouping}<c:varyColors val="0"/>${plainLines.map(({ s, i }) => serXml(spec, s, i, 'line', colorOf(s, i))).join('')}<c:marker val="1"/><c:axId val="111"/><c:axId val="222"/></c:lineChart>`;
    }
    if (secLines.length) {
      plot += `<c:lineChart>${lineGrouping}<c:varyColors val="0"/>${secLines.map(({ s, i }) => serXml(spec, s, i, 'line', colorOf(s, i))).join('')}<c:marker val="1"/><c:axId val="333"/><c:axId val="444"/></c:lineChart>`;
    }
    plot += axes(spec, secondary);
  }

  const legendPos = spec.legend || (spec.series.length > 1 || isPie ? 'b' : 'none');
  const legend = legendPos === 'none' ? '' : `<c:legend><c:legendPos val="${legendPos}"/><c:overlay val="0"/>${txPr(900, AXC.ink)}</c:legend>`;
  const title = `<c:title><c:tx><c:rich><a:bodyPr/><a:lstStyle/><a:p><a:pPr><a:defRPr sz="1200" b="1"><a:solidFill><a:srgbClr val="${AXC.ink}"/></a:solidFill><a:latin typeface="Arial"/></a:defRPr></a:pPr><a:r><a:rPr lang="es-MX" sz="1200" b="1"><a:solidFill><a:srgbClr val="${AXC.ink}"/></a:solidFill><a:latin typeface="Arial"/></a:rPr><a:t>${esc(spec.title)}</a:t></a:r></a:p></c:rich></c:tx><c:overlay val="0"/></c:title>`;

  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>`
    + `<c:chartSpace xmlns:c="http://schemas.openxmlformats.org/drawingml/2006/chart" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">`
    + `<c:roundedCorners val="0"/><c:chart>${title}<c:autoTitleDeleted val="0"/><c:plotArea><c:layout/>${plot}<c:spPr><a:noFill/></c:spPr></c:plotArea>${legend}<c:plotVisOnly val="1"/><c:dispBlanksAs val="gap"/></c:chart>`
    + `<c:spPr>${fill('FFFFFF')}<a:ln w="9525">${fill(AXC.line)}</a:ln></c:spPr>${txPr(900, AXC.ink)}</c:chartSpace>`;
}

function anchorXml(spec: ChartSpec, rid: string, id: number): string {
  const { col, row, cols, rows } = spec.anchor;
  return `<xdr:twoCellAnchor editAs="oneCell"><xdr:from><xdr:col>${col}</xdr:col><xdr:colOff>0</xdr:colOff><xdr:row>${row}</xdr:row><xdr:rowOff>0</xdr:rowOff></xdr:from><xdr:to><xdr:col>${col + cols}</xdr:col><xdr:colOff>0</xdr:colOff><xdr:row>${row + rows}</xdr:row><xdr:rowOff>0</xdr:rowOff></xdr:to>`
    + `<xdr:graphicFrame macro=""><xdr:nvGraphicFramePr><xdr:cNvPr id="${id}" name="Grafica ${id - 1}"/><xdr:cNvGraphicFramePr/></xdr:nvGraphicFramePr><xdr:xfrm><a:off x="0" y="0"/><a:ext cx="0" cy="0"/></xdr:xfrm><a:graphic><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/chart"><c:chart xmlns:c="http://schemas.openxmlformats.org/drawingml/2006/chart" r:id="${rid}"/></a:graphicData></a:graphic></xdr:graphicFrame><xdr:clientData/></xdr:twoCellAnchor>`;
}

const REL_NS = 'http://schemas.openxmlformats.org/package/2006/relationships';

export async function injectNativeCharts(
  buffer: ArrayBuffer,
  chartsBySheet: Array<{ sheet: string; charts: ChartSpec[] }>,
): Promise<ArrayBuffer> {
  const withCharts = chartsBySheet.filter(c => c.charts.length);
  if (!withCharts.length) return buffer;
  const JSZip = (await import('jszip')).default;
  const zip = await JSZip.loadAsync(buffer);

  const workbookXml = await zip.file('xl/workbook.xml')!.async('string');
  const workbookRels = await zip.file('xl/_rels/workbook.xml.rels')!.async('string');
  const relTarget = new Map<string, string>();
  for (const m of workbookRels.matchAll(/<Relationship\b[^>]*>/g)) {
    const id = m[0].match(/\bId="([^"]+)"/)?.[1];
    const target = m[0].match(/\bTarget="([^"]+)"/)?.[1];
    if (id && target) relTarget.set(id, target);
  }
  const sheetPath = new Map<string, string>();
  for (const m of workbookXml.matchAll(/<sheet\b[^>]*>/g)) {
    const name = m[0].match(/\bname="([^"]+)"/)?.[1];
    const rid = m[0].match(/\br:id="([^"]+)"/)?.[1];
    const target = rid ? relTarget.get(rid) : undefined;
    if (name && target) sheetPath.set(name.replace(/&amp;/g, '&').replace(/&apos;/g, "'").replace(/&quot;/g, '"'), `xl/${target.replace(/^\/?(xl\/)?/, '')}`);
  }

  let contentTypes = await zip.file('[Content_Types].xml')!.async('string');
  const overrides: string[] = [];
  let chartNo = 0;
  let drawingNo = 0;

  for (const { sheet, charts } of withCharts) {
    const path = sheetPath.get(sheet);
    if (!path) continue;
    drawingNo += 1;
    const drawingName = `drawing${900 + drawingNo}`;
    const anchors: string[] = [];
    const drawingRels: string[] = [];
    charts.forEach((spec, i) => {
      chartNo += 1;
      const chartName = `chart${900 + chartNo}`;
      zip.file(`xl/charts/${chartName}.xml`, buildChartXml(spec));
      overrides.push(`<Override PartName="/xl/charts/${chartName}.xml" ContentType="application/vnd.openxmlformats-officedocument.drawingml.chart+xml"/>`);
      drawingRels.push(`<Relationship Id="rId${i + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/chart" Target="../charts/${chartName}.xml"/>`);
      anchors.push(anchorXml(spec, `rId${i + 1}`, i + 2));
    });
    zip.file(`xl/drawings/${drawingName}.xml`,
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><xdr:wsDr xmlns:xdr="http://schemas.openxmlformats.org/drawingml/2006/spreadsheetDrawing" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">${anchors.join('')}</xdr:wsDr>`);
    zip.file(`xl/drawings/_rels/${drawingName}.xml.rels`, `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="${REL_NS}">${drawingRels.join('')}</Relationships>`);
    overrides.push(`<Override PartName="/xl/drawings/${drawingName}.xml" ContentType="application/vnd.openxmlformats-officedocument.drawing+xml"/>`);

    // sheet -> drawing relationship
    const relsPath = path.replace('worksheets/', 'worksheets/_rels/') + '.rels';
    const existingRels = zip.file(relsPath) ? await zip.file(relsPath)!.async('string') : `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="${REL_NS}"></Relationships>`;
    const drawingRelId = 'rIdAxDrawing1';
    zip.file(relsPath, existingRels.replace('</Relationships>', `<Relationship Id="${drawingRelId}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/drawing" Target="../drawings/${drawingName}.xml"/></Relationships>`));

    // <drawing> must precede legacyDrawing / tableParts / extLst
    let sheetXml = await zip.file(path)!.async('string');
    const tag = `<drawing r:id="${drawingRelId}"/>`;
    const before = ['<legacyDrawing', '<legacyDrawingHF', '<picture', '<oleObjects', '<controls', '<webPublishItems', '<tableParts', '<extLst', '</worksheet>']
      .map(t => sheetXml.indexOf(t)).filter(i => i >= 0).sort((a, b) => a - b)[0];
    sheetXml = sheetXml.slice(0, before) + tag + sheetXml.slice(before);
    zip.file(path, sheetXml);
  }

  contentTypes = contentTypes.replace('</Types>', `${overrides.join('')}</Types>`);
  zip.file('[Content_Types].xml', contentTypes);
  return zip.generateAsync({ type: 'arraybuffer', compression: 'DEFLATE' });
}
