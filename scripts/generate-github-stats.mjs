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
    throw new Error("GITHUB_TOKEN or GH_TOKEN is required to query GitHub Search API.");
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

// Keep collection and rendering in one flow so each scheduled run updates the SVG and README together.
async function main() {
    const [commits, pullRequests, issues] = await Promise.all([
        fetchMetricGroup("commit"),
        fetchMetricGroup("pullRequest"),
        fetchMetricGroup("issue"),
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

    await writeStatsSvg(stats);
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

// Preserve the SVG mtime when only the generated "Updated" date would change.
async function writeStatsSvg(stats) {
    const nextSvg = renderSvg(stats);
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
function renderSvg(stats) {
    const width = 760;
    const height = 430;
    const x = 42;
    const headerY = 96;
    const rowHeight = 68;
    const columns = [
        { label: "Total", key: "total", x: 292 },
        { label: `${currentYear}`, key: "current", x: 468 },
        { label: `${previousYear}`, key: "previous", x: 624 },
    ];

    const rows = stats
        .map((item, index) => {
            const y = headerY + 42 + index * rowHeight;
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
        <line x1="${x}" y1="${y - 30}" x2="${width - x}" y2="${y - 30}" class="divider" />
        <text x="${x}" y="${y + 7}" class="metric">${escapeXml(item.label)}</text>${cells}
    </g>`;
        })
        .join("");

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
    )}.</desc>
    <style>
        .bg { fill: #ffffff; }
        .border { fill: none; stroke: #d0d7de; }
        .title { fill: #24292f; font: 700 24px -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }
        .subtitle { fill: #57606a; font: 500 13px -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }
        .column { fill: #6e7781; font: 700 13px -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }
        .metric { fill: #24292f; font: 700 16px -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }
        .value { fill: #0969da; font: 700 23px -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }
        .divider { stroke: #d8dee4; stroke-width: 1; }
        .footnote { fill: #6e7781; font: 500 12px -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }
    </style>
    <rect class="bg" x="0.5" y="0.5" width="${width - 1}" height="${height - 1}" rx="8" />
    <rect class="border" x="0.5" y="0.5" width="${width - 1}" height="${height - 1}" rx="8" />
    <text x="${x}" y="48" class="title">GitHub Stats</text>
    <text x="${x}" y="${headerY}" class="column">Metric</text>${headerColumns}
${rows}
    <line x1="${x}" y1="${height - 60}" x2="${width - x}" y2="${height - 60}" class="divider" />
    <text x="${x}" y="${height - 30}" class="footnote">Updated ${escapeXml(
        dateFormatter.format(new Date()),
    )} (${escapeXml(timeZone)}) · Contributions are commits + pull requests + issues.</text>
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
        /Updated .*? \([^)]*\) · Contributions are commits \+ pull requests \+ issues\./,
        "Updated DATE (TIME_ZONE) · Contributions are commits + pull requests + issues.",
    );
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
