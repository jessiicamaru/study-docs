// Inline text editing for HTML documents.
//
// 1. In edit mode the doc:// protocol serves the page with a small script appended
//    (editModeInjection). The page's own scripts are switched off with a CSP nonce, so the
//    page's DOM is exactly what the HTML parser produced from the file.
// 2. That script makes every "text block" (a paragraph, heading, list item, table cell... that
//    only contains text, inline tags and pictures) editable, and remembers its position in the
//    tree. Inside a block: typing, bold/italic/underline/strike, links, pasted pictures.
//    Enter in a paragraph or list item starts a new one right after it; nothing else in the
//    page's structure can change.
// 3. On save, the changed blocks are sent back. applyHtmlEdits parses the original file with
//    parse5 (the same spec parser algorithm the browser uses), finds each block by position,
//    and replaces only the text between its start and end tag; new paragraphs go right after
//    its end tag. Every other byte of the file stays exactly as it was. What the page sends is
//    cleaned first (sanitizeInline): only inline tags, no scripts or on…="" handlers.
//
// No Electron imports here, so this file is unit tested directly.

import { parse, parseFragment, serialize } from 'parse5'
import type { DefaultTreeAdapterMap } from 'parse5'
import type { HtmlBlockEdit } from '../shared/types'
import { t } from '../shared/i18n'
import { anchoringSource } from './view-helper'

type Node = DefaultTreeAdapterMap['node']
type Element = DefaultTreeAdapterMap['element']

const isElement = (n: Node): n is Element => 'tagName' in n

export class HtmlEditError extends Error {}

type ParentNode = DefaultTreeAdapterMap['parentNode']
type ChildNode = DefaultTreeAdapterMap['childNode']

/** Tags allowed inside an edited block (the others are taken away, their text kept). */
const INLINE_TAGS = new Set(['a', 'abbr', 'b', 'bdi', 'bdo', 'br', 'cite', 'code', 'data', 'del', 'dfn', 'em', 'i', 'img', 'ins', 'kbd', 'mark', 'q', 's', 'samp', 'small', 'span', 'strong', 'sub', 'sup', 'time', 'u', 'var', 'wbr'])

/** What a block added while editing may be. */
const NEW_BLOCK_TAGS = new Set(['p', 'li', 'h2', 'h3', 'h4', 'ul', 'ol', 'table', 'tr', 'td', 'th', 'blockquote', 'hr'])

/** Blocks of the file whose kind can change (paragraph, heading, quote): only their tag names change. */
const RETAG_TAGS = new Set(['p', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'blockquote'])

/** The cells of a row: only <td>/<th>, each cleaned like a block, on one line. */
function sanitizeCells(row: Element | undefined): string {
  if (!row) return ''
  return row.childNodes
    .filter((c): c is Element => isElement(c) && (c.tagName === 'td' || c.tagName === 'th'))
    .map((c) => `<${c.tagName}>${sanitizeInline(serialize(c))}</${c.tagName}>`)
    .join('')
}

/** The rows of a table typed while editing, sorted into header rows and body rows. */
function rowsOf(html: string): { head: string[]; body: string[] } {
  const table = parseFragment(`<table>${html}</table>`).childNodes.find(isElement)
  const head: string[] = []
  const body: string[] = []
  const walk = (el: Element, into: string[]): void => {
    for (const c of el.childNodes) {
      if (!isElement(c)) continue
      if (c.tagName === 'tr') into.push(sanitizeCells(c))
      else if (c.tagName === 'thead') walk(c, head)
      else if (c.tagName === 'tbody' || c.tagName === 'tfoot') walk(c, body)
    }
  }
  if (table) walk(table, body)
  return { head, body }
}

/** A table typed while editing: header rows in <thead>, the others in <tbody>, a row per line. */
export function sanitizeTable(html: string, indent: string): string {
  const { head, body } = rowsOf(html)
  const part = (tag: string, rows: string[]): string =>
    rows.length ? `\n${indent}  <${tag}>${rows.map((r) => `\n${indent}    <tr>${r}</tr>`).join('')}\n${indent}  </${tag}>` : ''
  return part('thead', head) + part('tbody', body)
}

/** The items of a new list, one per line: only <li>, each cleaned like a block. */
export function sanitizeList(html: string, indent: string): string {
  const items = parseFragment(html).childNodes.filter((n): n is Element => isElement(n) && n.tagName === 'li')
  return items.map((li) => `\n${indent}<li>${sanitizeInline(serialize(li))}</li>`).join('')
}

/** What a block of the file already had: kept as it was when the block is edited. */
interface Original {
  comments: Set<string>
  /** tag, attribute and value of every attribute in it. */
  attrs: Set<string>
  /** Elements left empty on purpose (an icon <i class="…"></i>): tag and attributes. */
  empties: Set<string>
}
const attrKey = (tag: string, name: string, value: string): string => `${tag}\u0000${name}\u0000${value}`
const emptyKey = (el: Element): string => [el.tagName, ...el.attrs.map((a) => `${a.name}=${a.value}`)].join('\u0000')

function originalOf(html: string): Original {
  const o: Original = { comments: new Set(), attrs: new Set(), empties: new Set() }
  const walk = (parent: ParentNode): void => {
    for (const node of parent.childNodes as ChildNode[]) {
      if (node.nodeName === '#comment' && 'data' in node) o.comments.add(node.data)
      if (!isElement(node)) continue
      for (const a of node.attrs) o.attrs.add(attrKey(node.tagName, a.name, a.value))
      if (node.childNodes.length === 0) o.empties.add(emptyKey(node))
      walk(node)
    }
  }
  walk(parseFragment(html))
  return o
}

/**
 * The inner HTML of an edited block, made safe to write: inline tags only (others are unwrapped,
 * scripts and styles dropped), no on…="" handlers, no javascript: links. Other attributes
 * (class, style, title…) are kept, so a block's own look is not lost by editing it.
 *
 * `original` is the block's inner HTML in the file. What was already there (comments, handlers,
 * data: links, empty icons) is the file's own and is kept; only what is new is cleaned.
 */
export function sanitizeInline(html: string, original?: string): string {
  const had = original ? originalOf(original) : null
  const fragment = parseFragment(html)
  const clean = (parent: ParentNode): void => {
    for (let i = 0; i < parent.childNodes.length; i++) {
      const node = parent.childNodes[i] as ChildNode
      if (node.nodeName === '#comment') {
        if (!(had && 'data' in node && had.comments.has(node.data))) parent.childNodes.splice(i--, 1)
        continue
      }
      if (!isElement(node)) continue
      const tag = node.tagName
      if (tag === 'script' || tag === 'style' || tag === 'template' || tag === 'iframe' || tag === 'object' || tag === 'embed') {
        parent.childNodes.splice(i--, 1)
        continue
      }
      if (!INLINE_TAGS.has(tag)) {
        // Keep the text, lose the tag.
        const kids = node.childNodes
        for (const k of kids) k.parentNode = parent
        parent.childNodes.splice(i, 1, ...kids)
        i--
        continue
      }
      node.attrs = node.attrs.filter((a) => {
        if (had?.attrs.has(attrKey(tag, a.name, a.value))) return true
        const name = a.name.toLowerCase()
        if (name.startsWith('on')) return false
        if (name === 'href' || name === 'src' || name === 'xlink:href' || name === 'formaction') {
          const v = a.value.replace(/[\u0000-\u0020]/g, '').toLowerCase()
          if (v.startsWith('javascript:') || v.startsWith('vbscript:')) return false
          if (v.startsWith('data:') && !(tag === 'img' && name === 'src' && v.startsWith('data:image/'))) return false
        }
        return true
      })
      clean(node)
      // Formatting left empty (bold switched off, then Enter) is not written.
      if (node.childNodes.length === 0 && !['br', 'img', 'wbr'].includes(tag) && !node.attrs.some((a) => a.name === 'id' || a.name === 'name') && !had?.empties.has(emptyKey(node))) {
        parent.childNodes.splice(i--, 1)
      }
    }
  }
  clean(fragment)
  return serialize(fragment)
}

export function applyHtmlEdits(source: string, edits: HtmlBlockEdit[]): string {
  // parse5 reports offsets into the text it parsed; keep a byte-order mark out of the way.
  const bom = source.startsWith('\uFEFF') ? '\uFEFF' : ''
  const text = bom ? source.slice(1) : source
  const doc = parse(text, { sourceCodeLocationInfo: true })
  const html = doc.childNodes.find(isElement)
  if (!html) throw new HtmlEditError(t('File HTML không có thẻ <html>.'))

  /** Indent of the line an element starts on; null when something else comes before it on that line. */
  const lineIndent = (offset: number): string | null => {
    const lineStart = text.lastIndexOf('\n', offset - 1) + 1
    const lead = text.slice(lineStart, offset)
    return /^[ \t]*$/.test(lead) ? lead : null
  }
  const indentOf = (offset: number): string => lineIndent(offset) ?? ''
  /** A paragraph, heading, list item or list typed while editing, as HTML. */
  const newBlock = (b: { tag: string; html: string }, indent: string): string => {
    if (!NEW_BLOCK_TAGS.has(b.tag)) throw new HtmlEditError(t('Không thêm được đoạn <{0}>.', { 0: String(b.tag) }))
    if (b.tag === 'ul' || b.tag === 'ol') return `<${b.tag}>${sanitizeList(b.html, `${indent}  `)}\n${indent}</${b.tag}>`
    if (b.tag === 'table') return `<table>${sanitizeTable(b.html, indent)}\n${indent}</table>`
    if (b.tag === 'tr') {
      const { head, body } = rowsOf(`<tr>${b.html}</tr>`)
      return `<tr>${head[0] ?? body[0] ?? ''}</tr>`
    }
    if (b.tag === 'hr') return '<hr>'
    return `<${b.tag}>${sanitizeInline(b.html)}</${b.tag}>`
  }

  // Every change is a piece of the file replaced by new text. Pieces never cross: a block that
  // moves (a reorder) carries its own edits inside it.
  interface Op {
    start: number
    end: number
    render: () => string
  }
  const ops: Op[] = []

  for (const edit of edits) {
    let node: Element = html
    for (const index of edit.path) {
      const child = node.childNodes.filter(isElement)[index]
      if (!child) throw new HtmlEditError(t('Không tìm thấy đoạn văn đã sửa trong file. File có thể vừa bị thay đổi.'))
      node = child
    }
    if (node.tagName !== edit.tag) {
      throw new HtmlEditError(t('Đoạn văn đã sửa không khớp với file (<{0}> ≠ <{1}>). Hãy sửa trong raw.', { 0: edit.tag, 1: node.tagName }))
    }
    const loc = node.sourceCodeLocation
    const needsTags = typeof edit.html === 'string' || !!edit.after?.length || !!edit.before?.length || !!edit.retag
    if (needsTags && (!loc?.startTag || !loc.endTag)) {
      throw new HtmlEditError(t('Thẻ <{0}> trong file không có thẻ đóng nên không sửa trực tiếp được. Hãy sửa đoạn này trong raw.', { 0: edit.tag }))
    }
    if (edit.remove) {
      // Deleted (a table row or column): the element, and its line when it is alone on it.
      if (!loc) throw new HtmlEditError(t('Không xoá được ở đây; hãy dùng Raw.'))
      let start = loc.startOffset
      let end = loc.endOffset
      const lead = lineIndent(start)
      const lineEnd = text.indexOf('\n', end)
      if (lead !== null && lineEnd >= 0 && !text.slice(end, lineEnd).trim()) {
        start -= lead.length
        end = lineEnd + 1
      }
      ops.push({ start, end, render: () => '' })
      continue
    }
    if (loc?.startTag && edit.before?.length) {
      // New blocks right before this element (nothing of the file comes before them).
      const lead = lineIndent(loc.startTag.startOffset)
      const indent = lead ?? ''
      const added = edit.before.map((b) => `${newBlock(b, indent)}${lead !== null ? `\n${indent}` : ''}`).join('')
      ops.push({ start: loc.startTag.startOffset, end: loc.startTag.startOffset, render: () => added })
    }
    if (edit.retag && loc?.startTag && loc.endTag) {
      // Another kind of block (paragraph -> heading, quote...): only the two tag names change,
      // its attributes and everything inside stay.
      const to = String(edit.retag).toLowerCase()
      if (!RETAG_TAGS.has(node.tagName) || !RETAG_TAGS.has(to)) {
        throw new HtmlEditError(t('Không đổi được <{0}> thành <{1}> ở đây; hãy dùng Raw.', { 0: node.tagName, 1: to }))
      }
      const name = node.tagName.length
      const open = loc.startTag.startOffset + 1
      const close = loc.endTag.startOffset + 2
      if (text.slice(open, open + name).toLowerCase() !== node.tagName || text.slice(close, close + name).toLowerCase() !== node.tagName) {
        throw new HtmlEditError(t('Không đổi được <{0}> thành <{1}> ở đây; hãy dùng Raw.', { 0: node.tagName, 1: to }))
      }
      ops.push({ start: open, end: open + name, render: () => to })
      ops.push({ start: close, end: close + name, render: () => to })
    }
    if (typeof edit.html === 'string' && loc?.startTag && loc.endTag) {
      const inner = sanitizeInline(edit.html, text.slice(loc.startTag.endOffset, loc.endTag.startOffset))
      ops.push({ start: loc.startTag.endOffset, end: loc.endTag.startOffset, render: () => inner })
    }
    if (edit.after?.length && loc?.startTag && loc.endTag) {
      // New paragraphs / list items right after this element, on their own lines, indented like it
      // (on the same line when the element shares its line, like the cells of a row).
      const lead = lineIndent(loc.startTag.startOffset)
      const indent = lead ?? ''
      const added = edit.after.map((b) => `${lead !== null ? `\n${indent}` : ''}${newBlock(b, indent)}`).join('')
      ops.push({ start: loc.endTag.endOffset, end: loc.endTag.endOffset, render: () => added })
    }
    if (edit.order) {
      // The children of this element in a new order (dragged), with new blocks among them.
      const kids = node.childNodes.filter(isElement)
      if (!kids.length) throw new HtmlEditError(t('Không sắp xếp lại được ở đây; hãy dùng Raw.'))
      const range = (el: Element): { start: number; end: number } => {
        const l = el.sourceCodeLocation
        if (!l) throw new HtmlEditError(t('Không sắp xếp lại được ở đây; hãy dùng Raw.'))
        return { start: l.startOffset, end: l.endOffset }
      }
      const spans = kids.map(range)
      // Only spaces and line breaks between the elements, or moving them would move text too.
      for (const n of node.childNodes) {
        if (isElement(n)) continue
        const l = n.sourceCodeLocation
        if (!l || l.startOffset < spans[0].start || l.endOffset > spans[spans.length - 1].end) continue
        if (n.nodeName !== '#text' || text.slice(l.startOffset, l.endOffset).trim()) {
          throw new HtmlEditError(t('Giữa các khối có chữ hoặc chú thích nên không sắp xếp lại được ở đây; hãy dùng Raw.'))
        }
      }
      // Children left out were deleted.
      const used = edit.order.filter((o): o is { i: number } => 'i' in o).map((o) => o.i)
      if (new Set(used).size !== used.length || used.some((i) => !Number.isInteger(i) || i < 0 || i >= kids.length)) {
        throw new HtmlEditError(t('Thứ tự mới không khớp với file. File có thể vừa bị thay đổi.'))
      }
      const indent = indentOf(spans[0].start)
      const sep = spans.length > 1 ? text.slice(spans[0].end, spans[1].start) : `\n${indent}`
      const order = edit.order
      ops.push({
        start: spans[0].start,
        end: spans[spans.length - 1].end,
        render: () => order.map((o) => ('i' in o ? emit(spans[o.i].start, spans[o.i].end) : newBlock(o, indent))).join(sep)
      })
    }
  }

  // Pieces either nest or are apart.
  for (const a of ops) {
    for (const b of ops) {
      if (a === b) continue
      const apart = a.end <= b.start || b.end <= a.start
      const nested = (a.start <= b.start && b.end <= a.end) || (b.start <= a.start && a.end <= b.end)
      if (!apart && !nested) throw new HtmlEditError(t('Các đoạn sửa chồng lên nhau.'))
    }
  }
  ops.sort((a, b) => a.start - b.start || b.end - a.end)

  /**
   * The text of [from, to) with the changes inside it. Ops are sorted (an outer piece before the
   * pieces inside it); a moved block renders its own range, so its inner edits come with it.
   */
  function emit(from: number, to: number): string {
    let out = ''
    let pos = from
    for (const op of ops) {
      if (op.start < pos || op.end > to) continue
      out += text.slice(pos, op.start) + op.render()
      pos = op.end
    }
    return out + text.slice(pos, to)
  }
  return bom + emit(0, text.length)
}

/**
 * Appended to the end of the page in edit mode. Runs with `nonce`; everything else is blocked.
 * Talks to the app only through postMessage (the iframe is sandboxed, cross-origin).
 */
export function editModeInjection(nonce: string): string {
  return `
<style data-studydocs>
  [data-sd-block] { outline: 1.5px dashed transparent; outline-offset: 3px; border-radius: 5px; cursor: text;
    transition: outline-color .15s, background-color .15s, box-shadow .2s; }
  [data-sd-block]:hover { outline-color: rgba(180, 83, 31, .38); background-color: rgba(180, 83, 31, .035); }
  [data-sd-block]:focus { outline: 2px solid rgba(180, 83, 31, .75); background-color: rgba(180, 83, 31, .05);
    box-shadow: 0 0 0 6px rgba(180, 83, 31, .12); }
  td[data-sd-block], th[data-sd-block] { outline-offset: -2px; border-radius: 0; min-width: 48px; }
  td[data-sd-block]:focus, th[data-sd-block]:focus { box-shadow: none; }
  [data-sd-block][data-sd-dirty], [data-sd-new] { box-shadow: inset 3px 0 0 rgba(47, 93, 138, .75); }
  td[data-sd-block][data-sd-new], th[data-sd-block][data-sd-new], td[data-sd-block][data-sd-dirty], th[data-sd-block][data-sd-dirty] { box-shadow: none; background-color: rgba(47, 93, 138, .08); }
  [data-sd-new]:empty::before { content: '\\200b'; }
  hr[data-sd-new] { cursor: pointer; }
  hr[data-sd-new]:hover { outline: 2px dashed rgba(194, 74, 74, .7); outline-offset: 6px; }
  [data-sd-block] img { max-width: 100%; }
  table[data-sd-new-table] { border-collapse: collapse; margin: .8em 0; }
  table[data-sd-new-table] th, table[data-sd-new-table] td { border: 1px solid rgba(128, 128, 128, .45); padding: 6px 10px; text-align: left; }
  table[data-sd-new-table] th { background: rgba(128, 128, 128, .1); }
  [data-sd-svg] { cursor: text; }
  [data-sd-svg]:hover { text-decoration: underline dotted rgba(180, 83, 31, .8); }
  [data-sd-svg][data-sd-dirty] { text-decoration: underline solid rgba(47, 93, 138, .9); }
  .sd-handle { position: fixed; z-index: 2147483646; width: 20px; height: 24px; display: none; align-items: center; justify-content: center;
    border-radius: 6px; background: #fff; color: rgba(150, 70, 25, .9); border: 1px solid rgba(180, 83, 31, .3);
    box-shadow: 0 2px 8px rgba(0, 0, 0, .12); font: 700 13px system-ui, sans-serif; letter-spacing: -2px;
    cursor: grab; user-select: none; touch-action: none; transition: background .15s, transform .15s; }
  .sd-handle:hover { background: #fdf0e7; transform: scale(1.08); }
  .sd-drop { position: fixed; z-index: 2147483646; height: 3px; border-radius: 2px; pointer-events: none; display: none;
    background: linear-gradient(90deg, rgba(180, 83, 31, .95), rgba(214, 130, 60, .8)); box-shadow: 0 0 8px rgba(180, 83, 31, .5); }
  [data-sd-dragging] { opacity: .4; }
  .sd-table-tools { position: fixed; z-index: 2147483645; display: none; gap: 2px; padding: 3px; border-radius: 9px;
    background: rgba(255, 255, 255, .96); border: 1px solid rgba(0, 0, 0, .1); box-shadow: 0 6px 20px rgba(0, 0, 0, .16);
    font: 12.5px system-ui, sans-serif; }
  .sd-table-tools button { border: none; background: transparent; color: #333; font: inherit; padding: 4px 9px; border-radius: 6px; cursor: pointer; }
  .sd-table-tools button:hover { background: rgba(180, 83, 31, .12); color: #8a3c12; }
  .sd-table-tools button.sd-danger:hover { background: rgba(194, 74, 74, .12); color: #b02a2a; }
  .sd-table-tools .sd-sep { width: 1px; margin: 3px 2px; background: rgba(0, 0, 0, .12); }
  input[data-studydocs] { position: fixed; z-index: 2147483647; font: 14px system-ui, sans-serif; padding: 2px 6px;
    border: 2px solid rgba(180, 83, 31, .9); border-radius: 4px; background: #fff; color: #111; box-shadow: 0 4px 14px rgba(0, 0, 0, .25); }
</style>
<script nonce="${nonce}" data-studydocs>
(() => {
  const HTML_NS = 'http://www.w3.org/1999/xhtml'
  const INLINE = new Set(['A','ABBR','B','BDI','BDO','BR','CITE','CODE','DATA','DEL','DFN','EM','I','IMG','INS','KBD','MARK','Q','S','SAMP','SMALL','SPAN','STRONG','SUB','SUP','TIME','U','VAR','WBR'])
  const SKIP = new Set(['SCRIPT','STYLE','NOSCRIPT','TEMPLATE','TEXTAREA','SELECT','BUTTON','INPUT','IFRAME','CANVAS','VIDEO','AUDIO','OBJECT'])
  const isOurs = (el) => el.hasAttribute('data-studydocs')
  const onlyInline = (el) => [...el.children].every((c) => c.namespaceURI === HTML_NS && INLINE.has(c.tagName) && onlyInline(c))
  const pathOf = (el) => {
    const path = []
    while (el !== document.documentElement) {
      const parent = el.parentElement
      path.unshift([...parent.children].indexOf(el))
      el = parent
    }
    return path
  }

  // A block = the outermost element that has text and only inline tags inside.
  const blocks = []
  // A blank line: a paragraph with nothing but line breaks in it (<p><br></p>).
  const isBlankLine = (el) => el.tagName === 'P' && !el.textContent.trim() && [...el.children].every((c) => c.tagName === 'BR')
  const walk = (el) => {
    for (const child of el.children) {
      if (isOurs(child) || child.namespaceURI !== HTML_NS || SKIP.has(child.tagName)) continue
      if ((child.textContent.trim() || child.tagName === 'TD' || child.tagName === 'TH' || isBlankLine(child)) && onlyInline(child)) {
        blocks.push({ el: child, path: pathOf(child), tag: child.tagName.toLowerCase(), original: child.innerHTML })
      } else {
        walk(child)
      }
    }
  }
  walk(document.body)

  // Every element of the file and its position in it, taken now: blocks may move or be added
  // later, and the file is changed by these first positions.
  const orig = new WeakMap()
  // ...and its tag in the file (a block may get another kind while editing).
  const origTag = new WeakMap()
  for (const el of document.documentElement.querySelectorAll('*')) {
    if (el.closest('[data-studydocs]')) continue
    orig.set(el, pathOf(el))
    origTag.set(el, el.tagName.toLowerCase())
  }
  const tagInFile = (el) => origTag.get(el) || el.tagName.toLowerCase()
  // Kinds a block of the file can become: only its tag name changes in the file.
  const RETAG = new Set(['P','H1','H2','H3','H4','H5','H6','BLOCKQUOTE'])
  const HR_TITLE = ${JSON.stringify(t('Đường kẻ vừa thêm: bấm để bỏ'))}
  // Containers whose children were dragged into a new order.
  const reordered = new Set()

  // Text in SVG diagrams (issue #26): <text>/<tspan> that hold only text. SVG can't be
  // contenteditable, so clicking one opens a small text box over it. Only the text between
  // its tags is written back; spaces/newlines around it in the file are kept.
  const SVG_NS = 'http://www.w3.org/2000/svg'
  const svgTexts = [...document.querySelectorAll('svg text, svg tspan')]
    .filter((el) => el.namespaceURI === SVG_NS && el.children.length === 0 && el.textContent.trim() && !el.closest('[data-studydocs]'))
    .map((el) => {
      const [, lead, , trail] = /^(\\s*)([\\s\\S]*?)(\\s*)$/.exec(el.textContent)
      return { el, path: pathOf(el), tag: el.tagName, original: el.textContent, lead, trail }
    })
  const escapeText = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')

  const send = (msg) => parent.postMessage({ source: 'studydocs', ...msg }, '*')

  // Ctrl+F while editing: the same finder as when reading. It only paints the matches, the
  // page's content is not touched.
  const anchoring = ${anchoringSource()}
  let found = []
  let foundIndex = 0
  const showFound = () => {
    anchoring.showFind(document, found, foundIndex)
    const current = found[foundIndex]
    if (current) {
      const r = current.getBoundingClientRect()
      if (r.top < 60 || r.bottom > innerHeight - 40) scrollBy({ top: r.top - innerHeight / 3, behavior: 'instant' })
    }
    send({ type: 'find-result', index: foundIndex, total: found.length })
  }
  // Paragraphs and list items started with Enter (not in the file yet). Left empty, they are not saved.
  const added = []
  const kept = (el) => el.isConnected && (el.textContent.trim() !== '' || !!el.querySelector('img'))
  // Table parts added while editing are kept even when empty (a row or column was asked for).
  const isTablePart = (el) => el.hasAttribute('data-sd-new-row') || el.hasAttribute('data-sd-new-table') || el.tagName === 'TD' || el.tagName === 'TH' || el.tagName === 'HR'
  // An empty paragraph added while editing, with text before and after it: a blank line, saved
  // as <p><br></p>. Empty ones at the end (an extra Enter) are not saved.
  const hasContent = (el) => !!el && (!el.hasAttribute('data-sd-new') ? !el.hasAttribute('data-studydocs') : kept(el) || isTablePart(el) || el.hasAttribute('data-sd-new-list'))
  const blankLine = (el) => {
    if (!el.isConnected || el.tagName !== 'P' || !el.hasAttribute('data-sd-new') || kept(el)) return false
    let before = el.previousElementSibling
    while (before && before.tagName === 'P' && before.hasAttribute('data-sd-new') && !kept(before)) before = before.previousElementSibling
    let after = el.nextElementSibling
    while (after && after.tagName === 'P' && after.hasAttribute('data-sd-new') && !kept(after)) after = after.nextElementSibling
    return hasContent(before) && hasContent(after)
  }
  const counts = (el) => el.isConnected && (isTablePart(el) || kept(el) || blankLine(el))
  // Elements of the file deleted while editing (table rows, columns, tables).
  const removed = []
  const dirtyCount = () =>
    blocks.filter((b) => b.el.isConnected && (b.el.innerHTML !== b.original || b.retag)).length + svgTexts.filter((t) => t.el.textContent !== t.original).length +
    added.filter(counts).length + reordered.size + removed.length

  let box = null
  const openBox = (t) => {
    if (box) box.blur()
    const r = t.el.getBoundingClientRect()
    const input = document.createElement('input')
    input.setAttribute('data-studydocs', '')
    input.value = t.el.textContent.trim()
    input.style.left = Math.max(4, r.left - 6) + 'px'
    input.style.top = Math.max(4, r.top + r.height / 2 - 15) + 'px'
    input.style.width = Math.max(140, r.width + 40) + 'px'
    let done = false
    const finish = (keep) => {
      if (done) return
      done = true
      if (keep && input.value.trim() !== t.el.textContent.trim()) {
        t.el.textContent = t.lead + input.value.trim() + t.trail
        t.el.toggleAttribute('data-sd-dirty', t.el.textContent !== t.original)
        send({ type: 'dirty', count: dirtyCount() })
      }
      input.remove()
      if (box === input) box = null
    }
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { e.preventDefault(); finish(true) }
      if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); finish(false) }
    })
    input.addEventListener('blur', () => finish(true))
    document.body.appendChild(input)
    box = input
    input.focus()
    input.select()
  }
  for (const t of svgTexts) {
    t.el.setAttribute('data-sd-svg', '')
    t.el.addEventListener('click', (e) => { e.preventDefault(); e.stopPropagation(); openBox(t) })
  }

  // What may happen inside a block: typing, deleting, line breaks (Shift+Enter), bold, italic,
  // underline, strike, links, undo. Pasting is handled below (plain text or a picture).
  const ALLOWED = new Set(['insertText','insertReplacementText','insertCompositionText','insertLineBreak','insertLink','deleteContentBackward','deleteContentForward','deleteContent','deleteWordBackward','deleteWordForward','deleteSoftLineBackward','deleteSoftLineForward','deleteHardLineBackward','deleteHardLineForward','deleteByCut','historyUndo','historyRedo','formatBold','formatItalic','formatUnderline','formatStrikeThrough','formatRemove'])
  const SPLITS = new Set(['P','LI','H1','H2','H3','H4','H5','H6','BLOCKQUOTE'])
  const changed = () => {
    for (const b of blocks) b.el.toggleAttribute('data-sd-dirty', b.el.innerHTML !== b.original || !!b.retag)
    send({ type: 'dirty', count: dirtyCount() })
  }
  const caretAtStart = (el) => {
    const sel = getSelection()
    if (!sel.rangeCount || !sel.isCollapsed) return false
    const r = document.createRange()
    r.selectNodeContents(el)
    r.setEnd(sel.anchorNode, sel.anchorOffset)
    return r.toString() === '' && !r.cloneContents().querySelector('img')
  }
  const placeCaret = (el, atEnd) => {
    el.focus()
    const r = document.createRange()
    r.selectNodeContents(el)
    r.collapse(!atEnd)
    getSelection().removeAllRanges()
    getSelection().addRange(r)
  }
  // The last place the caret was in a block, for the app's toolbar (which takes the focus).
  let lastRange = null
  const blockOf = (node) => {
    const el = node && (node.nodeType === 1 ? node : node.parentElement)
    return el ? el.closest('[data-sd-block]') : null
  }
  document.addEventListener('selectionchange', () => {
    const sel = getSelection()
    if (sel.rangeCount && blockOf(sel.anchorNode)) lastRange = sel.getRangeAt(0).cloneRange()
  })
  // "selectionchange" comes a moment after a click: a block that just got the focus counts at
  // once (the paragraph-type menu may be used right after clicking).
  document.addEventListener('focusin', (e) => {
    const el = blockOf(e.target)
    if (!el || (lastRange && el.contains(lastRange.startContainer))) return
    const sel = getSelection()
    if (sel.rangeCount && el.contains(sel.anchorNode)) {
      lastRange = sel.getRangeAt(0).cloneRange()
      return
    }
    const r = document.createRange()
    r.selectNodeContents(el)
    r.collapse(false)
    lastRange = r
  })
  const restore = () => {
    const el = lastRange && blockOf(lastRange.startContainer)
    if (!el || !el.isConnected) return null
    el.focus()
    getSelection().removeAllRanges()
    getSelection().addRange(lastRange)
    return el
  }
  const insertNode = (node) => {
    const el = restore()
    if (!el) return
    const r = getSelection().getRangeAt(0)
    r.deleteContents()
    // A picture is never put inside a link: right after it instead.
    const at = r.startContainer.nodeType === 1 ? r.startContainer : r.startContainer.parentElement
    const link = at && at.closest('a')
    if (link && el.contains(link)) {
      r.setStartAfter(link)
      r.collapse(true)
    }
    r.insertNode(node)
    r.setStartAfter(node)
    r.collapse(true)
    getSelection().removeAllRanges()
    getSelection().addRange(r)
    changed()
  }
  // Pictures are prepared by the app (shrunk, embedded or saved in assets/); it answers with the src.
  const pendingImages = new Map()
  let nextImage = 1
  const askImage = (file) => {
    const id = nextImage++
    pendingImages.set(id, lastRange ? lastRange.cloneRange() : null)
    send({ type: 'image', id, file })
  }


  // ---------- pasting with formatting ----------
  // Copied from a page (Chrome writes the formatting into style="" of spans), Word or Google
  // Docs: bold, italic, underline, strike, code, links, sub/superscript and marks are kept;
  // colours, fonts and sizes are not. Each block of what was copied (paragraph, heading, list
  // item) becomes a block here. Only those tags are made, so nothing else gets in.
  const PASTE_KEEP = { B: 'b', STRONG: 'b', I: 'i', EM: 'i', U: 'u', INS: 'u', S: 's', STRIKE: 's', DEL: 's', CODE: 'code', KBD: 'code', SAMP: 'code', SUB: 'sub', SUP: 'sup', MARK: 'mark' }
  const PASTE_BLOCKS = new Set(['P','DIV','H1','H2','H3','H4','H5','H6','LI','BLOCKQUOTE','PRE','TR','DT','DD','SECTION','ARTICLE','HEADER','FOOTER','FIGCAPTION','ASIDE','MAIN','NAV','DETAILS','SUMMARY','ADDRESS'])
  const PASTE_SKIP = new Set(['SCRIPT','STYLE','META','TITLE','HEAD','TEMPLATE','NOSCRIPT','BUTTON','INPUT','SELECT','TEXTAREA','IFRAME','OBJECT','EMBED','CANVAS','VIDEO','AUDIO','svg','SVG','MATH'])
  const WS = new RegExp('[' + String.fromCharCode(32, 9, 10, 13, 160) + ']+', 'g')
  const escHtml = (t) => t.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  const escAttr = (t) => escHtml(t).replace(/"/g, '&quot;')
  /** Formatting given by style="" (Chrome copies the look of a page that way). */
  const styleTags = (n) => {
    const st = n.style
    const out = []
    if (!st) return out
    const w = st.fontWeight
    if (w === 'bold' || w === 'bolder' || Number(w) >= 600) out.push('b')
    if (st.fontStyle === 'italic' || st.fontStyle === 'oblique') out.push('i')
    const deco = (st.textDecorationLine || st.textDecoration || '')
    if (deco.indexOf('underline') >= 0) out.push('u')
    if (deco.indexOf('line-through') >= 0) out.push('s')
    if (st.verticalAlign === 'super') out.push('sup')
    if (st.verticalAlign === 'sub') out.push('sub')
    return out
  }
  const safeHref = (h) => {
    const v = (h || '').trim()
    const low = v.toLowerCase()
    if (!v || low.indexOf('javascript:') === 0 || low.indexOf('vbscript:') === 0 || low.indexOf('data:') === 0) return null
    return v
  }
  /** What was copied, as blocks of clean inline HTML: [{ tag: 'p' | 'h2' | 'h3' | 'h4' | 'li', html }]. */
  const pastedBlocks = (html) => {
    const doc = new DOMParser().parseFromString(html, 'text/html')
    const out = []
    let cur = null
    const start = (tag) => {
      cur = { tag: tag, parts: [] }
      out.push(cur)
    }
    const add = (piece) => {
      if (!cur) start('p')
      cur.parts.push(piece)
    }
    const wrapped = (wrap, inner) => {
      let open = ''
      let close = ''
      for (const w of wrap) {
        if (w.indexOf('a ') === 0) {
          open += '<a href="' + escAttr(w.slice(2)) + '">'
          close = '</a>' + close
        } else {
          open += '<' + w + '>'
          close = '</' + w + '>' + close
        }
      }
      return open + inner + close
    }
    const walk = (node, wrap, pre) => {
      for (const n of node.childNodes) {
        if (n.nodeType === 3) {
          const text = pre ? n.data : n.data.replace(WS, ' ')
          if (!text || (!cur && !text.trim())) continue
          add(wrapped(wrap, escHtml(text)))
          continue
        }
        if (n.nodeType !== 1 || PASTE_SKIP.has(n.tagName)) continue
        const tag = n.tagName.toUpperCase()
        if (tag === 'BR') {
          add('<br>')
          continue
        }
        if (tag === 'IMG') {
          const src = n.getAttribute('src') || ''
          if (src.indexOf('data:image/') === 0) add('<img src="' + escAttr(src) + '" alt="' + escAttr(n.getAttribute('alt') || '') + '">')
          continue
        }
        let w = wrap.slice()
        for (const t of styleTags(n)) if (w.indexOf(t) < 0) w.push(t)
        const keep = PASTE_KEEP[tag]
        // Google Docs wraps everything in <b style="font-weight:normal">: not bold.
        const notBold = (tag === 'B' || tag === 'STRONG') && n.style && (n.style.fontWeight === 'normal' || n.style.fontWeight === '400')
        if (keep && !notBold && w.indexOf(keep) < 0) w.push(keep)
        if (tag === 'A') {
          const href = safeHref(n.getAttribute('href'))
          if (href) w = w.filter((x) => x.indexOf('a ') !== 0).concat(['a ' + href])
        }
        if (tag === 'TD' || tag === 'TH') {
          // Cells of a copied table: one line per row, cells apart.
          if (cur && cur.parts.length) add(' ')
          walk(n, w, pre)
          continue
        }
        if (PASTE_BLOCKS.has(tag)) {
          const kind = tag === 'H1' || tag === 'H2' ? 'h2' : tag === 'H3' ? 'h3' : tag === 'H4' || tag === 'H5' || tag === 'H6' ? 'h4' : tag === 'LI' ? 'li' : 'p'
          start(kind)
          walk(n, w, pre || tag === 'PRE')
          cur = null
          continue
        }
        walk(n, w, pre)
      }
    }
    walk(doc.body, [], false)
    return out
      .map((b) => ({ tag: b.tag, html: b.parts.join('').replace(/^(<br>| )+|(<br>| )+$/g, '') }))
      .filter((b) => b.html.replace(/<[^>]*>/g, '').trim() !== '' || b.html.indexOf('<img') >= 0)
  }
  /** Puts clean HTML at the caret (in the block it is in), the caret after it. */
  const insertHtml = (html) => {
    const sel = getSelection()
    if (!sel.rangeCount) return
    const range = sel.getRangeAt(0)
    range.deleteContents()
    const frag = range.createContextualFragment(html)
    const last = frag.lastChild
    range.insertNode(frag)
    if (last) {
      range.setStartAfter(last)
      range.collapse(true)
      sel.removeAllRanges()
      sel.addRange(range)
    }
  }
  /** Pastes what was copied with its formatting: the first block at the caret, the others as new blocks after this one. */
  const pasteRich = (el, html) => {
    const list = pastedBlocks(html)
    if (!list.length) return false
    if (list.length === 1 || !SPLITS.has(el.tagName)) {
      // One block, or a place that holds one only (a table cell): lines kept apart by line breaks.
      insertHtml(list.map((b) => b.html).join('<br>'))
      changed()
      return true
    }
    const sel = getSelection()
    if (!sel.rangeCount) return false
    const range = sel.getRangeAt(0)
    range.deleteContents()
    // What followed the caret goes to the end of the last pasted block.
    const tail = document.createRange()
    tail.setStart(range.endContainer, range.endOffset)
    tail.setEnd(el, el.childNodes.length)
    const rest = tail.extractContents()
    el.insertAdjacentHTML('beforeend', list[0].html)
    let prev = el
    for (const b of list.slice(1)) {
      // In a list, every block is an item; elsewhere items become paragraphs.
      const tag = el.tagName === 'LI' ? 'li' : b.tag === 'li' ? 'p' : b.tag
      const next = document.createElement(tag)
      next.innerHTML = b.html
      prev.after(next)
      wire(next, true)
      added.push(next)
      prev = next
    }
    placeCaret(prev, true)
    const caret = getSelection().getRangeAt(0).cloneRange()
    prev.appendChild(rest)
    getSelection().removeAllRanges()
    getSelection().addRange(caret)
    changed()
    return true
  }

  const wire = (el, isNew) => {
    el.setAttribute('data-sd-block', '')
    if (isNew) el.setAttribute('data-sd-new', '')
    el.contentEditable = 'true'
    el.spellcheck = false
    el.addEventListener('beforeinput', (e) => {
      if (!ALLOWED.has(e.inputType)) e.preventDefault()
    })
    el.addEventListener('paste', (e) => {
      e.preventDefault()
      const items = e.clipboardData ? [...e.clipboardData.items] : []
      const image = items.find((i) => i.kind === 'file' && i.type.indexOf('image/') === 0)
      if (image) {
        lastRange = getSelection().rangeCount ? getSelection().getRangeAt(0).cloneRange() : lastRange
        askImage(image.getAsFile())
        return
      }
      // Copied from a page, Word...: with its formatting.
      const copied = (e.clipboardData && e.clipboardData.getData('text/html')) || ''
      if (copied && pasteRich(el, copied)) return
      const text = (e.clipboardData && e.clipboardData.getData('text/plain')) || ''
      // One block = one paragraph: line breaks in pasted text become spaces.
      document.execCommand('insertText', false, text.split(String.fromCharCode(13)).join('').split(String.fromCharCode(10)).join(' '))
    })
    el.addEventListener('drop', (e) => e.preventDefault())
    el.addEventListener('keydown', (e) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault()
        send({ type: 'link' })
        return
      }
      if (e.key === 'Backspace' && isNew && caretAtStart(el)) {
        // Back into the block before: this one's text joins it.
        const prev = el.previousElementSibling
        e.preventDefault()
        if (prev && prev.hasAttribute('data-sd-block')) {
          placeCaret(prev, true)
          const r = getSelection().getRangeAt(0)
          const rest = document.createRange()
          rest.selectNodeContents(el)
          r.insertNode(rest.extractContents())
          r.collapse(true)
        }
        el.remove()
        changed()
        return
      }
      if (e.key === 'Backspace' && !isNew && isBlankLine(el) && orig.has(el)) {
        // A blank line of the file: Backspace takes it away.
        e.preventDefault()
        const prev = el.previousElementSibling
        removed.push(el)
        removedFrom.set(el, el.parentElement)
        el.remove()
        if (prev && prev.hasAttribute('data-sd-block')) placeCaret(prev, true)
        changed()
        return
      }
      if (e.key === 'Tab' && (el.tagName === 'TD' || el.tagName === 'TH')) {
        // Tab / Shift+Tab: the next / previous cell; Tab in the last cell adds a row.
        e.preventDefault()
        const table = el.closest('table')
        const cells = [...table.querySelectorAll('td, th')].filter((c) => c.closest('table') === table)
        const i = cells.indexOf(el) + (e.shiftKey ? -1 : 1)
        if (i >= 0 && i < cells.length) placeCaret(cells[i], true)
        else if (!e.shiftKey) tableAction('row-add', el)
        return
      }
      if (e.key !== 'Enter' || e.shiftKey) return
      e.preventDefault()
      if (!SPLITS.has(el.tagName) || !el.parentElement) return
      // Enter on an empty item of a new list: the list ends, a paragraph follows it.
      const list = el.parentElement
      if (isNew && el.tagName === 'LI' && !kept(el)) {
        const p = document.createElement('p')
        list.after(p)
        el.remove()
        if (list.hasAttribute('data-sd-new-list') && !list.children.length) list.remove()
        wire(p, true)
        added.push(p)
        placeCaret(p, false)
        changed()
        return
      }
      // Enter: what follows the caret goes to a new paragraph (a new item in a list).
      const sel = getSelection()
      if (!sel.rangeCount) return
      const range = sel.getRangeAt(0)
      range.deleteContents()
      const tail = document.createRange()
      tail.setStart(range.endContainer, range.endOffset)
      tail.setEnd(el, el.childNodes.length)
      const next = document.createElement(el.tagName === 'LI' ? 'li' : 'p')
      next.appendChild(tail.extractContents())
      el.after(next)
      wire(next, true)
      added.push(next)
      placeCaret(next, false)
      changed()
    })
    el.addEventListener('input', changed)
  }
  for (const b of blocks) wire(b.el, false)

  // ---------- tables ----------
  const NOTICE = {
    spans: ${JSON.stringify(t('Bảng này có ô gộp (colspan/rowspan) nên không thêm/xoá hàng, cột ở đây được; hãy dùng Raw.'))},
    lastRow: ${JSON.stringify(t('Đây là hàng cuối của bảng; dùng "Xoá bảng" nếu muốn bỏ cả bảng.'))},
    lastCol: ${JSON.stringify(t('Đây là cột cuối của bảng; dùng "Xoá bảng" nếu muốn bỏ cả bảng.'))}
  }
  const notice = (text) => send({ type: 'notice', text })
  const newCell = (tag) => {
    const c = document.createElement(tag)
    wire(c, true)
    return c
  }
  const hasSpans = (table) => [...table.querySelectorAll('td, th')].some((c) => c.closest('table') === table && (c.colSpan > 1 || c.rowSpan > 1))
  /** Gone from the page; deleted from the file on save when it was in the file. */
  const removedFrom = new Map()
  const drop = (el) => {
    if (orig.has(el)) {
      removed.push(el)
      removedFrom.set(el, el.parentElement)
    }
    el.remove()
  }
  const tableAction = (action, cell) => {
    const table = cell && cell.closest('table')
    if (!table) return
    const row = cell.parentElement
    if (action === 'table-del') {
      const after = table.nextElementSibling
      drop(table)
      hideTools()
      if (after && after.hasAttribute('data-sd-block')) placeCaret(after, false)
      changed()
      return
    }
    if (hasSpans(table)) return notice(NOTICE.spans)
    const rows = [...table.rows]
    if (action === 'row-add') {
      const tr = document.createElement('tr')
      tr.setAttribute('data-sd-new-row', '')
      for (let i = 0; i < row.cells.length; i++) tr.appendChild(newCell('td'))
      // Under a header row: the first row of the body.
      const body = row.parentElement.tagName === 'THEAD' && table.tBodies[0]
      if (body) body.insertBefore(tr, body.firstElementChild)
      else row.after(tr)
      added.push(tr)
      placeCaret(tr.cells[Math.min(cell.cellIndex, tr.cells.length - 1)], false)
    }
    if (action === 'row-del') {
      if (rows.length < 2) return notice(NOTICE.lastRow)
      const next = rows[rows.indexOf(row) + 1] || rows[rows.indexOf(row) - 1]
      drop(row)
      placeCaret(next.cells[Math.min(cell.cellIndex, next.cells.length - 1)], true)
    }
    if (action === 'col-add') {
      const at = cell.cellIndex
      let mine = null
      for (const r of rows) {
        const ref = r.cells[at]
        const c = newCell(ref && ref.tagName === 'TH' ? 'th' : 'td')
        if (ref) ref.after(c)
        else r.appendChild(c)
        added.push(c)
        if (r === row) mine = c
      }
      if (mine) placeCaret(mine, false)
    }
    if (action === 'col-del') {
      if (row.cells.length < 2) return notice(NOTICE.lastCol)
      const at = cell.cellIndex
      for (const r of rows) if (r.cells[at]) drop(r.cells[at])
      placeCaret(row.cells[Math.min(at, row.cells.length - 1)], true)
    }
    changed()
    placeTools()
  }

  // A small bar over the table the caret is in.
  const tools = document.createElement('div')
  tools.className = 'sd-table-tools'
  tools.setAttribute('data-studydocs', '')
  const TOOL_BUTTONS = [
    ['row-add', ${JSON.stringify(t('+ Hàng'))}, ${JSON.stringify(t('Thêm hàng bên dưới (Tab ở ô cuối cũng thêm hàng)'))}],
    ['col-add', ${JSON.stringify(t('+ Cột'))}, ${JSON.stringify(t('Thêm cột bên phải'))}],
    ['sep'],
    ['row-del', ${JSON.stringify(t('− Hàng'))}, ${JSON.stringify(t('Xoá hàng này'))}],
    ['col-del', ${JSON.stringify(t('− Cột'))}, ${JSON.stringify(t('Xoá cột này'))}],
    ['sep'],
    ['table-del', ${JSON.stringify(t('Xoá bảng'))}, ${JSON.stringify(t('Xoá cả bảng'))}]
  ]
  for (const [action, label, title] of TOOL_BUTTONS) {
    if (action === 'sep') {
      const sep = document.createElement('span')
      sep.className = 'sd-sep'
      tools.appendChild(sep)
      continue
    }
    const b = document.createElement('button')
    b.type = 'button'
    b.textContent = label
    b.title = title
    b.setAttribute('data-action', action)
    if (action === 'table-del') b.className = 'sd-danger'
    // Keep the caret where it is: the action runs on the cell it is in.
    b.addEventListener('mousedown', (e) => e.preventDefault())
    b.addEventListener('click', () => tableAction(action, toolCell))
    tools.appendChild(b)
  }
  document.body.appendChild(tools)
  let toolCell = null
  const hideTools = () => {
    toolCell = null
    tools.style.display = 'none'
  }
  const placeTools = () => {
    if (!toolCell || !toolCell.isConnected) return hideTools()
    const table = toolCell.closest('table')
    const r = table.getBoundingClientRect()
    tools.style.display = 'flex'
    const h = tools.offsetHeight || 30
    // At the table's right end, out of the way of the drag handle on the left.
    const w = tools.offsetWidth
    tools.style.left = Math.max(4, Math.min(innerWidth - w - 8, r.right - w >= r.left ? r.right - w : r.left)) + 'px'
    tools.style.top = (r.top - h - 6 >= 4 ? r.top - h - 6 : r.bottom + 6) + 'px'
  }
  document.addEventListener('selectionchange', () => {
    const sel = getSelection()
    const el = sel.rangeCount ? blockOf(sel.anchorNode) : null
    const cell = el && (el.tagName === 'TD' || el.tagName === 'TH') ? el : null
    if (cell) {
      toolCell = cell
      placeTools()
    } else if (document.activeElement && !tools.contains(document.activeElement)) hideTools()
  })
  addEventListener('scroll', () => toolCell && placeTools(), { passive: true })

  /** A new table (a header row and two rows, two columns) after the block the caret is in. */
  const insertTable = () => {
    const el = restore()
    if (!el) return
    let at = el
    if (el.tagName === 'LI') at = el.parentElement
    const inTable = el.closest('table')
    if (inTable) at = inTable
    const table = document.createElement('table')
    table.setAttribute('data-sd-new-table', '')
    const head = document.createElement('thead')
    const body = document.createElement('tbody')
    table.append(head, body)
    for (let r = 0; r < 3; r++) {
      const tr = document.createElement('tr')
      for (let c = 0; c < 2; c++) tr.appendChild(newCell(r === 0 ? 'th' : 'td'))
      ;(r === 0 ? head : body).appendChild(tr)
    }
    // A new empty paragraph becomes the table; otherwise it goes after the block.
    if (at === el && el.hasAttribute('data-sd-new') && !kept(el) && el.tagName !== 'TD' && el.tagName !== 'TH') el.replaceWith(table)
    else at.after(table)
    added.push(table)
    placeCaret(table.rows[0].cells[0], false)
    changed()
  }

  // ---------- dragging blocks into a new order ----------
  // A handle shows at the left of the block under the mouse (a paragraph, heading, list item,
  // list, table, code…). Dragging it moves the block among its neighbours (same container).
  const handle = document.createElement('div')
  handle.className = 'sd-handle'
  handle.setAttribute('data-studydocs', '')
  handle.title = ${JSON.stringify(t('Kéo để đổi chỗ'))}
  handle.textContent = String.fromCharCode(8942, 8942)
  const dropLine = document.createElement('div')
  dropLine.className = 'sd-drop'
  dropLine.setAttribute('data-studydocs', '')
  document.body.append(handle, dropLine)
  const MOVABLE_TAGS = new Set(['P','LI','H1','H2','H3','H4','H5','H6','UL','OL','TABLE','TR','PRE','BLOCKQUOTE','FIGURE','IMG','HR','DL','DETAILS','SECTION','ARTICLE','DIV','ASIDE'])
  const siblingsOf = (el) => [...el.parentElement.children].filter((c) => !c.closest('[data-studydocs]') && c.namespaceURI === HTML_NS)
  /** The block to drag for an element under the mouse: itself or an ancestor whose siblings hold text blocks. */
  const movableFrom = (target) => {
    for (let el = target; el && el !== document.body && el !== document.documentElement; el = el.parentElement) {
      if (el.closest('[data-studydocs]') || el.namespaceURI !== HTML_NS) return null
      if (!MOVABLE_TAGS.has(el.tagName) || !el.parentElement || el.parentElement.hasAttribute('data-sd-block')) continue
      if (el.parentElement !== document.body && !orig.has(el.parentElement)) continue
      if (siblingsOf(el).length > 1) return el
    }
    return null
  }
  let hovered = null
  let dragging = null
  let dropBefore = undefined
  const placeHandle = () => {
    if (!hovered || dragging) return
    const r = hovered.getBoundingClientRect()
    handle.style.display = 'flex'
    handle.style.left = Math.max(2, r.left - 24) + 'px'
    handle.style.top = (r.top + Math.min(r.height, 28) / 2 - 11) + 'px'
  }
  // The handle stays while the mouse travels from the block to it (the strip on the block's
  // left), and a moment longer before it goes.
  let hideTimer = 0
  const keepHandle = () => {
    clearTimeout(hideTimer)
    hideTimer = 0
  }
  const towardHandle = (e) => {
    if (!hovered || handle.style.display !== 'flex') return false
    const r = hovered.getBoundingClientRect()
    const left = parseFloat(handle.style.left) - 8
    return e.clientX >= left && e.clientX <= r.left + 12 && e.clientY >= r.top - 6 && e.clientY <= r.bottom + 6
  }
  document.addEventListener('mousemove', (e) => {
    if (dragging) return
    if (e.target === handle || towardHandle(e)) return keepHandle()
    const el = movableFrom(e.target)
    if (el) {
      keepHandle()
      hovered = el
      placeHandle()
    } else if (hovered && !hideTimer) {
      hideTimer = setTimeout(() => {
        hideTimer = 0
        hovered = null
        handle.style.display = 'none'
      }, 450)
    }
  })
  addEventListener('scroll', placeHandle, { passive: true })
  handle.addEventListener('pointerdown', (e) => {
    if (!hovered) return
    e.preventDefault()
    dragging = hovered
    dragging.setAttribute('data-sd-dragging', '')
    handle.setPointerCapture(e.pointerId)
    handle.style.cursor = 'grabbing'
  })
  handle.addEventListener('pointermove', (e) => {
    if (!dragging) return
    // Where it would go: before the first neighbour whose middle is below the pointer.
    const others = siblingsOf(dragging).filter((c) => c !== dragging)
    dropBefore = null
    for (const c of others) {
      const r = c.getBoundingClientRect()
      if (e.clientY < r.top + r.height / 2) {
        dropBefore = c
        break
      }
    }
    const ref = dropBefore || others[others.length - 1]
    if (!ref) return
    const r = ref.getBoundingClientRect()
    const pr = dragging.parentElement.getBoundingClientRect()
    dropLine.style.display = 'block'
    dropLine.style.left = Math.max(0, pr.left) + 'px'
    dropLine.style.width = Math.max(40, pr.width) + 'px'
    dropLine.style.top = (dropBefore ? r.top - 3 : r.bottom + 1) + 'px'
  })
  const endDrag = (apply) => {
    if (!dragging) return
    const el = dragging
    dragging = null
    el.removeAttribute('data-sd-dragging')
    dropLine.style.display = 'none'
    handle.style.cursor = 'grab'
    if (apply && dropBefore !== undefined) {
      const parent = el.parentElement
      const before = el.nextElementSibling
      if (dropBefore === null) {
        // After the last neighbour: before our own nodes at the end of <body>, if any.
        const ours = [...parent.children].find((c) => c.closest('[data-studydocs]'))
        parent.insertBefore(el, ours || null)
      } else if (dropBefore !== el) parent.insertBefore(el, dropBefore)
      if (el.nextElementSibling !== before) {
        reordered.add(parent)
        changed()
      }
    }
    dropBefore = undefined
    placeHandle()
  }
  handle.addEventListener('pointerup', () => endDrag(true))
  handle.addEventListener('pointercancel', () => endDrag(false))
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && dragging) {
      e.stopPropagation()
      endDrag(false)
    }
  }, true)
  // Links inside editable text should not navigate while editing.
  document.addEventListener('click', (e) => { if (e.target.closest && e.target.closest('a')) e.preventDefault() }, true)
  // Ctrl+S inside the page saves too.
  document.addEventListener('keydown', (e) => {
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') { e.preventDefault(); send({ type: 'save' }) }
    if (e.key === 'Escape') send({ type: 'cancel' })
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'f') { e.preventDefault(); send({ type: 'key', key: 'ctrl+f' }) }
  }, true)

  window.addEventListener('message', (e) => {
    if (e.source !== parent || !e.data || e.data.source !== 'studydocs-app') return
    if (e.data.type === 'find') {
      found = anchoring.findAll(document.body, e.data.query)
      foundIndex = 0
      showFound()
    }
    if (e.data.type === 'find-step' && found.length) {
      foundIndex = (foundIndex + e.data.dir + found.length) % found.length
      showFound()
    }
    if (e.data.type === 'find-clear') {
      found = []
      anchoring.showFind(document, [], 0)
    }
    if (e.data.type === 'format') {
      if (restore()) document.execCommand(e.data.cmd, false, e.data.value)
      changed()
    }
    // Paragraph type (heading, list, quote…). Blocks added while editing can become anything;
    // the page's own paragraphs, headings and quotes can become one another (lists: in Raw).
    if (e.data.type === 'insert-table') insertTable()
    if (e.data.type === 'block') {
      const el = restore()
      if (!el) return
      if (el.tagName === 'TD' || el.tagName === 'TH') return
      const inNewList = el.tagName === 'LI' && el.parentElement.hasAttribute('data-sd-new-list')
      if (!el.hasAttribute('data-sd-new')) {
        // A block of the file: a paragraph, heading or quote can become another of these.
        const b = blocks.find((x) => x.el === el)
        const to = String(e.data.tag).toUpperCase()
        if (!b || !RETAG.has(el.tagName) || !RETAG.has(to)) {
          send({ type: 'block-refused' })
          return
        }
        if (el.tagName === to) return
        const next = document.createElement(to.toLowerCase())
        for (const a of [...el.attributes]) next.setAttribute(a.name, a.value)
        while (el.firstChild) next.appendChild(el.firstChild)
        el.replaceWith(next)
        wire(next, false)
        orig.set(next, orig.get(el))
        origTag.set(next, tagInFile(el))
        b.el = next
        b.retag = to.toLowerCase() === b.tag ? null : to.toLowerCase()
        placeCaret(next, true)
        changed()
        return
      }
      const tag = e.data.tag
      const toList = tag === 'ul' || tag === 'ol'
      // An item added to one of the page's lists already is a list item.
      if (el.tagName === 'LI' && !inNewList && toList) return
      if (inNewList && toList) {
        // Bullets <-> numbers: the whole new list changes.
        const old = el.parentElement
        const list = document.createElement(tag)
        list.setAttribute('data-sd-new-list', '')
        while (old.firstChild) list.appendChild(old.firstChild)
        old.replaceWith(list)
        added.push(list)
        placeCaret(el, true)
        changed()
        return
      }
      let next
      if (toList) {
        next = document.createElement(tag)
        next.setAttribute('data-sd-new-list', '')
        const li = document.createElement('li')
        while (el.firstChild) li.appendChild(el.firstChild)
        next.appendChild(li)
        wire(li, true)
        added.push(li)
      } else {
        next = document.createElement(tag)
        while (el.firstChild) next.appendChild(el.firstChild)
        wire(next, true)
      }
      if (el.tagName === 'LI') {
        // An item becomes a paragraph or heading: it leaves the list, right after it.
        const list = el.parentElement
        list.after(next)
        el.remove()
        if (list.hasAttribute('data-sd-new-list') && !list.children.length) list.remove()
      } else {
        el.replaceWith(next)
      }
      added.push(next)
      placeCaret(toList ? next.firstChild : next, true)
      changed()
    }
    if (e.data.type === 'insert-hr') {
      // A divider after the block being edited (after its list or table), and a paragraph after it.
      const el = restore()
      if (!el) return
      let at = el
      if (el.tagName === 'LI') at = el.parentElement
      if (el.tagName === 'TD' || el.tagName === 'TH') at = el.closest('table')
      const hr = document.createElement('hr')
      hr.setAttribute('data-sd-new', '')
      hr.title = HR_TITLE
      hr.addEventListener('click', () => {
        hr.remove()
        changed()
      })
      at.after(hr)
      added.push(hr)
      const p = document.createElement('p')
      hr.after(p)
      wire(p, true)
      added.push(p)
      placeCaret(p, false)
      changed()
    }
    if (e.data.type === 'insert-image' && e.data.src) {
      const img = document.createElement('img')
      img.src = e.data.src
      img.alt = ''
      insertNode(img)
    }
    if (e.data.type === 'image-src') {
      const range = pendingImages.get(e.data.id)
      pendingImages.delete(e.data.id)
      if (e.data.src) {
        if (range) lastRange = range
        const img = document.createElement('img')
        img.src = e.data.src
        img.alt = ''
        insertNode(img)
      }
    }
    if (e.data.type === 'collect') {
      if (box) box.blur() // a text box still open counts too
      // Chrome puts no-break spaces next to formatting it just typed ("<b>a</b>&nbsp;b");
      // between two words they are plain spaces. Blocks that had them on purpose keep them.
      const fixSpaces = (html) => {
        const parts = html.split('&nbsp;')
        let out = parts[0]
        for (let i = 1; i < parts.length; i++) {
          const before = out.slice(-1)
          const after = parts[i].slice(0, 1)
          out += (before && after && before !== ' ' && after !== ' ' ? ' ' : '&nbsp;') + parts[i]
        }
        return out
      }
      const htmlOf = (b) => (b.original.indexOf('&nbsp;') >= 0 ? b.el.innerHTML : fixSpaces(b.el.innerHTML))
      const edits = blocks
        .filter((b) => b.el.isConnected && (b.el.innerHTML !== b.original || b.retag))
        .map((b) => {
          const edit = { path: b.path, tag: b.tag }
          if (b.el.innerHTML !== b.original) edit.html = htmlOf(b)
          if (b.retag) edit.retag = b.retag
          return edit
        })
      // New paragraphs, headings and lists belong after the nearest block of the file before them.
      const isNewNode = (n) => n.hasAttribute('data-sd-new') || n.hasAttribute('data-sd-new-list') || n.hasAttribute('data-sd-new-row') || n.hasAttribute('data-sd-new-table')
      const cellsOf = (tr) => [...tr.cells].map((c) => '<' + c.tagName.toLowerCase() + '>' + fixSpaces(c.innerHTML) + '</' + c.tagName.toLowerCase() + '>').join('')
      /** A block added while editing, as { tag, html }; null when left empty. */
      const newItem = (el) => {
        if (el.hasAttribute('data-sd-new-list')) {
          const items = [...el.children].filter((li) => kept(li))
          return items.length ? { tag: el.tagName.toLowerCase(), html: items.map((li) => '<li>' + fixSpaces(li.innerHTML) + '</li>').join('') } : null
        }
        if (el.hasAttribute('data-sd-new-table')) {
          const part = (sec) => '<' + sec.tagName.toLowerCase() + '>' + [...sec.rows].map((tr) => '<tr>' + cellsOf(tr) + '</tr>').join('') + '</' + sec.tagName.toLowerCase() + '>'
          return { tag: 'table', html: [...el.children].filter((c) => c.tagName === 'THEAD' || c.tagName === 'TBODY').map(part).join('') }
        }
        if (el.hasAttribute('data-sd-new-row')) return { tag: 'tr', html: cellsOf(el) }
        if (el.tagName === 'HR') return { tag: 'hr', html: '' }
        if (blankLine(el)) return { tag: 'p', html: '<br>' }
        if (el.tagName === 'TD' || el.tagName === 'TH') return { tag: el.tagName.toLowerCase(), html: fixSpaces(el.innerHTML) }
        return kept(el) ? { tag: el.tagName.toLowerCase(), html: fixSpaces(el.innerHTML) } : null
      }
      /** The edit of an element of the file (by its first position), made when needed. */
      const editOf = (el) => {
        const path = orig.get(el)
        let edit = edits.find((x) => x.path.join() === path.join())
        if (!edit) edits.push((edit = { path, tag: tagInFile(el) }))
        return edit
      }
      // Containers in a new order: all their children, in order (new blocks included).
      for (const parent of reordered) {
        if (!parent.isConnected || !orig.has(parent)) continue
        const order = []
        for (const child of parent.children) {
          if (child.closest('[data-studydocs]')) continue
          if (orig.has(child)) order.push({ i: orig.get(child)[orig.get(child).length - 1] })
          else {
            const item = newItem(child)
            if (item) order.push(item)
          }
        }
        editOf(parent).order = order
      }
      // Other new blocks go right after the nearest element of the file before them (or before
      // the first one after them). Those inside other new blocks come with them.
      const tops = [...new Set(added)].filter((el) => el.isConnected && orig.has(el.parentElement) && !reordered.has(el.parentElement))
      tops.sort((a, b) => (a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING ? -1 : 1))
      const fromFile = (n) => n && !isNewNode(n) && !n.closest('[data-studydocs]') && orig.has(n)
      for (const el of tops) {
        const item = newItem(el)
        if (!item) continue
        let anchor = el.previousElementSibling
        while (anchor && !fromFile(anchor)) anchor = anchor.previousElementSibling
        if (anchor) {
          const edit = editOf(anchor)
          ;(edit.after = edit.after || []).push(item)
          continue
        }
        let next = el.nextElementSibling
        while (next && !fromFile(next)) next = next.nextElementSibling
        if (next) {
          const edit = editOf(next)
          ;(edit.before = edit.before || []).push(item)
        }
      }
      // Deleted rows, columns and tables (in a reordered container they are left out of its order).
      for (const el of removed) {
        if (reordered.has(removedFrom.get(el)) || removed.some((r) => r !== el && r.contains && r.contains(el))) continue
        edits.push({ path: orig.get(el), tag: tagInFile(el), remove: true })
      }
      for (const t of svgTexts) {
        if (t.el.textContent !== t.original) edits.push({ path: t.path, tag: t.tag, html: escapeText(t.el.textContent) })
      }
      send({ type: 'edits', id: e.data.id, edits })
    }
  })
  send({ type: 'ready', blocks: blocks.length + svgTexts.length })
})()
</script>`
}
