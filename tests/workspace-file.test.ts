import { describe, expect, it } from 'vitest'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { cleanName, nameFromFile, parseWorkspace, readWorkspaceFile, serializeWorkspace, writeWorkspaceFile } from '../src/main/workspace-file'

describe('workspace file', () => {
  const dir = path.resolve('/work/hoc')
  const file = path.join(dir, 'Học kỳ 1.studyws')

  it('keeps paths on the same drive relative to the file, others absolute', () => {
    const other = process.platform === 'win32' ? 'Z:\\Notes' : null
    const text = serializeWorkspace(
      { name: 'Học kỳ 1', folders: [path.join(dir, 'System_Design'), ...(other ? [other] : [])], files: [path.resolve('/work/Sach/DDIA.epub')] },
      file
    )
    const json = JSON.parse(text)
    expect(json.version).toBe(1)
    expect(json.folders[0]).toBe('System_Design')
    if (other) expect(json.folders[1]).toBe('Z:/Notes')
    expect(json.files).toEqual(['../Sach/DDIA.epub'])
    // ...and reading it back gives the same absolute paths.
    expect(parseWorkspace(text, file)).toEqual({
      name: 'Học kỳ 1',
      folders: [path.join(dir, 'System_Design'), ...(other ? [other] : [])],
      files: [path.resolve('/work/Sach/DDIA.epub')]
    })
  })

  it('a workspace that moved with its folders still finds them', () => {
    const text = serializeWorkspace({ name: 'X', folders: [path.join(dir, 'A')], files: [] }, file)
    const moved = path.resolve('/elsewhere/copy/Học kỳ 1.studyws')
    expect(parseWorkspace(text, moved).folders).toEqual([path.resolve('/elsewhere/copy/A')])
  })

  it('takes its name from the file when it has none, and cleans names', () => {
    expect(parseWorkspace('{"folders":[]}', file).name).toBe('Học kỳ 1')
    expect(nameFromFile('C:\\a\\Ôn thi.STUDYWS')).toBe('Ôn thi')
    expect(cleanName('  Ôn \n thi\u0007 ')).toBe('Ôn thi')
    expect(cleanName('x'.repeat(200))).toHaveLength(80)
  })

  it('ignores junk entries and duplicates; refuses what is not a workspace', () => {
    const ws = parseWorkspace('\uFEFF{"name":"a","folders":["A","a",3,"",null],"files":"nope"}', file)
    expect(ws.folders).toHaveLength(process.platform === 'win32' ? 1 : 2)
    expect(ws.files).toEqual([])
    expect(() => parseWorkspace('not json', file)).toThrow('not-json')
    expect(() => parseWorkspace('[1,2]', file)).toThrow('not-workspace')
  })

  it('writes and reads a file on disk', async () => {
    const tmp = mkdtempSync(path.join(tmpdir(), 'ws-'))
    try {
      const f = path.join(tmp, 'Ôn tập.studyws')
      await writeWorkspaceFile(f, { name: 'Ôn tập', folders: [path.join(tmp, 'docs')], files: [] })
      expect(JSON.parse(readFileSync(f, 'utf8')).folders).toEqual(['docs'])
      expect(await readWorkspaceFile(f)).toEqual({ name: 'Ôn tập', folders: [path.join(tmp, 'docs')], files: [] })
    } finally {
      rmSync(tmp, { recursive: true, force: true })
    }
  })
})

describe('network paths in a workspace file', () => {
  it('tells paths on another computer from local ones', async () => {
    const { isNetworkPath } = await import('../src/main/workspace-file')
    expect(isNetworkPath('\\\\server\\share\\Docs')).toBe(true)
    expect(isNetworkPath('//server/share')).toBe(true)
    expect(isNetworkPath('\\\\?\\UNC\\server\\share')).toBe(true)
    expect(isNetworkPath('\\\\?\\C:\\Docs')).toBe(false)
    expect(isNetworkPath('\\\\.\\D:\\Docs')).toBe(false)
    expect(isNetworkPath('C:\\Users\\a\\Docs')).toBe(false)
    expect(isNetworkPath('/home/a/docs')).toBe(false)
  })
})
