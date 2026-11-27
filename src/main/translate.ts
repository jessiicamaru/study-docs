// Translating a selected piece of text with Google Translate (the free endpoints Google's own
// translate widgets and Chrome extension use; no account). Only the selected text is sent,
// never the file. Text already in the target language is translated the other way
// (Vietnamese <-> English).
//
// These endpoints limit how many requests one network may send; a refusal (429) can come even
// for one word when the network (school Wi-Fi, a VPN) sent many. So: translations are kept
// for the session (the same text is not asked again), a refused request is tried again after a
// moment, then on Google's second endpoint.
//
// No Electron imports here (the fetch function is passed in), so this file is unit tested.

import type { TranslateResult } from '../shared/types'
import { t } from '../shared/i18n'

/** Longest text translated at once (a few paragraphs). */
export const MAX_TRANSLATE_CHARS = 5000
/** The second endpoint takes the text in its address, so only this much goes there. */
const MAX_FALLBACK_CHARS = 1500

const PRIMARY = 'https://translate.googleapis.com/translate_a/single?client=gtx&sl=auto&dt=t&tl='
const FALLBACK = 'https://clients5.google.com/translate_a/t?client=dict-chrome-ex&sl=auto&tl='

/** The answer of the first endpoint: [[[translated, original, ...], ...], null, "detected language", ...]. */
export function parseGoogle(data: unknown): { text: string; from: string } {
  if (!Array.isArray(data) || !Array.isArray(data[0])) throw new Error('bad answer')
  const text = (data[0] as unknown[])
    .map((part) => (Array.isArray(part) && typeof part[0] === 'string' ? part[0] : ''))
    .join('')
  return { text, from: typeof data[2] === 'string' ? data[2] : '' }
}

/**
 * The answer of the second endpoint, in the shapes it has been seen in:
 * [["translated", "en"]], ["translated"], or { sentences: [{ trans }], src }.
 */
export function parseGoogleFallback(data: unknown): { text: string; from: string } {
  if (Array.isArray(data)) {
    const first = data[0]
    if (Array.isArray(first) && typeof first[0] === 'string') return { text: first[0], from: typeof first[1] === 'string' ? first[1] : '' }
    if (typeof first === 'string') return { text: first, from: '' }
  }
  if (data && typeof data === 'object' && Array.isArray((data as { sentences?: unknown }).sentences)) {
    const d = data as { sentences: { trans?: unknown }[]; src?: unknown }
    const text = d.sentences.map((s) => (typeof s.trans === 'string' ? s.trans : '')).join('')
    if (text) return { text, from: typeof d.src === 'string' ? d.src : '' }
  }
  throw new Error('bad answer')
}

export type Fetch = (
  url: string,
  init: { method: string; body?: string; headers?: Record<string, string>; signal: AbortSignal }
) => Promise<{ ok: boolean; status: number; json: () => Promise<unknown> }>

class Refused extends Error {}

async function call(fetchFn: Fetch, url: string, init: { method: string; body?: string; headers?: Record<string, string> }): Promise<unknown> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), 15000)
  try {
    const res = await fetchFn(url, { ...init, signal: controller.signal })
    if (res.status === 429 || res.status === 403) throw new Refused(String(res.status))
    if (!res.ok) throw new Error(String(res.status))
    return await res.json()
  } finally {
    clearTimeout(timer)
  }
}

const wait = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

/** Asks Google, trying again then the second endpoint when refused or unreachable. */
async function ask(text: string, to: string, fetchFn: Fetch, pause: (ms: number) => Promise<void>): Promise<{ text: string; from: string }> {
  const primary = (): Promise<{ text: string; from: string }> =>
    call(fetchFn, PRIMARY + encodeURIComponent(to), {
      method: 'POST',
      body: new URLSearchParams({ q: text }).toString(),
      headers: { 'Content-Type': 'application/x-www-form-urlencoded;charset=UTF-8' }
    }).then(parseGoogle)
  const fallback = (): Promise<{ text: string; from: string }> =>
    call(fetchFn, `${FALLBACK}${encodeURIComponent(to)}&q=${encodeURIComponent(text.slice(0, MAX_FALLBACK_CHARS))}`, { method: 'GET' }).then(parseGoogleFallback)
  let refused = false
  for (const [attempt, delay] of [[primary, 0], [primary, 900], [fallback, 300]] as const) {
    if (delay) await pause(delay)
    try {
      return await attempt()
    } catch (err) {
      if (err instanceof Refused) refused = true
    }
  }
  throw new Error(
    refused
      ? t('Google Dịch đang tạm chặn vì mạng của bạn vừa gửi nhiều yêu cầu (hay gặp với Wi-Fi chung, VPN). Đợi một lúc rồi bấm Thử lại.')
      : t('Không kết nối được Google Dịch. Hãy kiểm tra mạng rồi thử lại.')
  )
}

/** Translations already made in this session: the same text is not asked again. */
const cache = new Map<string, TranslateResult>()
const CACHE_SIZE = 300

/**
 * Translates into `to` ("vi" or "en"); text that is already in that language goes into the
 * other one, so the same button works both ways.
 */
export async function translateText(text: string, to: 'vi' | 'en', fetchFn: Fetch, pause: (ms: number) => Promise<void> = wait): Promise<TranslateResult> {
  const source = text.trim().slice(0, MAX_TRANSLATE_CHARS)
  if (!source) throw new Error(t('Chưa chọn chữ nào để dịch.'))
  const key = `${to}\n${source}`
  const known = cache.get(key)
  if (known) return known
  let target: 'vi' | 'en' = to
  let answer = await ask(source, target, fetchFn, pause)
  if (answer.from === target) {
    target = target === 'vi' ? 'en' : 'vi'
    answer = await ask(source, target, fetchFn, pause)
  }
  const result: TranslateResult = { text: answer.text.trim(), from: answer.from, to: target, cut: text.trim().length > MAX_TRANSLATE_CHARS }
  cache.set(key, result)
  if (cache.size > CACHE_SIZE) cache.delete(cache.keys().next().value!)
  return result
}

/** For tests. */
export function clearTranslateCache(): void {
  cache.clear()
}
