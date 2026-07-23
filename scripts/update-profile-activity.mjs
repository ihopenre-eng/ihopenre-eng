import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

const USERNAME = process.env.PROFILE_USERNAME ?? 'ihopenre-eng';
const README_PATH = process.env.PROFILE_README ?? 'README.md';
const TOKEN = process.env.GITHUB_TOKEN;
const MAX_PRS = 10;
const PROFILE_REPOSITORY = `${USERNAME}/${USERNAME}`.toLowerCase();
const MAX_ADVISORY_PAGES = Number(process.env.MAX_ADVISORY_PAGES ?? 10);
const ADVISORY_LOOKBACK_DAYS = Number(process.env.ADVISORY_LOOKBACK_DAYS ?? 14);
// The advisory API is queried by modification window, so a credit stops being
// returned once it goes quiet. Credits are earned permanently, so every one that
// has ever been seen is kept on disk and merged back in on each run.
const CREDITS_STORE_PATH = process.env.PROFILE_CREDITS_STORE ?? 'data/security-credits.json';

const headers = {
  Accept: 'application/vnd.github+json',
  'X-GitHub-Api-Version': '2026-03-10',
  ...(TOKEN ? { Authorization: `Bearer ${TOKEN}` } : {}),
};

const ASSET_BASE = `https://raw.githubusercontent.com/${USERNAME}/${USERNAME}/main/assets`;

const escapeCell = (value) => String(value ?? '').replaceAll('|', '\\|').replaceAll('\n', ' ').trim();
const escapeHtml = (value) =>
  String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll('\n', ' ')
    .trim();
const shortDate = (value) => value ? new Date(value).toISOString().slice(0, 10) : '-';
const prettyCreditType = (value) => String(value ?? 'contributor').replaceAll('_', ' ');

async function api(url) {
  const response = await fetch(url, { headers });
  if (!response.ok) throw new Error(`GitHub API ${response.status}: ${url}`);
  return { data: await response.json(), link: response.headers.get('link') };
}

function nextLink(link) {
  if (!link) return null;
  return link.split(',').map((part) => part.trim()).find((part) => part.endsWith('rel="next"'))?.match(/<([^>]+)>/)?.[1] ?? null;
}

// This section is meant for upstream contributions only. `is:public` keeps private
// work out of a public README even when the script runs with a broadly scoped token,
// and `-user:` drops pull requests opened against the author's own repositories and forks.
async function searchPullRequests(qualifiers, limit) {
  const query = encodeURIComponent(`author:${USERNAME} is:pr is:public -user:${USERNAME} ${qualifiers}`);
  const { data } = await api(`https://api.github.com/search/issues?q=${query}&sort=updated&order=desc&per_page=${limit}`);
  return (data.items ?? []).filter((item) => {
    const [owner, name] = item.repository_url?.split('/').slice(-2) ?? [];
    if (!owner || !name) return false;
    if (owner.toLowerCase() === USERNAME.toLowerCase()) return false;
    if (`${owner}/${name}`.toLowerCase() === PROFILE_REPOSITORY) return false;
    return item.user?.login?.toLowerCase() === USERNAME.toLowerCase();
  });
}

// 공개 프로필에는 완료된 upstream 기여만 표시한다.
async function fetchPullRequests() {
  const items = await searchPullRequests('is:merged', MAX_PRS);
  const details = await Promise.all(items.map((item) => fetchPullRequestDetail(item)));
  return items.map((item, index) => ({ ...item, detail: details[index] }));
}

// The search API omits diff size, so pull it per item to fill out the status column.
async function fetchPullRequestDetail(item) {
  if (!item.pull_request?.url) return null;
  try {
    const { data } = await api(item.pull_request.url);
    return {
      additions: data.additions,
      deletions: data.deletions,
      changedFiles: data.changed_files,
      mergedAt: data.merged_at,
    };
  } catch (error) {
    console.warn(`Skipping diff stats for ${item.html_url}: ${error.message}`);
    return null;
  }
}

const byNewest = (a, b) => new Date(b.updatedAt ?? 0) - new Date(a.updatedAt ?? 0);

async function fetchSecurityCredits() {
  const since = new Date(Date.now() - ADVISORY_LOOKBACK_DAYS * 86_400_000).toISOString().slice(0, 10);
  const today = new Date().toISOString().slice(0, 10);
  let url = `https://api.github.com/advisories?type=reviewed&modified=${since}..${today}&sort=updated&direction=desc&per_page=100`;
  const credits = new Map();

  for (let page = 0; url && page < MAX_ADVISORY_PAGES; page += 1) {
    const { data, link } = await api(url);
    for (const advisory of data) {
      const myCredits = (advisory.credits ?? []).filter(
        (credit) => credit.user?.login?.toLowerCase() === USERNAME.toLowerCase(),
      );
      if (myCredits.length) {
        credits.set(advisory.ghsa_id, {
          ghsaId: advisory.ghsa_id,
          htmlUrl: advisory.html_url,
          summary: advisory.summary,
          severity: advisory.severity,
          publishedAt: advisory.published_at,
          updatedAt: advisory.updated_at,
          types: myCredits.map((credit) => prettyCreditType(credit.type)),
        });
      }
    }
    url = nextLink(link);
  }

  return [...credits.values()].sort(byNewest);
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

// Freshly fetched advisories win, so a re-published summary or severity still lands.
function mergeCredits(stored, fetched) {
  const merged = new Map(stored.map((entry) => [entry.ghsaId, entry]));
  for (const entry of fetched) merged.set(entry.ghsaId, entry);
  return [...merged.values()].sort(byNewest);
}

const PILL = {
  Merged: { file: 'pill-merged.svg', width: 82 },
  Open: { file: 'pill-open.svg', width: 66 },
  Closed: { file: 'pill-closed.svg', width: 76 },
};

// Splits `fix(scope): title` into a chip and the remaining summary.
function splitConventionalTitle(title) {
  const match = /^([a-z]+(?:\([^)]*\))?!?):\s*(.+)$/i.exec(String(title ?? '').trim());
  return match ? { tag: match[1], text: match[2] } : { tag: null, text: String(title ?? '').trim() };
}

// Diff size and landing date, stacked under the status pill.
function renderStats(item, state) {
  const detail = item.detail;
  if (!detail || typeof detail.additions !== 'number') return '';

  const files = detail.changedFiles === 1 ? '1 file' : `${detail.changedFiles} files`;
  const date = shortDate(state === 'Merged' ? detail.mergedAt ?? item.closed_at : item.created_at);
  return (
    `<br /><sub><code>+${detail.additions} -${detail.deletions}</code></sub>` +
    `<br /><sub>${files} · ${date}</sub>`
  );
}

function renderPrs(items) {
  if (!items.length) return '_No public pull requests detected yet. This section updates automatically._';

  const rows = items.flatMap((item) => {
    const repo = item.repository_url?.split('/').slice(-2).join('/') ?? 'repository';
    const [org] = repo.split('/');
    const state = item.state === 'closed' ? (item.pull_request?.merged_at ? 'Merged' : 'Closed') : 'Open';
    const pill = PILL[state];
    const { tag, text } = splitConventionalTitle(item.title);
    const chip = tag ? `<code>${escapeHtml(tag)}</code> ` : '';

    return [
      '<tr>',
      `<td width="44" align="center"><a href="https://github.com/${encodeURIComponent(org)}"><img src="https://github.com/${encodeURIComponent(org)}.png?size=64" width="28" height="28" alt="${escapeHtml(org)}" /></a></td>`,
      `<td><a href="${item.html_url}"><b>${escapeHtml(repo)}</b></a><br /><sub>${chip}${escapeHtml(text)}</sub></td>`,
      `<td width="168" align="right"><a href="${item.html_url}"><img src="${ASSET_BASE}/${pill.file}" width="${pill.width}" height="24" alt="${state}" /></a>${renderStats(item, state)}</td>`,
      '</tr>',
    ];
  });

  return [
    '<table>',
    '<tr>',
    '<th colspan="2" align="left"><sub>PROJECT · CONTRIBUTION</sub></th>',
    '<th align="right"><sub>STATUS</sub></th>',
    '</tr>',
    ...rows,
    '</table>',
  ].join('\n');
}

function renderCredits(items) {
  if (!items.length) return '_No public GitHub Advisory credits detected yet. This section updates automatically._';
  const rows = items.map((entry) =>
    `| [${entry.ghsaId}](${entry.htmlUrl}) | ${escapeCell(entry.summary)} | ${escapeCell((entry.types ?? []).join(', '))} | ${escapeCell(entry.severity ?? 'unknown')} | ${shortDate(entry.publishedAt)} |`,
  );
  return ['| Advisory | Summary | Credit | Severity | Published |', '| :-- | :-- | :-- | :-- | :-- |', ...rows].join('\n');
}

function replaceSection(readme, name, content) {
  const start = `<!-- ${name}:START -->`;
  const end = `<!-- ${name}:END -->`;
  const escapeRegex = (value) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const pattern = new RegExp(`(${escapeRegex(start)})[\\s\\S]*?(${escapeRegex(end)})`);
  if (!pattern.test(readme)) throw new Error(`Missing generated section: ${name}`);
  return readme.replace(pattern, `${start}\n${content}\n${end}`);
}

const [pullRequests, freshCredits, storedCredits, originalReadme] = await Promise.all([
  fetchPullRequests(),
  fetchSecurityCredits(),
  readCreditsStore(),
  readFile(README_PATH, 'utf8'),
]);

const securityCredits = mergeCredits(storedCredits, freshCredits);
const serializedCredits = `${JSON.stringify(securityCredits, null, 2)}\n`;

let updatedReadme = replaceSection(originalReadme, 'OSS-PRS', renderPrs(pullRequests));
updatedReadme = replaceSection(updatedReadme, 'SECURITY-CREDITS', renderCredits(securityCredits));

if (updatedReadme !== originalReadme) await writeFile(README_PATH, updatedReadme);

// Always written, so the commit step in CI can name the path unconditionally.
await mkdir(dirname(CREDITS_STORE_PATH), { recursive: true });
await writeFile(CREDITS_STORE_PATH, serializedCredits);

const state = updatedReadme === originalReadme ? 'already current' : 'updated';
console.log(`Profile activity ${state}: ${pullRequests.length} PRs, ${securityCredits.length} security credits.`);
