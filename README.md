# KnowWho — "Who should work on this?"

A Forge app for Atlassian Codegeist 2026 (Software Teams). A Rovo agent that
answers who should review, own, or unblock any Jira issue, returning a ranked
expert list with a one-line reason and evidence for each person.

One codebase targets three bonus prizes at once:

| Bonus | How KnowWho qualifies |
|---|---|
| Best Agents — Rovo / Assignable agents | `rovo:agent` with five GET actions; assignable via Jira Automation ("Use Rovo Agent") or @-mention in Rovo Chat |
| Best app with Atlassian MCP | `rovo:mcp` exposes the same five actions as MCP tools; `skill.md` documents them for third-party agents |
| Best apps with Teamwork Graph integration | Reads the Teamwork Graph API (`requestTeamworkGraph`) for page contributors, recent commenters, team membership, and assigned work |

## How the ranking works (transparent, no black box)

Each candidate gets a weighted score, and the breakdown is shown with the answer:

| Signal | Points |
|---|---|
| Authored / contributed to a related Confluence page | +3 per page (cap +6) |
| Resolved a similar past issue | +2 per issue (cap +6) |
| Lead of the issue's component | +4 |
| Owns a related Confluence page | +2 per page (cap +4) |
| Active on this in the last 90 days | +1 |
| Same Atlassian team as the asker | +1 |
| Overloaded (open items over 3) | −1 each (cap −4) |

Role tweaks: `reviewer` boosts authorship/fixes, `owner` boosts ownership,
`unblocker` boosts recency and availability.

Every signal also has a Jira/Confluence REST fallback, so the app keeps working
if a graph query is unavailable. When a source could not be read, the answer
says so instead of pretending there is nobody.

## Project layout

```
manifest.yml            modules, scopes, runtime (nodejs22.x)
package.json
prompts/prompt.md       the Rovo agent prompt (loaded as a resource)
skill.md                MCP skill file for third-party agents
src/
  index.js              5 Rovo actions (all GET) + Jira issue panel resolver
  twg.js                Teamwork Graph client (curated queries, paging, retries)
  rest.js               Jira/Confluence REST helpers + keyword extraction
  ranking.js            transparent weighted ranking
  frontend/index.jsx    Jira issue panel (UI Kit): ranked list + Assign button
```

## Prerequisites

- Node.js 22.23.4+ (local build used 22.23.5) and Forge CLI 15.1.0:
  `npm install -g @forge/cli`
- An Atlassian account + API token (https://id.atlassian.com/manage-profile/security/api-tokens)
- A site with Rovo enabled. **Use the Forge demo site, not the free dev site:**
  the free Atlassian Cloud Developer License site does not have Rovo chat.
  `forge site provision` provisions a 90-day demo site with Jira, Confluence,
  JSM and Rovo Enterprise + seeded data, then install with `forge install --demo-site`.

## Setup (Yovmi — needs your Atlassian account)

```bash
forge login                                  # Atlassian account + API token
forge site provision                         # 90-day demo site (Rovo enabled)
cd knowwho
npm install
# Replace the placeholder app id: run `forge register` and copy the id it
# prints into manifest.yml (app.id), or run `forge create` once and copy
# the id it writes. Do NOT commit a real id until the app is registered
# under your Atlassian account.
forge deploy
forge install --demo-site
```

Installing an app with Teamwork Graph scopes needs an **organization admin** to
approve the graph scopes on install. Budget for that in the judge setup
instructions (the Devpost submission must explain it).

## Seed demo data

The demo site's seeded data may be too thin for convincing rankings. Before
recording the demo video, seed realistic data on the demo site: a Jira project
with a few issues (some Done, with assignees), 2–3 Confluence pages about the
same topic (written by different people), and a component with a lead. The
ranking only looks real when authorship, past fixes, and ownership point at
different people.

## Test it

In Rovo Chat on a Jira issue (demo site):
- "Who should review PROJ-123?"
- "Who should own this issue?"
- "Who can unblock this work?"
- "Who wrote about the payments runbook?"

On the issue itself, the KnowWho panel shows the same ranking, with a role
filter and an Assign button. Via MCP, point any MCP client at
`https://mcp.atlassian.com/forge/<app-id>` (admin must enable "Expose tools
via external MCP endpoint") and call the five tools listed in `skill.md`.

## Known uncertainties (verify on the demo site)

- **Confluence page ARI shape.** `src/twg.js` builds page ARIs as
  `ari:cloud:confluence:<cloudId>:page/<pageId>`, following the work-item ARI
  pattern. Verify it in the GraphiQL playground
  (`https://<site>.atlassian.net/gateway/api/graphql/twg`) before relying on
  page-contributor queries; the REST fallback covers authorship if it differs.
- **Curated field names.** The queries use the documented curated fields
  (`atlassianUserAssignedJiraWorkItems`, `confluencePageContributors`,
  `jiraWorkItemComments`, `atlassianUserInTeams`, `atlassianTeamMembers`).
  Teamwork Graph is Preview — check the schema in the playground if a field
  errors, and update `src/twg.js` accordingly.
- **Scope names.** The manifest uses per-object graph scopes
  (`read:graph:issue:jira`, `read:graph:page:confluence`, …). The broad
  `read:graph:jira` / `read:graph:confluence` scopes are being retired, so
  do not fall back to them.
- **`forge lint` / deploy were not run here** (they need a logged-in account).
  Run `forge lint` after `forge login`; it will flag the `app.id` placeholder
  until the app is registered.

## Codegeist 2026 submission checklist

- [ ] App registered (`forge register`) and `app.id` filled in
- [ ] Deployed to production (`forge deploy -e production`)
- [ ] Installation link created via the developer console (Distribution → Sharing, Jira)
- [ ] Demo video < 5 min, public on YouTube, showing the agent + panel working
- [ ] Devpost description (~750 words), category: Apps for Software Teams,
      bonus prizes: Best Agents, Best app with Atlassian MCP, Best Teamwork Graph
- [ ] Judge setup instructions, including org-admin approval of graph scopes
- [ ] Submit before 22 Dec 2026 12:00 PT (23 Dec 2026 03:00 WIB)
