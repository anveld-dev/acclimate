# Additive roadmap contract

Keep all existing R0 operations and fields unchanged. This closes the existing decision-history requirement with one read operation.

`GET /v1/projects/{projectId}/bundles/{bundleId}/channels/{channel}/promotions?limit=20&beforeRevision=REV`

- Requires the scoped `read` grant before data access. Missing scoped bundle/channel is 404; invalid query is typed 400 `invalid_content`.
- `limit` is an integer from 1 to 100, default 20. `beforeRevision` is an optional positive canonical decimal string fitting the server revision range. It is an exclusive bound; clients treat it as opaque.
- Response: `PromotionPage = { items: Promotion[], nextBeforeRevision: string | null }` using the existing Promotion wire shape, newest revision first. Return a cursor only when another older page exists; it is the last included revision. History is immutable even when a newer promotion arrives.
- TS client: `listPromotions(projectId,bundleId,channel,{limit?,beforeRevision?}={}) -> Promise<PromotionPage>`.
- Python client: `list_promotions(project_id,bundle_id,channel,*,limit=20,before_revision=None) -> PromotionPage`.

The generated OpenAPI includes this read operation and page type. No new mutation, release automation, native lifecycle protocol, or registry operation is part of this change. Operator tools compute before/after file changes from the already available immutable payload reads.
