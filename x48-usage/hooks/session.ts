// What core's sessions.rs reads. No runtime import of 'claude-code', so Vitest loads it.

const FORMAT = 1
const APP_ID = 'com.48x.aiusage'
const SESSIONS_DIR = 'sessions'
export const MAX_FILE_BYTES = 64 * 1024
export const MAX_SAMPLES = 60
// Bounds and timings as the old statusline messenger had them, which core's reader expects.
const REFRESH_SECS = 60
const MIN_SAMPLE_GAP = 10
const RESET_MOVE = 60
const FIVE_HOURS = 5 * 3600
const RESET_BEHIND = 3600
const RESET_AHEAD = 8 * 24 * 3600
const MAX_CONTEXT_SIZE = 10_000_000
const MAX_COST_USD = 1_000_000
const MAX_SESSION_ID_BYTES = 256
// Core refuses a file with a sample or reset outside 2020 to 2100, so none is carried over.
const SANE_FROM = 1_577_836_800
const SANE_TO = 4_102_444_800

type WindowState = { used: number; resets_at: number | null; observed: number }
type ContextState = { used: number | null; size: number | null; observed: number }
export type SessionFile = {
  v: number
  account: string
  updated: number
  five_hour: WindowState | null
  seven_day: WindowState | null
  samples: [number, number][]
  context: ContextState | null
  cost_usd: number | null
}

/** The part of `$.session.usage()` and `session.measure` this mod reads. */
export type Measured = {
  rateLimits: readonly { kind: string; percentUsed: number; resetsAt?: string }[]
  context: { window: number; percent?: number }
  cost?: { usd: number }
}

type Window = { used: number; resetsAt: number | null }
export type Reading = {
  fiveHour?: Window
  sevenDay?: Window
  context?: { used: number | null; size: number | null }
  costUsd?: number
}

const finite = (n: unknown): n is number => typeof n === 'number' && Number.isFinite(n)
const percent = (n: unknown) => (finite(n) ? Math.min(100, Math.max(0, n)) : undefined)
const utf8Length = (text: string) => new TextEncoder().encode(text).length
const isUsed = (n: unknown): n is number => finite(n) && n >= 0 && n <= 100
const isTime = (n: unknown): n is number => finite(n) && Number.isInteger(n) && n >= SANE_FROM && n <= SANE_TO
const isContextSize = (n: unknown): n is number =>
  finite(n) && Number.isInteger(n) && n >= 1 && n <= MAX_CONTEXT_SIZE
const isCost = (n: unknown): n is number => finite(n) && n >= 0 && n <= MAX_COST_USD
const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)

function resetTime(iso: unknown, now: number): number | null {
  const ms = typeof iso === 'string' ? Date.parse(iso) : NaN
  if (!finite(ms)) return null
  const at = Math.floor(ms / 1000)
  return at >= now - RESET_BEHIND && at <= now + RESET_AHEAD ? at : null
}

/** Allowlist only; out-of-range values stay unknown. */
export function reading(e: Measured, now: number): Reading {
  const limits = Array.isArray(e.rateLimits) ? e.rateLimits : []
  const window = (kind: string): Window | undefined => {
    const limit = limits.find(r => r?.kind === kind)
    const used = percent(limit?.percentUsed)
    return used === undefined ? undefined : { used, resetsAt: resetTime(limit?.resetsAt, now) }
  }
  const out: Reading = {}
  const fiveHour = window('five_hour')
  const sevenDay = window('seven_day')
  if (fiveHour) out.fiveHour = fiveHour
  if (sevenDay) out.sevenDay = sevenDay
  const used = percent(e.context?.percent)
  const contextWindow = e.context?.window
  const size = isContextSize(contextWindow) ? contextWindow : null
  if (used !== undefined || size !== null) out.context = { used: used ?? null, size }
  const cost = e.cost?.usd
  if (isCost(cost)) out.costUsd = cost
  return out
}

export const hasReading = (r: Reading) => Boolean(r.fiveHour || r.sevenDay || r.context)

export function merge(previous: SessionFile | null, account: string, r: Reading, now: number): SessionFile {
  const prev = previous?.account === account ? previous : null
  const observe = (w: Window | undefined): WindowState | null =>
    w ? { used: w.used, resets_at: w.resetsAt, observed: now } : null
  const context: ContextState | null = r.context ? { ...r.context, observed: now } : (prev?.context ?? null)

  // Drops samples from a clock that has since gone backwards, and anything outside the window.
  let samples = (prev?.samples ?? []).filter(([t, used]) => t <= now && t > now - FIVE_HOURS && finite(used))
  if (r.fiveHour) {
    const oldReset = prev?.five_hour?.resets_at
    const newReset = r.fiveHour.resetsAt
    if (oldReset != null && newReset != null && Math.abs(oldReset - newReset) > RESET_MOVE) samples = []
    const last = samples[samples.length - 1]
    const age = last ? now - last[0] : Infinity
    if (!last || (last[1] !== r.fiveHour.used && age >= MIN_SAMPLE_GAP) || age >= REFRESH_SECS) {
      samples.push([now, r.fiveHour.used])
    }
    samples = samples.slice(-MAX_SAMPLES)
  }

  return {
    v: FORMAT,
    account,
    updated: now,
    five_hour: observe(r.fiveHour) ?? prev?.five_hour ?? null,
    seven_day: observe(r.sevenDay) ?? prev?.seven_day ?? null,
    samples,
    context,
    cost_usd: r.costUsd ?? prev?.cost_usd ?? null,
  }
}

/** On a change, or a minute after the last write. */
export function shouldWrite(previous: SessionFile | null, next: SessionFile): boolean {
  if (!previous) return true
  const age = next.updated - previous.updated
  const values = (f: SessionFile) =>
    JSON.stringify([f.account, f.five_hour?.used, f.five_hour?.resets_at, f.seven_day?.used,
      f.seven_day?.resets_at, f.context?.used, f.context?.size, f.samples, f.cost_usd])
  return age < 0 || age >= REFRESH_SECS || values(previous) !== values(next)
}

/** What `/x48-usage` says a write saved. */
export function summary(file: SessionFile): string {
  const limits = [
    file.five_hour && `5-hour ${file.five_hour.used}%`,
    file.seven_day && `weekly ${file.seven_day.used}%`,
  ].filter(Boolean)
  return limits.length > 0 ? limits.join(', ') : 'the context window (no plan limits reported yet)'
}

/** Undefined over core's 64 KiB limit. */
export function encode(file: SessionFile): string | undefined {
  const text = JSON.stringify(file)
  return utf8Length(text) <= MAX_FILE_BYTES ? text : undefined
}

function windowState(value: unknown): WindowState | null | undefined {
  if (value === null) return null
  if (!isObject(value)) return undefined
  const { used, resets_at, observed } = value
  if (!isUsed(used) || !(resets_at === null || isTime(resets_at)) || !isTime(observed)) return undefined
  return { used, resets_at, observed }
}

function contextState(value: unknown): ContextState | null | undefined {
  if (value === null) return null
  if (!isObject(value)) return undefined
  const { used, size, observed } = value
  if (!(used === null || isUsed(used)) || !(size === null || isContextSize(size)) || !isTime(observed)) return undefined
  return { used, size, observed }
}

function sampleRing(value: unknown): [number, number][] | undefined {
  if (!Array.isArray(value) || value.length > MAX_SAMPLES) return undefined
  const ring: [number, number][] = []
  for (const sample of value) {
    if (!Array.isArray(sample) || sample.length !== 2 || !isTime(sample[0]) || !isUsed(sample[1])) return undefined
    ring.push([sample[0], sample[1]])
  }
  return ring
}

/** A file this mod wrote for `account`, read back strictly. Anything else counts as absent. */
export function previousFile(text: string, account: string): SessionFile | null {
  if (utf8Length(text) > MAX_FILE_BYTES) return null
  let file: unknown
  try {
    file = JSON.parse(text)
  } catch {
    return null
  }
  if (!isObject(file) || file.v !== FORMAT || file.account !== account) return null
  const { updated, cost_usd } = file
  const five_hour = windowState(file.five_hour)
  const seven_day = windowState(file.seven_day)
  const context = contextState(file.context)
  const samples = sampleRing(file.samples)
  if (!isTime(updated) || !(cost_usd === null || isCost(cost_usd))) return null
  if (five_hour === undefined || seven_day === undefined || context === undefined || samples === undefined) return null
  return { v: FORMAT, account, updated, five_hour, seven_day, samples, context, cost_usd }
}

async function hex16(text: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text))
  return Array.from(new Uint8Array(digest, 0, 8), b => b.toString(16).padStart(2, '0')).join('')
}

/** Core's normalize, rule for rule. */
export function normalize(path: string): string {
  const out = path.replace(/\\/g, '/').replace(/\/{2,}/g, '/').replace(/\/+$/, '')
  return out === '' ? path : out
}

/** Core's rule: unset, empty and `<home>/.claude` all mean "default". `home` is HOME, else USERPROFILE. */
export async function accountHash(configDir: string | undefined, home: string | undefined): Promise<string> {
  const defaultDir = home ? normalize(`${home}/.claude`) : undefined
  const dir = configDir ? normalize(configDir) : undefined
  return hex16(dir !== undefined && dir !== defaultDir ? dir : 'default')
}

/** Neither the raw session id nor the config path ever reaches the disk. */
export async function fileName(account: string, sessionId: string): Promise<string> {
  return `${await hex16(`${account}\0${sessionId}`)}.json`
}

export const isSessionId = (id: unknown): id is string =>
  typeof id === 'string' && id.length > 0 && utf8Length(id) <= MAX_SESSION_ID_BYTES

export type DataDir = {
  dir: string
  sessions: string
  /** Drive paths compare without regard to case or separator, as Windows resolves them. */
  isWindows: boolean
  file: (name: string) => string
}

/** Absolute, local, no empty, . or .. part. Returns the reason otherwise. */
export function parseDataDir(option: unknown): DataDir | string {
  if (option === undefined || option === '') {
    return 'no dataDir option is set (the 48X AI Usage app sets it when it installs the mod)'
  }
  if (typeof option !== 'string') return 'the dataDir option is not a path'
  if (/[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/.test(option)) {
    return 'the dataDir option holds a control character'
  }
  const isWindows = /^[A-Za-z]:[\\/]/.test(option)
  if (!isWindows && !/^\/(?!\/)/.test(option)) return 'the dataDir option must be an absolute local path'
  let end = option.length
  while (end > 0 && (option[end - 1] === '/' || option[end - 1] === '\\')) end--
  const dir = option.slice(0, end)
  const parts = dir.split(/[\\/]/)
  if (parts.length < 2 || parts.slice(1).some(part => part === '' || part === '.' || part === '..')) {
    return 'the dataDir option must name a folder below the root, with no empty, "." or ".." parts'
  }
  const sep = isWindows && option.includes('\\') ? '\\' : '/'
  const sessions = `${dir}${sep}${SESSIONS_DIR}`
  return { dir, sessions, isWindows, file: name => `${sessions}${sep}${name}` }
}

export type Os = 'macos' | 'windows' | 'linux'
export type Env = Partial<Record<'HOME' | 'USERPROFILE' | 'LOCALAPPDATA' | 'XDG_DATA_HOME', string>>

function under(base: string | undefined, isWindows: boolean, parts: string[]): DataDir | undefined {
  if (!base) return undefined
  const parent = parseDataDir(base)
  if (typeof parent === 'string' || parent.isWindows !== isWindows) return undefined
  const data = parseDataDir([parent.dir, ...parts].join(isWindows ? '\\' : '/'))
  return typeof data === 'string' ? undefined : data
}

/**
 * Core's paths::data_dir() on `os`, from the environment alone, each value held to dataDir's rules.
 * Undefined where core would ask the OS instead, or a value isn't a safe absolute path.
 */
export function defaultDataDir(os: Os, env: Env): DataDir | undefined {
  if (os === 'macos') return under(env.HOME, false, ['Library', 'Application Support', APP_ID])
  if (os === 'linux') {
    // As dirs does: an XDG_DATA_HOME that isn't absolute is ignored.
    const xdg = env.XDG_DATA_HOME
    return xdg?.startsWith('/') ? under(xdg, false, [APP_ID]) : under(env.HOME, false, ['.local', 'share', APP_ID])
  }
  return env.LOCALAPPDATA
    ? under(env.LOCALAPPDATA, true, [APP_ID])
    : under(env.USERPROFILE, true, ['AppData', 'Local', APP_ID])
}

/** Every OS's default, as the mod can't ask which OS it's on; only the app's own folder will exist. */
export const defaultDataDirs = (env: Env): DataDir[] =>
  (['macos', 'windows', 'linux'] as const).flatMap(os => defaultDataDir(os, env) ?? [])

type Stat = { kind: 'file' | 'dir' | 'other'; isLink: boolean; realPath?: string }
type Entry = { name: string }

function samePath(real: string | undefined, path: string, isWindows: boolean): boolean {
  if (!isWindows || real === undefined) return real === path
  const fold = (p: string) => p.replace(/\\/g, '/').toLowerCase()
  return fold(real) === fold(path)
}

/** The app makes these folders; the mod writes only into one that's real at exactly this path. */
export const isRealDir = (stat: Stat | undefined, path: string, isWindows = false) =>
  stat !== undefined && stat.kind === 'dir' && !stat.isLink && samePath(stat.realPath, path, isWindows)

/** Missing, or a regular non-link file. With no stat, the listing tells missing from unreadable. */
export function isWritableFile(stat: Stat | undefined, entries: readonly Entry[] | undefined, name: string): boolean {
  if (stat) return stat.kind === 'file' && !stat.isLink
  return entries !== undefined && !entries.some(entry => entry.name === name)
}
