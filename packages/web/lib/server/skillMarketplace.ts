import { execFile } from 'node:child_process';
import { cp, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve, sep } from 'node:path';
import { promisify } from 'node:util';
import { listSkillPackageFiles } from '@zleap/core/skill-sources';
import { parseSkillPackage, skillRecordFromPackageManifest } from '@zleap/core/skill-package';
import type { SkillDefinitionRecord, SkillInvocationPolicy } from '@zleap/core';
import type { ZleapStore } from '@zleap/store';
import { saveSkillRecord } from './avatarContext';
import { defaultSkillsRoot } from './projectPaths';

const SKILLS_SH_BASE_URL = 'https://skills.sh';
const MARKETPLACE_SEARCH_LIMIT = 20;
const SKILLS_CLI_TIMEOUT_MS = 120_000;
const SKILLS_CLI_MAX_BUFFER_BYTES = 10 * 1024 * 1024;
const SKILLS_CLI_AGENT = 'claude-code';
const execFileAsync = promisify(execFile);

export type MarketplaceAuditStatus = 'pass' | 'warn' | 'fail' | 'unknown';

export type MarketplaceAudit = {
  provider: string;
  slug?: string;
  status: 'pass' | 'warn' | 'fail' | string;
  summary?: string;
  auditedAt?: string;
  riskLevel?: string;
  categories?: string[];
};

export type MarketplaceAuditSummary = {
  status: MarketplaceAuditStatus;
  audits: MarketplaceAudit[];
};

export type MarketplaceSkill = {
  id: string;
  slug: string;
  name: string;
  source: string;
  installs: number;
  sourceType: string;
  installUrl?: string | null;
  url: string;
  installed?: boolean;
  audit?: MarketplaceAuditSummary;
};

export type MarketplaceSkillDetail = {
  id: string;
  source: string;
  slug: string;
  installs: number;
  hash?: string | null;
  files: Array<{ path: string; contents: string }>;
  skillMd?: string;
  audit?: MarketplaceAuditSummary;
  url: string;
};

export class SkillMarketplaceError extends Error {
  constructor(readonly code: string, message: string, readonly status = 400) {
    super(message);
    this.name = 'SkillMarketplaceError';
  }
}

type SkillsShSkill = {
  id?: unknown;
  slug?: unknown;
  name?: unknown;
  source?: unknown;
  installs?: unknown;
  sourceType?: unknown;
  installUrl?: unknown;
  url?: unknown;
  isDuplicate?: unknown;
};

type SkillsShDetail = {
  id?: unknown;
  source?: unknown;
  slug?: unknown;
  installs?: unknown;
  hash?: unknown;
  files?: unknown;
};

export async function searchSkills(input: { query: string; limit?: number; store?: Pick<ZleapStore, 'skills'> | null }): Promise<{ skills: MarketplaceSkill[]; query: string }> {
  const query = input.query.trim();
  if (query.length < 2) {
    throw new SkillMarketplaceError('query_too_short', 'Search query must be at least 2 characters.', 400);
  }
  const limit = clampInteger(input.limit, 1, MARKETPLACE_SEARCH_LIMIT, 10);
  const installedKeys = await installedSkillKeys(input.store);

  if (hasSkillsShToken()) {
    try {
      const data = await skillsShJson<{ data?: SkillsShSkill[] }>(`/api/v1/skills/search?q=${encodeURIComponent(query)}&limit=${limit}`);
      const base = (data.data ?? [])
        .filter((skill) => skill.isDuplicate !== true)
        .map((skill) => normalizeSearchSkill(skill, installedKeys))
        .filter((skill): skill is MarketplaceSkill => Boolean(skill));
      const withAudits = await Promise.all(
        base.map(async (skill) => ({
          ...skill,
          audit: await getSkillAudit(skill.id).catch((): MarketplaceAuditSummary => ({ status: 'unknown', audits: [] })),
        })),
      );
      return { skills: sortMarketplaceSkills(withAudits), query };
    } catch {
      // The public CLI path is the normal local fallback when skills.sh API auth is unavailable or stale.
    }
  }

  return { skills: sortMarketplaceSkills(await searchSkillsWithCli(query, limit, installedKeys)), query };
}

export async function getSkillDetail(id: string): Promise<MarketplaceSkillDetail> {
  const cleanId = normalizeMarketplaceId(id);
  if (hasSkillsShToken()) {
    try {
      return getSkillDetailFromApi(cleanId);
    } catch {
      // Fall back to the public CLI path; local users should not need skills.sh API credentials.
    }
  }

  return getSkillDetailWithCli(cleanId);
}

export async function getSkillAudit(id: string): Promise<MarketplaceAuditSummary> {
  const cleanId = normalizeMarketplaceId(id);
  if (!hasSkillsShToken()) {
    return getPublicSkillPage(cleanId).then((page) => page.audit).catch((): MarketplaceAuditSummary => ({ status: 'unknown', audits: [] }));
  }
  const response = await skillsShFetch(`/api/v1/skills/audit/${marketplacePath(cleanId)}`);
  if (response.status === 404) {
    return { status: 'unknown', audits: [] };
  }
  const data = (await response.json().catch(() => ({}))) as { audits?: unknown; error?: string; message?: string };
  if (!response.ok) {
    throw marketplaceFetchError(response.status, data);
  }
  const audits = Array.isArray(data.audits)
    ? data.audits.map(normalizeAudit).filter((audit): audit is MarketplaceAudit => Boolean(audit))
    : [];
  return { status: summarizeAuditStatus(audits), audits };
}

export async function importMarketplaceSkill(
  store: ZleapStore,
  input: { id: string; root?: string; invocationPolicy?: SkillInvocationPolicy },
): Promise<{ skill: SkillDefinitionRecord; packageRoot: string; detail: MarketplaceSkillDetail }> {
  if (hasSkillsShToken()) {
    try {
      const detail = await getSkillDetailFromApi(normalizeMarketplaceId(input.id));
      if (!detail.files.length || !detail.skillMd?.trim()) {
        throw new SkillMarketplaceError('skill_snapshot_unavailable', 'Skill file snapshot is unavailable from skills.sh.', 404);
      }
      const packageRoot = marketplacePackageRoot(input.root ?? defaultSkillsRoot(), detail.id);
      await writeMarketplaceFiles(packageRoot, detail.files);
      const files = await listSkillPackageFiles(packageRoot);
      const manifest = parseSkillPackage({
        root: packageRoot,
        sourcePath: packageRoot,
        sourceType: 'imported',
        skillMd: detail.skillMd,
        files,
        openaiYaml: detail.files.find((file) => file.path === 'agents/openai.yaml')?.contents,
        trustStatus: 'review_required',
      });
      const record = skillRecordFromPackageManifest(manifest, { origin: 'user', sourceType: 'imported' });
      const safeRecord: SkillDefinitionRecord = {
        ...record,
        toolIds: [],
        sourceType: 'imported',
        trustStatus: 'review_required',
        invocationPolicy: normalizeImportedInvocationPolicy(input.invocationPolicy),
        metadata: {
          ...(record.metadata ?? {}),
          marketplace: {
            id: detail.id,
            source: detail.source,
            slug: detail.slug,
            url: detail.url,
            installs: detail.installs,
            hash: detail.hash ?? undefined,
          },
        },
        riskAudit: record.riskAudit ? { ...record.riskAudit, status: 'review_required' } : record.riskAudit,
      };
      return { skill: await saveSkillRecord(store, safeRecord), packageRoot, detail };
    } catch {
      // Fall through to npx skills add so local imports do not depend on skills.sh API credentials.
    }
  }

  return importMarketplaceSkillWithCli(store, input);
}

async function getSkillDetailFromApi(cleanId: string): Promise<MarketplaceSkillDetail> {
  const detail = await skillsShJson<SkillsShDetail>(`/api/v1/skills/${marketplacePath(cleanId)}`);
  const files = normalizeDetailFiles(detail.files);
  const skillMd = files.find((file) => file.path === 'SKILL.md')?.contents;
  return {
    id: stringField(detail.id) ?? cleanId,
    source: stringField(detail.source) ?? cleanId.split('/').slice(0, -1).join('/'),
    slug: stringField(detail.slug) ?? cleanId.split('/').at(-1) ?? cleanId,
    installs: numberField(detail.installs),
    hash: stringField(detail.hash) ?? null,
    files,
    ...(skillMd ? { skillMd } : {}),
    audit: await getSkillAudit(cleanId).catch((): MarketplaceAuditSummary => ({ status: 'unknown', audits: [] })),
    url: `${SKILLS_SH_BASE_URL}/${marketplacePath(cleanId)}`,
  };
}

async function searchSkillsWithCli(query: string, limit: number, installedKeys: Set<string>): Promise<MarketplaceSkill[]> {
  const output = await runSkillsCli(['find', query]);
  const skills = parseSkillsFindOutput(output, installedKeys).slice(0, limit);
  const withAudits = await Promise.all(
    skills.map(async (skill) => ({
      ...skill,
      audit: await getSkillAudit(skill.id).catch((): MarketplaceAuditSummary => ({ status: 'unknown', audits: [] })),
    })),
  );
  return withAudits;
}

async function getSkillDetailWithCli(cleanId: string): Promise<MarketplaceSkillDetail> {
  const output = await runSkillsCli(['use', marketplaceCliRef(cleanId)]);
  const skillMd = extractSkillMdFromUseOutput(output);
  const publicPage = await getPublicSkillPage(cleanId).catch(() => publicSkillPageFallback(cleanId));
  return {
    id: cleanId,
    source: publicPage.source,
    slug: publicPage.slug,
    installs: publicPage.installs,
    hash: null,
    files: [{ path: 'SKILL.md', contents: skillMd }],
    skillMd,
    audit: publicPage.audit,
    url: publicPage.url,
  };
}

async function importMarketplaceSkillWithCli(
  store: ZleapStore,
  input: { id: string; root?: string; invocationPolicy?: SkillInvocationPolicy },
): Promise<{ skill: SkillDefinitionRecord; packageRoot: string; detail: MarketplaceSkillDetail }> {
  const cleanId = normalizeMarketplaceId(input.id);
  const targetRoot = marketplacePackageRoot(input.root ?? defaultSkillsRoot(), cleanId);
  const tempRoot = await mkdtemp(join(tmpdir(), 'zleap-skills-marketplace-'));
  try {
    await runSkillsCli(['add', marketplaceCliRef(cleanId), '--agent', SKILLS_CLI_AGENT, '--copy', '-y'], { cwd: tempRoot });
    const installedRoot = await findInstalledSkillPackageRoot(tempRoot, cleanId.split('/').at(-1) ?? cleanId);
    await rm(targetRoot, { recursive: true, force: true });
    await mkdir(dirname(targetRoot), { recursive: true });
    await cp(installedRoot, targetRoot, { recursive: true });

    const skillMd = await readFile(join(targetRoot, 'SKILL.md'), 'utf8');
    const openaiYaml = await readOptionalUtf8(join(targetRoot, 'agents', 'openai.yaml'));
    const files = await listSkillPackageFiles(targetRoot);
    const manifest = parseSkillPackage({
      root: targetRoot,
      sourcePath: targetRoot,
      sourceType: 'imported',
      skillMd,
      openaiYaml,
      files,
      trustStatus: 'review_required',
    });
    const record = skillRecordFromPackageManifest(manifest, { origin: 'user', sourceType: 'imported' });
    const page = await getPublicSkillPage(cleanId).catch(() => publicSkillPageFallback(cleanId));
    const safeRecord: SkillDefinitionRecord = {
      ...record,
      toolIds: [],
      sourceType: 'imported',
      trustStatus: 'review_required',
      invocationPolicy: normalizeImportedInvocationPolicy(input.invocationPolicy),
      metadata: {
        ...(record.metadata ?? {}),
        marketplace: {
          id: cleanId,
          source: page.source,
          slug: page.slug,
          url: page.url,
          installs: page.installs,
        },
      },
      riskAudit: record.riskAudit ? { ...record.riskAudit, status: 'review_required' } : record.riskAudit,
    };
    const detail: MarketplaceSkillDetail = {
      id: cleanId,
      source: page.source,
      slug: page.slug,
      installs: page.installs,
      hash: null,
      files: [{ path: 'SKILL.md', contents: skillMd }],
      skillMd,
      audit: page.audit,
      url: page.url,
    };
    return { skill: await saveSkillRecord(store, safeRecord), packageRoot: targetRoot, detail };
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
}

function normalizeImportedInvocationPolicy(value: SkillInvocationPolicy | undefined): SkillInvocationPolicy {
  return value === 'disabled' ? 'disabled' : 'explicit_only';
}

async function installedSkillKeys(store: Pick<ZleapStore, 'skills'> | null | undefined): Promise<Set<string>> {
  const keys = new Set<string>();
  if (!store) return keys;
  const records = await store.skills.listSkills({ limit: 1_000 }).catch(() => []);
  for (const record of records) {
    keys.add(record.id);
    keys.add(record.sourceName ?? '');
    const marketplace = record.metadata?.marketplace;
    if (marketplace && typeof marketplace === 'object' && 'id' in marketplace && typeof marketplace.id === 'string') {
      keys.add(marketplace.id);
    }
  }
  keys.delete('');
  return keys;
}

type PublicSkillPage = {
  source: string;
  slug: string;
  installs: number;
  audit: MarketplaceAuditSummary;
  url: string;
};

function parseSkillsFindOutput(output: string, installedKeys: Set<string>): MarketplaceSkill[] {
  const clean = stripAnsi(output).replace(/\r/g, '');
  const lines = clean.split('\n').map((line) => line.trim()).filter(Boolean);
  const skills: MarketplaceSkill[] = [];
  for (let index = 0; index < lines.length; index += 1) {
    const match = /^(.+?)@(\S+)\s+([0-9][0-9.,]*)([kKmMbB]?)\s+installs\b/.exec(lines[index] ?? '');
    if (!match) continue;
    const source = match[1]?.trim();
    const slug = match[2]?.trim();
    if (!source || !slug) continue;
    const nextLine = lines[index + 1] ?? '';
    const url = nextLine.match(/https?:\/\/skills\.sh\/\S+/i)?.[0] ?? `${SKILLS_SH_BASE_URL}/${marketplacePath(`${source}/${slug}`)}`;
    const id = marketplaceIdFromUrl(url) ?? `${source}/${slug}`;
    skills.push({
      id,
      slug: id.split('/').at(-1) ?? slug,
      name: slug,
      source: id.split('/').slice(0, -1).join('/') || source,
      installs: parseInstallCount(match[3] ?? '0', match[4]),
      sourceType: inferSourceType(source),
      installUrl: source.includes('/') ? `https://github.com/${source}` : null,
      url,
      installed: installedKeys.has(id) || installedKeys.has(slug),
    });
  }
  return skills;
}

async function getPublicSkillPage(cleanId: string): Promise<PublicSkillPage> {
  const url = `${SKILLS_SH_BASE_URL}/${marketplacePath(cleanId)}`;
  const response = await fetch(url, { cache: 'no-store' });
  if (!response.ok) {
    throw marketplaceFetchError(response.status, { message: `skills.sh page failed with HTTP ${response.status}.` });
  }
  const html = await response.text();
  const jsonLd = extractSoftwareApplicationJsonLd(html);
  const fallback = publicSkillPageFallback(cleanId);
  return {
    source: fallback.source,
    slug: stringField(jsonLd?.name) ?? fallback.slug,
    installs: numberField(readNested(jsonLd, ['interactionStatistic', 'userInteractionCount'])) || fallback.installs,
    audit: parsePublicAuditSummary(html),
    url,
  };
}

function publicSkillPageFallback(cleanId: string): PublicSkillPage {
  const parts = cleanId.split('/');
  return {
    source: parts.slice(0, -1).join('/'),
    slug: parts.at(-1) ?? cleanId,
    installs: 0,
    audit: { status: 'unknown', audits: [] },
    url: `${SKILLS_SH_BASE_URL}/${marketplacePath(cleanId)}`,
  };
}

function extractSoftwareApplicationJsonLd(html: string): Record<string, unknown> | undefined {
  const matches = html.matchAll(/<script\s+type="application\/ld\+json">([\s\S]*?)<\/script>/gi);
  for (const match of matches) {
    const raw = decodeHtmlEntities(match[1] ?? '');
    try {
      const parsed = JSON.parse(raw) as unknown;
      if (parsed && typeof parsed === 'object' && (parsed as Record<string, unknown>)['@type'] === 'SoftwareApplication') {
        return parsed as Record<string, unknown>;
      }
    } catch {
      continue;
    }
  }
  return undefined;
}

function parsePublicAuditSummary(html: string): MarketplaceAuditSummary {
  const audits: MarketplaceAudit[] = [];
  const auditMatches = html.matchAll(/href="\/[^"]+\/security\/([^"]+)"[\s\S]*?<span[^>]*>([^<]+)<\/span>[\s\S]*?<span[^>]*>(Pass|Warn|Fail)<\/span>/gi);
  for (const match of auditMatches) {
    const provider = decodeHtmlEntities(match[2] ?? '').trim();
    const status = (match[3] ?? '').toLowerCase();
    if (!provider || !status) continue;
    audits.push({ provider, slug: decodeHtmlEntities(match[1] ?? '').trim() || undefined, status });
  }
  return { status: summarizeAuditStatus(audits), audits };
}

async function runSkillsCli(args: string[], options: { cwd?: string } = {}): Promise<string> {
  try {
    const result = await execFileAsync(npxCommand(), ['--yes', 'skills', ...args], {
      cwd: options.cwd,
      timeout: SKILLS_CLI_TIMEOUT_MS,
      maxBuffer: SKILLS_CLI_MAX_BUFFER_BYTES,
      env: {
        ...process.env,
        CI: process.env.CI ?? '1',
        NO_COLOR: '1',
        FORCE_COLOR: '0',
      },
    });
    if (typeof result === 'string') return result;
    if (Array.isArray(result)) return `${result[0] ?? ''}\n${result[1] ?? ''}`;
    return `${result.stdout ?? ''}\n${result.stderr ?? ''}`;
  } catch (error) {
    throw new SkillMarketplaceError('skills_cli_failed', summarizeCliError(error), 502);
  }
}

function npxCommand(): string {
  return process.platform === 'win32' ? 'npx.cmd' : 'npx';
}

function summarizeCliError(error: unknown): string {
  if (!error || typeof error !== 'object') {
    return `npx skills failed: ${String(error)}`;
  }
  const record = error as { message?: unknown; stdout?: unknown; stderr?: unknown };
  const output = stripAnsi(`${typeof record.stdout === 'string' ? record.stdout : ''}\n${typeof record.stderr === 'string' ? record.stderr : ''}`)
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .slice(0, 8)
    .join('\n');
  const message = typeof record.message === 'string' ? record.message : 'npx skills failed.';
  return output ? `${message}\n${output}` : message;
}

function extractSkillMdFromUseOutput(output: string): string {
  const match = /<SKILL\.md>\s*([\s\S]*?)\s*<\/SKILL\.md>/.exec(output);
  const skillMd = match?.[1]?.trim();
  if (!skillMd) {
    throw new SkillMarketplaceError('skill_snapshot_unavailable', 'npx skills use did not return a SKILL.md snapshot.', 404);
  }
  return `${skillMd}\n`;
}

async function findInstalledSkillPackageRoot(tempRoot: string, slug: string): Promise<string> {
  const searchRoots = [
    join(tempRoot, '.claude', 'skills'),
    join(tempRoot, '.agents', 'skills'),
    join(tempRoot, '.codex', 'skills'),
  ];
  const candidates: string[] = [];
  for (const root of searchRoots) {
    candidates.push(...await findSkillPackageRoots(root));
  }
  if (!candidates.length) {
    throw new SkillMarketplaceError('skill_install_not_found', 'npx skills add completed but no SKILL.md was installed.', 502);
  }
  const wanted = normalizeNameForMatch(slug);
  const exact = candidates.find((candidate) => normalizeNameForMatch(candidate.split(/[\\/]/).at(-1) ?? '') === wanted);
  if (exact) return exact;
  if (candidates.length === 1) return candidates[0]!;
  for (const candidate of candidates) {
    const skillMd = await readFile(join(candidate, 'SKILL.md'), 'utf8').catch(() => '');
    if (normalizeNameForMatch(readFrontmatterName(skillMd)) === wanted) {
      return candidate;
    }
  }
  throw new SkillMarketplaceError('skill_install_ambiguous', 'npx skills add installed multiple skills and Zleap could not identify the requested one.', 502);
}

async function findSkillPackageRoots(root: string): Promise<string[]> {
  let entries: Array<{ name: string; isFile(): boolean; isDirectory(): boolean; isSymbolicLink(): boolean }>;
  try {
    entries = await readdir(root, { withFileTypes: true, encoding: 'utf8' });
  } catch (error) {
    if (isNotFound(error)) return [];
    throw error;
  }
  const roots: string[] = [];
  if (entries.some((entry) => entry.isFile() && entry.name === 'SKILL.md')) {
    roots.push(root);
    return roots;
  }
  for (const entry of entries) {
    if (!entry.isDirectory() && !entry.isSymbolicLink()) continue;
    roots.push(...await findSkillPackageRoots(join(root, entry.name)));
  }
  return roots;
}

function marketplaceCliRef(id: string): string {
  const cleanId = normalizeMarketplaceId(id);
  const parts = cleanId.split('/');
  const slug = parts.pop();
  const source = parts.join('/');
  if (!source || !slug || /\s|@/.test(source) || /\s/.test(slug)) {
    throw new SkillMarketplaceError('skill_id_invalid', 'Marketplace skill id cannot be converted to a skills CLI reference.', 400);
  }
  return `${source}@${slug}`;
}

function marketplaceIdFromUrl(url: string): string | undefined {
  try {
    const parsed = new URL(url);
    if (parsed.hostname !== 'skills.sh' && parsed.hostname !== 'www.skills.sh') return undefined;
    return normalizeMarketplaceId(decodeURIComponent(parsed.pathname));
  } catch {
    return undefined;
  }
}

function parseInstallCount(value: string, suffix: string | undefined): number {
  const base = Number(value.replace(/,/g, ''));
  if (!Number.isFinite(base)) return 0;
  const normalizedSuffix = suffix?.toUpperCase();
  if (normalizedSuffix === 'B') return Math.round(base * 1_000_000_000);
  if (normalizedSuffix === 'M') return Math.round(base * 1_000_000);
  if (normalizedSuffix === 'K') return Math.round(base * 1_000);
  return Math.round(base);
}

function inferSourceType(source: string): string {
  if (/^(vercel-labs|anthropics|openai|supabase|expo)\//i.test(source)) return 'well-known';
  if (source.includes('/')) return 'github';
  return 'unknown';
}

function readFrontmatterName(markdown: string): string {
  return /^name:\s*["']?([^"'\n]+)["']?\s*$/m.exec(markdown)?.[1]?.trim() ?? '';
}

function normalizeNameForMatch(value: string): string {
  return value.trim().toLowerCase().replace(/[^a-z0-9._:-]+/g, '-').replace(/^-+|-+$/g, '');
}

async function readOptionalUtf8(path: string): Promise<string | undefined> {
  try {
    return await readFile(path, 'utf8');
  } catch (error) {
    if (isNotFound(error)) return undefined;
    throw error;
  }
}

function hasSkillsShToken(): boolean {
  return Boolean(skillsShToken());
}

function skillsShToken(): string | undefined {
  return process.env.VERCEL_OIDC_TOKEN?.trim() || process.env.SKILLS_SH_OIDC_TOKEN?.trim() || undefined;
}

function normalizeSearchSkill(skill: SkillsShSkill, installedKeys: Set<string>): MarketplaceSkill | undefined {
  const id = stringField(skill.id);
  const slug = stringField(skill.slug);
  const name = stringField(skill.name);
  const source = stringField(skill.source);
  const url = stringField(skill.url);
  if (!id || !slug || !name || !source || !url) return undefined;
  return {
    id,
    slug,
    name,
    source,
    installs: numberField(skill.installs),
    sourceType: stringField(skill.sourceType) ?? 'unknown',
    installUrl: stringField(skill.installUrl) ?? null,
    url,
    installed: installedKeys.has(id) || installedKeys.has(slug) || installedKeys.has(name),
  };
}

function sortMarketplaceSkills(skills: MarketplaceSkill[]): MarketplaceSkill[] {
  return [...skills].sort((left, right) =>
    right.installs - left.installs ||
    sourceRank(right) - sourceRank(left) ||
    auditRank(right.audit?.status) - auditRank(left.audit?.status) ||
    left.name.localeCompare(right.name),
  );
}

function sourceRank(skill: MarketplaceSkill): number {
  if (skill.sourceType === 'well-known') return 4;
  if (/^(vercel-labs|anthropics|openai|supabase|expo)\//i.test(skill.source)) return 3;
  if (skill.sourceType === 'github') return 2;
  return 1;
}

function auditRank(status: MarketplaceAuditStatus | undefined): number {
  if (status === 'pass') return 3;
  if (status === 'warn') return 2;
  if (status === 'unknown') return 1;
  return 0;
}

async function writeMarketplaceFiles(packageRoot: string, files: Array<{ path: string; contents: string }>): Promise<void> {
  const root = resolve(packageRoot);
  await mkdir(root, { recursive: true });
  for (const file of files) {
    const relativePath = normalizeRelativePath(file.path);
    if (!relativePath) continue;
    const target = resolve(root, relativePath);
    if (target !== root && !target.startsWith(root + sep)) {
      throw new SkillMarketplaceError('skill_file_path_forbidden', `Skill file path escapes package root: ${file.path}`, 400);
    }
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, file.contents, 'utf8');
  }
}

function marketplacePackageRoot(root: string, id: string): string {
  const safe = normalizeMarketplaceId(id)
    .split('/')
    .map((part) => part.replace(/[^a-zA-Z0-9._-]+/g, '-').replace(/^-+|-+$/g, '') || 'skill');
  return join(resolve(root), `marketplace__${safe.join('__')}`);
}

function normalizeDetailFiles(value: unknown): Array<{ path: string; contents: string }> {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item) => {
    if (!item || typeof item !== 'object') return [];
    const record = item as Record<string, unknown>;
    const path = stringField(record.path);
    const contents = textField(record.contents);
    return path && contents !== undefined ? [{ path, contents }] : [];
  });
}

function normalizeAudit(value: unknown): MarketplaceAudit | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const record = value as Record<string, unknown>;
  const provider = stringField(record.provider);
  const status = stringField(record.status);
  if (!provider || !status) return undefined;
  return {
    provider,
    ...(stringField(record.slug) ? { slug: stringField(record.slug) } : {}),
    status,
    ...(stringField(record.summary) ? { summary: stringField(record.summary) } : {}),
    ...(stringField(record.auditedAt) ? { auditedAt: stringField(record.auditedAt) } : {}),
    ...(stringField(record.riskLevel) ? { riskLevel: stringField(record.riskLevel) } : {}),
    ...(Array.isArray(record.categories) ? { categories: record.categories.filter((item): item is string => typeof item === 'string') } : {}),
  };
}

function summarizeAuditStatus(audits: MarketplaceAudit[]): MarketplaceAuditStatus {
  if (audits.some((audit) => audit.status === 'fail' || /^(HIGH|CRITICAL)$/i.test(audit.riskLevel ?? ''))) return 'fail';
  if (audits.some((audit) => audit.status === 'warn' || /^(MEDIUM)$/i.test(audit.riskLevel ?? ''))) return 'warn';
  if (audits.some((audit) => audit.status === 'pass')) return 'pass';
  return 'unknown';
}

async function skillsShJson<T>(path: string): Promise<T> {
  const response = await skillsShFetch(path);
  const data = (await response.json().catch(() => ({}))) as T & { error?: string; message?: string };
  if (!response.ok) {
    throw marketplaceFetchError(response.status, data);
  }
  return data;
}

async function skillsShFetch(path: string): Promise<Response> {
  const token = skillsShToken();
  if (!token) {
    throw new SkillMarketplaceError('skills_marketplace_auth_required', 'skills.sh API requires VERCEL_OIDC_TOKEN or SKILLS_SH_OIDC_TOKEN.', 401);
  }
  return fetch(`${SKILLS_SH_BASE_URL}${path}`, {
    headers: { Authorization: `Bearer ${token}` },
    cache: 'no-store',
  });
}

function marketplaceFetchError(status: number, data: { error?: string; message?: string }): SkillMarketplaceError {
  return new SkillMarketplaceError(data.error ?? `skills_sh_http_${status}`, data.message ?? `skills.sh API failed with HTTP ${status}.`, status);
}

function normalizeMarketplaceId(id: string): string {
  const clean = id.trim().replace(/^\/+|\/+$/g, '').replace(/\/+/g, '/');
  if (!clean || clean.includes('..')) {
    throw new SkillMarketplaceError('skill_id_invalid', 'Marketplace skill id is invalid.', 400);
  }
  return clean;
}

function marketplacePath(id: string): string {
  return normalizeMarketplaceId(id).split('/').map(encodeURIComponent).join('/');
}

function normalizeRelativePath(path: string): string | undefined {
  const normalized = path.replace(/\\/g, '/').replace(/^\/+/, '').replace(/\/+/g, '/');
  if (!normalized || normalized === '.' || normalized.includes('../') || normalized.startsWith('..')) {
    return undefined;
  }
  return normalized;
}

function stringField(value: unknown): string | undefined {
  return typeof value === 'string' ? value.trim() || undefined : undefined;
}

function textField(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function numberField(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

function clampInteger(value: unknown, min: number, max: number, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value)
    ? Math.min(max, Math.max(min, Math.floor(value)))
    : fallback;
}

function readNested(value: unknown, path: string[]): unknown {
  let current = value;
  for (const key of path) {
    if (!current || typeof current !== 'object') return undefined;
    current = (current as Record<string, unknown>)[key];
  }
  return current;
}

function stripAnsi(value: string): string {
  return value.replace(/\x1B(?:[@-Z\\-_]|\[[0-?]*[ -/]*[@-~])/g, '');
}

function decodeHtmlEntities(value: string): string {
  return value
    .replace(/&quot;/g, '"')
    .replace(/&#x27;/g, "'")
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>');
}

function isNotFound(error: unknown): boolean {
  return Boolean(error && typeof error === 'object' && 'code' in error && (error as { code?: string }).code === 'ENOENT');
}
