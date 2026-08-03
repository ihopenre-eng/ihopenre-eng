import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

const USERNAME = process.env.PROFILE_USERNAME ?? 'ihopenre-eng';
const README_PATH = process.env.PROFILE_README ?? 'README.md';
const TOKEN = process.env.GITHUB_TOKEN;
const CREDITS_STORE_PATH = process.env.PROFILE_CREDITS_STORE ?? 'data/security-credits.json';
const ADVISORY_LOOKBACK_DAYS = Number(process.env.ADVISORY_LOOKBACK_DAYS ?? 14);
const MAX_ADVISORY_PAGES = Number(process.env.MAX_ADVISORY_PAGES ?? 10);
const REPOSITORY_ADVISORY_SOURCES = (process.env.PROFILE_ADVISORY_REPOSITORIES ?? 'openchoreo/openchoreo,hatchet-dev/hatchet')
  .split(',')
  .map((repository) => repository.trim())
  .filter(Boolean);

const headers = {
  Accept: 'application/vnd.github+json',
  'X-GitHub-Api-Version': '2026-03-10',
  ...(TOKEN ? { Authorization: `Bearer ${TOKEN}` } : {}),
};

const escapeHtml = (value) =>
  String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll('\n', ' ')
    .trim();
const shortDate = (value) => (value ? new Date(value).toISOString().slice(0, 10) : '-');
const prettyCreditType = (value) => String(value ?? 'contributor').replaceAll('_', ' ');
const severityRank = { critical: 4, high: 3, moderate: 2, medium: 2, low: 1 };

async function api(url) {
  const response = await fetch(url, { headers });
  if (!response.ok) throw new Error(`GitHub API ${response.status}: ${url}`);
  return { data: await response.json(), link: response.headers.get('link') };
}

function nextLink(link) {
  if (!link) return null;
  return link
    .split(',')
    .map((part) => part.trim())
    .find((part) => part.endsWith('rel="next"'))
    ?.match(/<([^>]+)>/)?.[1] ?? null;
}

function isMyCredit(credit) {
  const login = credit.user?.login ?? credit.login;
  return String(login ?? '').toLowerCase() === USERNAME.toLowerCase();
}

function toCredit(advisory) {
  if (advisory.state && advisory.state !== 'published') return null;
  if (!advisory.published_at) return null;
  const credits = (advisory.credits ?? []).filter(isMyCredit);
  if (!credits.length) return null;

  return {
    ghsaId: advisory.ghsa_id,
    cveId: advisory.cve_id ?? null,
    htmlUrl: advisory.html_url,
    summary: advisory.summary,
    severity: advisory.severity,
    publishedAt: advisory.published_at,
    updatedAt: advisory.updated_at,
    types: credits.map((credit) => prettyCreditType(credit.type)),
  };
}

async function fetchGlobalAdvisories() {
  const since = new Date(Date.now() - ADVISORY_LOOKBACK_DAYS * 86_400_000).toISOString().slice(0, 10);
  const today = new Date().toISOString().slice(0, 10);
  let url = `https://api.github.com/advisories?type=reviewed&modified=${since}..${today}&sort=updated&direction=desc&per_page=100`;
  const credits = [];

  for (let page = 0; url && page < MAX_ADVISORY_PAGES; page += 1) {
    const { data, link } = await api(url);
    for (const advisory of data) {
      const credit = toCredit(advisory);
      if (credit) credits.push(credit);
    }
    url = nextLink(link);
  }

  return credits;
}

async function fetchRepositoryAdvisories(repository) {
  let url = `https://api.github.com/repos/${repository}/security-advisories?per_page=100`;
  const credits = [];

  for (let page = 0; url && page < MAX_ADVISORY_PAGES; page += 1) {
    const { data, link } = await api(url);
    for (const advisory of data) {
      const credit = toCredit(advisory);
      if (credit) credits.push(credit);
    }
    url = nextLink(link);
  }

  return credits;
}

function byImportance(left, right) {
  const severityDelta = (severityRank[right.severity] ?? 0) - (severityRank[left.severity] ?? 0);
  return severityDelta || new Date(right.publishedAt ?? 0) - new Date(left.publishedAt ?? 0);
}

async function fetchSecurityCredits() {
  const credits = new Map();
  const discovered = await fetchGlobalAdvisories();

  for (const repository of REPOSITORY_ADVISORY_SOURCES) {
    try {
      discovered.push(...await fetchRepositoryAdvisories(repository));
    } catch (error) {
      console.warn(`Skipping repository advisories for ${repository}: ${error.message}`);
    }
  }

  for (const credit of discovered) credits.set(credit.ghsaId, credit);
  return [...credits.values()].sort(byImportance);
}

async function readCreditsStore() {
  try {
    const parsed = JSON.parse(await readFile(CREDITS_STORE_PATH, 'utf8'));
    return Array.isArray(parsed) ? parsed.filter((entry) => entry?.ghsaId) : [];
  } catch (error) {
    if (error.code !== 'ENOENT') console.warn(`Ignoring unreadable credits store: ${error.message}`);
    return [];
  }
}

function mergeCredits(stored, fetched) {
  const merged = new Map(stored.map((entry) => [entry.ghsaId, entry]));
  for (const entry of fetched) merged.set(entry.ghsaId, entry);
  return [...merged.values()].sort(byImportance);
}

function renderCredits(items) {
  if (!items.length) return '_No public CVE or GitHub Advisory credits detected yet. This section updates automatically._';

  return items.map((entry) => {
    const identifier = entry.cveId ? `${entry.cveId} · ${entry.ghsaId}` : entry.ghsaId;
    const severity = String(entry.severity ?? 'unknown').toUpperCase();
    const credit = (entry.types ?? []).join(', ');
    return `- **[${identifier}](${entry.htmlUrl})** · \`${severity}\`<br />\n  <sub>${escapeHtml(entry.summary)} · ${escapeHtml(credit)} · ${shortDate(entry.publishedAt)}</sub>`;
  }).join('\n\n');
}

function replaceSection(readme, name, content) {
  const start = `<!-- ${name}:START -->`;
  const end = `<!-- ${name}:END -->`;
  const escapeRegex = (value) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const pattern = new RegExp(`(${escapeRegex(start)})[\\s\\S]*?(${escapeRegex(end)})`);
  if (!pattern.test(readme)) throw new Error(`Missing generated section: ${name}`);
  return readme.replace(pattern, `${start}\n${content}\n${end}`);
}

const [freshCredits, storedCredits, originalReadme] = await Promise.all([
  fetchSecurityCredits(),
  readCreditsStore(),
  readFile(README_PATH, 'utf8'),
]);

const securityCredits = mergeCredits(storedCredits, freshCredits);
const serializedCredits = `${JSON.stringify(securityCredits, null, 2)}\n`;
const updatedReadme = replaceSection(originalReadme, 'SECURITY-CREDITS', renderCredits(securityCredits));

if (updatedReadme !== originalReadme) await writeFile(README_PATH, updatedReadme);
await mkdir(dirname(CREDITS_STORE_PATH), { recursive: true });
await writeFile(CREDITS_STORE_PATH, serializedCredits);

console.log(`Security credits ${updatedReadme === originalReadme ? 'already current' : 'updated'}: ${securityCredits.length}.`);
