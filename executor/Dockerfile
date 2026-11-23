FROM rust:1.89-bookworm AS build
WORKDIR /src
COPY Cargo.toml Cargo.lock ./
COPY src ./src
COPY executor/Cargo.toml ./executor/Cargo.toml
COPY executor/src ./executor/src
ARG ACCLIMATE_EXECUTOR_BUILD
RUN ACCLIMATE_EXECUTOR_BUILD=${ACCLIMATE_EXECUTOR_BUILD:-$(sha256sum executor/src/*.rs Cargo.lock | sha256sum | cut -d ' ' -f 1)} cargo build -j 3 --locked --release -p acclimate-executor
FROM docker:28-cli AS cli
FROM debian:bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates && rm -rf /var/lib/apt/lists/*
COPY --from=cli /usr/local/bin/docker /usr/local/bin/docker
COPY --from=build /src/target/release/acclimate-executor /usr/local/bin/acclimate-executor
ENTRYPOINT ["acclimate-executor"]
