# Acclimate design guide

The [console productization guide](../architecture/productization/README.md) records the implemented local workflow and remaining deployment gates. Real-service and browser checks establish the local draft/evaluate/release path; hosted provider readiness remains separate.

**First implementation.** [Run locally](../development.md) for setup, checks, and current limits.

Acclimate improves and delivers the skills, reusable memories, and instructions used by an application's agent harness. The app keeps its native SDK, background-agent loop, tools, and credentials.

Start with three pages:

1. [Overview](overview.md): one background job and one improvement.
2. [Bundles and local cache](bundles-and-cache.md): what files are delivered and how an app pins them.
3. [SDKs and plugins](sdk-and-plugins.md): a small application-side integration, using native SDKs.

Then read [how improvement works](improvement.md) for proposals, app-run comparisons, and promotion. [Service interface](service.md) defines the small server contract; [roadmap](roadmap.md) gives the build order.

For implementation, use the [code architecture and parallel work plan](../architecture/README.md). It defines module interfaces, directory ownership, shared fixtures, and integration gates.

The [scope audit](../research/service-scope-audit.md) explains what we cut. [SDK research](../research/sdk-file-delivery.md) records verified native features and limits. The [earlier runtime-platform proposal](../research/archive/README.md) is historical, not part of this design.
