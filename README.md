# Version constraints with PingRoom

Choose releases from a finite internal catalog. A named release owner marks every candidate Supported, Unsupported or Unknown for one declared target. Code checks the catalog's conditional dependencies and proposes exactly one version of every mandatory package.

The paper-tools example contains an editor and renderer. Editor v2 requires renderer v2. If renderer v2 is unsupported, the proposal falls back to both v1 releases. The offline demo also covers complete unsatisfiability and Unknown. It fetches no registry data and installs no packages from the catalog.

## Run offline

Use Node.js 22 or newer and npm. Choose **Use this template**, clone your copy, then run:

```sh
npm ci
npm test
npm run demo
```

The starter pins `@pingroom/sdk` 0.8.0 with a committed npm lockfile. Tests and demo use the real SDK with local mock transports. After installation they need no network, account, credentials or phone. `.npmrc` requests a 14-day minimum release age where supported by npm.

## Define the catalog

```sh
cp examples/model.json model.json
cp config.example.json config.json
npm run validate
```

Edit `model.json` before collecting support evidence:

- `catalogId`: at most 32 characters; `title`: 32; `context`: 60; `target`: 60. State the environment precisely enough for a support judgment.
- `packages`: 1–4 mandatory packages, each containing `id`, `label` and `versions`. Each package has at least one candidate; the whole catalog allows at most eight.
- Each version contains `id`, `label` and `rank`. Labels allow 40 characters. Ranks are distinct integers 0–999 within each package; higher means preferred. Zero is valid.
- `dependencies`: 0–12 records with `id`, `fromPackage`, `fromVersion`, `toPackage` and nonempty `allowedVersions`.

Package, version and dependency IDs allow 12 characters: a lowercase initial letter, followed by lowercase letters, digits, `_` or `-`. Reserved object names are rejected. Version IDs are unique within their package; dependency IDs are unique across the catalog. `catalogId` uses the same character grammar with its longer limit.

A dependency activates only when its exact source version is selected. The chosen target version must then appear in its allowlist. For example:

```json
{
  "id": "editor-v2",
  "fromPackage": "editor",
  "fromVersion": "v2",
  "toPackage": "renderer",
  "allowedVersions": ["v2"]
}
```

All references must exist. Repeated source-version/target rules and duplicate allowlist entries are rejected. Cyclic and self dependencies are allowed when an assignment satisfies them. Every package remains mandatory; there are no optional packages or automatically discovered transitive packages.

Text limits use UTF-16 code units. Extra fields, fractional ranks, negative zero, malformed Unicode, control/format characters, line breaks and surrounding whitespace are rejected. Full candidate prompts must fit 500 characters. Input arrays canonicalize by ID; names such as `v2` are identifiers, not semantic-version comparisons.

## Connect and collect support

Install [PingRoom](https://pingroom.io/i), create a private standard room containing the release owner, then run:

```sh
npm run connect
npm run inspect
```

Approve the printed pairing link and grant the room. Verify the person in the app, then put their exact member UUID and descriptive label in `config.json`; a name alone is insufficient. For an existing granted connection, copy `.env.example` to `.env` and set both `PINGROOM_TOKEN` and the 12-character `PINGROOM_ROOM`. Partial pairs are rejected.

```sh
npm start
```

Each invocation creates at most one direct, 15-minute Question or reads the existing one, with room/member preflight before creation. After the owner answers, run the command to record the response, then run it again for the next candidate. Prompts contain the target, context, package and exact candidate identity.

Choose **Supported** for established support on that target, **Unsupported** for established lack of support, or **Unknown** when evidence is unavailable. Dependencies and ranks are declared manifest facts; the owner is only judging target support.

Every candidate requires a known answer, including candidates the final assignment does not use. Unknown, missing, expired, cancelled, malformed or misattributed answers withhold the entire analysis. Evidence is bound to the request, owner, room, asking registration, timestamps and calculation policy.

## Inspect and export

```sh
npm run status
npm run report
npm run export-analysis
npm run export-lock
```

These commands are local. `report` writes `.catalog/report.json`. `export-analysis` writes `.catalog/analysis.json` once all candidate judgments are known, including an `unsatisfiable` finding. `export-lock` additionally requires a coherent assignment and writes `.catalog/proposed-lock.json` with the source and attributed evidence. The selected catalog lock is under `analysis.proposedLock`.

Code enumerates all full assignments, at most 18 under these bounds. An assignment must select one supported candidate per package and satisfy every activated dependency. `evaluations` records each assignment and its violated constraint IDs; `feasibleAssignmentCount` counts valid choices.

Preference is lexicographic: sort package IDs in ASCII order, maximize the first package's rank, then the second, and continue. This is not a sum of ranks. An earlier package's improvement wins even if later packages lose more rank. Distinct ranks within each package make the preferred assignment unique. Renaming package IDs can therefore change preference.

When no assignment works, `unsatCore` contains a deletion-minimal subset of unsupported-candidate exclusions and dependency constraints. Exactly one candidate per mandatory package remains the background rule. Removing any retained core constraint admits its recorded witness assignment under the remaining core. A witness may violate original constraints omitted from that core; it is not a repair proposal. The core is deterministic but is not claimed to have minimum cardinality.

To adapt the template, translate your reviewed internal catalog and target into the manifest, including every relevant dependency. Review the proposed assignment before another system consumes it. This is not registry resolution, SemVer-range solving, an npm lockfile or proof that releases work together beyond the declared constraints. Human support assertions and omitted dependencies are not independently verified.

## Resume safely

Root inputs, credentials, runtime state and exports are ignored by Git. Keep `.catalog/` and `.pingroom/` private and intact. Changed catalog meanings, ranks, dependencies, target, identity or credentials cannot reuse a session. Input/config limits are 64/16 KiB; writes are atomic under a local lock.

A lost creation response leaves `create_unknown` and is never automatically resent:

```sh
npm run status
npm run find-id
npm run recover -- EXACT-QUESTION-UUID
```

Recover only the original Question. An empty bounded search does not prove creation failed. Resolve or revoke uncertain/expired pairing in Connected Agents before archiving its pending file. Remove a stale `.lock` only after confirming its process stopped. Resolve the original session before archiving it for revised inputs; never delete state to retry.

Run commands serially. Exit codes: `0` complete/local result, including unsatisfiability; `1` invalid setup/evidence or refused export; `2` incomplete/failed answer; `3` pending/ready/interrupted; `4` uncertain creation.

Tests compare results against an independent subset oracle, verify core witnesses, and cover SDK/CLI recovery and private exports. GitHub Actions checks Node.js 22 and 24. Live phone delivery is not tested. MIT licensed.
