# Synthetic regression

From the repository root on Linux with Node.js 24.22.2, run:

```sh
bash .github/ci/run.sh
```

The suite imports the checked-out product entry point and runs its receipt and workflow ledger code against a small synthetic host adapter. The fixtures pin the supported DSH owner-source contract to Web 0.2.2-rc.1 and include a deliberately unknown host. They do not depend on the plugin version, the settings namespace, the on-disk directory names, a DSH installation, or a model provider.

The launcher clears the environment and creates temporary HOME, XDG and DSH data. Tests require a network namespace with only loopback. The launcher tries unprivileged namespaces first. On GitHub-hosted Ubuntu it can use passwordless sudo to bring up loopback in a new network namespace, then drops to the runner UID before starting Node. If isolation cannot be set up, the job fails. Checkout and Node setup happen before isolation. [GitHub-hosted runner privileges](https://docs.github.com/en/actions/reference/runners/github-hosted-runners#administrative-privileges)

This gate exercises the plugin against synthetic events, including the authorization and retry boundaries. Native Web installation, browser UI, durable host queues, version migration, rollback and real model behavior have separate integration evidence.
