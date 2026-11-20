# KnowWho skill

Find the right person to review, own, or unblock a Jira work item — with evidence, not guesses.

## When to use it

Use KnowWho when you need to answer, for a Jira work item:
- who should review it,
- who should own it,
- who can unblock it,
- who wrote about the topic, or
- who fixed similar work before.

## How it works

KnowWho reads the Atlassian Teamwork Graph and Jira/Confluence data, then ranks
people with a transparent weighted score: Confluence authorship (+3 per page),
similar resolved issues (+2 each), component ownership (+4 for the component lead),
recent activity (+1), same team (+1), minus a penalty for people who are overloaded.
Every point is shown in the answer, with a one-line reason per person.

## MCP tools

The KnowWho Forge app exposes these tools over MCP
(endpoint `https://mcp.atlassian.com/forge/<app-id>`, OAuth as the signed-in user):

- `knowwho-rank-experts` — ranked expert shortlist for a work item.
  Inputs: `issueKey` (optional, e.g. `PROJ-123`), `role` (optional: `reviewer`, `owner`, `unblocker`).
- `knowwho-page-authors` — people who wrote Confluence pages about a topic.
  Inputs: `topic` (required, e.g. `payments runbook`).
- `knowwho-past-resolvers` — people who resolved issues similar to a given one.
  Inputs: `issueKey` (optional), `keywords` (optional).
- `knowwho-component-owner` — owner of a Jira component or service.
  Inputs: `issueKey` (optional), `component` (optional).
- `knowwho-workload` — open work items assigned to a person.
  Inputs: `person` (optional, a name or email; empty means the caller).

## Rules

- Never invent people. Only report people the tools returned.
- If a tool's `notes` say a source could not be read, say the answer may be
  incomplete instead of saying there is nobody.
- Present the ranking in the order returned, with each person's score and reason.
