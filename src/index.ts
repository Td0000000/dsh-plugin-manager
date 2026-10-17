/**
 * Host backend for DSH Plugin Manager:
 * Scans installed DSH plugins, manages persistent groups in td-plugin-groups.json,
 * toggles plugins via cordis.patch.yml (triggers DSH live HMR),
 * and handles plugin uninstallation.
 */

import { existsSync, readFileSync, writeFileSync, readdirSync, renameSync, rmSync, statSync } from 'node:fs'
import { basename, dirname, join, resolve } from 'node:path'
import { homedir } from 'node:os'
import { spawnSync } from 'node:child_process'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { isMap, isScalar, isSeq, parseDocument, parse as parseYaml, stringify as stringifyYaml } from 'yaml'
import type { YAMLMap, YAMLSeq } from 'yaml'

export interface Context {
  webServer: {
    register: (opts: {
      kind: 'prefix' | 'exact'
      path: string
      handler: (req: IncomingMessage, res: ServerResponse) => void | Promise<void>
    }) => () => void
  }
  webRuntime?: {
    trustedHosts?: string[]
  }
  effect: (fn: () => void | (() => void), name?: string) => void
  /** Read a service without the inject requirement (undefined when absent). */
  get?: (name: string, strict?: boolean) => any
  logger?: {
    info: (...args: any[]) => void
    warn: (...args: any[]) => void
    error: (...args: any[]) => void
  }
}

export interface PluginInfo {
  id: string
  name: string
  version: string
  description: string
  author?: string
  homepage?: string
  disabled: boolean
  system: boolean
  removable: boolean
  /** `engines.dsh` declared by the plugin package, when it declares one. */
  enginesDsh?: string
  /**
   * Whether the running DSH version accepts `engines.dsh`: `true`/`false` when
   * the official plugin manager could answer, `null` when unknown.
   */
  compatible?: boolean | null
}

export interface PluginGroupsData {
  groups: Record<string, string[]>
  groupOrder: string[]
}

const PROTECTED_PATTERNS = [
  /^cordis:/u,
  /^@cordisjs\//u,
  /^@deepseek-ai\//u,
]

export function isSystemPlugin(nameOrId: string): boolean {
  return PROTECTED_PATTERNS.some((re) => re.test(nameOrId))
}

/**
 * Resolve the profile this plugin manages.
 *
 * DSH 0.1.x was launched with `--profile <name>`, so the original probe read
 * that flag and otherwise assumed `web`. The 0.2.x launchers (including the
 * Electron Desktop Host) instead pass the profile **directory** positionally
 * (`<dshRoot> <profileDir> <runtimeDir> <pnpm> <bin>`), so the old default sent
 * every read and write to a non-existent `profiles/web` directory. Accept the
 * explicit argument, the `--profile` flag, a positional `…/profiles/<name>`
 * path, `DSH_PROFILE`, then fall back to the only installed profile.
 */
export function resolveProfileDir(customProfile?: string): { profile: string; dir: string } {
  const dshHome = process.env.DSH_HOME || join(homedir(), '.dsh')
  const profilesRoot = join(dshHome, 'profiles')

  /** Recognize an absolute/relative directory whose parent directory is `profiles`. */
  const fromProfileDir = (candidate: string): { profile: string; dir: string } | undefined => {
    let resolved: string
    try {
      resolved = resolve(candidate)
      if (!existsSync(resolved) || !statSync(resolved).isDirectory()) return undefined
    } catch {
      return undefined
    }
    if (basename(dirname(resolved)).toLowerCase() !== 'profiles') return undefined
    const profile = basename(resolved)
    if (!profile || profile === '.' || profile === '..') return undefined
    return { profile, dir: resolved }
  }

  if (customProfile) {
    return fromProfileDir(customProfile) ?? { profile: customProfile, dir: join(profilesRoot, customProfile) }
  }

  const argv = process.argv

  // `dsh --profile <name>` (CLI launched profiles).
  const idx = argv.indexOf('--profile')
  if (idx !== -1 && idx + 1 < argv.length) {
    const val = argv[idx + 1]
    if (val && !val.startsWith('-')) {
      return fromProfileDir(val) ?? { profile: val, dir: join(profilesRoot, val) }
    }
  }

  // DSH 0.2 Host launchers pass the profile directory among the positional args.
  for (const arg of argv) {
    if (!arg || arg.startsWith('-')) continue
    const hit = fromProfileDir(arg)
    if (hit) return hit
  }

  const envProfile = process.env.DSH_PROFILE
  if (envProfile) {
    return fromProfileDir(envProfile) ?? { profile: envProfile, dir: join(profilesRoot, envProfile) }
  }

  // No explicit signal: use the only installed profile, preferring shipped names.
  try {
    const names = readdirSync(profilesRoot, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && !entry.name.startsWith('.'))
      .map((entry) => entry.name)
    if (names.length === 1) return { profile: names[0], dir: join(profilesRoot, names[0]) }
    for (const preferred of ['desktop', 'web']) {
      if (names.includes(preferred)) return { profile: preferred, dir: join(profilesRoot, preferred) }
    }
  } catch {}

  return { profile: 'web', dir: join(profilesRoot, 'web') }
}

function getGroupsFilePath(profileDir: string): string {
  return join(profileDir, 'td-plugin-groups.json')
}

export function readGroups(profileDir: string): PluginGroupsData {
  const file = getGroupsFilePath(profileDir)
  if (!existsSync(file)) {
    return { groups: {}, groupOrder: [] }
  }
  try {
    const content = readFileSync(file, 'utf-8')
    const parsed = JSON.parse(content)
    return {
      groups: parsed?.groups && typeof parsed.groups === 'object' ? parsed.groups : {},
      groupOrder: Array.isArray(parsed?.groupOrder) ? parsed.groupOrder : [],
    }
  } catch {
    return { groups: {}, groupOrder: [] }
  }
}

export function saveGroups(profileDir: string, data: PluginGroupsData): void {
  const file = getGroupsFilePath(profileDir)
  writeFileSync(file, JSON.stringify(data, null, 2), 'utf-8')
}

function getPatchFilePath(profileDir: string): string {
  return join(profileDir, 'cordis.patch.yml')
}

interface PatchEntry {
  id?: string
  name?: string
  disabled?: boolean
  insert?: PatchEntry[]
  [key: string]: any
}

export function readPatchYaml(profileDir: string): PatchEntry[] {
  const patchFile = getPatchFilePath(profileDir)
  if (!existsSync(patchFile)) {
    return []
  }
  try {
    const raw = readFileSync(patchFile, 'utf-8')
    const parsed = parseYaml(raw, { customTags: [JS_TAG] })
    return Array.isArray(parsed) ? (parsed as PatchEntry[]) : []
  } catch {
    return []
  }
}

export function writePatchYaml(profileDir: string, patches: PatchEntry[]): void {
  const patchFile = getPatchFilePath(profileDir)
  const yamlStr = stringifyYaml(patches)
  writeFileSync(patchFile, yamlStr, 'utf-8')
}

/**
 * `!!js` is the Loader's expression tag. Declaring it as a known string tag
 * keeps `parseDocument` quiet and lets the Document round-trip the tag instead
 * of folding or re-quoting the expression.
 */
const JS_TAG = { tag: 'tag:yaml.org,2002:js', resolve: (value: string) => value }

type PatchDocument = ReturnType<typeof parseDocument>

function writeFileAtomic(file: string, content: string): void {
  const tmp = `${file}.tmp-${process.pid}-${Date.now()}`
  writeFileSync(tmp, content, 'utf-8')
  renameSync(tmp, file)
}

/**
 * Load the profile patch as a YAML Document so edits stay local: comments,
 * unrelated entries, key order, and `!!js` tags are preserved instead of being
 * rebuilt by a whole-file `stringify`. Returns an error instead of silently
 * replacing a file we could not understand.
 */
function loadPatchDocument(profileDir: string): { doc: PatchDocument } | { error: string } {
  const patchFile = getPatchFilePath(profileDir)
  let raw = '[]\n'
  if (existsSync(patchFile)) {
    raw = readFileSync(patchFile, 'utf-8')
  }
  const doc = parseDocument(raw, { customTags: [JS_TAG] })
  if (doc.errors.length > 0) {
    return { error: `cordis.patch.yml 解析失败，已保留原文件未修改：${doc.errors[0].message}` }
  }
  if (doc.contents === null) {
    // Empty file: start an empty patch list on the same document.
    doc.contents = doc.createNode([]) as any
  }
  if (!isSeq(doc.contents)) {
    return { error: 'cordis.patch.yml 顶层必须是 YAML 数组，已保留原文件未修改' }
  }
  return { doc }
}

function savePatchDocument(profileDir: string, doc: PatchDocument): void {
  const text = doc.toString({ lineWidth: 0 })
  writeFileAtomic(getPatchFilePath(profileDir), text.endsWith('\n') ? text : `${text}\n`)
}

function patchSeqOf(doc: PatchDocument): YAMLSeq {
  return doc.contents as YAMLSeq
}

function scalarText(node: unknown): string | undefined {
  if (!isScalar(node)) return undefined
  const value = (node as { value?: unknown }).value
  return typeof value === 'string' ? value : undefined
}

/** `YAMLMap.get` unwraps scalars by default; keep the node to read its text. */
function mapText(map: YAMLMap, key: string): string | undefined {
  return scalarText(map.get(key, true))
}

interface PatchMapRef {
  map: YAMLMap
  parent: YAMLSeq
  index: number
}

/** Depth-first walk over patch maps, including nested `insert` entries. */
function forEachPatchMap(seq: YAMLSeq, visitor: (ref: PatchMapRef) => void): void {
  const items = seq.items as unknown[]
  for (let index = 0; index < items.length; index++) {
    const item = items[index]
    if (!isMap(item)) continue
    visitor({ map: item as YAMLMap, parent: seq, index })
    const nested = (item as YAMLMap).get('insert', true)
    if (isSeq(nested)) forEachPatchMap(nested as YAMLSeq, visitor)
  }
}

function patchMapMatches(map: YAMLMap, targets: string[]): boolean {
  const id = mapText(map, 'id')
  const name = mapText(map, 'name')
  return (id !== undefined && targets.includes(id)) || (name !== undefined && targets.includes(name))
}

/** Keys that only record the disabled switch, so the whole patch is removable. */
function isPureDisabledEntry(map: YAMLMap): boolean {
  const pairs = map.items as unknown[]
  for (const pair of pairs) {
    const key = scalarText((pair as { key?: unknown }).key)
    if (key !== 'id' && key !== 'name' && key !== 'disabled') return false
  }
  return true
}

/** Move a removed entry's leading comment onto the next entry instead of dropping it. */
function splicePatchEntry(parent: YAMLSeq, index: number, map: YAMLMap): void {
  const commentBefore = (map as unknown as { commentBefore?: string }).commentBefore
  parent.items.splice(index, 1)
  if (!commentBefore) return
  const next = (parent.items as unknown[])[index]
  if (isMap(next)) {
    const target = next as YAMLMap
    const existing = (target as unknown as { commentBefore?: string }).commentBefore
    ;(target as unknown as { commentBefore?: string }).commentBefore = existing ? `${commentBefore}\n${existing}` : commentBefore
  }
}

export interface PatchUpdateResult {
  ok: boolean
  changed: boolean
  error?: string
}

/**
 * Persist one entry's enablement in the profile patch by editing only that
 * entry: `disabled: true` is set (added when absent), and enabling removes a
 * switch-only override or drops `disabled` while keeping the rest of the
 * entry's config. Every other patch entry, comment, and `!!js` tag is left as
 * written.
 */
export function setPluginEnabledInPatch(
  profileDir: string,
  targets: string[],
  enable: boolean,
): PatchUpdateResult {
  const loaded = loadPatchDocument(profileDir)
  if ('error' in loaded) return { ok: false, changed: false, error: loaded.error }
  const { doc } = loaded
  const seq = patchSeqOf(doc)
  let changed = false

  if (!enable) {
    let matched: PatchMapRef | undefined
    forEachPatchMap(seq, (ref) => {
      if (!matched && patchMapMatches(ref.map, targets)) matched = ref
    })
    if (matched) {
      if (matched.map.get('disabled') !== true) {
        matched.map.set('disabled', true)
        changed = true
      }
    } else {
      doc.add({ id: targets[0], disabled: true })
      changed = true
    }
  } else {
    const removals: PatchMapRef[] = []
    const cleared: YAMLMap[] = []
    forEachPatchMap(seq, (ref) => {
      if (!patchMapMatches(ref.map, targets)) return
      if (isPureDisabledEntry(ref.map)) {
        removals.push(ref)
      } else if (ref.map.has('disabled')) {
        cleared.push(ref.map)
      }
    })
    const byParent = new Map<YAMLSeq, PatchMapRef[]>()
    for (const ref of removals) {
      const list = byParent.get(ref.parent) ?? []
      list.push(ref)
      byParent.set(ref.parent, list)
    }
    for (const [parent, refs] of byParent) {
      refs.sort((a, b) => b.index - a.index)
      for (const ref of refs) splicePatchEntry(parent, ref.index, ref.map)
      changed = true
    }
    for (const map of cleared) {
      map.delete('disabled')
      changed = true
    }
  }

  if (!changed) return { ok: true, changed: false }
  savePatchDocument(profileDir, doc)
  return { ok: true, changed }
}

/** Remove every patch entry that targets the given plugin (used on uninstall). */
export function removePluginFromPatch(profileDir: string, targets: string[]): PatchUpdateResult {
  const loaded = loadPatchDocument(profileDir)
  if ('error' in loaded) return { ok: false, changed: false, error: loaded.error }
  const seq = patchSeqOf(loaded.doc)
  const removals: PatchMapRef[] = []
  forEachPatchMap(seq, (ref) => {
    if (patchMapMatches(ref.map, targets)) removals.push(ref)
  })
  if (removals.length === 0) return { ok: true, changed: false }
  const byParent = new Map<YAMLSeq, PatchMapRef[]>()
  for (const ref of removals) {
    const list = byParent.get(ref.parent) ?? []
    list.push(ref)
    byParent.set(ref.parent, list)
  }
  for (const [parent, refs] of byParent) {
    refs.sort((a, b) => b.index - a.index)
    for (const ref of refs) splicePatchEntry(parent, ref.index, ref.map)
  }
  savePatchDocument(profileDir, loaded.doc)
  return { ok: true, changed: true }
}


function findEntryIdInPatches(entries: PatchEntry[], targetId: string): string | null {
  for (const item of entries) {
    if (item.name === targetId && item.id) {
      return item.id
    }
    if (item.id === targetId) {
      return item.id
    }
    if (Array.isArray(item.insert)) {
      const nested = findEntryIdInPatches(item.insert, targetId)
      if (nested) return nested
    }
  }
  return null
}

function findEntryIdInPluginBundle(pluginDir: string, targetId: string): string | null {
  const patchPath = join(pluginDir, 'cordis.patch.yml')
  if (!existsSync(patchPath)) return null
  try {
    const raw = readFileSync(patchPath, 'utf-8')
    const parsed = parseYaml(raw, { customTags: [JS_TAG] })
    if (Array.isArray(parsed)) {
      return findEntryIdInPatches(parsed as PatchEntry[], targetId)
    }
  } catch {}
  return null
}

export function scanPlugins(profileDir: string): PluginInfo[] {
  const pluginsMap = new Map<string, PluginInfo>()

  const packageJsonPath = join(profileDir, 'package.json')
  let profileDependencies: Record<string, string> = {}
  let profileBundles: string[] = []

  if (existsSync(packageJsonPath)) {
    try {
      const pkg = JSON.parse(readFileSync(packageJsonPath, 'utf-8'))
      profileDependencies = pkg.dependencies || {}
      profileBundles = pkg.dsh?.profile?.bundles || []
    } catch {}
  }

  const patches = readPatchYaml(profileDir)
  const disabledMap = new Map<string, boolean>()

  function collectDisabled(entries: PatchEntry[]) {
    for (const item of entries) {
      if (item.id && typeof item.disabled === 'boolean') {
        disabledMap.set(item.id, item.disabled)
      }
      if (item.name && typeof item.disabled === 'boolean') {
        disabledMap.set(item.name, item.disabled)
      }
      if (Array.isArray(item.insert)) {
        collectDisabled(item.insert)
      }
    }
  }
  collectDisabled(patches)

  for (const dep of profileBundles) {
    if (dep.startsWith('@deepseek-ai/dsh-')) continue
    const isSys = isSystemPlugin(dep)
    pluginsMap.set(dep, {
      id: dep,
      name: dep,
      version: profileDependencies[dep] || 'bundled',
      description: '',
      disabled: false,
      system: isSys,
      removable: !isSys,
    })
  }

  for (const dep of Object.keys(profileDependencies)) {
    if (dep.startsWith('@deepseek-ai/dsh-')) continue
    const isSys = isSystemPlugin(dep)
    if (!pluginsMap.has(dep)) {
      pluginsMap.set(dep, {
        id: dep,
        name: dep,
        version: profileDependencies[dep],
        description: '',
        disabled: false,
        system: isSys,
        removable: !isSys,
      })
    }
  }

  const nodeModulesDir = join(profileDir, 'node_modules')
  if (existsSync(nodeModulesDir)) {
    try {
      const rootEntries = readdirSync(nodeModulesDir, { withFileTypes: true })
      for (const entry of rootEntries) {
        if (entry.name.startsWith('.')) continue

        if (entry.name.startsWith('@')) {
          const scopeDir = join(nodeModulesDir, entry.name)
          try {
            const scopedEntries = readdirSync(scopeDir, { withFileTypes: true })
            for (const scopedEntry of scopedEntries) {
              const fullPkgName = `${entry.name}/${scopedEntry.name}`
              if (isSystemPlugin(fullPkgName)) continue
              inspectAndRegisterNodeModule(fullPkgName, join(scopeDir, scopedEntry.name))
            }
          } catch {}
        } else {
          if (isSystemPlugin(entry.name)) continue
          inspectAndRegisterNodeModule(entry.name, join(nodeModulesDir, entry.name))
        }
      }
    } catch {}
  }

  function inspectAndRegisterNodeModule(pkgName: string, pkgDir: string) {
    const pkgJsonPath = join(pkgDir, 'package.json')
    if (!existsSync(pkgJsonPath)) return

    try {
      const pkgJson = JSON.parse(readFileSync(pkgJsonPath, 'utf-8'))
      const isDshPlugin =
        pkgJson.dsh !== undefined ||
        pkgJson.keywords?.includes('dsh-plugin') ||
        pkgJson.keywords?.includes('dsh') ||
        pkgName.startsWith('dsh-') ||
        pkgName.includes('dsh-plugin')

      if (!isDshPlugin && !pluginsMap.has(pkgName)) {
        return
      }

      const existing = pluginsMap.get(pkgName)
      const isSys = isSystemPlugin(pkgName)
      const version = pkgJson.version || existing?.version || 'unknown'
      const description = pkgJson.description || existing?.description || ''
      const author = typeof pkgJson.author === 'string' ? pkgJson.author : pkgJson.author?.name
      const homepage = pkgJson.homepage
      const enginesDsh =
        typeof pkgJson.engines?.dsh === 'string' && pkgJson.engines.dsh.trim() !== ''
          ? pkgJson.engines.dsh
          : existing?.enginesDsh

      pluginsMap.set(pkgName, {
        id: pkgName,
        name: pkgJson.name || pkgName,
        version,
        description,
        author,
        homepage,
        disabled: existing?.disabled ?? false,
        system: isSys,
        removable: !isSys,
        ...(enginesDsh ? { enginesDsh, compatible: null } : {}),
      })
    } catch {}
  }

  for (const [id, info] of pluginsMap.entries()) {
    let resolvedLoaderId = id
    const candidatePath = join(nodeModulesDir, id)
    if (existsSync(candidatePath)) {
      const insideId = findEntryIdInPluginBundle(candidatePath, id)
      if (insideId) {
        resolvedLoaderId = insideId
      }
    }

    if (disabledMap.has(resolvedLoaderId)) {
      info.disabled = Boolean(disabledMap.get(resolvedLoaderId))
    } else if (disabledMap.has(id)) {
      info.disabled = Boolean(disabledMap.get(id))
    }
  }

  return Array.from(pluginsMap.values()).filter((p) => !p.system)
}

/**
 * Resolve the Loader entry id a plugin package contributes: a bundle's own
 * `cordis.patch.yml` declares `id`/`name`, and profile patches address that id.
 */
export function resolveLoaderEntryId(profileDir: string, id: string): string {
  const pluginDir = join(profileDir, 'node_modules', id)
  if (existsSync(pluginDir)) {
    const insideId = findEntryIdInPluginBundle(pluginDir, id)
    if (insideId) return insideId
  }
  const patchId = findEntryIdInPatches(readPatchYaml(profileDir), id)
  return patchId ?? id
}

export function togglePlugin(profileDir: string, id: string, enable: boolean): { ok: boolean; error?: string } {
  try {
    const resolvedLoaderId = resolveLoaderEntryId(profileDir, id)
    const result = setPluginEnabledInPatch(profileDir, [resolvedLoaderId, id], enable)
    return result.ok ? { ok: true } : { ok: false, error: result.error }
  } catch (err: any) {
    return { ok: false, error: err?.message || String(err) }
  }
}

/**
 * One plugin whose live loader state we want to confirm before responding:
 * `expectEnabled` is the state the toggle is asking for.
 */
export interface SettledTarget {
  id: string
  expectEnabled: boolean
}

/**
 * Wait until the live Cordis loader has actually applied a patch change.
 *
 * Writing `cordis.patch.yml` only triggers the HMR watcher asynchronously:
 * the browser must NOT be told to reload before the host entry is enabled /
 * disposed, or the fresh page load would compose a stale client plugin graph
 * (this is exactly why "re-enabling" used to look like a no-op). Poll the
 * loader entry tree until every target reflects the requested state, or the
 * timeout elapses (we still resolve `true` on timeout so the UI can recover
 * via a manual page refresh).
 */
export function waitForLoaderSettled(
  ctx: Context,
  targets: SettledTarget[],
  timeoutMs = 10000,
  pollMs = 100,
): Promise<boolean> {
  const check = (): boolean => {
    // Resolve lazily per tick: at request time boot is long done, so this is
    // not racy; `undefined` (non-web context) means nothing to confirm.
    const loader = typeof ctx.get === 'function' ? ctx.get('loader') : undefined
    if (!loader || typeof loader.entries !== 'function') return true
    let entries: any[] = []
    try {
      entries = [...loader.entries()]
    } catch {
      return true
    }
    for (const target of targets) {
      const matches = entries.filter(
        (e) => e?.options?.name === target.id || e?.options?.id === target.id,
      )
      // Not mounted in this profile's loader tree (e.g. not in bundles):
      // the patch can only be a no-op, so there is nothing to wait for.
      if (matches.length === 0) continue
      for (const entry of matches) {
        const disabled = Boolean(entry.disabled)
        if (target.expectEnabled) {
          if (disabled || entry.fiber === undefined || entry.fiber === null) return false
        } else if (!disabled) {
          return false
        }
      }
    }
    return true
  }

  return new Promise((resolve) => {
    const deadline = Date.now() + timeoutMs
    const tick = () => {
      if (check()) {
        resolve(true)
        return
      }
      if (Date.now() >= deadline) {
        resolve(false)
        return
      }
      setTimeout(tick, pollMs)
    }
    tick()
  })
}

export function togglePluginGroup(profileDir: string, groupName: string, enable: boolean): { ok: boolean; count: number; error?: string } {
  try {
    const groupsData = readGroups(profileDir)
    const members = groupsData.groups[groupName] || []
    let count = 0
    for (const pluginId of members) {
      const res = togglePlugin(profileDir, pluginId, enable)
      if (res.ok) count++
    }
    return { ok: true, count }
  } catch (err: any) {
    return { ok: false, count: 0, error: err?.message || String(err) }
  }
}

/** Drop the plugin from every saved group without touching the rest of the file. */
export function removePluginFromGroups(profileDir: string, id: string): boolean {
  const groupsData = readGroups(profileDir)
  let modified = false
  for (const groupName of Object.keys(groupsData.groups)) {
    const list = groupsData.groups[groupName]
    let idx = list.indexOf(id)
    while (idx !== -1) {
      list.splice(idx, 1)
      modified = true
      idx = list.indexOf(id)
    }
  }
  if (modified) saveGroups(profileDir, groupsData)
  return modified
}

/**
 * Remove a plugin's dependency and bundle selection from the profile manifest.
 *
 * Every other dependency, every other `dsh.profile.bundles` entry, and every
 * unknown field is preserved (only the two target values change); the file's
 * own indentation and trailing-newline style are kept, and an unparseable
 * manifest is reported instead of being overwritten. `compatibility.json` is
 * owned by the official plugin manager and is never touched here.
 */
function removePluginFromProfileManifest(profileDir: string, id: string): { ok: boolean; error?: string } {
  const pkgJsonPath = join(profileDir, 'package.json')
  if (!existsSync(pkgJsonPath)) return { ok: true }
  const text = readFileSync(pkgJsonPath, 'utf-8')
  let pkg: any
  try {
    pkg = JSON.parse(text)
  } catch {
    return { ok: false, error: 'Profile 的 package.json 解析失败，为避免破坏配置未做修改' }
  }
  let modified = false
  if (pkg?.dependencies && Object.prototype.hasOwnProperty.call(pkg.dependencies, id)) {
    delete pkg.dependencies[id]
    modified = true
  }
  const bundles = pkg?.dsh?.profile?.bundles
  if (Array.isArray(bundles)) {
    const idx = bundles.indexOf(id)
    if (idx !== -1) {
      bundles.splice(idx, 1)
      modified = true
    }
  }
  if (!modified) return { ok: true }
  const indent = /^([ \t]+)"/m.exec(text)?.[1] ?? '  '
  const trailingNewline = text.endsWith('\n') ? '\n' : ''
  writeFileAtomic(pkgJsonPath, JSON.stringify(pkg, null, indent) + trailingNewline)
  return { ok: true }
}

const INSTALLED_NAME = /^(?:@[a-z0-9][a-z0-9._~-]*\/)?[a-z0-9][a-z0-9._~-]*$/iu

export function uninstallPlugin(profileDir: string, id: string): { ok: boolean; error?: string } {
  try {
    if (isSystemPlugin(id)) {
      return { ok: false, error: 'Cannot uninstall system protected plugin' }
    }

    const resolvedLoaderId = resolveLoaderEntryId(profileDir, id)
    const patch = removePluginFromPatch(profileDir, [resolvedLoaderId, id])
    if (!patch.ok) {
      return { ok: false, error: patch.error }
    }

    const manifest = removePluginFromProfileManifest(profileDir, id)
    if (!manifest.ok) {
      return { ok: false, error: manifest.error }
    }

    removePluginFromGroups(profileDir, id)

    const targetPkgDir = join(profileDir, 'node_modules', id)
    if (existsSync(targetPkgDir)) {
      try {
        rmSync(targetPkgDir, { recursive: true, force: true })
      } catch {}
    }

    // Best effort: the manifest edit above is what actually uninstalls the
    // plugin for future boots, so a failing/absent pnpm only leaves the lockfile
    // stale. The name is validated first because this runs through cmd.exe on
    // Windows and must never be able to carry shell syntax.
    if (INSTALLED_NAME.test(id)) {
      try {
        if (process.platform === 'win32') {
          spawnSync('cmd.exe', ['/d', '/s', '/c', `pnpm remove ${id}`], {
            cwd: profileDir,
            stdio: 'ignore',
          })
        } else {
          spawnSync('pnpm', ['remove', id], {
            cwd: profileDir,
            stdio: 'ignore',
          })
        }
      } catch {}
    }

    return { ok: true }
  } catch (err: any) {
    return { ok: false, error: err?.message || String(err) }
  }
}

/* ------------------------------------------------------------------------- *
 * Official `pluginManager` bridge (DSH 0.2.1+)
 *
 * DSH 0.2.1 ships a host service that owns profile plugin state (enablement,
 * bundle selection, install/remove, compatibility exemptions). When it exists we
 * let it perform the write first, because it also drives the live Loader
 * lifecycle and keeps `compatibility.json` consistent. The hand-rolled profile
 * file editor above remains the fallback for older hosts (0.2.0) and for
 * operations the official service refuses (for example a non-bundle package).
 * ------------------------------------------------------------------------- */

/** Subset of the official `ChangeResult` we interpret; the service owns the rest. */
export interface ChangeResultLike {
  changed?: boolean
  application?: 'applied' | 'restart-required' | 'overridden' | 'failed' | 'cancelled'
  error?: { code?: string; diagnostic?: string; incompatible?: unknown[] }
  warnings?: string[]
  version?: string
}

export interface OfficialPluginManagerLike {
  listPlugins?: () => Promise<any[]>
  setPluginEnabled?: (id: string, enabled: boolean) => Promise<ChangeResultLike>
  removeBundle?: (name: string) => Promise<ChangeResultLike>
  listBundles?: () => Promise<any[]>
}

/** The official service, or `undefined` on hosts that do not provide it. */
export function getOfficialPluginManager(ctx: Context): OfficialPluginManagerLike | undefined {
  if (typeof ctx.get !== 'function') return undefined
  let service: any
  try {
    service = ctx.get('pluginManager')
  } catch {
    return undefined
  }
  if (!service || typeof service !== 'object') return undefined
  if (typeof service.setPluginEnabled !== 'function' || typeof service.listPlugins !== 'function') return undefined
  return service as OfficialPluginManagerLike
}

function changeFailure(result?: ChangeResultLike): string {
  const code = result?.error?.code
  const diagnostic = result?.error?.diagnostic
  if (code && diagnostic) return `${code}: ${diagnostic}`
  if (code) return code
  return result?.application ? `application=${result.application}` : 'unknown result'
}

/** Loader entry id the official manager uses for a plugin package name. */
async function officialEntryId(service: OfficialPluginManagerLike, id: string): Promise<string | undefined> {
  if (typeof service.listPlugins !== 'function') return undefined
  const entries = (await service.listPlugins()) ?? []
  const matches = entries.filter((entry) => entry && (entry.moduleName === id || entry.entryId === id))
  const writable = matches.find((entry) => !entry.readOnlyReason)
  return writable?.entryId
}

export interface ToggleResult {
  ok: boolean
  via: 'official' | 'legacy'
  changed?: boolean
  application?: string
  error?: string
  warnings?: string[]
}

/**
 * Enable/disable one plugin: prefer the official service, fall back to editing
 * the profile patch exactly as before when it is absent or refuses.
 */
export async function togglePluginPreferringOfficial(
  ctx: Context,
  profileDir: string,
  id: string,
  enable: boolean,
): Promise<ToggleResult> {
  const service = getOfficialPluginManager(ctx)
  let officialProblem: string | undefined
  if (service && typeof service.setPluginEnabled === 'function') {
    try {
      const entryId = await officialEntryId(service, id)
      if (entryId) {
        const result = await service.setPluginEnabled(entryId, enable)
        const application = result?.application
        if (application === 'applied' || application === 'restart-required' || application === 'overridden') {
          const warnings = [...(result?.warnings ?? [])]
          if (application === 'overridden') {
            warnings.push('官方 pluginManager 报告该条目的启用状态被更高优先级的 patch 覆盖')
          }
          return { ok: true, via: 'official', changed: result?.changed, application, warnings: warnings.length ? warnings : undefined }
        }
        officialProblem = changeFailure(result)
      }
    } catch (err: any) {
      officialProblem = err?.message || String(err)
    }
  }

  const legacy = togglePlugin(profileDir, id, enable)
  return {
    ok: legacy.ok,
    via: 'legacy',
    error: legacy.ok ? undefined : legacy.error ?? officialProblem,
    warnings: legacy.ok && officialProblem ? [`官方 pluginManager 不可用，已回退本地 patch：${officialProblem}`] : undefined,
  }
}

export interface GroupToggleResult {
  ok: boolean
  count: number
  error?: string
  warnings?: string[]
}

export async function togglePluginGroupPreferringOfficial(
  ctx: Context,
  profileDir: string,
  groupName: string,
  enable: boolean,
): Promise<GroupToggleResult> {
  try {
    const groupsData = readGroups(profileDir)
    const members = groupsData.groups[groupName] || []
    let count = 0
    const warnings: string[] = []
    for (const pluginId of members) {
      const result = await togglePluginPreferringOfficial(ctx, profileDir, pluginId, enable)
      if (result.ok) count++
      else warnings.push(`${pluginId}: ${result.error ?? 'unknown error'}`)
      if (result.warnings) warnings.push(...result.warnings)
    }
    return { ok: true, count, warnings: warnings.length ? warnings : undefined }
  } catch (err: any) {
    return { ok: false, count: 0, error: err?.message || String(err) }
  }
}

export interface UninstallResult {
  ok: boolean
  via: 'official' | 'legacy'
  error?: string
  warnings?: string[]
}

/** Uninstall through the official service when it owns the bundle, else by hand. */
export async function uninstallPluginPreferringOfficial(
  ctx: Context,
  profileDir: string,
  id: string,
): Promise<UninstallResult> {
  if (isSystemPlugin(id)) {
    return { ok: false, via: 'legacy', error: 'Cannot uninstall system protected plugin' }
  }
  const service = getOfficialPluginManager(ctx)
  let officialProblem: string | undefined
  if (service && typeof service.removeBundle === 'function') {
    try {
      const result = await service.removeBundle(id)
      const application = result?.application
      if ((application === 'applied' || application === 'restart-required') && !result?.error) {
        // The service already removed the dependency, bundle selection, and
        // patch; only this plugin's own group bookkeeping is ours.
        removePluginFromGroups(profileDir, id)
        return { ok: true, via: 'official', warnings: result?.warnings }
      }
      officialProblem = changeFailure(result)
    } catch (err: any) {
      officialProblem = err?.message || String(err)
    }
  }

  const legacy = uninstallPlugin(profileDir, id)
  return {
    ok: legacy.ok,
    via: 'legacy',
    error: legacy.error,
    warnings: legacy.ok && officialProblem ? [`官方 pluginManager 不可用，已回退本地清理：${officialProblem}`] : undefined,
  }
}

/**
 * The plugin list is polled by the UI every few seconds; bundle metadata is
 * comparatively expensive, so one service's answer is reused briefly.
 */
const compatibilityCache = new WeakMap<object, { at: number; promise: Promise<Map<string, any>> }>()
const COMPATIBILITY_TTL_MS = 60_000

function bundleByName(service: OfficialPluginManagerLike): Promise<Map<string, any>> {
  const cached = compatibilityCache.get(service as unknown as object)
  const now = Date.now()
  if (cached && now - cached.at < COMPATIBILITY_TTL_MS) return cached.promise
  const promise = (async () => {
    const bundles = (await service.listBundles?.()) ?? []
    const byName = new Map<string, any>()
    for (const bundle of bundles) {
      if (bundle && typeof bundle.name === 'string') byName.set(bundle.name, bundle)
    }
    return byName
  })()
  compatibilityCache.set(service as unknown as object, { at: now, promise })
  promise.catch(() => compatibilityCache.delete(service as unknown as object))
  return promise
}

/**
 * Fill `compatible` for plugins that declare `engines.dsh`, using the official
 * manager's authoritative compatibility verdict (it knows the running DSH
 * version and saved exemptions). Unknown when the service is absent.
 */
export async function annotatePluginCompatibility(ctx: Context, plugins: PluginInfo[]): Promise<void> {
  if (!plugins.some((plugin) => plugin.enginesDsh)) return
  const service = getOfficialPluginManager(ctx)
  if (!service || typeof service.listBundles !== 'function') return
  try {
    const byName = await bundleByName(service)
    for (const plugin of plugins) {
      if (!plugin.enginesDsh) continue
      const bundle = byName.get(plugin.id) ?? byName.get(plugin.name)
      if (!bundle) continue
      plugin.compatible = bundle.error?.code === 'incompatible-version' ? false : true
    }
  } catch {
    // Compatibility is presentation only; a failing lookup leaves it unknown.
  }
}

async function readJsonBody(req: IncomingMessage): Promise<any> {
  return new Promise((resolve, reject) => {
    let raw = ''
    req.on('data', (chunk) => {
      raw += chunk
    })
    req.on('end', () => {
      try {
        resolve(raw ? JSON.parse(raw) : {})
      } catch (err) {
        reject(err)
      }
    })
    req.on('error', reject)
  })
}

function writeJson(res: ServerResponse, status: number, data: any) {
  const str = JSON.stringify(data)
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'Content-Length': Buffer.byteLength(str),
  })
  res.end(str)
}

function createApiHandler(ctx: Context) {
  const { profile, dir: profileDir } = resolveProfileDir()

  return async (req: IncomingMessage, res: ServerResponse) => {
    const pathname = new URL(req.url ?? '/', 'http://dsh.internal').pathname
    const subpath = pathname.replace(/^(\/td-plugins\/api|\/td-integration\/api)\/?/, '')

    try {
      if (subpath === 'plugins' || subpath === 'plugins/list') {
        const plugins = scanPlugins(profileDir)
        // Authoritative engines.dsh verdict when the official service is present.
        await annotatePluginCompatibility(ctx, plugins)
        const groupsData = readGroups(profileDir)
        writeJson(res, 200, {
          ok: true,
          value: {
            profile,
            profileDir,
            plugins,
            groups: groupsData.groups,
            groupOrder: groupsData.groupOrder,
            officialPluginManager: getOfficialPluginManager(ctx) !== undefined,
          },
        })
        return
      }

      if (req.method !== 'POST') {
        writeJson(res, 405, { ok: false, error: { message: 'Method Not Allowed' } })
        return
      }

      const body = (await readJsonBody(req)) as any

      if (subpath === 'plugins/toggle') {
        const { id, enable } = body || {}
        if (!id || typeof enable !== 'boolean') {
          writeJson(res, 400, { ok: false, error: { message: 'Missing id or enable boolean' } })
          return
        }
        const result = await togglePluginPreferringOfficial(ctx, profileDir, id, enable)
        // Only respond once the live loader has applied the change, so the
        // client's immediate full-page reload composes the fresh plugin graph.
        const settled = result.ok ? await waitForLoaderSettled(ctx, [{ id, expectEnabled: enable }]) : true
        writeJson(res, 200, { ok: result.ok, value: { ...result, settled }, error: result.error })
        return
      }

      if (subpath === 'plugins/toggle-group') {
        const { group, enable } = body || {}
        if (!group || typeof enable !== 'boolean') {
          writeJson(res, 400, { ok: false, error: { message: 'Missing group or enable boolean' } })
          return
        }
        const groupMembers = readGroups(profileDir).groups[group] || []
        const result = await togglePluginGroupPreferringOfficial(ctx, profileDir, group, enable)
        const members = result.ok ? groupMembers : []
        const settled = result.ok
          ? await waitForLoaderSettled(ctx, members.map((id) => ({ id, expectEnabled: enable })))
          : true
        writeJson(res, 200, { ok: result.ok, value: { ...result, settled }, error: result.error })
        return
      }

      if (subpath === 'plugins/groups') {
        const { action, name, newName, member, members } = body || {}
        const groupsData = readGroups(profileDir)

        if (action === 'create') {
          if (!name || typeof name !== 'string') {
            writeJson(res, 400, { ok: false, error: { message: 'Invalid group name' } })
            return
          }
          if (groupsData.groups[name]) {
            writeJson(res, 400, { ok: false, error: { message: 'Group already exists' } })
            return
          }
          groupsData.groups[name] = []
          groupsData.groupOrder.push(name)
        } else if (action === 'rename') {
          if (!name || !newName || typeof newName !== 'string') {
            writeJson(res, 400, { ok: false, error: { message: 'Invalid rename params' } })
            return
          }
          if (!groupsData.groups[name]) {
            writeJson(res, 404, { ok: false, error: { message: 'Group not found' } })
            return
          }
          const existing = groupsData.groups[name]
          delete groupsData.groups[name]
          groupsData.groups[newName] = existing
          const idx = groupsData.groupOrder.indexOf(name)
          if (idx !== -1) groupsData.groupOrder[idx] = newName
        } else if (action === 'delete') {
          if (!name || !groupsData.groups[name]) {
            writeJson(res, 404, { ok: false, error: { message: 'Group not found' } })
            return
          }
          delete groupsData.groups[name]
          const idx = groupsData.groupOrder.indexOf(name)
          if (idx !== -1) groupsData.groupOrder.splice(idx, 1)
        } else if (action === 'add-member') {
          if (!name || !groupsData.groups[name] || !member) {
            writeJson(res, 400, { ok: false, error: { message: 'Invalid add-member params' } })
            return
          }
          if (!groupsData.groups[name].includes(member)) {
            groupsData.groups[name].push(member)
          }
        } else if (action === 'remove-member') {
          if (!name || !groupsData.groups[name] || !member) {
            writeJson(res, 400, { ok: false, error: { message: 'Invalid remove-member params' } })
            return
          }
          const idx = groupsData.groups[name].indexOf(member)
          if (idx !== -1) groupsData.groups[name].splice(idx, 1)
        } else if (action === 'set-members') {
          if (!name || !groupsData.groups[name] || !Array.isArray(members)) {
            writeJson(res, 400, { ok: false, error: { message: 'Invalid set-members params' } })
            return
          }
          groupsData.groups[name] = members
        } else {
          writeJson(res, 400, { ok: false, error: { message: `Unknown action: ${action}` } })
          return
        }

        saveGroups(profileDir, groupsData)
        writeJson(res, 200, { ok: true, value: { groups: groupsData.groups, groupOrder: groupsData.groupOrder } })
        return
      }

      if (subpath === 'plugins/uninstall') {
        const { id } = body || {}
        if (!id) {
          writeJson(res, 400, { ok: false, error: { message: 'Missing plugin id' } })
          return
        }
        const result = await uninstallPluginPreferringOfficial(ctx, profileDir, id)
        writeJson(res, result.ok ? 200 : 500, { ok: result.ok, value: result, error: result.error })
        return
      }

      writeJson(res, 404, { ok: false, error: { message: `Unknown endpoint: ${subpath}` } })
    } catch (err: any) {
      writeJson(res, 500, { ok: false, error: { message: err?.message || String(err) } })
    }
  }
}

export const name = 'dsh-plugin-manager'
export const inject = ['webServer']

export function apply(ctx: Context) {
  const handler = createApiHandler(ctx)

  // Register both /td-plugins/api and /td-integration/api for compatibility
  ctx.effect(() => {
    const unreg1 = ctx.webServer.register({
      kind: 'prefix',
      path: '/td-plugins/api',
      handler,
    })
    const unreg2 = ctx.webServer.register({
      kind: 'prefix',
      path: '/td-integration/api',
      handler,
    })
    return () => {
      unreg1()
      unreg2()
    }
  }, 'dsh-plugin-manager: HTTP routes')
}
