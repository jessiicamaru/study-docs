import { describe, expect, it } from 'vitest'
import { applyHtmlEdits, editModeInjection, HtmlEditError, sanitizeInline } from '../src/main/html-edit'

const page = `<!DOCTYPE html>
<html lang="vi">
<head>
  <meta charset="UTF-8">
  <title>T</title>
  <style>p{color:red}</style>
</head>
<body>
  <h1>Event   Sourcing</h1>
  <section>
    <p>Lưu <strong>chuỗi</strong> event &amp; replay.</p>
    <ul><li>Một</li><li>Hai</li></ul>
  </section>
</body>
</html>
`

describe('applyHtmlEdits', () => {
  // body = [1], h1 = [1,0], section = [1,1], p = [1,1,0], ul = [1,1,1], li#2 = [1,1,1,1]
  it('replaces only the inner HTML of the edited block, keeping the rest byte-for-byte', () => {
    const out = applyHtmlEdits(page, [{ path: [1, 1, 0], tag: 'p', html: 'Lưu <strong>chuỗi</strong> sự kiện &amp; replay.' }])
    expect(out).toBe(page.replace('event &amp; replay', 'sự kiện &amp; replay'))
  })

  it('applies several edits at once', () => {
    const out = applyHtmlEdits(page, [
      { path: [1, 0], tag: 'h1', html: 'ES' },
      { path: [1, 1, 1, 1], tag: 'li', html: 'Hai (sửa)' }
    ])
    expect(out).toContain('<h1>ES</h1>')
    expect(out).toContain('<li>Hai (sửa)</li>')
    expect(out).toContain('<li>Một</li>')
    expect(out).toContain('<style>p{color:red}</style>')
  })

  it('works with Windows line endings and a byte-order mark', () => {
    const crlf = '﻿' + page.replace(/\n/g, '\r\n')
    const out = applyHtmlEdits(crlf, [{ path: [1, 1, 0], tag: 'p', html: 'X' }])
    expect(out).toBe(crlf.replace('Lưu <strong>chuỗi</strong> event &amp; replay.', 'X'))
  })

  it('refuses when the element at that position is a different tag', () => {
    expect(() => applyHtmlEdits(page, [{ path: [1, 1, 0], tag: 'li', html: 'X' }])).toThrow(HtmlEditError)
  })

  it('refuses elements without an end tag in the source', () => {
    const src = '<html><body><ul><li>Một<li>Hai</ul></body></html>'
    expect(() => applyHtmlEdits(src, [{ path: [1, 0, 0], tag: 'li', html: 'X' }])).toThrow(/thẻ đóng/)
  })

  it('refuses a path that does not exist', () => {
    expect(() => applyHtmlEdits(page, [{ path: [1, 9], tag: 'p', html: 'X' }])).toThrow(HtmlEditError)
  })
})

describe('editing HTML with formatting', () => {
  it('the script added to the page in edit mode is valid JavaScript', () => {
    const html = editModeInjection('n0nce')
    const js = html.slice(html.indexOf('>', html.indexOf('<script')) + 1, html.lastIndexOf('</script>'))
    expect(() => new Function(js)).not.toThrow()
  })

  it('keeps bold, links and pictures; drops scripts, handlers and javascript: links', () => {
    expect(sanitizeInline('Lưu <b>chuỗi</b> <a href="https://x.dev" class="k">link</a> <img src="data:image/webp;base64,AAAA" alt="">')).toBe(
      'Lưu <b>chuỗi</b> <a href="https://x.dev" class="k">link</a> <img src="data:image/webp;base64,AAAA" alt="">'
    )
    expect(sanitizeInline('a<script>alert(1)</script><img src=x onerror="alert(1)"><a href=" JaVaScript:alert(1)">b</a>')).toBe('a<img src="x"><a>b</a>')
    expect(sanitizeInline('<div>trong <p>khối</p></div><!-- c -->')).toBe('trong khối')
    expect(sanitizeInline('<a href="data:text/html,x">y</a>')).toBe('<a>y</a>')
    expect(sanitizeInline('Đoạn mới<b></b><i><b></b></i> và<br>dòng')).toBe('Đoạn mới và<br>dòng')
  })

  it('new paragraphs (Enter) go right after their block, on their own lines, indented like it', () => {
    const out = applyHtmlEdits(page, [{ path: [1, 1, 0], tag: 'p', html: 'Lưu <strong>chuỗi</strong> event &amp; replay.', after: [{ tag: 'p', html: 'Đoạn <b>mới</b>' }, { tag: 'p', html: 'Thêm nữa' }] }])
    expect(out).toContain('    <p>Lưu <strong>chuỗi</strong> event &amp; replay.</p>\n    <p>Đoạn <b>mới</b></p>\n    <p>Thêm nữa</p>\n    <ul>')
    const li = applyHtmlEdits(page, [{ path: [1, 1, 1, 0], tag: 'li', html: 'Một', after: [{ tag: 'li', html: 'Một rưỡi' }] }])
    expect(li).toContain('<ul><li>Một</li><li>Một rưỡi</li><li>Hai</li></ul>')
    expect(() => applyHtmlEdits(page, [{ path: [1, 0], tag: 'h1', html: 'x', after: [{ tag: 'div' as 'p', html: 'y' }] }])).toThrow(HtmlEditError)
  })
})

describe('new headings and lists typed while editing', () => {
  it('go after their block: a heading, then a list with one item per line', () => {
    const out = applyHtmlEdits(page, [
      {
        path: [1, 1, 0],
        tag: 'p',
        html: 'Lưu <strong>chuỗi</strong> event &amp; replay.',
        after: [
          { tag: 'h2', html: 'Mục mới' },
          { tag: 'ul', html: '<li>Một <b>a</b></li><li>Hai<script>x</script></li><p>bỏ</p>' }
        ]
      }
    ])
    expect(out).toContain('replay.</p>\n    <h2>Mục mới</h2>\n    <ul>\n      <li>Một <b>a</b></li>\n      <li>Hai</li>\n    </ul>\n    <ul><li>Một</li>')
  })

  it('refuses other block types', () => {
    expect(() => applyHtmlEdits(page, [{ path: [1, 0], tag: 'h1', html: 'x', after: [{ tag: 'div' as 'p', html: 'y' }] }])).toThrow(HtmlEditError)
  })
})

describe('dragging blocks into a new order', () => {
  it('reorders list items, byte for byte', () => {
    const out = applyHtmlEdits(page, [{ path: [1, 1, 1], tag: 'ul', order: [{ i: 1 }, { i: 0 }] }])
    expect(out).toBe(page.replace('<ul><li>Một</li><li>Hai</li></ul>', '<ul><li>Hai</li><li>Một</li></ul>'))
  })

  it('a moved block keeps its own edits; new blocks can sit among the others', () => {
    const out = applyHtmlEdits(page, [
      { path: [1, 1], tag: 'section', order: [{ i: 1 }, { tag: 'p', html: 'Mới <b>thêm</b>' }, { i: 0 }] },
      { path: [1, 1, 0], tag: 'p', html: 'Lưu <strong>chuỗi</strong> event.' }
    ])
    expect(out).toContain('  <section>\n    <ul><li>Một</li><li>Hai</li></ul>\n    <p>Mới <b>thêm</b></p>\n    <p>Lưu <strong>chuỗi</strong> event.</p>\n  </section>')
  })

  it('a paragraph can follow a list (an element that is not a text block)', () => {
    const out = applyHtmlEdits(page, [{ path: [1, 1, 1], tag: 'ul', after: [{ tag: 'p', html: 'Sau danh sách' }] }])
    expect(out).toContain('<ul><li>Một</li><li>Hai</li></ul>\n    <p>Sau danh sách</p>\n  </section>')
  })

  it('refuses when text sits between the blocks, or the order does not match the file', () => {
    const mixed = page.replace('<ul>', 'chữ lẻ <ul>')
    expect(() => applyHtmlEdits(mixed, [{ path: [1, 1], tag: 'section', order: [{ i: 1 }, { i: 0 }] }])).toThrow(HtmlEditError)
    expect(() => applyHtmlEdits(page, [{ path: [1, 1], tag: 'section', order: [{ i: 0 }, { i: 0 }] }])).toThrow(HtmlEditError)
    expect(() => applyHtmlEdits(page, [{ path: [1, 1], tag: 'section', order: [{ i: 0 }, { i: 5 }] }])).toThrow(HtmlEditError)
  })

  it('a child left out of the new order is deleted', () => {
    const out = applyHtmlEdits(page, [{ path: [1, 1], tag: 'section', order: [{ i: 1 }] }])
    expect(out).toContain('<section>\n    <ul><li>Một</li><li>Hai</li></ul>\n  </section>')
  })
})

describe('tables while editing', () => {
  const withTable = `<!doctype html>
<html>
<body>
  <p>Trước</p>
  <table>
    <tr><th>Giao thức</th><th>Tin cậy</th></tr>
    <tr><td>TCP</td><td>Có</td></tr>
    <tr><td>UDP</td><td></td></tr>
  </table>
</body>
</html>
`
  // body = [1], p = [1,0], table = [1,1], tbody (added by the parser) = [1,1,0], rows [1,1,0,i]

  it('a new table is written after its block, a row per line', () => {
    const out = applyHtmlEdits(withTable, [
      { path: [1, 0], tag: 'p', after: [{ tag: 'table', html: '<thead><tr><th>A</th><th>B</th></tr></thead><tbody><tr><td>1</td><td><b>2</b><script>x</script></td></tr></tbody>' }] }
    ])
    expect(out).toContain(
      '  <p>Trước</p>\n  <table>\n    <thead>\n      <tr><th>A</th><th>B</th></tr>\n    </thead>\n    <tbody>\n      <tr><td>1</td><td><b>2</b></td></tr>\n    </tbody>\n  </table>\n  <table>'
    )
  })

  it('an empty cell of the file can be filled', () => {
    const out = applyHtmlEdits(withTable, [{ path: [1, 1, 0, 2, 1], tag: 'td', html: 'Không' }])
    expect(out).toBe(withTable.replace('<td>UDP</td><td></td>', '<td>UDP</td><td>Không</td>'))
  })

  it('a new row goes on its own line after a row; a new column cell on the same line as its neighbour', () => {
    const out = applyHtmlEdits(withTable, [
      { path: [1, 1, 0, 1], tag: 'tr', after: [{ tag: 'tr', html: '<td>QUIC</td><td>Có</td>' }] },
      { path: [1, 1, 0, 0, 1], tag: 'th', after: [{ tag: 'th', html: 'Ghi chú' }] },
      { path: [1, 1, 0, 1, 1], tag: 'td', after: [{ tag: 'td', html: '' }] }
    ])
    expect(out).toContain(
      '    <tr><th>Giao thức</th><th>Tin cậy</th><th>Ghi chú</th></tr>\n    <tr><td>TCP</td><td>Có</td><td></td></tr>\n    <tr><td>QUIC</td><td>Có</td></tr>\n    <tr><td>UDP</td><td></td></tr>'
    )
  })

  it('a deleted row takes its line with it; a deleted cell only itself', () => {
    const out = applyHtmlEdits(withTable, [
      { path: [1, 1, 0, 1], tag: 'tr', remove: true },
      { path: [1, 1, 0, 0, 1], tag: 'th', remove: true },
      { path: [1, 1, 0, 2, 1], tag: 'td', remove: true }
    ])
    expect(out).toContain('  <table>\n    <tr><th>Giao thức</th></tr>\n    <tr><td>UDP</td></tr>\n  </table>')
  })

  it('rows dragged into a new order (the parser added the <tbody>, it is not in the file)', () => {
    const out = applyHtmlEdits(withTable, [{ path: [1, 1, 0], tag: 'tbody', order: [{ i: 0 }, { i: 2 }, { i: 1 }] }])
    expect(out).toContain('    <tr><th>Giao thức</th><th>Tin cậy</th></tr>\n    <tr><td>UDP</td><td></td></tr>\n    <tr><td>TCP</td><td>Có</td></tr>\n  </table>')
  })

  it('new blocks before the first element of a container', () => {
    const out = applyHtmlEdits(withTable, [{ path: [1, 0], tag: 'p', before: [{ tag: 'h2', html: 'Đầu' }] }])
    expect(out).toContain('<body>\n  <h2>Đầu</h2>\n  <p>Trước</p>')
  })
})


describe('editing a block keeps what the file already had in it', () => {
  const kept = `<!doctype html>
<html>
<body>
  <p>Tải <a href="data:text/plain;base64,SGk=" download="a.txt" onclick="track()">file</a> <!-- ghi chú --> và <i class="icon"></i> xong.</p>
</body>
</html>
`
  // body = [1], p = [1,0]
  it('comments, handlers, data: links and empty icons that were there stay', () => {
    const html = 'Tải xuống <a href="data:text/plain;base64,SGk=" download="a.txt" onclick="track()">file</a> <!-- ghi chú --> và <i class="icon"></i> xong.'
    const out = applyHtmlEdits(kept, [{ path: [1, 0], tag: 'p', html }])
    expect(out).toBe(kept.replace('Tải <a', 'Tải xuống <a'))
  })

  it('the same things typed in new are still cleaned', () => {
    const html = 'Tải <a href="data:text/plain;base64,SGk=" download="a.txt" onclick="track()">file</a> <!-- ghi chú --> và <i class="icon"></i> xong. <b onclick="evil()">Mới</b><!-- lạ --><a href="data:text/html,x">y</a><i class="other"></i><a href="javascript:alert(1)">z</a>'
    const out = applyHtmlEdits(kept, [{ path: [1, 0], tag: 'p', html }])
    expect(out).toContain('xong. <b>Mới</b><a>y</a><a>z</a></p>')
    expect(out).toContain('onclick="track()"')
    expect(out).not.toContain('evil')
  })

  it('a handler of the file moved to another tag is new there', () => {
    const html = 'Tải <b onclick="track()">file</b> xong.'
    expect(applyHtmlEdits(kept, [{ path: [1, 0], tag: 'p', html }])).toContain('<p>Tải <b>file</b> xong.</p>')
  })
})

describe('changing the kind of a block of the file, dividers and quotes', () => {
  it('a paragraph becomes a heading or a quote: only its tag names change', () => {
    const src = '<html><body>\n  <p class="lead" id="x">Một <b>đoạn</b></p>\n  <h2>Tiêu đề</h2>\n</body></html>'
    expect(applyHtmlEdits(src, [{ path: [1, 0], tag: 'p', retag: 'blockquote' }])).toBe(
      '<html><body>\n  <blockquote class="lead" id="x">Một <b>đoạn</b></blockquote>\n  <h2>Tiêu đề</h2>\n</body></html>'
    )
    expect(applyHtmlEdits(src, [{ path: [1, 1], tag: 'h2', retag: 'p', html: 'Tiêu đề mới' }])).toContain('<p>Tiêu đề mới</p>')
    // With new blocks after it too.
    expect(applyHtmlEdits(src, [{ path: [1, 0], tag: 'p', retag: 'h3', after: [{ tag: 'p', html: 'Sau' }] }])).toContain(
      '<h3 class="lead" id="x">Một <b>đoạn</b></h3>\n  <p>Sau</p>'
    )
  })
  it('an upper-case tag in the file is renamed too', () => {
    expect(applyHtmlEdits('<html><body><P>A</P></body></html>', [{ path: [1, 0], tag: 'p', retag: 'h2' }])).toBe('<html><body><h2>A</h2></body></html>')
  })
  it('refuses kinds it cannot change (lists, list items, cells)', () => {
    const src = '<html><body><ul><li>A</li></ul><p>B</p></body></html>'
    expect(() => applyHtmlEdits(src, [{ path: [1, 0, 0], tag: 'li', retag: 'p' }])).toThrow(HtmlEditError)
    expect(() => applyHtmlEdits(src, [{ path: [1, 1], tag: 'p', retag: 'ul' }])).toThrow(HtmlEditError)
  })
  it('a divider and a quote added after a block', () => {
    const src = '<html><body>\n  <p>A</p>\n</body></html>'
    expect(applyHtmlEdits(src, [{ path: [1, 0], tag: 'p', after: [{ tag: 'hr', html: 'ignored <b>x</b>' }, { tag: 'blockquote', html: 'Ghi <i>chú</i>' }] }])).toBe(
      '<html><body>\n  <p>A</p>\n  <hr>\n  <blockquote>Ghi <i>chú</i></blockquote>\n</body></html>'
    )
  })
})
