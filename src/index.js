// KnowWho: Rovo actions + Jira issue panel resolver.
//
// All Rovo actions are GET. That is deliberate: agents triggered by Jira
// Automation rules will not call CREATE, UPDATE, DELETE or TRIGGER actions,
// so a read-only action set keeps the agent assignable. The panel's Assign
// button is a UI resolver call, not a Rovo action, so it may write.
//
// Every action answers a plain JSON object and never throws. When a source
// could not be read, the answer carries a "notes" entry saying so, and the
// prompt tells the agent to report that part as possibly incomplete instead
// of saying there is nobody.

import Resolver from "@forge/resolver";
import { twg, twgAll, Q, userAri, workItemAri, pageAri } from "./twg.js";
import {
  keywordsFrom,
  getIssue,
  searchSimilarIssues,
  getComponent,
  getOpenWorkload,
  findPerson,
  personName,
  assignIssue,
  searchConfluencePages,
  getPageAuthorsRest,
} from "./rest.js";
import { rankCandidates, addCandidate, WEIGHTS } from "./ranking.js";

const log = (event, data) => console.log(JSON.stringify({ knowwho: event, ...data }));

// Rovo puts the person chatting in payload.context.accountId.
const askerOf = (payload) => payload?.context?.accountId || null;

// The work item open on screen, when the user chats from a Jira issue.
const issueKeyOf = (payload) =>
  String(payload?.issueKey || payload?.context?.jira?.issueKey || "").trim().toUpperCase();

const cloudIdOf = (payload) => payload?.context?.cloudId || null;

// Role tweaks the ranking: a reviewer should know the area, an owner should own it,
// an unblocker should be active and available. Applied on top of the base score.
function applyRole(experts, role) {
  if (!role) return experts;
  const r = String(role).toLowerCase();
  for (const e of experts) {
    const b = e.breakdown;
    if (r.includes("review")) e.score += Math.round(b.authorship * 0.5 + b.pastFixes * 0.25);
    else if (r.includes("owner")) e.score += Math.round(b.ownership * 0.5);
    else if (r.includes("unblock")) e.score += Math.round(b.recency * 2 + Math.max(b.load, -4) * 0.5);
  }
  experts.sort((a, b) => b.score - a.score || a.name.localeCompare(b.name));
  return experts;
}

// --- Signal gathering (shared by the rank action and the panel) ---

async function gatherSignals({ issue, askerAccountId, cloudId, notes }) {
  const candidates = new Map();
  const keywords = keywordsFrom(`${issue.summary} ${issue.text}`);
  const component = issue.components?.[0] || null;

  // 1. Past resolvers of similar issues (REST — the reliable path).
  const similar = await searchSimilarIssues({
    projectKey: issue.projectKey,
    keywords,
    component: component?.name,
  });
  if (similar.ok) {
    for (const s of similar.issues) {
      if (s.resolver) addCandidate(candidates, s.resolver.accountId, s.resolver.name, { fixes: [{ key: s.key, summary: s.summary }] });
    }
  } else {
    notes.push(`similar past issues could not be read: ${similar.error}`);
  }

  // 2. Component lead (REST).
  if (component) {
    const comp = await getComponent(component.id);
    if (comp.ok && comp.component.lead) {
      addCandidate(candidates, comp.component.lead.accountId, comp.component.lead.name, { isComponentLead: true });
    } else if (!comp.ok) {
      notes.push(`component owner could not be read: ${comp.error}`);
    }
  }

  // 3. Confluence authors for the topic (TWG first, REST fallback).
  const pages = await searchConfluencePages(keywords);
  if (pages.ok) {
    for (const page of pages.pages.slice(0, 5)) {
      let authors = null;
      if (cloudId) {
        const tw = await twgAll("pageContributors", Q.pageContributors, { id: pageAri(cloudId, page.id) }, "confluencePageContributors", 1);
        if (tw.ok) authors = tw.nodes.map((n) => ({ accountId: n.accountId, name: n.name, role: "contributor" }));
        else notes.push(`contributors of "${page.title}" could not be read from the graph: ${tw.error}`);
      }
      if (!authors) {
        const rest = await getPageAuthorsRest(page.id);
        if (rest.ok) authors = rest.authors.map((a) => ({ accountId: a.accountId, name: a.name, role: a.roles.join(", ") }));
        else notes.push(`authors of "${page.title}" could not be read: ${rest.error}`);
      }
      for (const a of authors || []) {
        addCandidate(candidates, a.accountId, a.name, { pages: [{ title: page.title, url: page.url, role: a.role }] });
      }
    }
  } else {
    notes.push(`related Confluence pages could not be read: ${pages.error}`);
  }

  // 4. Recent commenters on this issue (TWG) — a recency signal.
  if (cloudId) {
    const comments = await twgAll(
      "workItemComments",
      Q.workItemComments,
      { id: workItemAri(cloudId, issue.id), since: "P90D" },
      "jiraWorkItemComments",
      1
    );
    if (comments.ok) {
      for (const c of comments.nodes) {
        const accountId = c.author?.accountId;
        if (accountId) addCandidate(candidates, accountId, c.author?.name, { recent: true });
      }
    } else {
      notes.push(`recent comments could not be read: ${comments.error}`);
    }
  }

  // 5. Same team as the asker (TWG, best effort, capped).
  if (askerAccountId) {
    const teams = await twgAll("userTeams", Q.userTeams, { userId: userAri(askerAccountId) }, "atlassianUserInTeams", 1);
    if (teams.ok && teams.nodes.length > 0) {
      const team = teams.nodes[0];
      const members = await twgAll("teamMembers", Q.teamMembers, { teamAri: team.id }, "atlassianTeamMembers", 1);
      if (members.ok) {
        for (const m of members.nodes) {
          if (candidates.has(m.accountId)) addCandidate(candidates, m.accountId, m.name, { sameTeam: true });
        }
      }
    }
  }

  // 6. Workload for the candidates (TWG first, REST fallback). Capped to the top 8 by signal so far.
  const prelim = [...candidates.entries()].sort((a, b) => {
    const score = (c) => (c.pages?.length || 0) * 3 + (c.fixes?.length || 0) * 2 + (c.isComponentLead ? 4 : 0);
    return score(b[1]) - score(a[1]);
  });
  for (const [accountId] of prelim.slice(0, 8)) {
    let openCount = null;
    const tw = await twgAll("assignedWork", Q.assignedWork, { userId: userAri(accountId) }, "atlassianUserAssignedJiraWorkItems", 1);
    if (tw.ok) {
      openCount = tw.nodes.filter((w) => w.status?.name && !/^(done|closed|resolved)$/i.test(w.status.name)).length;
    } else {
      const rest = await getOpenWorkload(accountId);
      if (rest.ok) openCount = rest.openCount;
      else notes.push(`workload for one candidate could not be read: ${rest.error}`);
    }
    if (typeof openCount === "number") addCandidate(candidates, accountId, null, { openCount });
  }

  return candidates;
}

async function buildRanking({ issueKey, role, askerAccountId, cloudId }) {
  const t0 = Date.now();
  const notes = [];

  const issueRes = await getIssue(issueKey);
  if (!issueRes.ok) return { error: issueRes.error };
  const issue = issueRes.issue;

  const candidates = await gatherSignals({ issue, askerAccountId, cloudId, notes });
  let experts = rankCandidates(candidates);
  experts = applyRole(experts, role);

  log("rank-experts", { issue: issueKey, ms: Date.now() - t0, experts: experts.length, notes: notes.length });

  return {
    issue: { key: issue.key, summary: issue.summary, projectKey: issue.projectKey, status: issue.status },
    role: role || null,
    experts,
    weights: WEIGHTS,
    notes,
  };
}

// --- Rovo actions ---

export async function rankExperts(payload) {
  const key = issueKeyOf(payload);
  if (!key) return { error: "Which work item? Give me a key such as PROJ-123." };
  const role = String(payload?.role || "").trim() || null;
  return buildRanking({ issueKey: key, role, askerAccountId: askerOf(payload), cloudId: cloudIdOf(payload) });
}

export async function findPageAuthors(payload) {
  const topic = String(payload?.topic || "").trim();
  if (!topic) return { error: "What topic? Give me a few words, for example 'payments runbook'." };
  const notes = [];
  const keywords = keywordsFrom(topic);
  const pages = await searchConfluencePages(keywords);
  if (!pages.ok) return { error: pages.error };
  const cloudId = cloudIdOf(payload);
  const out = [];
  for (const page of pages.pages) {
    let authors = [];
    if (cloudId) {
      const tw = await twgAll("pageContributors", Q.pageContributors, { id: pageAri(cloudId, page.id) }, "confluencePageContributors", 1);
      if (tw.ok) authors = tw.nodes.map((n) => ({ accountId: n.accountId, name: n.name }));
      else notes.push(`contributors of "${page.title}" could not be read from the graph: ${tw.error}`);
    }
    if (authors.length === 0) {
      const rest = await getPageAuthorsRest(page.id);
      if (rest.ok) authors = rest.authors.map((a) => ({ accountId: a.accountId, name: a.name }));
      else notes.push(`authors of "${page.title}" could not be read: ${rest.error}`);
    }
    out.push({ title: page.title, url: page.url, authors });
  }
  return { topic, pages: out, notes };
}

export async function findPastResolvers(payload) {
  const key = String(payload?.issueKey || "").trim().toUpperCase();
  const keywords = keywordsFrom(payload?.keywords || "");
  let projectKey = "";
  let component = "";
  let seedKeywords = keywords;
  if (key) {
    const issueRes = await getIssue(key);
    if (!issueRes.ok) return { error: issueRes.error };
    projectKey = issueRes.issue.projectKey;
    component = issueRes.issue.components?.[0]?.name || "";
    seedKeywords = keywordsFrom(issueRes.issue.text);
  }
  if (!key && keywords.length === 0) return { error: "Give me a work item key or some keywords." };
  const similar = await searchSimilarIssues({ projectKey, keywords: seedKeywords, component });
  if (!similar.ok) return { error: similar.error };
  const byResolver = new Map();
  for (const s of similar.issues) {
    if (!s.resolver) continue;
    const row = byResolver.get(s.resolver.accountId) || { accountId: s.resolver.accountId, name: s.resolver.name, count: 0, issues: [] };
    row.count += 1;
    row.issues.push({ key: s.key, summary: s.summary });
    byResolver.set(s.resolver.accountId, row);
  }
  const resolvers = [...byResolver.values()].sort((a, b) => b.count - a.count).slice(0, 5);
  return { issueKey: key || null, keywords: seedKeywords, resolvers, notes: [] };
}

export async function findComponentOwner(payload) {
  const key = String(payload?.issueKey || "").trim().toUpperCase();
  const componentName = String(payload?.component || "").trim();
  let component = null;
  let issue = null;
  if (key) {
    const issueRes = await getIssue(key);
    if (!issueRes.ok) return { error: issueRes.error };
    issue = issueRes.issue;
    component = issue.components?.[0] || null;
    if (!component) return { error: `${key} has no component set.` };
  } else if (componentName) {
    component = { name: componentName };
  } else {
    return { error: "Give me a work item key or a component name." };
  }
  const notes = [];
  let lead = null;
  if (component.id) {
    const comp = await getComponent(component.id);
    if (comp.ok) lead = comp.component.lead;
    else notes.push(`component lead could not be read: ${comp.error}`);
  }
  // People who recently resolved issues in this component.
  const similar = await searchSimilarIssues({ projectKey: issue?.projectKey || "", component: component.name, keywords: [] });
  const recentWorkers = new Map();
  if (similar.ok) {
    for (const s of similar.issues.slice(0, 10)) {
      if (!s.resolver) continue;
      const row = recentWorkers.get(s.resolver.accountId) || { accountId: s.resolver.accountId, name: s.resolver.name, count: 0 };
      row.count += 1;
      recentWorkers.set(s.resolver.accountId, row);
    }
  } else {
    notes.push(`recent work in this component could not be read: ${similar.error}`);
  }
  return {
    component: component.name,
    issueKey: key || null,
    lead,
    recentWorkers: [...recentWorkers.values()].sort((a, b) => b.count - a.count).slice(0, 5),
    notes,
  };
}

export async function getWorkload(payload) {
  const notes = [];
  const asked = String(payload?.person || "").trim();
  let person;
  if (asked) {
    person = await findPerson(asked);
    if (person.error) return { error: person.error };
  } else {
    const id = askerOf(payload);
    if (!id) return { error: "I could not tell who is asking. Give me a name." };
    person = { accountId: id, name: await personName(id) };
  }
  const tw = await twgAll("assignedWork", Q.assignedWork, { userId: userAri(person.accountId) }, "atlassianUserAssignedJiraWorkItems", 2);
  if (tw.ok) {
    const items = tw.nodes.map((w) => ({ key: w.key, summary: w.summary, status: w.status?.name || null, webUrl: w.webUrl }));
    const open = items.filter((w) => w.status && !/^(done|closed|resolved)$/i.test(w.status));
    return { person: person.name, openCount: open.length, openItems: open, doneCount: items.length - open.length, notes };
  }
  const rest = await getOpenWorkload(person.accountId);
  if (!rest.ok) return { error: rest.error, notes: [`graph workload could not be read: ${tw.error}`] };
  return { person: person.name, openCount: rest.openCount, openItems: rest.openItems, doneCount: null, notes: [`graph workload could not be read: ${tw.error}`] };
}

// --- Jira issue panel resolver (UI Kit) ---

const resolver = new Resolver();

resolver.define("getRanking", async (req) => {
  const issueKey = String(req.payload?.issueKey || "").trim().toUpperCase();
  if (!issueKey) return { error: "No work item key was provided." };
  return buildRanking({
    issueKey,
    role: String(req.payload?.role || "").trim() || null,
    askerAccountId: req.context?.accountId || null,
    cloudId: req.context?.cloudId || null,
  });
});

resolver.define("assignIssue", async (req) => {
  const issueKey = String(req.payload?.issueKey || "").trim().toUpperCase();
  const accountId = String(req.payload?.accountId || "").trim();
  if (!issueKey || !accountId) return { ok: false, error: "Issue key and account are required." };
  const res = await assignIssue(issueKey, accountId);
  return res;
});

export const panelResolver = resolver.getDefinitions();
