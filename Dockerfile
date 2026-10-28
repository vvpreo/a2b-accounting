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
COPY scripts/badge-icons.mjs ./scripts/
# Stand marker for the app icon: prod (default — CI/Docker Hub images) has no
# marker; build the DEV stand with `--build-arg APP_ENV=dev`.
ARG APP_ENV=prod
RUN APP_ENV=$APP_ENV npm run build

# ---- OCR models: PaddleOCR PP-OCRv5 (ONNX, architecture-independent) ----
FROM --platform=$BUILDPLATFORM debian:trixie-slim AS ocr-models
RUN apt-get update \
    && apt-get install -y --no-install-recommends curl ca-certificates \
    && rm -rf /var/lib/apt/lists/*
COPY scripts/fetch-ocr-models.sh /fetch-ocr-models.sh
RUN /fetch-ocr-models.sh /ocr-models

# ---- Backend: Rust (cross-compiled to $TARGETARCH) ----
# Debian 13 (trixie): the prebuilt ONNX Runtime linked into the server (OCR)
# needs glibc >= 2.38 and GCC 13+ libstdc++; bookworm is too old.
FROM --platform=$BUILDPLATFORM rust:1-trixie AS backend
ARG TARGETARCH
WORKDIR /app
RUN case "$TARGETARCH" in \
      amd64) echo x86_64-unknown-linux-gnu > /rust-target ;; \
      arm64) echo aarch64-unknown-linux-gnu > /rust-target \
             && apt-get update \
             && apt-get install -y --no-install-recommends gcc-aarch64-linux-gnu g++-aarch64-linux-gnu libc6-dev-arm64-cross \
             && rm -rf /var/lib/apt/lists/* ;; \
      *) echo "unsupported TARGETARCH=$TARGETARCH" >&2; exit 1 ;; \
    esac \
    && rustup target add "$(cat /rust-target)"
# g++ for aarch64: the statically linked ONNX Runtime (ort, for OCR) needs
# the target's libstdc++ at link time.
ENV CARGO_TARGET_AARCH64_UNKNOWN_LINUX_GNU_LINKER=aarch64-linux-gnu-gcc \
    CC_aarch64_unknown_linux_gnu=aarch64-linux-gnu-gcc \
    CXX_aarch64_unknown_linux_gnu=aarch64-linux-gnu-g++
COPY server ./server
RUN cargo build --release --manifest-path server/Cargo.toml --target "$(cat /rust-target)" \
    && cp "server/target/$(cat /rust-target)/release/a2b-accounting-server" /a2b-accounting-server

# ---- Runtime ----
# Same Debian release as the backend builder (glibc/libstdc++ of the server).
FROM debian:trixie-slim
COPY --from=backend /a2b-accounting-server /app/a2b-accounting-server
COPY --from=frontend /app/dist /app/static
# Local OCR for documents (bank slips): PaddleOCR models + their character
# dictionaries; ONNX Runtime is linked into the server binary. Nothing is
# sent to any service.
COPY --from=ocr-models /ocr-models /app/ocr-models
COPY server/ocr /app/ocr-dicts
ENV FINANCES_DATA_DIR=/data \
    FINANCES_STATIC_DIR=/app/static \
    FINANCES_BIND=0.0.0.0:8080 \
    FINANCES_OCR_MODELS=/app/ocr-models \
    FINANCES_OCR_DICTS=/app/ocr-dicts
VOLUME /data
EXPOSE 8080
ENTRYPOINT ["/app/a2b-accounting-server"]
