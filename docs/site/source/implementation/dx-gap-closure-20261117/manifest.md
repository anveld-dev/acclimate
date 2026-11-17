# Application-retained evaluation manifests

The researcher persona review found that hand-written dataset/grader labels could remain unchanged after task inputs, expected answers or settings changed. `@acclimate/sdk/evaluation/manifest` and `acclimate.evaluation_manifest` now derive public revision hashes from an explicitly declared private manifest. The existing evaluator receives the same captured case inventory; no second list of case/repetition identities is required.

## API and installed integration recipe

TypeScript exports `createEvaluationManifest(input)`, `restoreEvaluationManifest(privateJson)` and `canonicalEvaluationJson(value)`. A captured result has `descriptor`, `definition`, `privateManifest`, and `privateManifestJson`. Python exports their snake case equivalents; its result properties are `descriptor`, `definition`, `private_manifest`, and `private_manifest_json`. Structured properties return independent clones. Capturing inputs and then mutating either the originals or a returned property cannot change the retained identity.

The helper operates locally and synchronously. It never reads a file, environment variable, credential or network resource; executes a callback; or discovers an application's source/dependencies. The application explicitly supplies the source text or reviewed grader artifact digest and a nonempty named inventory of intended runtime/build artifacts. The artifact map can include executor, dependency lockfile, container or runtime build identities. Its names and digests remain private; the public runtime carries their combined revision hash.

An installed Node application uses the public SDK imports below. `reviewedBuild` is an application-retained CI/build manifest containing actual reviewed SHA-256 artifact digests; supply those identities from the application's own build process. It is not sufficient to invent or copy the illustrative digest syntax.

```ts
import { defineEvaluation } from '@acclimate/sdk/evaluation';
import {
  createEvaluationManifest,
  restoreEvaluationManifest,
} from '@acclimate/sdk/evaluation/manifest';
import { executeTask, gradeTask, graderSourceUtf8, reviewedBuild } from './application.js';

const manifest = createEvaluationManifest({
  configId: 'support-evaluator',
  execution: 'model-free', // use live when this app executes paid/live work
  cases: [
    {
      caseId: 'refund',
      input: { ticket: 'Saved task' },
      expected: { decision: 'review' },
      repetitions: 2,
    },
  ],
  grader: { sourceUtf8: graderSourceUtf8 },
  runtime: {
    settings: { temperature: 0.1, seed: 17 },
    artifacts: {
      executor: reviewedBuild.executorDigest,
      dependencies: reviewedBuild.lockfileDigest,
    },
  },
});
const app = defineEvaluation({ ...manifest.definition, execute: executeTask, grade: gradeTask });
// Public request/console configuration:
const publicConfiguration = manifest.descriptor;
// Retain this string in application-owned private storage, with private permissions:
const privateJson = manifest.privateManifestJson;
// Later, reconstruct the same case payloads/settings and descriptor:
const restored = restoreEvaluationManifest(privateJson);
const recoveredApp = defineEvaluation({
  ...restored.definition,
  execute: executeTask,
  grade: gradeTask,
});
```

For Python, the same inventory uses the installed evaluator's `Case` values. The saved private JSON uses the same camel case wire schema as TypeScript; restored `definition` reconstructs Python `Case` values and snake case `define_evaluation` arguments.

```python
from acclimate.evaluation import Case, define_evaluation
from acclimate.evaluation_manifest import (
    create_evaluation_manifest, restore_evaluation_manifest,
)
from application import execute_task, grade_task, grader_source_utf8, reviewed_build

manifest = create_evaluation_manifest(
    config_id="support-evaluator", execution="model-free",
    cases=[Case("refund", {"ticket": "Saved task"}, {"decision": "review"}, 2)],
    grader={"sourceUtf8": grader_source_utf8},
    runtime={"settings": {"temperature": 0.1, "seed": 17},
             "artifacts": {"executor": reviewed_build["executorDigest"],
                           "dependencies": reviewed_build["lockfileDigest"]}},
)
app = define_evaluation(**manifest.definition, execute=execute_task, grade=grade_task)
public_configuration = manifest.descriptor
private_json = manifest.private_manifest_json
restored = restore_evaluation_manifest(private_json)
recovered_app = define_evaluation(**restored.definition, execute=execute_task, grade=grade_task)
```

`grader` is exactly one of `{sourceUtf8: nonempty text}` and `{artifactDigest: "sha256:<64 lowercase hex>"}`. Source text identifies its exact UTF-8 bytes, including newlines/BOM; the helper makes no newline or Unicode normalization. For binary graders or source outside UTF-8, compute and explicitly supply the reviewed artifact digest. Runtime settings must be a JSON object; artifacts must contain 1–32 names matching `[A-Za-z0-9._-]{1,128}`, with SHA-256 digest values. Declare every intended behavior-affecting artifact/settings input. Credentials should normally remain outside the retained manifest; if deliberately included in settings they remain private and affect its hash. No helper can infer omitted credentials, model aliases, environment values or hidden runtime dependencies.

Only `descriptor` is intended for the service/console. `definition` includes captured inputs/expected answers; both private manifest accessors additionally include source/settings and are private. The descriptor contains dataset/grader hashes, combined runtime/configuration hashes, stable public config/case IDs, execution mode and existing fixed runner controls/inventory. Choose nonsecret case/config IDs. A digest is not encryption and can permit guessing of low-entropy private values; this helper makes no cryptographic secrecy claim.

## Versioned canonical representation

The private wire schema is closed: exactly `schema`, `configId`, `execution`, `cases`, `grader`, and `runtime`; schema is `acclimate-evaluation-manifest-v1`. Case records are closed `caseId`, `input`, `expected`, and optional `repetitions` (default 1). Runtime is closed `settings` plus `artifacts`; grader is the one-field union above. Arbitrary input/expected/settings objects retain their application-defined JSON keys. Restoring JSON rejects duplicate decoded keys at every level, including keys written with different escape spellings. It reparses canonical bytes before capture, so integral `1.0`/`1e0` and negative-zero payload/repetition spellings have the same normalized private snapshots as creation. Fractional/boolean repetitions remain invalid. It recomputes identities instead of accepting saved public hash assertions.

Canonical JSON uses no insignificant whitespace. Object keys sort by unsigned UTF-8 bytes, including numeric-looking keys; nested array order remains significant. Cases sort by UTF-8 `caseId`, independent of declaration order; repetition count remains part of dataset identity, with expanded repetitions `0..count-1`. Strings use JSON escapes for controls, quote and backslash; slash and non-ASCII scalar values remain literal UTF-8. Unicode must be valid scalar text, with no normalization: canonically equivalent Unicode spellings can identify different inputs. Case/config IDs that consist entirely of the shared whitespace union (U+0009–000D, U+0020, U+0085, U+00A0, U+1680, U+2000–200A, U+2028–2029, U+202F, U+205F, U+3000, U+FEFF) are rejected independently of native JavaScript `trim` or Python `strip` behavior; control characters are also rejected anywhere in IDs. Accepted ID text is preserved exactly.

Numbers are finite IEEE-754 binary64. Integral numbers must remain within `±(2^53−1)`; Python integers outside this range are rejected as well. `-0`, `0`, and `0.0` serialize as `0`; `1` and `1.0` serialize as `1`. Nonintegral numbers serialize as their exact terminating decimal binary64 value, without exponent notation. For example `0.1` serializes as `0.1000000000000000055511151231257827021181583404541015625`. This avoids differences between JavaScript/Python shortest decimal formatting, including exponent spelling and subnormal values. Parsing these private JSON values reconstructs the same binary64 numbers in either language. This is this schema's explicit canonical convention, not a claim to implement RFC 8785.

Only ordinary JSON data is accepted. TypeScript additionally rejects proxies, getters/setters, sparse/decorated arrays, symbols, class instances and non-enumerable fields before reading their values. Python accepts exact built-in JSON types and existing `Case` instances; tuple is accepted only as the outer `cases` collection. Both reject cycles, nonfinite numbers, invalid Unicode, more than 100,000 nodes, nesting beyond 64 levels, individual strings beyond 1 MiB, and canonical data beyond 16 MiB. Canonical byte accounting includes decimal expansion, escaped keys and separators. There are at most 1,000 expanded case/repetition pairs, with IDs limited to 1,024 UTF-8 bytes and config IDs to 128. Existing `defineEvaluation`/`define_evaluation` retain their additional report-envelope budget check before execution.

Each hash is `sha256:<hex(SHA256(UTF8(schema + "\n" + domain + "\n" + canonicalJSON(value))))>`. Domains and values are:

| Revision      | Domain          | Canonical value                                                 |
| ------------- | --------------- | --------------------------------------------------------------- |
| Dataset       | `dataset`       | normalized private cases, with explicit repetitions             |
| Grader        | `grader`        | source/digest declaration                                       |
| Runtime       | `runtime`       | private settings and named artifact digests                     |
| Configuration | `configuration` | config ID, execution mode, and dataset/grader/runtime revisions |

The schema also defines existing fixed runner controls `concurrency="1"` and `gradeRetries="0"`. Changes to cases/expected answers/repetitions alter dataset and configuration revisions. Source/artifact changes alter grader or runtime and configuration revisions. Reordering object fields/cases or spelling integral values as floating point leaves the identity unchanged; changing nested array order remains significant.

## Evidence and limits

The helper binds declared inputs/settings/artifact identities. It cannot establish that the supplied source matches the installed grader, a reviewed digest matches any local file, callbacks used the declared settings, remote providers remained unchanged, or execution really happened. Callback authenticity, artifact verification and immutable runtime selection remain application responsibilities. These hashes are reproducibility metadata for app assertions, not proof of execution truth, release quality or statistical confidence. The saved manifest reconstructs declared cases/expected answers/settings/artifact declarations; an application must retain the corresponding executable artifacts and callbacks separately.

Shared vectors are in `tests/conformance/evaluation-manifest-v1.json`. Canonical byte examples include normalized integers/negative zero, `0.1`, minimum subnormal, minimum normal, Unicode key order across BMP/astral boundaries, escaped/control strings and significant array order. The same fixture locks private bytes, public descriptor and digest revisions in both implementations. Tests also cover mutation isolation, direct installed-evaluator definition, no private plaintext in descriptors, changes to each identity component, duplicate/unknown fields, malformed values and oversized numeric expansion.

Verification commands (source execution; no build, service, model, upload or publication):

```sh
node_modules/.bin/tsx --test packages/sdk/tests/evaluation/manifest.test.ts
PYTHONPATH=python python3.11 -m unittest python.tests.test_evaluation_manifest -v
node_modules/.bin/tsc --noEmit --pretty false
```

The helper tests passed: TypeScript 7/7; Python 7/7 on Python 3.11.7 (the initial five tests also passed on Python 3.12). The repository TypeScript `--noEmit` check passed. This environment's default `python3` is 3.9 and cannot import the SDK's existing Python 3.11+ `typing.NotRequired` dependency; use the supported Python interpreter. Tests exercise installed-style public definitions through source files. Building/installing distributable SDK artifacts was outside this change's allowed verification scope.
