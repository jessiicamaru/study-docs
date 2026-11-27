// Translating a selected piece of text with Google Translate (the free endpoint the Google
// Translate web widgets use; no account). Only the selected text is sent, never the file.
// Text already in the target language is translated the other way (Vietnamese <-> English).
//
// No Electron imports here (the fetch function is passed in), so this file is unit tested.

import type { TranslateResult } from '../shared/types'
import { t } from '../shared/i18n'

/** Longest text translated at once (a few paragraphs). */
export const MAX_TRANSLATE_CHARS = 5000

const ENDPOINT = 'https://translate.googleapis.com/translate_a/single?client=gtx&sl=auto&dt=t&tl='

/** The answer of the endpoint: [[[translated, original, ...], ...], null, "detected language", ...]. */
export function parseGoogle(data: unknown): { text: string; from: string } {
  if (!Array.isArray(data) || !Array.isArray(data[0])) throw new Error('bad answer')
  const text = (data[0] as unknown[])
    .map((part) => (Array.isArray(part) && typeof part[0] === 'string' ? part[0] : ''))
    .join('')
  return { text, from: typeof data[2] === 'string' ? data[2] : '' }
}

type Fetch = (url: string, init: { method: string; body: string; headers: Record<string, string>; signal: AbortSignal }) => Promise<{ ok: boolean; status: number; json: () => Promise<unknown> }>

async function ask(text: string, to: string, fetchFn: Fetch): Promise<{ text: string; from: string }> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), 15000)
  try {
    const res = await fetchFn(ENDPOINT + encodeURIComponent(to), {
      method: 'POST',
      body: new URLSearchParams({ q: text }).toString(),
      headers: { 'Content-Type': 'application/x-www-form-urlencoded;charset=UTF-8' },
      signal: controller.signal
    })
    if (res.status === 429) throw new Error(t('Google Dịch đang tạm chặn vì dịch quá nhiều trong thời gian ngắn. Hãy thử lại sau ít phút.'))
    if (!res.ok) throw new Error(t('Google Dịch không trả lời được (mã {0}). Hãy thử lại sau.', { 0: res.status }))
    return parseGoogle(await res.json())
  } catch (err) {
    if (err instanceof Error && /Google Dịch|Google Translate/.test(err.message)) throw err
    throw new Error(t('Không kết nối được Google Dịch. Hãy kiểm tra mạng rồi thử lại.'))
  } finally {
    clearTimeout(timer)
  }
}

/**
 * Translates into `to` ("vi" or "en"); text that is already in that language goes into the
 * other one, so the same button works both ways.
 */
export async function translateText(text: string, to: 'vi' | 'en', fetchFn: Fetch): Promise<TranslateResult> {
  const source = text.trim().slice(0, MAX_TRANSLATE_CHARS)
  if (!source) throw new Error(t('Chưa chọn chữ nào để dịch.'))
  let target: 'vi' | 'en' = to
  let answer = await ask(source, target, fetchFn)
  if (answer.from === target) {
    target = target === 'vi' ? 'en' : 'vi'
    answer = await ask(source, target, fetchFn)
  }
  return { text: answer.text.trim(), from: answer.from, to: target, cut: text.trim().length > MAX_TRANSLATE_CHARS }
}
