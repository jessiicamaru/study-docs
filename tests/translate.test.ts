import { describe, expect, it } from 'vitest'
import { MAX_TRANSLATE_CHARS, parseGoogle, translateText } from '../src/main/translate'

/** A fake Google Translate: answers from a table, and records what was asked. */
function fakeGoogle(answers: Record<string, { text: string; from: string }>, status = 200) {
  const calls: { to: string; q: string }[] = []
  const fetchFn = async (url: string, init: { body: string }) => {
    const to = new URL(url).searchParams.get('tl')!
    const q = new URLSearchParams(init.body).get('q')!
    calls.push({ to, q })
    const a = answers[to]
    return {
      ok: status === 200,
      status,
      json: async () => [[[a.text, q, null, null, 3]], null, a.from]
    }
  }
  return { fetchFn, calls }
}

describe('translating selected text', () => {
  it('reads the answer, sentence by sentence', () => {
    expect(parseGoogle([[['Chào các em. ', 'Hello. '], ['Bắt đầu.', 'Start.']], null, 'en'])).toEqual({ text: 'Chào các em. Bắt đầu.', from: 'en' })
    expect(() => parseGoogle({})).toThrow()
  })

  it('translates into Vietnamese, sending only the selected text by POST', async () => {
    const g = fakeGoogle({ vi: { text: 'Bộ nhớ đệm', from: 'en' } })
    expect(await translateText('  cache  ', 'vi', g.fetchFn)).toEqual({ text: 'Bộ nhớ đệm', from: 'en', to: 'vi', cut: false })
    expect(g.calls).toEqual([{ to: 'vi', q: 'cache' }])
  })

  it('text already in Vietnamese goes into English', async () => {
    const g = fakeGoogle({ vi: { text: 'bộ nhớ đệm', from: 'vi' }, en: { text: 'cache', from: 'vi' } })
    const r = await translateText('bộ nhớ đệm', 'vi', g.fetchFn)
    expect(r.to).toBe('en')
    expect(r.text).toBe('cache')
    expect(g.calls.map((c) => c.to)).toEqual(['vi', 'en'])
  })

  it('long selections are cut; errors say what happened', async () => {
    const g = fakeGoogle({ vi: { text: 'x', from: 'en' } })
    const r = await translateText('a'.repeat(MAX_TRANSLATE_CHARS + 10), 'vi', g.fetchFn)
    expect(r.cut).toBe(true)
    expect(g.calls[0].q.length).toBe(MAX_TRANSLATE_CHARS)
    await expect(translateText('   ', 'vi', g.fetchFn)).rejects.toThrow()
    await expect(translateText('hi', 'vi', fakeGoogle({}, 429).fetchFn)).rejects.toThrow(/Google Dịch/)
    await expect(translateText('hi', 'vi', async () => { throw new Error('offline') })).rejects.toThrow(/kết nối/)
  })
})
