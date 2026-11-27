import { beforeEach, describe, expect, it } from 'vitest'
import { clearTranslateCache, MAX_TRANSLATE_CHARS, parseGoogle, parseGoogleFallback, translateText, type Fetch } from '../src/main/translate'

const noWait = async (): Promise<void> => {}

/**
 * A fake Google Translate: the first endpoint answers with `status` (or from the table), the
 * second one (clients5) with `fallbackStatus`. Records what was asked.
 */
function fakeGoogle(answers: Record<string, { text: string; from: string }>, status = 200, fallbackStatus = 200) {
  const calls: { endpoint: 'primary' | 'fallback'; to: string; q: string; method: string }[] = []
  const fetchFn: Fetch = async (url, init) => {
    const u = new URL(url)
    const fallback = u.hostname === 'clients5.google.com'
    const to = u.searchParams.get('tl')!
    const q = fallback ? u.searchParams.get('q')! : new URLSearchParams(init.body).get('q')!
    calls.push({ endpoint: fallback ? 'fallback' : 'primary', to, q, method: init.method })
    const code = fallback ? fallbackStatus : status
    const a = answers[to]
    return {
      ok: code === 200,
      status: code,
      json: async () => (fallback ? [[a.text, a.from]] : [[[a.text, q, null, null, 3]], null, a.from])
    }
  }
  return { fetchFn, calls }
}

beforeEach(clearTranslateCache)

describe('translating selected text', () => {
  it('reads both endpoints\' answers', () => {
    expect(parseGoogle([[['Chào các em. ', 'Hello. '], ['Bắt đầu.', 'Start.']], null, 'en'])).toEqual({ text: 'Chào các em. Bắt đầu.', from: 'en' })
    expect(() => parseGoogle({})).toThrow()
    expect(parseGoogleFallback([['xin chào', 'en']])).toEqual({ text: 'xin chào', from: 'en' })
    expect(parseGoogleFallback(['xin chào'])).toEqual({ text: 'xin chào', from: '' })
    expect(parseGoogleFallback({ sentences: [{ trans: 'Xin ' }, { trans: 'chào' }], src: 'en' })).toEqual({ text: 'Xin chào', from: 'en' })
    expect(() => parseGoogleFallback({})).toThrow()
  })

  it('translates into Vietnamese, sending only the selected text by POST', async () => {
    const g = fakeGoogle({ vi: { text: 'Bộ nhớ đệm', from: 'en' } })
    expect(await translateText('  cache  ', 'vi', g.fetchFn, noWait)).toEqual({ text: 'Bộ nhớ đệm', from: 'en', to: 'vi', cut: false })
    expect(g.calls).toEqual([{ endpoint: 'primary', to: 'vi', q: 'cache', method: 'POST' }])
  })

  it('the same text is not asked again', async () => {
    const g = fakeGoogle({ vi: { text: 'Bộ nhớ đệm', from: 'en' } })
    await translateText('cache', 'vi', g.fetchFn, noWait)
    await translateText(' cache ', 'vi', g.fetchFn, noWait)
    expect(g.calls.length).toBe(1)
  })

  it('text already in Vietnamese goes into English', async () => {
    const g = fakeGoogle({ vi: { text: 'bộ nhớ đệm', from: 'vi' }, en: { text: 'cache', from: 'vi' } })
    const r = await translateText('bộ nhớ đệm', 'vi', g.fetchFn, noWait)
    expect(r.to).toBe('en')
    expect(r.text).toBe('cache')
    expect(g.calls.map((c) => c.to)).toEqual(['vi', 'en'])
  })

  it('refused (429): tried again, then on the second endpoint', async () => {
    const g = fakeGoogle({ vi: { text: 'có thẩm quyền', from: 'en' } }, 429, 200)
    expect((await translateText('authoritative', 'vi', g.fetchFn, noWait)).text).toBe('có thẩm quyền')
    expect(g.calls.map((c) => c.endpoint)).toEqual(['primary', 'primary', 'fallback'])
    expect(g.calls[2].method).toBe('GET')
  })

  it('long selections are cut; errors say what happened', async () => {
    const g = fakeGoogle({ vi: { text: 'x', from: 'en' } })
    const r = await translateText('a'.repeat(MAX_TRANSLATE_CHARS + 10), 'vi', g.fetchFn, noWait)
    expect(r.cut).toBe(true)
    expect(g.calls[0].q.length).toBe(MAX_TRANSLATE_CHARS)
    await expect(translateText('   ', 'vi', g.fetchFn, noWait)).rejects.toThrow()
    await expect(translateText('hi', 'vi', fakeGoogle({}, 429, 429).fetchFn, noWait)).rejects.toThrow(/tạm chặn/)
    await expect(translateText('hi', 'vi', async () => { throw new Error('offline') }, noWait)).rejects.toThrow(/kết nối/)
  })
})
