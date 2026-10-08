import type { EngineInterface, Register } from 'claude-code'
import type { DataDir, Env, Measured, SessionFile } from './session'
import {
  MAX_FILE_BYTES,
  accountHash,
  defaultDataDirs,
  encode,
  fileName,
  hasReading,
  isRealDir,
  isSessionId,
  isWritableFile,
  merge,
  previousFile,
  reading,
  shouldWrite,
  summary,
} from './session'

const COMMAND = 'x48-usage'
// Bounds the map if a session.end is missed.
const MAX_TRACKED = 32
const NO_FOLDER = "the 48X AI Usage app hasn't set up its data folder yet, so nothing is saved"

type Tracked = {
  account: string
  name: string
  last: SessionFile | null
  /** Whether `last` has been read back from disk yet. */
  seeded: boolean
  /** Whether a data folder has been found, so the note names the file. */
  located: boolean
  note: string
  pending: Promise<void>
}

// Keyed by session id: after a /clear the process goes on under a new id with no session.start.
const tracked = new Map<string, Tracked>()
// The default folder once one passed the checks; the app makes it and the mod never does.
let found: DataDir | undefined

async function track($: EngineInterface): Promise<Tracked | undefined> {
  const id = await $.session.id()
  if (!isSessionId(id)) return undefined
  const hit = tracked.get(id)
  if (hit) {
    tracked.delete(id)
    tracked.set(id, hit)
    return hit
  }
  const home = (await $.env.get('HOME')) ?? (await $.env.get('USERPROFILE'))
  const account = await accountHash(await $.env.get('CLAUDE_CONFIG_DIR'), home)
  const name = await fileName(account, id)
  // Another dispatch may have started tracking while this one awaited.
  const known = tracked.get(id)
  if (known) return known
  const oldest = tracked.size >= MAX_TRACKED ? tracked.keys().next().value : undefined
  if (oldest !== undefined) tracked.delete(oldest)
  const session: Tracked = {
    account,
    name,
    last: null,
    seeded: false,
    located: false,
    note: 'nothing saved yet',
    pending: Promise.resolve(),
  }
  tracked.set(id, session)
  return session
}

async function folderProblem($: EngineInterface, data: DataDir): Promise<string | undefined> {
  const folders = [
    [data.dir, 'the data folder'],
    [data.sessions, 'the sessions folder'],
  ] as const
  for (const [dir, label] of folders) {
    const stat = await $.fs.stat(dir, { resolve: true }).catch(() => undefined)
    if (!isRealDir(stat, dir, data.isWindows)) {
      return `${label} is missing, a link or not a real folder, so nothing was saved`
    }
  }
  return undefined
}

/** The first default whose folders pass the checks. */
async function locate($: EngineInterface): Promise<DataDir | string> {
  if (found) return found
  const env: Env = {
    HOME: await $.env.get('HOME'),
    USERPROFILE: await $.env.get('USERPROFILE'),
    LOCALAPPDATA: await $.env.get('LOCALAPPDATA'),
    XDG_DATA_HOME: await $.env.get('XDG_DATA_HOME'),
  }
  for (const data of defaultDataDirs(env)) {
    if ((await folderProblem($, data)) === undefined) return (found = data)
  }
  return NO_FOLDER
}

type FileCheck = { problem: string } | { size: number | undefined }

/** Why the session file can't be written, or its size when it's already there. */
async function inspect($: EngineInterface, data: DataDir, session: Tracked): Promise<FileCheck> {
  const problem = await folderProblem($, data)
  if (problem) return { problem }
  const path = data.file(session.name)
  const stat = await $.fs.stat(path).catch(() => undefined)
  const entries = stat ? undefined : await $.fs.list(data.sessions).catch(() => undefined)
  if (!isWritableFile(stat, entries, session.name)) {
    return { problem: "the session file isn't a regular file, so it was left alone" }
  }
  return { size: stat?.size }
}

/** The file already on disk, after a resume or a reload, so its limits and samples carry on. */
async function seed($: EngineInterface, path: string, session: Tracked, size: number | undefined) {
  if (size === undefined || size > MAX_FILE_BYTES) return null
  const text = await $.fs.read(path).catch(() => undefined)
  return text === undefined ? null : previousFile(text, session.account)
}

async function write($: EngineInterface, session: Tracked, e: Measured | undefined) {
  const usage = e ?? (await $.session.usage())
  const now = Math.floor((await $.clock.now()) / 1000)
  const r = reading(usage, now)
  if (!hasReading(r)) return
  const data = await locate($)
  if (typeof data === 'string') {
    session.note = data
    return
  }
  session.located = true
  const file = await inspect($, data, session)
  if ('problem' in file) {
    session.note = file.problem
    return
  }
  const path = data.file(session.name)
  if (!session.seeded) {
    session.last = await seed($, path, session, file.size)
    session.seeded = true
    if (session.last) session.note = `saved ${summary(session.last)}`
  }
  const next = merge(session.last, session.account, r, now)
  if (!shouldWrite(session.last, next)) return
  const text = encode(next)
  if (text === undefined) {
    session.note = 'the file would be over 64 KiB, so it was not saved'
    return
  }
  await $.fs.write(path, text)
  session.last = next
  session.note = `saved ${summary(next)}`
}

/** With no measurement, saves what `$.session.usage()` says now. */
async function save($: EngineInterface, e?: Measured) {
  const session = await track($)
  if (!session) return
  // One write at a time per session, so an older measurement never lands after a newer one.
  session.pending = session.pending
    .then(() => write($, session, e))
    .catch(() => {
      session.note = 'the last save failed'
    })
  await session.pending
}

/** Saves once the hook has returned, so the session never waits on the disk. */
function queue($: EngineInterface, e?: Measured) {
  try {
    $.clock.after(0, () => {
      save($, e).catch(() => {})
    })
  } catch {
    // No timer, no save; the hook still passes the event on.
  }
}

// Command output already carries the plugin's name.
async function status($: EngineInterface): Promise<string> {
  const id = await $.session.id()
  const session = tracked.get(id)
  if (session) {
    // A save already under way finishes first, so the answer isn't one step behind.
    await session.pending
    return session.located ? `${session.note} (sessions/${session.name})` : session.note
  }
  return isSessionId(id) ? 'nothing measured yet' : 'this session has no usable id, so nothing is saved'
}

export const register: Register = on => {
  // Saving at start lets the app show "waiting" before the first reply.
  on('session.start', async ($, e, next) => {
    await $.command
      .register({ name: COMMAND, description: 'Show what the 48X usage mod last saved, or why it saved nothing' })
      .catch(() => undefined)
    queue($)
    return next(e)
  })

  on('session.measure', async ($, e, next) => {
    queue($, e)
    return next(e)
  })

  on('session.end', async ($, e, next) => {
    tracked.delete(e.sessionId)
    return next(e)
  })

  on('command.run', { command: COMMAND }, async $ => ({ text: await status($) })).catch(() => ({
    text: 'could not read its own state',
  }))
}
