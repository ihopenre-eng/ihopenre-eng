import { readFile, writeFile } from 'node:fs/promises';

const USERNAME = process.env.PROFILE_USERNAME ?? 'ihopenre-eng';
const README_PATH = process.env.PROFILE_README ?? 'README.md';
const TOKEN = process.env.GITHUB_TOKEN;
const MAX_PRS = 8;
const PROFILE_REPOSITORY = `${USERNAME}/${USERNAME}`.toLowerCase();
const MAX_ADVISORY_PAGES = Number(process.env.MAX_ADVISORY_PAGES ?? 10);
const ADVISORY_LOOKBACK_DAYS = Number(process.env.ADVISORY_LOOKBACK_DAYS ?? 14);

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

async function searchPullRequests(qualifiers) {
  const query = encodeURIComponent(`author:${USERNAME} is:pr -repo:${PROFILE_REPOSITORY} ${qualifiers}`);
  const { data } = await api(`https://api.github.com/search/issues?q=${query}&sort=updated&order=desc&per_page=${MAX_PRS}`);
  return (data.items ?? []).filter(
    (item) => item.repository_url?.split('/').slice(-2).join('/').toLowerCase() !== PROFILE_REPOSITORY,
  );
}

async function fetchPullRequests() {
  const [merged, active] = await Promise.all([
    searchPullRequests('is:merged'),
    searchPullRequests('-is:merged'),
  ]);

  const unique = new Map();
  for (const item of [...merged, ...active]) unique.set(item.html_url, item);
  return [...unique.values()].slice(0, MAX_PRS);
}

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
        credits.set(advisory.ghsa_id, { advisory, types: myCredits.map((credit) => prettyCreditType(credit.type)) });
      }
    }
    url = nextLink(link);
  }

  return [...credits.values()].sort((a, b) => new Date(b.advisory.updated_at) - new Date(a.advisory.updated_at));
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
      `<td width="96" align="right"><a href="${item.html_url}"><img src="${ASSET_BASE}/${pill.file}" width="${pill.width}" height="24" alt="${state}" /></a></td>`,
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
  const rows = items.map(({ advisory, types }) =>
    `| [${advisory.ghsa_id}](${advisory.html_url}) | ${escapeCell(advisory.summary)} | ${escapeCell(types.join(', '))} | ${escapeCell(advisory.severity ?? 'unknown')} | ${shortDate(advisory.published_at)} |`,
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

const [pullRequests, securityCredits, originalReadme] = await Promise.all([
  fetchPullRequests(),
  fetchSecurityCredits(),
  readFile(README_PATH, 'utf8'),
]);

let updatedReadme = replaceSection(originalReadme, 'OSS-PRS', renderPrs(pullRequests));
updatedReadme = replaceSection(updatedReadme, 'SECURITY-CREDITS', renderCredits(securityCredits));

if (updatedReadme !== originalReadme) {
  await writeFile(README_PATH, updatedReadme);
  console.log(`Updated profile activity: ${pullRequests.length} PRs, ${securityCredits.length} security credits.`);
} else {
  console.log(`Profile activity already current: ${pullRequests.length} PRs, ${securityCredits.length} security credits.`);
}
