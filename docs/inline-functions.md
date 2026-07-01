## Support for inline functions

Right now, inline functions are unsupported by the engine--that is, if we have a snippet of code like this:

```rs
#[inline(always)]
fn add(a: i32, b: i32) -> i32 {
    let sum = a + b;
    sum
}

fn main() {
    let result = add(3, 5);   // Breakpoint set here
    println!("{}", result);
}
```

Setting a breakpoint on the indicated line and then stepping into the line does not actually show `add` as one of the stack frames in the backtrace. Moreover, stepping over the line does not correctly step onto the `println!` line: instead, it steps into locations that our semantically inside the `add` function.

The reason why is that since the call to `add` does not correspond to any `call` instructions in the generated WebAssembly, the instrumented code never adds an entry for it onto the debugger call stack, and so the debugger has no knowledge that it occurred. When we step over, the debugger sees the breakpoints for the inlined function and thinks, incorrectly, that we are still in the `main` function.

## Solution

One way to solve this problem would be to add instrumentation code to the wasm that logs call frames for each inline function. This is not ideal for two reasons: first, given a PC, we can perfectly reconstruct the inline function call stack, since the DWARF tells us which inline functions are called over which PC ranges, making the addition debug frames redundant. Second, and perhaps more importantly, variables from the inline functions indicated in the DWARF re-use information from their containing function. For example, an inline function's parameter might be defined in terms of an offset to the same function base register of the parent (non-inline) function.

For these reasons, we will aspire to handle inline functions with essentially little to no performance impact and without adding any instrumented code to the running binary. We will keep the layout of the debug stack unchanged and make no changes to how functions are instrumented. Instead, we will use the information stored in the DWARF to determine our best guess of what the inline function call stack was. When the worker thread reports a breakpoint, we will decide whether to trigger a real breakpoint depending on whether we are stepping in/out/over and depending on how the inline call stack has changed since the last breakpoint.

### Generating an inline backtrace

Consider the following snippet:

```c
#include <stdio.h>

inline void bar(void) {
    printf("bar\n");    // Point A
}

inline void foo(void) {
    bar();
}

int main(void) {
    foo();
    return 0;
}
```

The compiler might encode this into the DWARF like so (hypothetical `llvm-dwarfdump` output):

```
0x00000000: DW_TAG_subprogram
              DW_AT_name	("main")
              DW_AT_low_pc	(0x00001000)
              DW_AT_high_pc	(0x00001050)

0x00000021:   DW_TAG_inlined_subroutine
                DW_AT_abstract_origin	(0x000000a0 "foo")
                DW_AT_low_pc	(0x00001010)
                DW_AT_high_pc	(0x00001040)
                DW_AT_call_file	(1 "example.c")
                DW_AT_call_line	(12)

0x00000038:     DW_TAG_inlined_subroutine
                  DW_AT_abstract_origin	(0x000000b0 "bar")
                  DW_AT_low_pc	(0x00001020)
                  DW_AT_high_pc	(0x00001030)
                  DW_AT_call_file	(1 "example.c")
                  DW_AT_call_line	(8)

0x000000a0: DW_TAG_subprogram
              DW_AT_name	("foo")
              DW_AT_inline	(DW_INL_inlined)

0x000000b0: DW_TAG_subprogram
              DW_AT_name	("bar")
              DW_AT_inline	(DW_INL_inlined)
```

To see how our approach might work at a high level, we can imagine that the function lifetimes semantically look like the following, even if they are not actually realized:

```
main()            ├──────────────────────────┤
foo() [inline]        ├──────────────────┤
bar() [inline]              ├────────┤

                                ^
                                A
```

Suppose that we are stopped at point A inside of `main()` which happens to be at PC `0x1025`. We could then apply the following procedure to reconstruct the inline call stack:

1. Resolve the inner-most DIE corresponding to that PC, which in this case corresponds to `0x38` or the `DW_TAG_inlined_subroutine` for `bar`.
2. The inner-most stack frame can be determined by combining the name of `0x38`'s function (by inspecting `DW_AT_abstract_origin` and getting its `qualified_name`) and the location at the current stop point to get:

   ```json
   {
     "id": 0,
     "name": "bar",
     "line": 4,
     "column": 0,
     "source": "example.c"
   }
   ```

3. We proceed by identifying the parent function of `0x38`, which is `0x21`. The next stack frame can be determined by looking at the `DW_AT_call_file`, `DW_AT_call_line` and `DW_AT_call_column` attributes of `0x38`. The function name is determined by the `DW_AT_abstract_origin` of `0x21`. Putting this together, we get:

   ```json
   {
     "id": 1,
     "name": "foo",
     "line": 8,
     "column": 0,
     "source": "example.c"
   }
   ```

4. Finally, we get the parent fo `0x21`, which is `0x0` or `main` itself. Repeating the same procedure, we get:

   ```json
   {
     "id": 2,
     "name": "main",
     "line": 12,
     "column": 0,
     "source": "example.c"
   }
   ```

### Implementing stepping

The worker thread will not take into account inline stack frames when choosing to step into/out/over. So the locations at which the worker chooses to stop at are a superset of the locations we actually want to stop at. We must enforce this behaviour in the main thread debugger for it to properly take effect.

We can do this with the following simple rules. On hitting a breakpoint on the main thread:

- If we are in step over mode, if the last stop point corresponded to the same function and the inline stack depth grew larger, ignore it. Otherwise, handle the breakpoint normally.
- If we are in step out mode, if the last stop point corresponded to the same function and the inline stack depth grew smaller, trigger a breakpoint. Otherwise, ignore it.

It is okay if these checks are done heuristically–we should not resolve the entire backtrace in order to implement these rules in case of large stack depths. We could, for example, implement this quickly by.

YAARRRGH but for stepping out, we won't actually hit the step out location since the worker will not fire a breakpoint if the _real_ stack depth did not grow smaller.

It looks like we're gonna need to re-imagine how stepping is implemented in order to do this well...
