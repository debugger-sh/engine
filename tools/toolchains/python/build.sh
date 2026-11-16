#!/usr/bin/env bash
# Builds CPython for wasm32-wasip1 inside the Docker image, with CPython's own WASI build
# (Platforms/WASI), from the revision in provenance.json:
#
#  * /out/python.wasm: the interpreter.
#  * /out/sysroot.tar.zst: the standard library, precompiled into /usr/local/lib/python3XY.zip
#    (the prefix the interpreter is built for).
#
# The C libraries that the standard library's optional modules need (zlib, bz2, lzma, sqlite3)
# are built too; decimal uses CPython's bundled libmpdec.
set -euo pipefail
source /toolchain/common.sh

DEPS=$WASI_SDK/share/wasi-sysroot
CC=("$WASI_SDK/bin/clang" --target=$TARGET -O2 $CFLAGS)
fetch cpython "$(upstream repository)" "$(upstream revision)"

# A library for CPython's build (Platforms/WASI looks for them with pkg-config, in wasi-sdk's
# sysroot): <name> <version> <archive> <headers...>.
library() {
  mkdir -p "$DEPS/lib/pkgconfig" "$DEPS/include"
  cp "$3" "$DEPS/lib/" && cp -R "${@:4}" "$DEPS/include/"
  printf 'Name: %s\nDescription: %s\nVersion: %s\nLibs: -L/lib -l%s\nCflags: -I/include\n' \
    "$1" "$1" "$2" "$(basename "$3" .a | sed s/^lib//)" > "$DEPS/lib/pkgconfig/$1.pc"
}
# A release tarball, checked against its SHA-256, unpacked into <dir>: <dir> <url> <sha256>.
download() {
  [[ -d $1 ]] || { curl -fsSL "$2" -o "$1.tar.gz" && echo "$3  $1.tar.gz" | sha256sum -c - \
    && mkdir "$1" && tar -xzf "$1.tar.gz" -C "$1" --strip-components=1; }
}

fetch zlib https://github.com/madler/zlib v1.4
(cd zlib && for f in adler32 crc32 deflate infback inffast inflate inftrees trees zutil compress uncompr gzclose gzlib gzread gzwrite; do
  "${CC[@]}" -DHAVE_UNISTD_H -c "$f.c" -o "$f.o"; done && "$WASI_SDK/bin/llvm-ar" rcs libz.a ./*.o)
library zlib 1.4 zlib/libz.a zlib/zlib.h zlib/zconf.h

download bzip2 https://sourceware.org/pub/bzip2/bzip2-1.0.8.tar.gz \
  ab5a03176ee106d3f0fa90e381da478ddae405918153cca248e682cd0c4a2269
(cd bzip2 && for f in blocksort huffman crctable randtable compress decompress bzlib; do
  "${CC[@]}" -D_FILE_OFFSET_BITS=64 -c "$f.c" -o "$f.o"; done && "$WASI_SDK/bin/llvm-ar" rcs libbz2.a ./*.o)
library bzip2 1.0.8 bzip2/libbz2.a bzip2/bzlib.h

fetch xz https://github.com/tukaani-project/xz v5.8.4
configure xz xz -DCMAKE_C_FLAGS="$CFLAGS" -DBUILD_SHARED_LIBS=OFF -DXZ_THREADS=no -DXZ_NLS=OFF \
  -DXZ_TOOL_XZ=OFF -DXZ_TOOL_XZDEC=OFF -DXZ_TOOL_LZMADEC=OFF -DXZ_TOOL_LZMAINFO=OFF -DXZ_TOOL_SCRIPTS=OFF -DXZ_DOC=OFF
ninja -C build/xz liblzma
library liblzma 5.8.4 build/xz/liblzma.a xz/src/liblzma/api/lzma.h xz/src/liblzma/api/lzma

# SQLite without what WASI lacks: threads, mmap, WAL's shared memory and loadable extensions.
download sqlite https://www.sqlite.org/2026/sqlite-autoconf-3540100.tar.gz \
  926ef8d3eab93fbf6e06011901273eec076b25594a4e1cdadd50c987f4f6d64e
"${CC[@]}" -DSQLITE_THREADSAFE=0 -DSQLITE_OMIT_LOAD_EXTENSION -DSQLITE_OMIT_WAL -DSQLITE_MAX_MMAP_SIZE=0 \
  -DSQLITE_OMIT_SHARED_CACHE -DSQLITE_DEFAULT_LOCKING_MODE=1 -D_WASI_EMULATED_GETPID \
  -DSQLITE_ENABLE_FTS5 -DSQLITE_ENABLE_MATH_FUNCTIONS -c sqlite/sqlite3.c -o sqlite/sqlite3.o
"$WASI_SDK/bin/llvm-ar" rcs sqlite/libsqlite3.a sqlite/sqlite3.o
library sqlite3 3.54.1 sqlite/libsqlite3.a sqlite/sqlite3.h
echo 'Libs.private: -lwasi-emulated-getpid' >> "$DEPS/lib/pkgconfig/sqlite3.pc"

# The interpreter is only run by the build as a final check, for which no WASI host is needed.
(cd cpython && python3 Platforms/WASI build-python --quiet \
  && python3 Platforms/WASI configure-host --quiet --wasi-sdk "$WASI_SDK" --host-runner true \
    -- --prefix=/usr/local --without-system-libmpdec \
  && python3 Platforms/WASI make-host --quiet)
# Optimized for speed rather than size, which makes little difference to its size.
optimize cpython/cross-build/$TARGET/python.wasm /out/python.wasm -O2

# The standard library, without what can't work in the browser (processes, terminals, GUIs,
# package installs) or isn't needed there (its tests), compiled by this same version of CPython
# (the build machine's) to .pyc files that record their paths in the sysroot.
PYTHON=$(echo cpython/cross-build/*-linux-gnu/python)
VERSION=$($PYTHON -c 'import sys; print(f"{sys.version_info[0]}.{sys.version_info[1]}")')
STDLIB=/work/stdlib
LIB=$STDLIB/usr/local/lib/python$VERSION
rm -rf "$STDLIB" && mkdir -p "$LIB/lib-dynload" && touch "$LIB/lib-dynload/.empty"
tar -cf - -C cpython/Lib --exclude=__pycache__ --exclude=./test --exclude=./idlelib --exclude=./tkinter \
  --exclude=./turtledemo --exclude=./turtle.py --exclude=./ensurepip --exclude=./venv --exclude=./curses \
  --exclude=./multiprocessing --exclude=./profiling . | tar -xf - -C "$LIB"
cp cpython/cross-build/$TARGET/build/lib.wasi-wasm32-$VERSION/_sysconfig* "$LIB/"
$PYTHON -m compileall -q -b -s "$STDLIB" -p / --invalidation-mode unchecked-hash "$LIB"
# The modules are stored uncompressed in the zip (so importing never inflates), next to the
# landmarks that the interpreter looks for to find its prefix (os.py and lib-dynload).
python3 - "$LIB" "$STDLIB/usr/local/lib/python${VERSION/./}.zip" <<'EOF'
import os, sys, zipfile
lib, out = sys.argv[1:]
with zipfile.ZipFile(out, 'w', zipfile.ZIP_STORED) as archive:
    for root, dirs, files in sorted(os.walk(lib)):
        for name in sorted(files):
            if name.endswith('.pyc') or (name.startswith('_sysconfig') and name.endswith('.json')):
                path = os.path.join(root, name)
                info = zipfile.ZipInfo(os.path.relpath(path, lib), date_time=(1980, 1, 1, 0, 0, 0))
                archive.writestr(info, open(path, 'rb').read())
EOF
find "$LIB" -mindepth 1 -maxdepth 1 ! -name os.py ! -name lib-dynload -exec rm -rf {} +
pack "$STDLIB" /out/sysroot.tar.zst
ls -lh /out
