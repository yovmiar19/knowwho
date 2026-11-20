// Jira / Confluence REST helpers for KnowWho.
//
// These are the fallback (and, for issue search, the primary) data source.
// Teamwork Graph is the differentiator, but every signal here also has a REST
// path, so the app keeps working if a graph query is unavailable or a scope
// is missing. All helpers answer plain objects and never throw.

import api, { route } from "@forge/api";

const log = (event, data) => console.log(JSON.stringify({ knowwho: event, ...data }));

const STOPWORDS = new Set([
  "the", "a", "an", "and", "or", "of", "to", "in", "on", "for", "with", "is", "are",
  "was", "were", "be", "by", "as", "at", "from", "it", "this", "that", "these", "those",
  "we", "you", "they", "he", "she", "i", "an", "but", "not", "no", "when", "when", "how",
  "please", "should", "would", "could", "can", "will", "fix", "bug", "issue", "error",
]);

// Pull up to 5 distinctive keywords out of free text, for JQL/CQL search.
export function keywordsFrom(text, max = 5) {
  const words = String(text || "")
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, " ")
    .split(/\s+/)
    .filter((w) => w.length > 2 && !STOPWORDS.has(w));
  const seen = new Set();
  const out = [];
  for (const w of words) {
    if (!seen.has(w)) {
      seen.add(w);
      out.push(w);
    }
    if (out.length >= max) break;
  }
  return out;
}

async function jiraGet(path) {
  try {
    const res = await api.asUser().requestJira(route`${path}`);
    if (!res.ok) return { ok: false, status: res.status };
    return { ok: true, data: await res.json() };
  } catch (e) {
    return { ok: false, error: String(e?.message || e) };
  }
}

async function jiraPost(path, body) {
  try {
    const res = await api.asUser().requestJira(route`${path}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!res.ok) return { ok: false, status: res.status };
    return { ok: true, data: await res.json() };
  } catch (e) {
    return { ok: false, error: String(e?.message || e) };
  }
}

async function confluenceGet(path) {
  try {
    const res = await api.asUser().requestConfluence(route`${path}`);
    if (!res.ok) return { ok: false, status: res.status };
    return { ok: true, data: await res.json() };
  } catch (e) {
    return { ok: false, error: String(e?.message || e) };
  }
}

// --- Jira ---

export async function getIssue(key) {
  const r = await jiraGet(
    `/rest/api/3/issue/${encodeURIComponent(key)}?fields=summary,description,components,labels,project,assignee,reporter,status,issuetype`
  );
  if (!r.ok) return { ok: false, error: r.status === 404 ? `${key} does not exist or you cannot see it.` : `Could not read ${key} (${r.status || r.error}).` };
  const f = r.data.fields || {};
  const text = [f.summary, typeof f.description === "string" ? f.description : ""].filter(Boolean).join(" ");
  return {
    ok: true,
    issue: {
      id: r.data.id,
      key: r.data.key,
      summary: f.summary || "",
      text,
      projectKey: f.project?.key || "",
      components: (f.components || []).map((c) => ({ id: c.id, name: c.name })),
      labels: f.labels || [],
      assignee: f.assignee ? { accountId: f.assignee.accountId, name: f.assignee.displayName } : null,
      reporter: f.reporter ? { accountId: f.reporter.accountId, name: f.reporter.displayName } : null,
      status: f.status?.name || "",
      issueType: f.issuetype?.name || "",
    },
  };
}

// Done issues similar to the given one (same project + keywords, or same component).
// Returns [{ key, summary, status, resolver: { accountId, name } }].
export async function searchSimilarIssues({ projectKey, keywords, component, maxResults = 20 }) {
  const clauses = [];
  if (projectKey) clauses.push(`project = "${projectKey}"`);
  if (component) clauses.push(`component = "${component.replace(/"/g, "")}"`);
  const kw = (keywords || []).slice(0, 3);
  if (kw.length > 0) clauses.push(`text ~ "${kw.join(" ")}"`);
  clauses.push("statusCategory = Done");
  const jql = clauses.join(" AND ") + " ORDER BY updated DESC";
  const r = await jiraPost("/rest/api/3/search", {
    jql,
    maxResults,
    fields: ["summary", "assignee", "status"],
  });
  if (!r.ok) return { ok: false, error: `similar-issue search failed (${r.status || r.error})` };
  const issues = (r.data.issues || []).map((i) => ({
    key: i.key,
    summary: i.fields?.summary || "",
    status: i.fields?.status?.name || "",
    resolver: i.fields?.assignee
      ? { accountId: i.fields.assignee.accountId, name: i.fields.assignee.displayName }
      : null,
  }));
  log("similar-issues", { jql, found: issues.length });
  return { ok: true, issues };
}

export async function getComponent(componentId) {
  const r = await jiraGet(`/rest/api/3/component/${encodeURIComponent(componentId)}`);
  if (!r.ok) return { ok: false, error: `component lookup failed (${r.status || r.error})` };
  return {
    ok: true,
    component: {
      id: r.data.id,
      name: r.data.name,
      lead: r.data.lead ? { accountId: r.data.lead.accountId, name: r.data.lead.displayName } : null,
    },
  };
}

// Open (not Done) work items assigned to a person. Returns { ok, openCount, openItems }.
export async function getOpenWorkload(accountId) {
  const jql = `assignee = "${accountId}" AND statusCategory != Done ORDER BY updated DESC`;
  const r = await jiraPost("/rest/api/3/search", { jql, maxResults: 25, fields: ["summary", "status"] });
  if (!r.ok) return { ok: false, error: `workload lookup failed (${r.status || r.error})` };
  return {
    ok: true,
    openCount: r.data.total ?? (r.data.issues || []).length,
    openItems: (r.data.issues || []).map((i) => ({
      key: i.key,
      summary: i.fields?.summary || "",
      status: i.fields?.status?.name || "",
    })),
  };
}

export async function findPerson(text) {
  const r = await jiraGet(`/rest/api/3/user/search?query=${encodeURIComponent(text)}&maxResults=5`);
  if (!r.ok) return { error: `user search failed (${r.status})` };
  const users = (r.data || []).filter((u) => u.accountType === "atlassian" && u.active);
  if (users.length === 0) return { error: `no active person matches "${text}"` };
  if (users.length > 1) {
    return { error: `"${text}" matches ${users.length} people: ${users.map((u) => u.displayName).join(", ")}. Ask which one.` };
  }
  return { accountId: users[0].accountId, name: users[0].displayName };
}

export async function personName(accountId) {
  const r = await jiraGet(`/rest/api/3/user?accountId=${encodeURIComponent(accountId)}`);
  return r.ok ? r.data.displayName : accountId;
}

export async function assignIssue(key, accountId) {
  try {
    const res = await api.asUser().requestJira(route`/rest/api/3/issue/${encodeURIComponent(key)}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ fields: { assignee: { accountId } } }),
    });
    if (!res.ok && res.status !== 204) return { ok: false, error: `assign failed (${res.status})` };
    return { ok: true };
  } catch (e) {
    return { ok: false, error: String(e?.message || e) };
  }
}

// --- Confluence ---

// Search Confluence pages by keywords. Returns [{ id, title, url }].
export async function searchConfluencePages(keywords, maxResults = 5) {
  const kw = (keywords || []).slice(0, 3);
  if (kw.length === 0) return { ok: true, pages: [] };
  const cql = `text ~ "${kw.join(" ")}"`;
  const r = await confluenceGet(
    `/rest/api/content/search?cql=${encodeURIComponent(cql)}&limit=${maxResults}`
  );
  if (!r.ok) return { ok: false, error: `page search failed (${r.status || r.error})` };
  const pages = (r.data.results || []).map((p) => ({
    id: p.id,
    title: p.title,
    url: p._links?.webui || "",
  }));
  return { ok: true, pages };
}

// Authorship for a page from REST: creator + latest version author.
export async function getPageAuthorsRest(pageId) {
  const r = await confluenceGet(`/rest/api/content/${encodeURIComponent(pageId)}?expand=history,version`);
  if (!r.ok) return { ok: false, error: `page lookup failed (${r.status || r.error})` };
  const authors = new Map();
  const add = (u, role) => {
    if (!u?.accountId) return;
    const row = authors.get(u.accountId) || { accountId: u.accountId, name: u.displayName, roles: [] };
    if (!row.roles.includes(role)) row.roles.push(role);
    authors.set(u.accountId, row);
  };
  add(r.data.history?.createdBy, "creator");
  add(r.data.version?.by, "last editor");
  return { ok: true, authors: [...authors.values()] };
}
