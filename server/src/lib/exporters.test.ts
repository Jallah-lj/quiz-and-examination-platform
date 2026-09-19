/**
 * Report exports. The Excel writer is the one that historically failed: report titles are
 * written for people ("Pass / fail report"), and Excel refuses a worksheet name containing
 * `/` — so the export answered 500 while CSV and PDF worked.
 */
import { describe, expect, it } from 'vitest';
import ExcelJS from 'exceljs';
import { exportFileName, sheetName, toCsv, toXlsx, type ReportTable } from './exporters';

function table(overrides: Partial<ReportTable> = {}): ReportTable {
  return {
    title: 'Pass / fail report',
    subtitle: 'Institution 2',
    columns: [
      { key: 'grade', header: 'Grade' },
      { key: 'count', header: 'Candidates', align: 'right' },
    ],
    rows: [
      { grade: 'C', count: 2 },
      { grade: 'F', count: 1 },
    ],
    generatedAt: '2026-09-17T10:00:00.000Z',
    ...overrides,
  };
}

describe('sheetName', () => {
  it('removes the characters Excel refuses', () => {
    expect(sheetName('Pass / fail report')).toBe('Pass fail report');
    expect(sheetName('Marks: term 1 [draft]')).toBe('Marks term 1 draft');
    expect(sheetName('Cohort * 2026 ?')).toBe('Cohort 2026');
    expect(sheetName('A\\B')).toBe('A B');
  });

  it('caps the name at the 31 characters Excel allows', () => {
    const long = sheetName('Candidate result report for the second semester cohort 2026');
    expect(long.length).toBeLessThanOrEqual(31);
    expect(long.length).toBeGreaterThan(0);
  });

  it('never returns a blank name or stray apostrophes', () => {
    expect(sheetName('   ')).toBe('Report');
    expect(sheetName('/ [ ] : * ?')).toBe('Report');
    expect(sheetName("'Quoted report'")).toBe('Quoted report');
  });
});

describe('toXlsx', () => {
  it('writes a workbook Excel can open for a report whose title contains a slash', async () => {
    const buffer = await toXlsx(table());
    // A real workbook, and the sheet is named after the cleaned title rather than throwing.
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load(buffer as unknown as ArrayBuffer);
    expect(workbook.worksheets.map((sheet) => sheet.name)).toEqual(['Pass fail report']);
    // The report's own title still reads exactly as written, inside the sheet.
    expect(workbook.worksheets[0].getCell('A1').value).toBe('Pass / fail report');
    expect(workbook.worksheets[0].getCell('A5').value).toBe('C');
    expect(workbook.worksheets[0].getCell('B6').value).toBe(1);
  });

  it('carries every title in the catalogue, whatever punctuation it uses', async () => {
    const titles = [
      'Candidate result report',
      'Class performance report',
      'Subject performance report',
      'Examination statistics',
      'Question performance report',
      'Pass / fail report',
      'Examiner activity report',
    ];
    for (const title of titles) {
      const buffer = await toXlsx(table({ title }));
      const workbook = new ExcelJS.Workbook();
      await workbook.xlsx.load(buffer as unknown as ArrayBuffer);
      expect(workbook.worksheets[0].name).toBe(sheetName(title));
    }
  });
});

describe('csv and file names', () => {
  it('quotes values so a comma or a quote cannot break the columns', () => {
    const csv = toCsv(table({ rows: [{ grade: 'A, "distinction"', count: 3 }] }));
    expect(csv).toContain('"A, ""distinction"""');
  });

  it('builds a file name that is safe on every platform', () => {
    const today = new Date().toISOString().slice(0, 10);
    expect(exportFileName('Pass / fail report', 'csv')).toBe(`pass-fail-report-${today}.csv`);
  });
});
