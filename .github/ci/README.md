# Synthetic regression

From the repository root on Linux with Node.js 24.22.2 and its bundled npm, run:

```sh
bash .github/ci/run.sh
```

The launcher clears the environment and creates temporary HOME and XDG directories. The synthetic host creates its own DSH data under the temporary directory. Tests require a network namespace with only loopback. The launcher tries unprivileged namespaces first. On GitHub-hosted Ubuntu it can use passwordless sudo to bring up loopback in a new network namespace, then drops to the runner UID before starting Node. If isolation cannot be set up, the job fails. Checkout and Node setup happen before isolation. [GitHub-hosted runner privileges](https://docs.github.com/en/actions/reference/runners/github-hosted-runners#administrative-privileges)

- The host adapter supplies the fixed DSH Web 0.2.2-rc.1 event contract and a deliberately unknown host. It imports the product entry point and uses the real receipt and SQLite ledger code with synthetic sessions.
- The regression covers legacy relay and workflow commands, authorization and owner isolation, exact retry and conflicting payloads, shared recipients, cancellation and expiry. The 30-window workload exercises shared workers and measures dispatch-to-wake and report-to-wake times.
- Faults include destination resolution failure, a throw after an inbox append, a failed result flush and unavailable recovery evidence. Restart cases reuse the ledger and synthetic durable inbox and event records, then check wake identity, replay prevention and continuations interrupted on either side of a downstream dispatch.
- Offline npm packing disables lifecycle scripts, checks each archived file against its source bytes and reports the archive and file-manifest SHA-256. The manifest is a compact JSON object keyed by sorted package-relative paths, with per-file SHA-256 values and no trailing newline.
- The GitHub job verifies the checked-out commit against the event SHA and prints the commit and tree. The pull request run identifies the tested merge tree. A push to main records its own commit and tree. Compare the product archive digest across those runs for the reviewed version.

Native Web installation, browser UI, actual host authentication and durable queues, version migration, rollback and real model behavior have separate integration evidence.

The 0.5.0 collaboration cases run against the product and CI combination tree. They drive the registered tools with exact and modified previews, queued and non-owner confirmations, same-window claims, batch retries, and mismatched artifact references. The interrupted-close case verifies that a result turn without completion or reconciliation cannot leave a completed task in the durable ledger. Run the full suite with the launcher above.

The closeout cases cover dispatch and duplicate requests while closeout is pending, cancellation and expiry before turn completion, and restart with or without durable turn completion. They check the first closeout payload, preserve the committed downstream attempt, and exercise explicit owner reconciliation before success.

Time-context cases use the fixed host's source-attributed clock snapshot. They cover owner confirmation, result dispatch and closeout replay. An owner or relay message carrying the same visible text remains a separate input and must preserve the mixed-turn fence.

The ordinary send cases check the same native time snapshot around the complete preview and the subsequent owner confirmation. They also verify that an additional owner or relay input containing the same text clears the frozen send authorization.

Colloquial routing cases exercise a bounded owner question to one named window and the original controller's result. They also verify that ambiguous or untrusted inputs do not dispatch, and that a quoted literal with a window suffix outside the title is delivered as ordinary text.

Direct-delegation receipt cases bind the queued status and exact title to the accepted target, preserve that receipt on a same-turn retry, and exercise route drift before dispatch and interruption after claim.

One-shot closeout cases exercise the 128-grant boundary, archived grant and attempt evidence, and a durable reply recovered after restart. The deadline cases distinguish when the native result turn completed from when the plugin restarted. Negative cases cover earlier, blank and interrupted replies, mixed turns, failure, owner action, cancellation, late reports and records created without the reply sequence.

Expiry recovery cases hold the durable history scan to check that an expired grant cannot resume work while awaiting evidence. They verify capacity is reusable once recovery settles, and that a missing turn end or unreadable history results in expiration and no replay.
