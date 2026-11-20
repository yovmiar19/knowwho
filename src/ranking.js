// Transparent weighted expert ranking for KnowWho.
//
// Every point is explainable: the breakdown is returned with the ranking, and
// the one-line reason names the strongest signal. No black box.
//
// Weights (tune here, and the panel shows the same numbers):
export const WEIGHTS = {
  pageAuthorship: 3, // per related Confluence page authored or contributed to (cap 6)
  pastFix: 2, // per similar resolved issue (cap 6)
  componentLead: 4, // is the lead of the issue's component
  pageOwner: 2, // owns a related Confluence page
  recentActivity: 1, // commented on or resolved something related in the last 90 days
  sameTeam: 1, // in the same Atlassian team as the person asking
  overloadPenalty: 1, // per open assigned item over 3 (cap 4)
  overloadFree: 3, // open items before the penalty starts
  maxList: 5, // how many experts the shortlist holds
};

// candidates: Map accountId -> {
//   name, pages: [{ title, url, role }], fixes: [{ key, summary }],
//   isComponentLead: bool, ownedPages: [{ title, url }],
//   recent: bool, sameTeam: bool, openCount: number
// }
// Returns a ranked array of { accountId, name, score, breakdown, reason, evidence }.
export function rankCandidates(candidates, limit = WEIGHTS.maxList) {
  const ranked = [];

  for (const [accountId, c] of candidates.entries()) {
    const b = {
      authorship: Math.min((c.pages?.length || 0) * WEIGHTS.pageAuthorship, 6),
      pastFixes: Math.min((c.fixes?.length || 0) * WEIGHTS.pastFix, 6),
      ownership: (c.isComponentLead ? WEIGHTS.componentLead : 0) + Math.min((c.ownedPages?.length || 0) * WEIGHTS.pageOwner, 4),
      recency: c.recent ? WEIGHTS.recentActivity : 0,
      team: c.sameTeam ? WEIGHTS.sameTeam : 0,
      load: -Math.min(Math.max((c.openCount ?? 0) - WEIGHTS.overloadFree, 0) * WEIGHTS.overloadPenalty, 4),
    };
    const score = b.authorship + b.pastFixes + b.ownership + b.recency + b.team + b.load;

    const parts = [];
    if (c.isComponentLead) parts.push("owns the component");
    if ((c.pages?.length || 0) > 0) parts.push(`wrote ${c.pages.length} related page${c.pages.length > 1 ? "s" : ""}`);
    if ((c.fixes?.length || 0) > 0) parts.push(`fixed ${c.fixes.length} similar issue${c.fixes.length > 1 ? "s" : ""}`);
    if (c.recent) parts.push("active on this in the last 90 days");
    if ((c.openCount ?? 0) > WEIGHTS.overloadFree) parts.push(`currently has ${c.openCount} open items`);
    else if ((c.openCount ?? 0) <= 1) parts.push("has capacity right now");
    const reason = parts.length > 0 ? parts.join("; ") : "has context on this work";

    ranked.push({
      accountId,
      name: c.name || accountId,
      score,
      breakdown: b,
      reason,
      evidence: {
        pages: (c.pages || []).map((p) => ({ title: p.title, url: p.url })),
        fixes: (c.fixes || []).map((f) => ({ key: f.key, summary: f.summary })),
        openCount: c.openCount ?? null,
      },
    });
  }

  ranked.sort((a, b) => b.score - a.score || a.name.localeCompare(b.name));
  return ranked.slice(0, limit);
}

// Merge one signal into the candidate map.
export function addCandidate(candidates, accountId, name, signal) {
  if (!accountId) return null;
  const c = candidates.get(accountId) || {
    name: name || accountId,
    pages: [],
    fixes: [],
    ownedPages: [],
    isComponentLead: false,
    recent: false,
    sameTeam: false,
    openCount: null,
  };
  if (name) c.name = name;
  if (signal.pages) for (const p of signal.pages) if (!c.pages.some((x) => x.url === p.url)) c.pages.push(p);
  if (signal.fixes) for (const f of signal.fixes) if (!c.fixes.some((x) => x.key === f.key)) c.fixes.push(f);
  if (signal.ownedPages) for (const p of signal.ownedPages) if (!c.ownedPages.some((x) => x.url === p.url)) c.ownedPages.push(p);
  if (signal.isComponentLead) c.isComponentLead = true;
  if (signal.recent) c.recent = true;
  if (signal.sameTeam) c.sameTeam = true;
  if (typeof signal.openCount === "number") c.openCount = signal.openCount;
  candidates.set(accountId, c);
  return c;
}
