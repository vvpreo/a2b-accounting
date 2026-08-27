# syntax=docker/dockerfile:1
# Multi-arch image (linux/amd64 + linux/arm64) built without QEMU: both build
# stages run on the build host's native platform and the Rust stage
# cross-compiles for the target architecture. The final image contains only
# the server binary and the built frontend — no keys, no data (the DB lives
# in the /data volume).

# ---- Frontend: React + Vite -> dist/ ----
FROM --platform=$BUILDPLATFORM node:20-bookworm-slim AS frontend
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY index.html vite.config.ts tsconfig.json tsconfig.node.json ./
COPY public ./public
COPY src ./src
RUN npm run build

# ---- Backend: Rust (cross-compiled to $TARGETARCH) ----
FROM --platform=$BUILDPLATFORM rust:1-bookworm AS backend
ARG TARGETARCH
WORKDIR /app
RUN case "$TARGETARCH" in \
      amd64) echo x86_64-unknown-linux-gnu > /rust-target ;; \
      arm64) echo aarch64-unknown-linux-gnu > /rust-target \
             && apt-get update \
             && apt-get install -y --no-install-recommends gcc-aarch64-linux-gnu libc6-dev-arm64-cross \
             && rm -rf /var/lib/apt/lists/* ;; \
      *) echo "unsupported TARGETARCH=$TARGETARCH" >&2; exit 1 ;; \
    esac \
    && rustup target add "$(cat /rust-target)"
ENV CARGO_TARGET_AARCH64_UNKNOWN_LINUX_GNU_LINKER=aarch64-linux-gnu-gcc \
    CC_aarch64_unknown_linux_gnu=aarch64-linux-gnu-gcc
COPY server ./server
RUN cargo build --release --manifest-path server/Cargo.toml --target "$(cat /rust-target)" \
    && cp "server/target/$(cat /rust-target)/release/finances-server" /finances-server

# ---- Runtime ----
FROM debian:bookworm-slim
COPY --from=backend /finances-server /app/finances-server
COPY --from=frontend /app/dist /app/static
ENV FINANCES_DATA_DIR=/data \
    FINANCES_STATIC_DIR=/app/static \
    FINANCES_BIND=0.0.0.0:8080
VOLUME /data
EXPOSE 8080
ENTRYPOINT ["/app/finances-server"]
