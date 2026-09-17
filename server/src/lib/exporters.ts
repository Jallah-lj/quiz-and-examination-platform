import ExcelJS from 'exceljs';
import PDFDocument from 'pdfkit';
import { sanitizeCsvValue } from './validation';

export interface ReportColumn {
  key: string;
  header: string;
  width?: number;
  align?: 'left' | 'right' | 'center';
}

export interface ReportTable {
  title: string;
  subtitle?: string;
  columns: ReportColumn[];
  rows: Record<string, unknown>[];
  summary?: Record<string, string | number>;
  generatedAt: string;
  generatedBy?: string;
  institution?: string;
}

export function toCsv(table: ReportTable): string {
  const header = table.columns.map((c) => sanitizeCsvValue(c.header)).join(',');
  const lines = table.rows.map((row) => table.columns.map((c) => sanitizeCsvValue(row[c.key])).join(','));
  const summaryLines = table.summary
    ? ['', ...Object.entries(table.summary).map(([k, v]) => `${sanitizeCsvValue(k)},${sanitizeCsvValue(v)}`)]
    : [];
  const titleBlock = [
    sanitizeCsvValue(table.title),
    sanitizeCsvValue(
      [table.subtitle, table.institution, `Generated ${table.generatedAt}`, table.generatedBy]
        .filter(Boolean)
        .join(' • '),
    ),
    '',
  ];
  return [...titleBlock, header, ...lines, ...summaryLines].join('\r\n');
}

/**
 * Excel rejects a worksheet name containing any of `* ? : \ / [ ]`, refuses names longer
 * than 31 characters, and refuses to open a workbook with a blank name. Report titles are
 * written for people ("Pass / fail report"), so the title is cleaned rather than the
 * report being renamed: the offending characters become spaces and the result is trimmed.
 */
export function sheetName(title: string): string {
  const cleaned = title
    // eslint-disable-next-line no-control-regex -- Excel also rejects control characters.
    .replace(/[*?:\\/[\]\u0000-\u001f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^'+|'+$/g, '')
    .slice(0, 31)
    .trim();
  return cleaned || 'Report';
}

export async function toXlsx(table: ReportTable): Promise<Buffer> {
  const workbook = new ExcelJS.Workbook();
  workbook.creator = 'ExamSys';
  workbook.created = new Date(table.generatedAt);
  const sheet = workbook.addWorksheet(sheetName(table.title));

  sheet.mergeCells(1, 1, 1, Math.max(1, table.columns.length));
  const titleCell = sheet.getCell(1, 1);
  titleCell.value = table.title;
  titleCell.font = { bold: true, size: 14 };
  sheet.mergeCells(2, 1, 2, Math.max(1, table.columns.length));
  const metaCell = sheet.getCell(2, 1);
  metaCell.value = [table.subtitle, table.institution, `Generated ${table.generatedAt}`]
    .filter(Boolean)
    .join('  •  ');
  metaCell.font = { size: 10, color: { argb: 'FF555555' } };

  const headerRow = sheet.getRow(4);
  table.columns.forEach((column, index) => {
    const cell = headerRow.getCell(index + 1);
    cell.value = column.header;
    cell.font = { bold: true };
    cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFE8EDF3' } };
    cell.border = { bottom: { style: 'thin' } };
    sheet.getColumn(index + 1).width = column.width ?? Math.max(12, column.header.length + 4);
  });

  table.rows.forEach((row, rowIndex) => {
    const excelRow = sheet.getRow(5 + rowIndex);
    table.columns.forEach((column, columnIndex) => {
      const value = row[column.key];
      const cell = excelRow.getCell(columnIndex + 1);
      cell.value = value === null || value === undefined ? '' : (value as ExcelJS.CellValue);
      if (column.align) cell.alignment = { horizontal: column.align };
    });
  });

  if (table.summary) {
    let offset = 6 + table.rows.length;
    sheet.getCell(offset, 1).value = 'Summary';
    sheet.getCell(offset, 1).font = { bold: true };
    offset += 1;
    Object.entries(table.summary).forEach(([key, value]) => {
      sheet.getCell(offset, 1).value = key;
      sheet.getCell(offset, 2).value = value;
      offset += 1;
    });
  }

  const buffer = await workbook.xlsx.writeBuffer();
  return Buffer.from(buffer);
}

export function toPdf(table: ReportTable): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: 'A4', layout: 'landscape', margin: 36 });
    const chunks: Buffer[] = [];
    doc.on('data', (chunk) => chunks.push(chunk as Buffer));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);

    doc.fontSize(16).fillColor('#111827').text(table.title, { continued: false });
    if (table.subtitle) doc.fontSize(10).fillColor('#4b5563').text(table.subtitle);
    doc
      .fontSize(8)
      .fillColor('#6b7280')
      .text(
        [table.institution, `Generated ${new Date(table.generatedAt).toUTCString()}`, table.generatedBy]
          .filter(Boolean)
          .join('  •  '),
      );
    doc.moveDown(0.8);

    if (table.summary) {
      doc.fontSize(9).fillColor('#111827');
      const summaryText = Object.entries(table.summary)
        .map(([key, value]) => `${key}: ${value}`)
        .join('     ');
      doc.text(summaryText);
      doc.moveDown(0.5);
    }

    const pageWidth = doc.page.width - doc.page.margins.left - doc.page.margins.right;
    const weights = table.columns.map((c) => c.width ?? 1);
    const totalWeight = weights.reduce((a, b) => a + b, 0);
    const widths = weights.map((w) => (w / totalWeight) * pageWidth);
    const startX = doc.page.margins.left;
    let y = doc.y;

    const drawHeader = () => {
      doc.fontSize(8).fillColor('#111827');
      let x = startX;
      table.columns.forEach((column, index) => {
        doc.text(column.header, x + 2, y + 3, { width: widths[index] - 4, ellipsis: true });
        x += widths[index];
      });
      doc
        .moveTo(startX, y)
        .lineTo(startX + pageWidth, y)
        .strokeColor('#d1d5db')
        .stroke();
      y += 16;
    };

    const drawRow = (row: Record<string, unknown>, shade: boolean) => {
      const rowHeight = 16;
      if (y + rowHeight > doc.page.height - doc.page.margins.bottom) {
        doc.addPage();
        y = doc.page.margins.top;
        drawHeader();
      }
      if (shade) {
        doc.rect(startX, y, pageWidth, rowHeight).fillColor('#f9fafb').fill();
      }
      doc.fillColor('#1f2937').fontSize(8);
      let x = startX;
      table.columns.forEach((column, index) => {
        const value = row[column.key];
        doc.text(value === null || value === undefined ? '—' : String(value), x + 2, y + 4, {
          width: widths[index] - 4,
          ellipsis: true,
          align: column.align === 'right' ? 'right' : 'left',
        });
        x += widths[index];
      });
      y += rowHeight;
    };

    drawHeader();
    table.rows.forEach((row, index) => drawRow(row, index % 2 === 1));

    if (!table.rows.length) {
      doc.fontSize(9).fillColor('#6b7280').text('No records matched this report.', startX, y + 6);
    }

    doc.end();
  });
}

export function exportFileName(title: string, extension: string): string {
  const slug = title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 60);
  return `${slug || 'report'}-${new Date().toISOString().slice(0, 10)}.${extension}`;
}
