import { basename } from "node:path";
const MAX_SUMMARY_LENGTH = 2800;
const MAX_ITEM_LENGTH = 500;
const MAX_ITEMS = 10;
export function buildNotificationCard(input, config) {
    const status = normalizeStatus(input.status);
    const title = truncate(input.title || config.defaultTitle, 80);
    const effectiveCwd = input.cwd || config.codex.cwd;
    const elements = [];
    elements.push(markdownBlock([
        `**Status:** ${escapeMarkdownValue(statusLabel(status))}`,
        `**Source:** ${escapeMarkdownValue(input.source || "agent")}`,
        `**Project:** ${escapeMarkdownValue(projectLabel(effectiveCwd))}`,
        `**Codex session:** ${escapeMarkdownValue(sessionLabel(config))}`
    ].join("\n")));
    elements.push({ tag: "hr" });
    elements.push(sectionBlock("Summary", truncate(input.summary, MAX_SUMMARY_LENGTH)));
    if (effectiveCwd) {
        elements.push(sectionBlock("Working directory", escapeMarkdownValue(effectiveCwd)));
    }
    appendStringList(elements, "Artifacts", input.artifacts);
    appendLinks(elements, input.links);
    appendStringList(elements, "Next steps", input.nextSteps);
    return {
        schema: "2.0",
        config: {
            update_multi: true,
            wide_screen_mode: true
        },
        header: {
            template: statusTemplate(status),
            title: {
                tag: "plain_text",
                content: title
            }
        },
        body: {
            elements
        }
    };
}
export function normalizeStatus(status) {
    if (status === "success" ||
        status === "failed" ||
        status === "needs_action" ||
        status === "info") {
        return status;
    }
    return "info";
}
function appendStringList(elements, title, values) {
    if (!values || values.length === 0)
        return;
    const lines = values
        .slice(0, MAX_ITEMS)
        .map((value, index) => `${index + 1}. ${truncate(value, MAX_ITEM_LENGTH)}`);
    if (values.length > MAX_ITEMS) {
        lines.push(`${MAX_ITEMS + 1}. ...and ${values.length - MAX_ITEMS} more`);
    }
    elements.push(sectionBlock(title, lines.join("\n")));
}
function appendLinks(elements, links) {
    if (!links || links.length === 0)
        return;
    const lines = links.slice(0, MAX_ITEMS).map((link) => {
        const label = truncate(link.label || link.url, 80);
        return `[${escapeMarkdownLabel(label)}](${link.url})`;
    });
    if (links.length > MAX_ITEMS) {
        lines.push(`...and ${links.length - MAX_ITEMS} more`);
    }
    elements.push(sectionBlock("Links", lines.join("\n")));
}
function sectionBlock(title, content) {
    return markdownBlock(`**${escapeMarkdownLabel(title)}**\n${content}`);
}
function markdownBlock(content) {
    return {
        tag: "markdown",
        content: sanitizeRichText(content)
    };
}
function statusLabel(status) {
    switch (status) {
        case "success":
            return "Success";
        case "failed":
            return "Failed";
        case "needs_action":
            return "Needs action";
        case "info":
            return "Info";
    }
}
function statusTemplate(status) {
    switch (status) {
        case "success":
            return "green";
        case "failed":
            return "red";
        case "needs_action":
            return "orange";
        case "info":
            return "blue";
    }
}
function projectLabel(cwd) {
    if (!cwd)
        return "(unknown)";
    return basename(cwd) || cwd;
}
function sessionLabel(config) {
    if (config.codex.sessionTitle) {
        const suffix = config.codex.sessionId ? ` (#${shortSessionId(config.codex.sessionId)})` : "";
        return `${config.codex.sessionTitle}${suffix}`;
    }
    if (config.codex.sessionId)
        return `#${shortSessionId(config.codex.sessionId)}`;
    if (config.codex.useLast)
        return "useLast(latest Codex session)";
    return "(unbound)";
}
function shortSessionId(sessionId) {
    return sessionId.slice(0, 8);
}
function truncate(value, maxLength) {
    if (value.length <= maxLength)
        return value;
    return `${value.slice(0, maxLength - 13)}... [truncated]`;
}
function sanitizeRichText(value) {
    return value;
}
function escapeMarkdownLabel(value) {
    return escapeMarkdownValue(value);
}
function escapeMarkdownValue(value) {
    return value.replaceAll("\\", "\\\\").replaceAll("*", "\\*").replaceAll("_", "\\_");
}
