FROM ubuntu:24.04

RUN apt-get update && apt-get install -y --no-install-recommends \
    ca-certificates cmake curl g++ git ninja-build python3 \
    && rm -rf /var/lib/apt/lists/*

ARG WASI_SDK=34
RUN mkdir /opt/wasi-sdk && curl -fsSL "https://github.com/WebAssembly/wasi-sdk/releases/download/wasi-sdk-${WASI_SDK}/wasi-sdk-${WASI_SDK}.0-$(uname -m | sed s/aarch64/arm64/)-linux.tar.gz" \
    | tar -xz -C /opt/wasi-sdk --strip-components=1

COPY build.sh provenance.json changes.patch /toolchain/
CMD ["/toolchain/build.sh"]
