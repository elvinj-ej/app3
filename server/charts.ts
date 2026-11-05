// Adds native (editable, data-linked) Excel charts to an .xlsx produced by write-excel-file.
// It post-processes the zip: chart parts, a drawing part, relationships and content types.
import { strFromU8, strToU8, unzipSync, zipSync } from 'fflate';

export interface ChartSeries {
  name: string;
  /** Sheet range for the values, e.g. 'Chart data'!$B$2:$B$25 */
  valRef: string;
  values: number[];
  color: string; // hex without '#'
  dash?: boolean;
  noMarker?: boolean;
}

export interface ChartDef {
  type: 'line' | 'column' | 'bar';
  stacked?: boolean;
  title: string;
  catRef: string;
  categories: string[];
  series: ChartSeries[];
  numFmt?: string;
  yMax?: number;
  /** Anchor on the target sheet: zero-based column/row of the top-left cell and size in cells. */
  at: { col: number; row: number; cols: number; rows: number };
}

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

const NS = 'xmlns:c="http://schemas.openxmlformats.org/drawingml/2006/chart" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"';
const TXT = (sz: number, color = '52514E', bold = false) =>
  `<c:txPr><a:bodyPr/><a:lstStyle/><a:p><a:pPr><a:defRPr sz="${sz}" b="${bold ? 1 : 0}"><a:solidFill><a:srgbClr val="${color}"/></a:solidFill><a:latin typeface="Calibri"/></a:defRPr></a:pPr><a:endParaRPr lang="en-AU"/></a:p></c:txPr>`;
const LINE = (color: string, w = 9525) => `<a:ln w="${w}"><a:solidFill><a:srgbClr val="${color}"/></a:solidFill></a:ln>`;

function strCache(vals: string[]) {
  return `<c:strCache><c:ptCount val="${vals.length}"/>${vals.map((v, i) => `<c:pt idx="${i}"><c:v>${esc(v)}</c:v></c:pt>`).join('')}</c:strCache>`;
}
function numCache(vals: number[], fmt: string) {
  return `<c:numCache><c:formatCode>${esc(fmt)}</c:formatCode><c:ptCount val="${vals.length}"/>${vals.map((v, i) => `<c:pt idx="${i}"><c:v>${v}</c:v></c:pt>`).join('')}</c:numCache>`;
}

function chartXml(d: ChartDef): string {
  const fmt = d.numFmt ?? '#,##0';
  const cat = `<c:cat><c:strRef><c:f>${esc(d.catRef)}</c:f>${strCache(d.categories)}</c:strRef></c:cat>`;
  const tx = (s: ChartSeries) => `<c:tx><c:v>${esc(s.name)}</c:v></c:tx>`;
  const val = (s: ChartSeries) => `<c:val><c:numRef><c:f>${esc(s.valRef)}</c:f>${numCache(s.values, fmt)}</c:numRef></c:val>`;
  let body: string;
  if (d.type === 'line') {
    const ser = d.series
      .map((s, i) => `<c:ser><c:idx val="${i}"/><c:order val="${i}"/>${tx(s)}<c:spPr><a:ln w="${s.dash ? 19050 : 28575}" cap="rnd"><a:solidFill><a:srgbClr val="${s.color}"/></a:solidFill>${s.dash ? '<a:prstDash val="dash"/>' : ''}<a:round/></a:ln></c:spPr>${s.noMarker ? '<c:marker><c:symbol val="none"/></c:marker>' : `<c:marker><c:symbol val="circle"/><c:size val="5"/><c:spPr><a:solidFill><a:srgbClr val="${s.color}"/></a:solidFill><a:ln w="9525"><a:solidFill><a:srgbClr val="FFFFFF"/></a:solidFill></a:ln></c:spPr></c:marker>`}${cat}${val(s)}<c:smooth val="0"/></c:ser>`)
      .join('');
    body = `<c:lineChart><c:grouping val="standard"/><c:varyColors val="0"/>${ser}<c:marker val="1"/><c:axId val="5001"/><c:axId val="5002"/></c:lineChart>`;
  } else {
    const ser = d.series
      .map((s, i) => `<c:ser><c:idx val="${i}"/><c:order val="${i}"/>${tx(s)}<c:spPr><a:solidFill><a:srgbClr val="${s.color}"/></a:solidFill>${LINE('FFFFFF', 6350)}</c:spPr><c:invertIfNegative val="0"/>${cat}${val(s)}</c:ser>`)
      .join('');
    const grouping = d.stacked ? 'stacked' : 'clustered';
    body = `<c:barChart><c:barDir val="${d.type === 'bar' ? 'bar' : 'col'}"/><c:grouping val="${grouping}"/><c:varyColors val="0"/>${ser}<c:gapWidth val="${d.type === 'bar' ? 40 : 60}"/>${d.stacked ? '<c:overlap val="100"/>' : ''}<c:axId val="5001"/><c:axId val="5002"/></c:barChart>`;
  }
  const horizontal = d.type === 'bar';
  const catAx = `<c:catAx><c:axId val="5001"/><c:scaling><c:orientation val="${horizontal ? 'maxMin' : 'minMax'}"/></c:scaling><c:delete val="0"/><c:axPos val="${horizontal ? 'l' : 'b'}"/><c:numFmt formatCode="General" sourceLinked="0"/><c:majorTickMark val="none"/><c:minorTickMark val="none"/><c:tickLblPos val="nextTo"/><c:spPr>${LINE('C9C8C1')}</c:spPr>${TXT(900)}<c:crossAx val="5002"/><c:crosses val="autoZero"/><c:auto val="1"/><c:lblAlgn val="ctr"/><c:lblOffset val="100"/><c:noMultiLvlLbl val="0"/></c:catAx>`;
  const valAx = `<c:valAx><c:axId val="5002"/><c:scaling><c:orientation val="minMax"/>${d.yMax !== undefined ? `<c:max val="${d.yMax}"/>` : ''}<c:min val="0"/></c:scaling><c:delete val="0"/><c:axPos val="${horizontal ? 'b' : 'l'}"/><c:majorGridlines><c:spPr>${LINE('E7E6E1')}</c:spPr></c:majorGridlines><c:numFmt formatCode="${esc(fmt)}" sourceLinked="0"/><c:majorTickMark val="none"/><c:minorTickMark val="none"/><c:tickLblPos val="nextTo"/><c:spPr><a:ln><a:noFill/></a:ln></c:spPr>${TXT(900)}<c:crossAx val="5001"/><c:crosses val="${horizontal ? 'max' : 'autoZero'}"/><c:crossBetween val="between"/></c:valAx>`;
  const legend = d.series.length > 1 ? `<c:legend><c:legendPos val="t"/><c:overlay val="0"/>${TXT(900)}</c:legend>` : '';
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><c:chartSpace ${NS}><c:roundedCorners val="0"/><c:chart><c:title><c:tx><c:rich><a:bodyPr/><a:lstStyle/><a:p><a:pPr><a:defRPr sz="1200" b="1"/></a:pPr><a:r><a:rPr lang="en-AU" sz="1200" b="1"><a:solidFill><a:srgbClr val="0B0B0B"/></a:solidFill><a:latin typeface="Calibri"/></a:rPr><a:t>${esc(d.title)}</a:t></a:r></a:p></c:rich></c:tx><c:overlay val="0"/></c:title><c:autoTitleDeleted val="0"/><c:plotArea><c:layout/>${body}${catAx}${valAx}<c:spPr><a:noFill/><a:ln><a:noFill/></a:ln></c:spPr></c:plotArea>${legend}<c:plotVisOnly val="1"/><c:dispBlanksAs val="gap"/></c:chart><c:spPr><a:solidFill><a:srgbClr val="FFFFFF"/></a:solidFill>${LINE('E2E1DC')}</c:spPr>${TXT(1000, '0B0B0B')}</c:chartSpace>`;
}

function anchorXml(d: ChartDef, i: number): string {
  const { col, row, cols, rows } = d.at;
  return `<xdr:twoCellAnchor editAs="oneCell"><xdr:from><xdr:col>${col}</xdr:col><xdr:colOff>0</xdr:colOff><xdr:row>${row}</xdr:row><xdr:rowOff>0</xdr:rowOff></xdr:from><xdr:to><xdr:col>${col + cols}</xdr:col><xdr:colOff>0</xdr:colOff><xdr:row>${row + rows}</xdr:row><xdr:rowOff>0</xdr:rowOff></xdr:to><xdr:graphicFrame macro=""><xdr:nvGraphicFramePr><xdr:cNvPr id="${i + 2}" name="Chart ${i + 1}"/><xdr:cNvGraphicFramePr/></xdr:nvGraphicFramePr><xdr:xfrm><a:off x="0" y="0"/><a:ext cx="0" cy="0"/></xdr:xfrm><a:graphic><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/chart"><c:chart xmlns:c="http://schemas.openxmlformats.org/drawingml/2006/chart" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" r:id="rId${i + 1}"/></a:graphicData></a:graphic></xdr:graphicFrame><xdr:clientData/></xdr:twoCellAnchor>`;
}

export function addCharts(xlsx: Uint8Array, sheetName: string, charts: ChartDef[]): Uint8Array {
  if (!charts.length) return xlsx;
  const files = unzipSync(xlsx);
  const read = (p: string) => strFromU8(files[p]);
  const write = (p: string, s: string) => (files[p] = strToU8(s));

  // locate the worksheet part for sheetName
  const wb = read('xl/workbook.xml');
  const m = [...wb.matchAll(/<sheet\b[^>]*>/g)].map((x) => x[0]).find((t) => t.includes(`name="${esc(sheetName)}"`));
  const rid = m?.match(/r:id="([^"]+)"/)?.[1];
  if (!rid) throw new Error(`Sheet not found: ${sheetName}`);
  const wbRels = read('xl/_rels/workbook.xml.rels');
  const target = [...wbRels.matchAll(/<Relationship\b[^>]*>/g)].map((x) => x[0]).find((t) => t.includes(`Id="${rid}"`))?.match(/Target="([^"]+)"/)?.[1];
  if (!target) throw new Error('Worksheet relationship not found');
  const sheetPath = `xl/${target.replace(/^\/?xl\//, '')}`;
  const sheetFile = sheetPath.split('/').pop()!;
  const relsPath = `xl/worksheets/_rels/${sheetFile}.rels`;

  charts.forEach((c, i) => write(`xl/charts/chart${i + 1}.xml`, chartXml(c)));
  write('xl/drawings/drawing1.xml', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><xdr:wsDr xmlns:xdr="http://schemas.openxmlformats.org/drawingml/2006/spreadsheetDrawing" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main">${charts.map(anchorXml).join('')}</xdr:wsDr>`);
  write('xl/drawings/_rels/drawing1.xml.rels', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${charts.map((_, i) => `<Relationship Id="rId${i + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/chart" Target="../charts/chart${i + 1}.xml"/>`).join('')}</Relationships>`);

  const drawingRel = `<Relationship Id="rIdCharts1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/drawing" Target="../drawings/drawing1.xml"/>`;
  const rels = files[relsPath] ? read(relsPath) : '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"></Relationships>';
  write(relsPath, rels.replace('</Relationships>', `${drawingRel}</Relationships>`));

  let sheet = read(sheetPath);
  if (!/xmlns:r=/.test(sheet.slice(0, 1000))) sheet = sheet.replace('<worksheet ', '<worksheet xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" ');
  // <drawing> must follow sheetData/mergeCells/…/pageSetup and precede legacyDrawing/tableParts/extLst
  // Print setup: landscape, fit to one page wide.
  if (!/<sheetPr\b/.test(sheet)) sheet = sheet.replace(/(<worksheet\b[^>]*>)/, '$1<sheetPr><pageSetUpPr fitToPage="1"/></sheetPr>');
  if (!/<pageSetup\b/.test(sheet)) {
    const margins = /<pageMargins\b/.test(sheet) ? '' : '<pageMargins left="0.4" right="0.4" top="0.5" bottom="0.5" header="0.3" footer="0.3"/>';
    sheet = sheet.replace('</sheetData>', `</sheetData>${margins}<pageSetup paperSize="9" orientation="landscape" fitToWidth="1" fitToHeight="0"/>`);
  }
  const before = sheet.search(/<(legacyDrawing|legacyDrawingHF|picture|oleObjects|controls|webPublishItems|tableParts|extLst)\b/);
  const drawingTag = '<drawing r:id="rIdCharts1"/>';
  sheet = before >= 0 ? sheet.slice(0, before) + drawingTag + sheet.slice(before) : sheet.replace('</worksheet>', `${drawingTag}</worksheet>`);
  write(sheetPath, sheet);

  const ct = read('[Content_Types].xml');
  const overrides =
    charts.map((_, i) => `<Override PartName="/xl/charts/chart${i + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.drawingml.chart+xml"/>`).join('') +
    `<Override PartName="/xl/drawings/drawing1.xml" ContentType="application/vnd.openxmlformats-officedocument.drawing+xml"/>`;
  write('[Content_Types].xml', ct.replace('</Types>', `${overrides}</Types>`));

  return zipSync(files, { level: 6 });
}

/** Print setup for extra sheets: landscape, fit to one page wide. */
export function fitSheetsToWidth(xlsx: Uint8Array, sheetNames: string[]): Uint8Array {
  const files = unzipSync(xlsx);
  const read = (p: string) => strFromU8(files[p]);
  const wb = read('xl/workbook.xml');
  const wbRels = read('xl/_rels/workbook.xml.rels');
  for (const name of sheetNames) {
    const tag = [...wb.matchAll(/<sheet\b[^>]*>/g)].map((x) => x[0]).find((t) => t.includes(`name="${esc(name)}"`));
    const rid = tag?.match(/r:id="([^"]+)"/)?.[1];
    const target = rid && [...wbRels.matchAll(/<Relationship\b[^>]*>/g)].map((x) => x[0]).find((t) => t.includes(`Id="${rid}"`))?.match(/Target="([^"]+)"/)?.[1];
    if (!target) continue;
    const path = `xl/${target.replace(/^\/?xl\//, '')}`;
    let sheet = read(path);
    if (!/<sheetPr\b/.test(sheet)) sheet = sheet.replace(/(<worksheet\b[^>]*>)/, '$1<sheetPr><pageSetUpPr fitToPage="1"/></sheetPr>');
    if (!/<pageSetup\b/.test(sheet)) {
      const margins = /<pageMargins\b/.test(sheet) ? '' : '<pageMargins left="0.4" right="0.4" top="0.5" bottom="0.5" header="0.3" footer="0.3"/>';
      const anchor = /<\/mergeCells>/.test(sheet) ? '</mergeCells>' : '</sheetData>';
      sheet = sheet.replace(anchor, `${anchor}${margins}<pageSetup paperSize="9" orientation="landscape" fitToWidth="1" fitToHeight="0"/>`);
    }
    files[path] = strToU8(sheet);
  }
  return zipSync(files, { level: 6 });
}
