import { mkdir, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

const USERNAME = process.env.PROFILE_USERNAME ?? 'ihopenre-eng';
const TOKEN = process.env.GITHUB_TOKEN;
const ACTIVITY_PATH = 'assets/github-activity.svg';
const LANGUAGES_PATH = 'assets/top-languages.svg';

if (!TOKEN) throw new Error('GITHUB_TOKEN is required to generate profile statistic cards.');

const escapeXml = (value) => String(value ?? '')
  .replaceAll('&', '&amp;')
  .replaceAll('<', '&lt;')
  .replaceAll('>', '&gt;')
  .replaceAll('"', '&quot;');
const formatNumber = (value) => new Intl.NumberFormat('en-US').format(value ?? 0);

async function graphql(query, variables) {
  const response = await fetch('https://api.github.com/graphql', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${TOKEN}`,
      'Content-Type': 'application/json',
      'X-GitHub-Api-Version': '2026-03-10',
    },
    body: JSON.stringify({ query, variables }),
  });
  const body = await response.json();
  if (!response.ok || body.errors?.length) {
    throw new Error(body.errors?.map((error) => error.message).join('; ') ?? `GitHub API ${response.status}`);
  }
  return body.data;
}

function svgFrame(width, height, label, content) {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" role="img" aria-label="${escapeXml(label)}">
  <rect x="0.5" y="0.5" width="${width - 1}" height="${height - 1}" rx="12" fill="#0d1117" stroke="#30363d" />
  <style>
    .label { fill: #8b949e; font: 600 11px -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; letter-spacing: 1.2px; }
    .value { fill: #f0f6fc; font: 700 27px -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; }
    .meta { fill: #8b949e; font: 500 12px -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; }
    .language { fill: #c9d1d9; font: 600 12px -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; }
  </style>
  ${content}
</svg>`;
}

function renderActivityCard(contributions) {
  const metrics = [
    ['COMMITS', contributions.totalCommitContributions],
    ['PULL REQUESTS', contributions.totalPullRequestContributions],
    ['REVIEWS', contributions.totalPullRequestReviewContributions],
    ['ISSUES', contributions.totalIssueContributions],
  ];
  const positions = [28, 144, 260, 376];
  const metricSvg = metrics.map(([label, value], index) => `
    <text class="label" x="${positions[index]}" y="96">${label}</text>
    <text class="value" x="${positions[index]}" y="132">${formatNumber(value)}</text>`).join('');
  return svgFrame(492, 170, 'Public GitHub activity over the last 12 months', `
    <rect x="28" y="28" width="4" height="28" rx="2" fill="#58a6ff" />
    <text class="label" x="44" y="40">PUBLIC GITHUB ACTIVITY</text>
    <text class="meta" x="44" y="58">LAST 12 MONTHS</text>
    <path d="M28 76H464" stroke="#21262d" />${metricSvg}`);
}

function renderLanguagesCard(languages) {
  const maxBytes = Math.max(...languages.map((language) => language.size), 1);
  const rows = languages.map((language, index) => {
    const y = 58 + index * 23;
    const width = Math.max(5, Math.round((language.size / maxBytes) * 150));
    const color = /^#[0-9a-f]{6}$/i.test(language.color ?? '') ? language.color : '#8b949e';
    return `
      <text class="language" x="28" y="${y + 10}">${escapeXml(language.name)}</text>
      <rect x="145" y="${y}" width="160" height="9" rx="4.5" fill="#21262d" />
      <rect x="145" y="${y}" width="${width}" height="9" rx="4.5" fill="${color}" />
      <text class="meta" x="318" y="${y + 10}">${language.percent}%</text>`;
  }).join('');
  return svgFrame(360, 170, 'Top languages across public non-fork repositories', `
    <rect x="28" y="28" width="4" height="28" rx="2" fill="#a371f7" />
    <text class="label" x="44" y="40">TOP LANGUAGES</text>
    <text class="meta" x="44" y="58">PUBLIC NON-FORK REPOS</text>${rows}`);
}

const now = new Date();
const from = new Date(now);
from.setUTCDate(from.getUTCDate() - 365);
const query = `
  query ProfileStats($login: String!, $from: DateTime!, $to: DateTime!) {
    user(login: $login) {
      contributionsCollection(from: $from, to: $to) {
        totalCommitContributions
        totalPullRequestContributions
        totalPullRequestReviewContributions
        totalIssueContributions
      }
      repositories(first: 100, ownerAffiliations: OWNER, isFork: false, privacy: PUBLIC, orderBy: {field: UPDATED_AT, direction: DESC}) {
        nodes {
          languages(first: 10, orderBy: {field: SIZE, direction: DESC}) {
            edges { size node { name color } }
          }
        }
      }
    }
  }
`;

const { user } = await graphql(query, { login: USERNAME, from: from.toISOString(), to: now.toISOString() });
const totals = new Map();
for (const repository of user.repositories.nodes) {
  for (const edge of repository.languages.edges) {
    const current = totals.get(edge.node.name) ?? { name: edge.node.name, color: edge.node.color, size: 0 };
    current.size += edge.size;
    totals.set(edge.node.name, current);
  }
}

const totalBytes = [...totals.values()].reduce((sum, language) => sum + language.size, 0) || 1;
const languages = [...totals.values()]
  .sort((left, right) => right.size - left.size)
  .slice(0, 5)
  .map((language) => ({ ...language, percent: Math.round((language.size / totalBytes) * 100) }));

await Promise.all([
  mkdir(dirname(ACTIVITY_PATH), { recursive: true }),
  mkdir(dirname(LANGUAGES_PATH), { recursive: true }),
]);
await Promise.all([
  writeFile(ACTIVITY_PATH, renderActivityCard(user.contributionsCollection)),
  writeFile(LANGUAGES_PATH, renderLanguagesCard(languages)),
]);

console.log(`Profile statistic cards updated: ${formatNumber(user.contributionsCollection.totalCommitContributions)} commits, ${formatNumber(user.contributionsCollection.totalPullRequestContributions)} PRs.`);
