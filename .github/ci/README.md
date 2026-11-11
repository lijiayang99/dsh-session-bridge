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
