# The image every toolchain builds in (as `debugger-sh-toolchain`): wasi-sdk to compile for
# wasm32-wasip1, Binaryen to optimize the result, and common.sh.
FROM ubuntu:24.04

RUN apt-get update && apt-get install -y --no-install-recommends \
    ca-certificates cmake curl g++ git make ninja-build pkg-config python3 xz-utils zstd \
    && rm -rf /var/lib/apt/lists/*

ARG WASI_SDK=34
RUN mkdir /opt/wasi-sdk && curl -fsSL "https://github.com/WebAssembly/wasi-sdk/releases/download/wasi-sdk-${WASI_SDK}/wasi-sdk-${WASI_SDK}.0-$(uname -m | sed s/aarch64/arm64/)-linux.tar.gz" \
    | tar -xz -C /opt/wasi-sdk --strip-components=1

ARG BINARYEN=133
RUN mkdir /opt/binaryen && curl -fsSL "https://github.com/WebAssembly/binaryen/releases/download/version_${BINARYEN}/binaryen-version_${BINARYEN}-$(uname -m)-linux.tar.gz" \
    | tar -xz -C /opt/binaryen --strip-components=1

COPY common.sh /toolchain/
