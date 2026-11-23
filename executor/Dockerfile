FROM rust:1.89-bookworm@sha256:948f9b08a66e7fe01b03a98ef1c7568292e07ec2e4fe90d88c07bb14563c84ff AS build
WORKDIR /src
COPY Cargo.toml Cargo.lock ./
COPY src ./src
COPY executor/Cargo.toml ./executor/Cargo.toml
COPY executor/provider-address ./executor/provider-address
COPY executor/src ./executor/src
ARG ACCLIMATE_EXECUTOR_BUILD
RUN ACCLIMATE_EXECUTOR_BUILD=${ACCLIMATE_EXECUTOR_BUILD:-$(sha256sum executor/src/*.rs executor/provider-address/src/*.rs Cargo.lock | sha256sum | cut -d ' ' -f 1)} cargo build -j 3 --locked --release -p acclimate-executor
FROM docker:28-cli@sha256:625d9431a9f54c5a2bc90f24f0e1c3d55b1349fd857dd85035f98c2c9acbdd4d AS cli
FROM debian:bookworm-slim@sha256:734a72b3d6142a71993b4bc580ca01d8ca687f77a2c422d96a961d3376b179bc
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates && rm -rf /var/lib/apt/lists/*
COPY --from=cli /usr/local/bin/docker /usr/local/bin/docker
COPY --from=build /src/target/release/acclimate-executor /usr/local/bin/acclimate-executor
ENTRYPOINT ["acclimate-executor"]
