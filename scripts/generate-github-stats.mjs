#!/usr/bin/env node

import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

const username =
    process.env.GITHUB_STATS_USERNAME ||
    process.env.GITHUB_REPOSITORY_OWNER ||
    process.argv[2];
const token = process.env.GITHUB_TOKEN || process.env.GH_TOKEN;
const svgPath = process.env.GITHUB_STATS_SVG_PATH || "assets/github-stats.svg";
const readmePath = process.env.GITHUB_STATS_README_PATH || "README.md";
const timeZone = process.env.GITHUB_STATS_TIME_ZONE || "Asia/Tokyo";

if (!username) {
    throw new Error(
        "GITHUB_STATS_USERNAME, GITHUB_REPOSITORY_OWNER, or a username argument is required.",
    );
}

if (!token) {
    throw new Error("GITHUB_TOKEN or GH_TOKEN is required to query GitHub API.");
}

const currentYear = Number(
    new Intl.DateTimeFormat("en", { timeZone, year: "numeric" }).format(new Date()),
);
const previousYear = currentYear - 1;
const numberFormatter = new Intl.NumberFormat("en-US");
const dateFormatter = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "short",
    day: "numeric",
});

const ranges = {
    total: null,
    current: {
        start: `${currentYear}-01-01`,
        end: `${currentYear}-12-31`,
    },
    previous: {
        start: `${previousYear}-01-01`,
        end: `${previousYear}-12-31`,
    },
};
const excludedCommitRepositories = ["naoigcat/naoigcat"];

// Keep collection and rendering in one flow so each scheduled run updates the SVG and README together.
async function main() {
    const [commits, pullRequests, issues, languages] = await Promise.all([
        fetchMetricGroup("commit"),
        fetchMetricGroup("pullRequest"),
        fetchMetricGroup("issue"),
        fetchLanguageRanking(),
    ]);

    const contributions = {
        total: commits.total + pullRequests.total + issues.total,
        current: commits.current + pullRequests.current + issues.current,
        previous: commits.previous + pullRequests.previous + issues.previous,
    };

    const stats = [
        { label: "Commits", values: commits },
        { label: "Pull Requests", values: pullRequests },
        { label: "Issues", values: issues },
        { label: "Contributions", values: contributions },
    ];

    await writeStatsSvg(stats, languages);
    await updateReadme();
}

// Query every reporting range through the same metric path to keep totals comparable.
async function fetchMetricGroup(kind) {
    const entries = await Promise.all(
        Object.entries(ranges).map(async ([key, range]) => [
            key,
            await fetchSearchCount(kind, range),
        ]),
    );

    return Object.fromEntries(entries);
}

// Use GitHub Search counts because the card only needs aggregate public activity.
async function fetchSearchCount(kind, range) {
    const url = new URL(`https://api.github.com/search/${searchEndpoint(kind)}`);
    url.searchParams.set("q", searchQuery(kind, range));
    url.searchParams.set("per_page", "1");

    const response = await fetch(url, {
        headers: {
            Accept: "application/vnd.github+json",
            Authorization: `Bearer ${token}`,
            "X-GitHub-Api-Version": "2022-11-28",
        },
    });

    if (!response.ok) {
        const body = await response.text();
        throw new Error(
            `GitHub API request failed (${response.status}) for ${url}: ${body}`,
        );
    }

    const json = await response.json();
    return json.total_count ?? 0;
}

// Centralize the endpoint split because commit search uses a different GitHub resource.
function searchEndpoint(kind) {
    return kind === "commit" ? "commits" : "issues";
}

// Build conservative public-profile queries so private activity is not surfaced in the SVG.
function searchQuery(kind, range) {
    const parts = [];

    if (kind === "commit") {
        // GitHub's commit search has no public-only qualifier. The default
        // Actions token avoids counting private repositories for this profile.
        parts.push(`author:${username}`);
        // Exclude the profile repository so README automation does not inflate activity totals.
        parts.push(...excludedCommitRepositories.map((repo) => `-repo:${repo}`));
        if (range) {
            parts.push(`committer-date:${range.start}..${range.end}`);
        }
        return parts.join(" ");
    }

    parts.push(`author:${username}`);
    parts.push(kind === "pullRequest" ? "type:pr" : "type:issue");
    parts.push("is:public");
    if (range) {
        parts.push(`created:${range.start}..${range.end}`);
    }

    return parts.join(" ");
}

// Aggregate owned repository languages so forks do not drown out the user's own profile.
async function fetchLanguageRanking() {
    const repos = (await fetchOwnedRepositories()).filter((repo) => !repo.fork);
    const totals = new Map();

    await Promise.all(
        repos.map(async (repo) => {
            const languages = await fetchJson(repo.languages_url);

            for (const [language, bytes] of Object.entries(languages)) {
                totals.set(language, (totals.get(language) ?? 0) + bytes);
            }
        }),
    );

    const totalBytes = [...totals.values()].reduce((sum, bytes) => sum + bytes, 0);

    if (totalBytes === 0) {
        return [];
    }

    return [...totals.entries()]
        .sort(([, leftBytes], [, rightBytes]) => rightBytes - leftBytes)
        .slice(0, 5)
        .map(([name, bytes]) => ({
            name,
            bytes,
            percent: bytes / totalBytes,
            color: languageColor(name),
        }));
}

async function fetchOwnedRepositories() {
    const repos = [];

    for (let page = 1; ; page += 1) {
        const url = new URL(`https://api.github.com/users/${username}/repos`);
        url.searchParams.set("type", "owner");
        url.searchParams.set("per_page", "100");
        url.searchParams.set("page", String(page));

        const pageRepos = await fetchJson(url);
        repos.push(...pageRepos);

        if (pageRepos.length < 100) {
            return repos;
        }
    }
}

async function fetchJson(url) {
    const response = await fetch(url, {
        headers: {
            Accept: "application/vnd.github+json",
            Authorization: `Bearer ${token}`,
            "X-GitHub-Api-Version": "2022-11-28",
        },
    });

    if (!response.ok) {
        const body = await response.text();
        throw new Error(`GitHub API request failed (${response.status}) for ${url}: ${body}`);
    }

    return response.json();
}

// Preserve the SVG mtime when only the generated "Updated" date would change.
async function writeStatsSvg(stats, languages) {
    const nextSvg = renderSvg(stats, languages);
    const currentSvg = await readExistingFile(svgPath);

    if (
        currentSvg !== null &&
        normalizeGeneratedDate(currentSvg) === normalizeGeneratedDate(nextSvg)
    ) {
        return;
    }

    await mkdir(path.dirname(svgPath), { recursive: true });
    await writeFile(svgPath, nextSvg, "utf8");
}

// Render text in English so the generated SVG remains language-consistent for profile viewers.
function renderSvg(stats, languages) {
    const width = 1012;
    const height = 332;
    const x = 30;
    const headerY = 82;
    const rowHeight = 46;
    const statsDividerX = 560;
    const languageX = 602;
    const languageWidth = 350;
    const columns = [
        { label: "Total", key: "total", x: 300 },
        { label: `${currentYear}`, key: "current", x: 430 },
        { label: `${previousYear}`, key: "previous", x: 550 },
    ];

    const rows = stats
        .map((item, index) => {
            const y = headerY + 40 + index * rowHeight;
            const cells = columns
                .map(
                    (column) => `
        <text x="${column.x}" y="${y + 9}" class="value" text-anchor="end">${escapeXml(
                        numberFormatter.format(item.values[column.key]),
                    )}</text>`,
                )
                .join("");

            return `
    <g>
        <line x1="${x}" y1="${y - 30}" x2="${statsDividerX}" y2="${y - 30}" class="divider" />
        <text x="${x}" y="${y + 7}" class="metric">${escapeXml(item.label)}</text>${cells}
    </g>`;
        })
        .join("");

    const languageRows =
        languages.length > 0
            ? languages
                  .map((language, index) => {
                      const y = 112 + index * 34;
                      const percentText = formatPercent(language.percent);
                      const barWidth = Math.max(3, Math.round(languageWidth * language.percent));

                      return `
    <g>
        <circle cx="${languageX + 5}" cy="${y - 4}" r="5" fill="${escapeXml(
                          language.color,
                      )}" />
        <text x="${languageX + 18}" y="${y}" class="language-name">${escapeXml(
                          language.name,
                      )}</text>
        <text x="${width - x}" y="${y}" class="language-percent" text-anchor="end">${escapeXml(
                          percentText,
                      )}</text>
        <rect x="${languageX}" y="${y + 9}" width="${languageWidth}" height="6" rx="3" class="language-bar-bg" />
        <rect x="${languageX}" y="${y + 9}" width="${barWidth}" height="6" rx="3" fill="${escapeXml(
                          language.color,
                      )}" />
    </g>`;
                  })
                  .join("")
            : `
    <text x="${languageX}" y="126" class="empty">No language data</text>`;

    const headerColumns = columns
        .map(
            (column) => `
    <text x="${column.x}" y="${headerY}" class="column" text-anchor="end">${escapeXml(
                column.label,
            )}</text>`,
        )
        .join("");

    return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" role="img" aria-labelledby="title desc">
    <title id="title">${escapeXml(username)} GitHub public repository stats</title>
    <desc id="desc">Public commits, pull requests, issues, and contribution totals for ${escapeXml(
        username,
    )}, with top repository languages.</desc>
    <style>
        .bg { fill: #ffffff; }
        .border { fill: none; stroke: #d0d7de; }
        .title { fill: #24292f; font: 700 20px -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }
        .section { fill: #24292f; font: 700 14px -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }
        .column { fill: #6e7781; font: 700 11px -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }
        .metric { fill: #24292f; font: 700 13px -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }
        .value { fill: #0969da; font: 700 18px -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }
        .language-name { fill: #24292f; font: 600 12px -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }
        .language-percent { fill: #57606a; font: 600 11px -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }
        .language-bar-bg { fill: #eaeef2; }
        .empty { fill: #6e7781; font: 500 12px -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }
        .divider { stroke: #d8dee4; stroke-width: 1; }
        .footnote { fill: #6e7781; font: 500 10px -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }
    </style>
    <rect class="bg" x="0.5" y="0.5" width="${width - 1}" height="${height - 1}" rx="6" />
    <rect class="border" x="0.5" y="0.5" width="${width - 1}" height="${height - 1}" rx="6" />
    <text x="${x}" y="42" class="title">GitHub Stats</text>
    <text x="${x}" y="${headerY}" class="column">Metric</text>${headerColumns}
    <text x="${languageX}" y="${headerY}" class="section">Top Languages</text>
    <line x1="${languageX - 22}" y1="60" x2="${languageX - 22}" y2="${height - 58}" class="divider" />
${rows}
${languageRows}
    <line x1="${x}" y1="${height - 54}" x2="${width - x}" y2="${height - 54}" class="divider" />
    <text x="${x}" y="${height - 30}" class="footnote">Updated ${escapeXml(
        dateFormatter.format(new Date()),
    )} (${escapeXml(timeZone)}) · Public activity and owned repository languages.</text>
</svg>
`;
}

// Maintain a stable README marker block so repeated workflow runs avoid duplicate cards.
async function updateReadme() {
    const start = "<!-- github-stats:start -->";
    const end = "<!-- github-stats:end -->";
    const block = `${start}
![GitHub public repository statistics](./${svgPath})
${end}`;
    const readme = await readFile(readmePath, "utf8");
    const hasStart = readme.includes(start);
    const hasEnd = readme.includes(end);

    if (hasStart !== hasEnd) {
        throw new Error(
            `README contains mismatched GitHub stats markers. Expected both "${start}" and "${end}" or neither.`,
        );
    }

    if (hasStart && hasEnd) {
        const pattern = new RegExp(`${escapeRegExp(start)}[\\s\\S]*?${escapeRegExp(end)}`);
        await writeFileIfChanged(
            readmePath,
            `${readme.replace(pattern, block).trimEnd()}\n`,
        );
        return;
    }

    const lines = readme.split(/\r?\n/);
    const insertIndex = Math.min(2, lines.length);
    lines.splice(insertIndex, 0, block);
    await writeFileIfChanged(readmePath, `${lines.join("\n").trimEnd()}\n`);
}

async function writeFileIfChanged(filePath, contents) {
    if ((await readExistingFile(filePath)) === contents) {
        return;
    }

    await writeFile(filePath, contents, "utf8");
}

async function readExistingFile(filePath) {
    try {
        return await readFile(filePath, "utf8");
    } catch (error) {
        if (error.code === "ENOENT") {
            return null;
        }

        throw error;
    }
}

function normalizeGeneratedDate(svg) {
    return svg.replace(
        /Updated .*? \([^)]*\) · Public activity and owned repository languages\./,
        "Updated DATE (TIME_ZONE) · Public activity and owned repository languages.",
    );
}

function formatPercent(value) {
    const percent = value * 100;

    if (percent >= 10) {
        return `${Math.round(percent)}%`;
    }

    return `${percent.toFixed(1)}%`;
}

function languageColor(language) {
    const colors = {
        CSS: "#663399",
        Dart: "#00b4ab",
        Dockerfile: "#384d54",
        Go: "#00add8",
        HTML: "#e34c26",
        Java: "#b07219",
        JavaScript: "#f1e05a",
        Kotlin: "#a97bff",
        PHP: "#4f5d95",
        Python: "#3572a5",
        Ruby: "#701516",
        Shell: "#89e051",
        Swift: "#f05138",
        TypeScript: "#3178c6",
        Vue: "#41b883",
    };

    return colors[language] ?? "#6e7781";
}

// Escape dynamic values before interpolation because the SVG is generated as a string.
function escapeXml(value) {
    return String(value)
        .replaceAll("&", "&amp;")
        .replaceAll("<", "&lt;")
        .replaceAll(">", "&gt;")
        .replaceAll('"', "&quot;");
}

// Escape marker text before building a replacement regex for the README block.
function escapeRegExp(value) {
    return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

await main();
