# syntax=docker/dockerfile:1
# Needs BuildKit (the default in current Docker): ADD --checksum and the per-architecture stages below.
ARG TARGETARCH=amd64

# epublift, which upgrades EPUB 2 books to EPUB 3 (EPUB_CHECK_EPUBLIFT): its static release binary, checked against the
# release's published SHA-256. To update it, change the version and both checksums here and in .github/workflows/ci.yml.
FROM scratch AS epublift-amd64
ADD --checksum=sha256:ec147844eb9f2ce923f71ebb983605d252a536927a9d3637d893bd6435e17801 \
    https://github.com/ePubLift/epublift/releases/download/cli-v4.5.1/epublift-4.5.1-x86_64-unknown-linux-musl.tar.gz /epublift.tar.gz
FROM scratch AS epublift-arm64
ADD --checksum=sha256:34a1eaf527fa33666a1f5d894caea2f2fa9f56f67630442c05d39b4266bf0cb5 \
    https://github.com/ePubLift/epublift/releases/download/cli-v4.5.1/epublift-4.5.1-aarch64-unknown-linux-musl.tar.gz /epublift.tar.gz
FROM epublift-${TARGETARCH} AS epublift

# Compile on the build machine's architecture and cross-compile for the target one, so multi-arch builds need no emulation
FROM --platform=$BUILDPLATFORM oven/bun:1 AS build
ARG TARGETARCH

WORKDIR /app
COPY package.json bun.lock tsconfig.json ./
RUN bun install --production --frozen-lockfile
COPY src ./src

# x64 "baseline" also runs on older NAS CPUs without AVX2
RUN case "$TARGETARCH" in \
        amd64) target=bun-linux-x64-baseline ;; \
        arm64) target=bun-linux-arm64 ;; \
        *) echo "Unsupported architecture: $TARGETARCH" >&2; exit 1 ;; \
    esac \
    && bun build src/index.ts --compile --minify --sourcemap --target="$target" --outfile /out/orbitkit \
    && mkdir /out/data

COPY --from=epublift /epublift.tar.gz /tmp/
RUN tar -xzf /tmp/epublift.tar.gz -C /tmp \
    && install -m 755 /tmp/epublift-*/epublift /out/epublift

# Just glibc and the executables: no shell, no package manager. Bun brings its own TLS and root certificates;
# epublift is statically linked.
FROM gcr.io/distroless/base-nossl-debian13

COPY --from=build /out/orbitkit /orbitkit
COPY --from=build /out/epublift /usr/local/bin/epublift
# /data has a folder per feature: epub-check/, pocketbook-sync/, opds-proxy/
COPY --from=build --chown=1000:1000 /out/data /data
VOLUME /data
USER 1000:1000

# OPDS Proxy, EPUB Check report pages
EXPOSE 8601 8602

ENV DATA_DIR=/data
HEALTHCHECK --interval=1m --timeout=10s --start-period=5m CMD ["/orbitkit", "--healthcheck"]

ENTRYPOINT ["/orbitkit"]
