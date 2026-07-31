# Friction log

Running record of everything confusing, broken, or slower than it should have
been while building on KeeperHub. **Write entries while confused, not after.**
Once something makes sense you cannot reconstruct why it did not.

This feeds the Best Onboarding UX bounty (SPEC.md §12): the worst item becomes a
PR, the rest become a teardown.

## Format

```
### [date] short title
**Doing:** what I was trying to accomplish
**Expected:** what I thought would happen
**Got:** what actually happened
**Cost:** how long I lost
**Fix:** what would have prevented this
```

---

### 2026-07-30 Repo scaffolded before account exists

**Doing:** Setting up the project skeleton ahead of signing up.
**Expected:** n/a, baseline entry.
**Got:** Wrote the KeeperHub REST client against the published docs without
being able to verify request or response shapes, because the API reference does
not show a full example payload for `execute` or the execution status poll.
**Cost:** ~0 so far, but every field name in `agent/executor.ts` is a guess and
carries a `TO VERIFY` marker.
**Fix:** A single copy-pasteable curl example per endpoint, showing a real
request and a real response body, would remove the guesswork entirely. This is a
strong bounty candidate.

---

### 2026-07-30 Docs do not state free-tier execution quota

**Doing:** Sizing the block-interval trigger for `hf-watch`.
**Expected:** A quota number on the pricing or quickstart page.
**Got:** Quickstart does not mention free-tier limits or gas sponsorship terms;
the marketplace page mentions quota only obliquely, via the note that executions
priced at $0.05+ do not count toward it.
**Cost:** Blocked on choosing a poll interval; had to design the tier system to
be quota-adaptive as a hedge.
**Fix:** State the quota on the quickstart page. A keeper's poll interval is one
of the first decisions a builder makes and it depends entirely on this number.

---

<!-- Add entries below as they happen. Do not batch them up. -->
