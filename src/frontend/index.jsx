import React, { useEffect, useState } from "react";
import ForgeReconciler, { Button, SectionMessage, Stack, Text } from "@forge/react";
import { invoke, view } from "@forge/bridge";

const ROLES = [
  { value: "", label: "All roles" },
  { value: "reviewer", label: "Reviewer" },
  { value: "owner", label: "Owner" },
  { value: "unblocker", label: "Unblocker" },
];

function App() {
  const [context, setContext] = useState(null);
  const [ranking, setRanking] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [role, setRole] = useState("");
  const [assigning, setAssigning] = useState(null);
  const [assigned, setAssigned] = useState(null);

  const load = async (issueKey, roleValue) => {
    setLoading(true);
    setError(null);
    try {
      const res = await invoke("getRanking", { issueKey, role: roleValue || undefined });
      if (res?.error) setError(res.error);
      else setRanking(res);
    } catch (e) {
      setError(`Could not load the ranking: ${e?.message || e}`);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    view.getContext().then((ctx) => {
      setContext(ctx);
      const issueKey = ctx?.extension?.issue?.key || ctx?.extension?.jira?.issueKey || "";
      if (issueKey) load(issueKey, "");
      else {
        setLoading(false);
        setError("KnowWho needs an open work item to rank experts for.");
      }
    });
  }, []);

  const issueKey = context?.extension?.issue?.key || context?.extension?.jira?.issueKey || "";

  const onRoleChange = (value) => {
    setRole(value);
    if (issueKey) load(issueKey, value);
  };

  const onAssign = async (accountId, name) => {
    setAssigning(accountId);
    try {
      const res = await invoke("assignIssue", { issueKey, accountId });
      if (res?.ok) setAssigned(name);
      else setError(res?.error || "Assign failed.");
    } catch (e) {
      setError(`Assign failed: ${e?.message || e}`);
    } finally {
      setAssigning(null);
    }
  };

  return (
    <Stack space="space.200">
      <Text>KnowWho finds the best person to review, own, or unblock this work item, from the Teamwork Graph.</Text>

      <Stack space="space.100" alignInline="start">
        {ROLES.map((r) => (
          <Button key={r.value || "all"} appearance={role === r.value ? "primary" : "default"} onClick={() => onRoleChange(r.value)}>
            {r.label}
          </Button>
        ))}
      </Stack>

      {loading && <Text>Finding experts…</Text>}
      {error && <SectionMessage title="KnowWho could not load" appearance="warning"><Text>{error}</Text></SectionMessage>}
      {assigned && <SectionMessage title="Assigned" appearance="confirmation"><Text>{assigned} is now the assignee of {issueKey}.</Text></SectionMessage>}

      {!loading && ranking && ranking.experts && ranking.experts.length === 0 && (
        <Text>No experts found yet. Seed related Confluence pages or resolved issues and try again.</Text>
      )}

      {!loading && ranking && ranking.experts && ranking.experts.map((expert, i) => (
        <Stack key={expert.accountId} space="space.050">
          <Text>
            {i + 1}. {expert.name} — score {expert.score}
          </Text>
          <Text>{expert.reason}</Text>
          {expert.evidence?.pages?.length > 0 && (
            <Text>Pages: {expert.evidence.pages.map((p) => p.title).join(", ")}</Text>
          )}
          {expert.evidence?.fixes?.length > 0 && (
            <Text>Fixed: {expert.evidence.fixes.map((f) => f.key).join(", ")}</Text>
          )}
          <Text>
            Score: authorship {expert.breakdown.authorship}, fixes {expert.breakdown.pastFixes}, ownership {expert.breakdown.ownership}, recency {expert.breakdown.recency}, team {expert.breakdown.team}, load {expert.breakdown.load}
          </Text>
          <Button
            appearance="primary"
            isDisabled={assigning === expert.accountId}
            onClick={() => onAssign(expert.accountId, expert.name)}
          >
            {assigning === expert.accountId ? "Assigning…" : `Assign to ${expert.name}`}
          </Button>
        </Stack>
      ))}

      {!loading && ranking && ranking.notes && ranking.notes.length > 0 && (
        <SectionMessage title="Some sources could not be read" appearance="information">
          <Text>{ranking.notes.join(" ")} The ranking may be incomplete.</Text>
        </SectionMessage>
      )}
    </Stack>
  );
}

ForgeReconciler.render(<App />);
