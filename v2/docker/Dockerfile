# syntax=docker/dockerfile:1.7

ARG UBUNTU_VERSION=24.04
ARG BENTO4_VERSION=v1.6.0-641

FROM ubuntu:${UBUNTU_VERSION} AS bento4-builder

ARG DEBIAN_FRONTEND=noninteractive
ARG BENTO4_VERSION

RUN apt-get update && apt-get install -y --no-install-recommends \
    build-essential \
    ca-certificates \
    cmake \
    git \
    python3 \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /src

RUN git clone --branch "${BENTO4_VERSION}" --depth 1 https://github.com/axiomatic-systems/Bento4.git

WORKDIR /src/Bento4/cmakebuild

RUN cmake -DCMAKE_BUILD_TYPE=Release .. \
  && cmake --build . --config Release -j"$(nproc)" \
  && find . -type f -name mp4decrypt -exec cp {} /tmp/mp4decrypt \; \
  && test -x /tmp/mp4decrypt

FROM ubuntu:${UBUNTU_VERSION}

ARG DEBIAN_FRONTEND=noninteractive
ARG TARGETARCH
ARG DENO_VERSION=2.3.7
ARG SHAKA_PACKAGER_VERSION=v3.7.2

RUN apt-get update && apt-get install -y --no-install-recommends \
    ca-certificates \
    curl \
    python3 \
    python3-pip \
    tini \
    unzip \
  && rm -rf /var/lib/apt/lists/*

RUN case "${TARGETARCH}" in \
      amd64) export SHAKA_ARCH=x64 DENO_ARCH=x86_64 ;; \
      arm64) export SHAKA_ARCH=arm64 DENO_ARCH=aarch64 ;; \
      *) echo "unsupported TARGETARCH: ${TARGETARCH}" >&2; exit 1 ;; \
    esac \
  && curl -fsSL -o /usr/local/bin/packager \
      "https://github.com/shaka-project/shaka-packager/releases/download/${SHAKA_PACKAGER_VERSION}/packager-linux-${SHAKA_ARCH}" \
  && chmod +x /usr/local/bin/packager \
  && curl -fsSL -o /tmp/deno.zip \
      "https://dl.deno.land/release/v${DENO_VERSION}/deno-${DENO_ARCH}-unknown-linux-gnu.zip" \
  && unzip /tmp/deno.zip -d /usr/local/bin \
  && chmod +x /usr/local/bin/deno \
  && rm -f /tmp/deno.zip

COPY --from=bento4-builder /tmp/mp4decrypt /usr/local/bin/mp4decrypt

WORKDIR /app

COPY v2/requirements.txt /app/requirements.txt
RUN pip3 install --break-system-packages --no-cache-dir -r /app/requirements.txt

COPY v2/cdm.py /app/cdm.py
COPY v2/voyo-shaka.ts /app/voyo-shaka.ts
COPY v2/docker/entrypoint.sh /usr/local/bin/voyo-entrypoint.sh

ENV DENO_DIR=/deno-dir

RUN deno cache /app/voyo-shaka.ts \
  && chmod +x /usr/local/bin/voyo-entrypoint.sh

ENV PYTHONUNBUFFERED=1 \
    DENO_DIR=/deno-dir \
    VOYO_PORT=8090 \
    VOYO_CDM_PORT=8091 \
    VOYO_CONFIG_DIR=/data \
    VOYO_CDM_DEVICE=/data/l3.wvd \
    VOYO_SEED_DIR=/seed-data \
    VOYO_MP4DECRYPT=/usr/local/bin/mp4decrypt \
    VOYO_SHAKA_PACKAGER=/usr/local/bin/packager

VOLUME ["/data"]

EXPOSE 8090

HEALTHCHECK --interval=30s --timeout=10s --start-period=20s --retries=5 \
  CMD ["/bin/bash", "-lc", "curl -fsS -u \"${VOYO_UI_BASIC_AUTH_USER:-adm}:${VOYO_UI_BASIC_AUTH_PASS:-fvoyo}\" \"http://127.0.0.1:${VOYO_PORT:-8090}/\" >/dev/null"]

ENTRYPOINT ["/usr/bin/tini", "--", "/usr/local/bin/voyo-entrypoint.sh"]
