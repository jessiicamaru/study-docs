import { describe, expect, it } from 'vitest'
import JSZip from 'jszip'
import { applyXlsxEdits, asExcelNumber, colName, formatSerialDate, parseCsv, parseDateText, parseRef, readXlsx, SheetError, writeCsv, xlsxText } from '../src/main/sheet'

describe('CSV', () => {
  it('reads quotes, delimiters and line breaks inside quoted fields', () => {
    const f = parseCsv('Tên,Ghi chú,Điểm\r\n"Nguyễn, An","Nói ""chào""\r\ndòng 2",8.5\r\nBình,,7\r\n')
    expect(f.delimiter).toBe(',')
    expect(f.eol).toBe('\r\n')
    expect(f.trailingEol).toBe(true)
    expect(f.rows).toEqual([
      ['Tên', 'Ghi chú', 'Điểm'],
      ['Nguyễn, An', 'Nói "chào"\r\ndòng 2', '8.5'],
      ['Bình', '', '7']
    ])
  })

  it('finds ; and tab delimiters, keeps a byte-order mark', () => {
    expect(parseCsv('a;b;c\n1;2;3').delimiter).toBe(';')
    expect(parseCsv('a\tb\n1\t2').delimiter).toBe('\t')
    const f = parseCsv('﻿a;b\n1;2')
    expect(f.bom).toBe(true)
    expect(f.rows[0]).toEqual(['a', 'b'])
    expect(f.trailingEol).toBe(false)
  })

  it('writes unchanged rows exactly as they were; only edited rows are written anew', () => {
    const src = '﻿Tên;Điểm\n"An" ;  7\n"Bình";8\n'
    const f = parseCsv(src)
    expect(writeCsv(f, f.rows.map((cells, i) => ({ orig: i, cells })))).toBe(src)
    const out = writeCsv(f, [
      { orig: 0, cells: f.rows[0] },
      { orig: 1, cells: f.rows[1] },
      { orig: 2, cells: ['Bình; Chi', '9'] },
      { cells: ['Dũng', ' 10'] }
    ])
    expect(out).toBe('﻿Tên;Điểm\n"An" ;  7\n"Bình; Chi";9\nDũng;" 10"\n')
  })

  it('rows left out are deleted', () => {
    const f = parseCsv('a,b\n1,2\n3,4\n')
    expect(writeCsv(f, [{ orig: 0, cells: ['a', 'b'] }, { orig: 2, cells: ['3', '4'] }])).toBe('a,b\n3,4\n')
  })
})

describe('cell positions and dates', () => {
  it('converts A1 references', () => {
    expect(parseRef('A1')).toEqual({ row: 0, col: 0 })
    expect(parseRef('AB12')).toEqual({ row: 11, col: 27 })
    expect(colName(0)).toBe('A')
    expect(colName(25)).toBe('Z')
    expect(colName(26)).toBe('AA')
    expect(colName(27)).toBe('AB')
  })
  it('shows Excel date serials as dd/mm/yyyy and reads them back', () => {
    expect(formatSerialDate(46346)).toBe('20/11/2026')
    expect(formatSerialDate(46346.75)).toBe('20/11/2026 18:00')
    expect(parseDateText('20/11/2026')).toBe(46346)
    expect(parseDateText('2026-11-20 18:00')).toBe(46346.75)
    expect(parseDateText('31/02/2026')).toBeNull()
    expect(parseDateText('hello')).toBeNull()
  })
})

/** A small workbook: shared strings, a date style, a formula, a boolean, an inline string. */
async function makeXlsx(): Promise<Uint8Array> {
  const zip = new JSZip()
  zip.file('[Content_Types].xml', '<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"/>')
  zip.file(
    'xl/workbook.xml',
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="Điểm" sheetId="1" r:id="rId1"/><sheet name="Khác" sheetId="2" r:id="rId2"/></sheets></workbook>'
  )
  zip.file(
    'xl/_rels/workbook.xml.rels',
    '<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="x" Target="worksheets/sheet1.xml"/><Relationship Id="rId2" Type="x" Target="/xl/worksheets/sheet2.xml"/></Relationships>'
  )
  zip.file(
    'xl/sharedStrings.xml',
    '<?xml version="1.0"?><sst xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" count="3" uniqueCount="3"><si><t>Tên</t></si><si><t>Ngày</t></si><si><r><t>Nguyễn </t></r><r><rPr><b/></rPr><t>An</t></r><rPh><t>x</t></rPh></si></sst>'
  )
  zip.file(
    'xl/styles.xml',
    '<?xml version="1.0"?><styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><numFmts count="1"><numFmt numFmtId="164" formatCode="dd/mm/yyyy"/></numFmts><cellXfs count="3"><xf numFmtId="0"/><xf numFmtId="164" applyNumberFormat="1"/><xf numFmtId="2"/></cellXfs></styleSheet>'
  )
  zip.file(
    'xl/worksheets/sheet1.xml',
    '<?xml version="1.0"?>\n<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><dimension ref="A1:D3"/><sheetData>' +
      '<row r="1" spans="1:4"><c r="A1" t="s"><v>0</v></c><c r="B1" t="s"><v>1</v></c><c r="C1" t="inlineStr"><is><t>Điểm</t></is></c><c r="D1" t="b"><v>1</v></c></row>' +
      '<row r="2" spans="1:4"><c r="A2" t="s"><v>2</v></c><c r="B2" s="1"><v>46346</v></c><c r="C2" s="2"><v>0.30000000000000004</v></c><c r="D2"><f>C2*10</f><v>3</v></c></row>' +
      '<row r="4"><c r="B4"><v>12</v></c></row>' +
      '</sheetData></worksheet>'
  )
  zip.file('xl/worksheets/sheet2.xml', '<?xml version="1.0"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData/></worksheet>')
  return zip.generateAsync({ type: 'uint8array' })
}

describe('XLSX', () => {
  it('reads values: shared and inline strings, dates, numbers without float noise, formulas as saved results', async () => {
    const [s1, s2] = await readXlsx(await makeXlsx())
    expect(s1.name).toBe('Điểm')
    expect(s2.name).toBe('Khác')
    expect(s1.cols).toBe(4)
    expect(s1.rows[0].map((c) => c.text)).toEqual(['Tên', 'Ngày', 'Điểm', 'TRUE'])
    expect(s1.rows[1]).toEqual([
      { text: 'Nguyễn An', kind: 'text' },
      { text: '20/11/2026', kind: 'date' },
      { text: '0.3', kind: 'number' },
      { text: '3', kind: 'formula' }
    ])
    expect(s1.rows[2]).toEqual([])
    expect(s1.rows[3][1]).toEqual({ text: '12', kind: 'number' })
    expect(s2.rows).toEqual([])
  })

  it('searchable text has every sheet and cell', async () => {
    const text = await xlsxText(await makeXlsx(), 10000)
    expect(text).toContain('Điểm')
    expect(text).toContain('Nguyễn An')
    expect(text).toContain('20/11/2026')
  })

  it('writes only the edited cells, keeping their style; new cells and rows go in order', async () => {
    const before = await makeXlsx()
    const after = await applyXlsxEdits(before, [
      { sheet: 0, row: 1, col: 0, text: 'Trần <Bình> & Chi' },
      { sheet: 0, row: 1, col: 1, text: '21/11/2026' },
      { sheet: 0, row: 1, col: 2, text: '7.25' },
      { sheet: 0, row: 0, col: 3, text: 'false' },
      { sheet: 0, row: 2, col: 1, text: 'mới' },
      { sheet: 0, row: 3, col: 0, text: 'trước B4' },
      { sheet: 0, row: 0, col: 5, text: 'F1' },
      { sheet: 1, row: 0, col: 0, text: 'sheet 2' }
    ])
    const [s1, s2] = await readXlsx(after)
    expect(s1.rows[1].map((c) => c.text)).toEqual(['Trần <Bình> & Chi', '21/11/2026', '7.25', '3'])
    expect(s1.rows[0][3]).toEqual({ text: 'FALSE', kind: 'bool' })
    expect(s1.rows[0][5].text).toBe('F1')
    expect(s1.rows[2][1].text).toBe('mới')
    expect(s1.rows[3].map((c) => c.text)).toEqual(['trước B4', '12'])
    expect(s2.rows[0][0].text).toBe('sheet 2')

    const zip = await JSZip.loadAsync(after)
    const old = await JSZip.loadAsync(before)
    const xml = await zip.file('xl/worksheets/sheet1.xml')!.async('string')
    // Style kept, text as an inline string, the date as a serial.
    expect(xml).toContain('<c r="A2" t="inlineStr"><is><t xml:space="preserve">Trần &lt;Bình&gt; &amp; Chi</t></is></c>')
    expect(xml).toContain('<c r="B2" s="1"><v>46347</v></c>')
    expect(xml).toContain('<c r="C2" s="2"><v>7.25</v></c>')
    expect(xml).toContain('<c r="D2"><f>C2*10</f><v>3</v></c>') // the formula cell as it was
    expect(xml).toContain('<row r="3"><c r="B3" t="inlineStr">')
    expect(xml).toContain('<row r="4"><c r="A4" t="inlineStr"><is><t xml:space="preserve">trước B4</t></is></c><c r="B4"><v>12</v></c></row>')
    expect(xml).toContain('<dimension ref="A1:F4"/>')
    // Other parts are untouched; Excel recalculates the formulas when it opens the file.
    expect(await zip.file('xl/sharedStrings.xml')!.async('string')).toBe(await old.file('xl/sharedStrings.xml')!.async('string'))
    expect(await zip.file('xl/workbook.xml')!.async('string')).toContain('</sheets><calcPr fullCalcOnLoad="1"/></workbook>')
  })

  it('refuses to change a formula cell', async () => {
    await expect(applyXlsxEdits(await makeXlsx(), [{ sheet: 0, row: 1, col: 3, text: '5' }])).rejects.toThrow(SheetError)
  })

  it('refuses files that are not workbooks', async () => {
    await expect(readXlsx(new TextEncoder().encode('not a zip'))).rejects.toThrow(SheetError)
  })
})

/** A one-sheet workbook with the given cells (sheet XML) and, if asked, an Excel table A1:B3. */
async function workbook(cells: string, shared: string[] = [], table = false): Promise<Uint8Array> {
  const zip = new JSZip()
  zip.file('xl/workbook.xml', '<workbook xmlns:r="r"><sheets><sheet name="S" sheetId="1" r:id="rId1"/></sheets></workbook>')
  zip.file('xl/_rels/workbook.xml.rels', '<Relationships><Relationship Id="rId1" Type="x" Target="worksheets/sheet1.xml"/></Relationships>')
  zip.file('xl/sharedStrings.xml', `<sst>${shared.map((s) => `<si><t>${s}</t></si>`).join('')}</sst>`)
  zip.file('xl/worksheets/sheet1.xml', `<worksheet><sheetData>${cells}</sheetData></worksheet>`)
  if (table) {
    zip.file('xl/worksheets/_rels/sheet1.xml.rels', '<Relationships><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/table" Target="../tables/table1.xml"/></Relationships>')
    zip.file('xl/tables/table1.xml', '<table id="1" name="Lop" displayName="Lop" ref="A1:B3"><tableColumns count="2"><tableColumn id="1" name="MSSV"/><tableColumn id="2" name="Tên"/></tableColumns></table>')
  }
  return zip.generateAsync({ type: 'uint8array' })
}
const sheetXml = async (buf: Uint8Array): Promise<string> => (await JSZip.loadAsync(buf)).file('xl/worksheets/sheet1.xml')!.async('string')

describe('XLSX: what a typed value becomes', () => {
  it('a text cell stays text: "00123" -> "00124" keeps its zeros', async () => {
    const out = await sheetXml(await applyXlsxEdits(await workbook('<row r="1"><c r="A1" t="s"><v>0</v></c></row>', ['00123']), [{ sheet: 0, row: 0, col: 0, text: '00124' }]))
    expect(out).toContain('<c r="A1" t="inlineStr"><is><t xml:space="preserve">00124</t></is></c>')
  })

  it('long numbers (ID card, bank account) and leading zeros (phone) are kept as text, even in a number cell', async () => {
    const buf = await workbook('<row r="1"><c r="A1"><v>5</v></c><c r="B1"><v>7</v></c></row>')
    const out = await sheetXml(
      await applyXlsxEdits(buf, [
        { sheet: 0, row: 0, col: 0, text: '0912345678' },
        { sheet: 0, row: 0, col: 1, text: '1.50' },
        { sheet: 0, row: 0, col: 2, text: '1234567890123456789' },
        { sheet: 0, row: 0, col: 3, text: '42' },
        { sheet: 0, row: 0, col: 4, text: '1.50' },
        { sheet: 0, row: 0, col: 5, text: '-3.25' }
      ])
    )
    expect(out).toContain('<c r="A1" t="inlineStr"><is><t xml:space="preserve">0912345678</t></is></c>')
    expect(out).toContain('<c r="B1"><v>1.5</v></c>') // a number cell stays a number
    expect(out).toContain('<c r="C1" t="inlineStr"><is><t xml:space="preserve">1234567890123456789</t></is></c>')
    expect(out).toContain('<c r="D1"><v>42</v></c>') // a new cell: a number when it reads back as typed
    expect(out).toContain('<c r="E1" t="inlineStr"><is><t xml:space="preserve">1.50</t></is></c>')
    expect(out).toContain('<c r="F1"><v>-3.25</v></c>')
  })

  it('asExcelNumber: only numbers Excel holds exactly', () => {
    expect(asExcelNumber('42', true)).toBe(42)
    expect(asExcelNumber('007', false)).toBeNull()
    expect(asExcelNumber('123456789012345', false)).toBe(123456789012345)
    expect(asExcelNumber('1234567890123456', false)).toBeNull()
    expect(asExcelNumber('1e3', true)).toBeNull()
    expect(asExcelNumber('1e3', false)).toBe(1000)
    expect(asExcelNumber('12a', false)).toBeNull()
  })
})

describe('XLSX: Excel tables', () => {
  const cells = '<row r="1"><c r="A1" t="s"><v>0</v></c><c r="B1" t="s"><v>1</v></c></row><row r="2"><c r="A2" t="s"><v>2</v></c><c r="B2" t="s"><v>3</v></c></row>'
  const shared = ['MSSV', 'Tên', '0012', 'An']
  it('the column names of a table are marked, and are not changed here', async () => {
    const buf = await workbook(cells, shared, true)
    const [tab] = await readXlsx(buf)
    expect(tab.tableHeaders?.sort()).toEqual(['0:0', '0:1'])
    await expect(applyXlsxEdits(buf, [{ sheet: 0, row: 0, col: 1, text: 'Họ tên' }])).rejects.toThrow(SheetError)
    const out = await sheetXml(await applyXlsxEdits(buf, [{ sheet: 0, row: 1, col: 1, text: 'Bình' }]))
    expect(out).toContain('<c r="B2" t="inlineStr"><is><t xml:space="preserve">Bình</t></is></c>')
  })
  it('without a table nothing is marked', async () => {
    expect((await readXlsx(await workbook(cells, shared)))[0].tableHeaders).toBeUndefined()
  })
})
