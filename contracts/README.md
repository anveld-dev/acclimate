# HTTP and data contracts

These files describe what Acclimate sends and accepts on the wire. Use them when you call the service without an SDK, generate a client, or check a response.

| File | Contents |
| --- | --- |
| [`openapi.json`](openapi.json) | The OpenAPI 3.1 description of every route, request and response body, status code and error code. It is the source of truth for the HTTP API. |
| [`bundle.schema.json`](bundle.schema.json) | JSON Schema for a bundle payload: file paths, kinds and size limits. |
| [`learning.md`](learning.md) | The learning loop’s routes, splits and evaluator protocol. |
| [`fixtures/`](fixtures) | Exact payload bytes, digests, channel resolutions, version metadata, native compatibility examples and evaluator CLI errors. |

Both SDKs follow this contract. TypeScript consumers can read the same types from the installed package's `.d.ts` files, and Python consumers from `acclimate.types`. The [versioning and compatibility reference](../apps/docs/content/docs/reference/versioning.mdx) explains how the contract changes between releases.
