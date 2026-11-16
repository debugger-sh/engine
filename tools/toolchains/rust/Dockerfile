FROM debugger-sh-toolchain
COPY rust/ /toolchain/
# The LLVM that rustc uses gets the same changes as the llvm toolchain's.
COPY llvm/changes.patch /toolchain/llvm.patch
CMD ["/toolchain/build.sh"]
