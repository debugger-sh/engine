# A better debugging interface

Right now, the debugging interface that the library exposes is unsatisfying, since it relies on the user of the library to directly interface with the DAP. Direct DAP access should be supported, but there should also be a lightweight, higher-level user interface built on top of the DAP.

## DAP Protocol Access

Existing applications which use the DAP may continue to do so, but through the `protocol` member:

```ts
const proc = engine.run("cpp", { debug: true });
proc.debugger.protocol.send(/* ... */);
proc.debugger.protocol.on("event", () => /* ... */);
```

## Usage

```ts
const proc = engine.run('cpp', { debug: true });
const dbg = proc.debugger;

/**
 * Set breakpoints in the debugger for a file.
 * This maps directly to a `setBreakpoints` DAP request
 */
const bps = await dbg.setBreakpoints('main.cpp', [{ line: 5 }]);
console.log(bps); // [{ verified: true, /* ... */ }]

/**
 * Continue until the debugger pauses somewhere
 */
let stop = await dbg.continue();

/**
 * The stop may be `null` if the debugger did not pause by the time
 * the process exits.
 */
while (stop) {

  for (const frame of stop.frames()) {
    console.log(`${frame.name} @ ${frame.source.path}:${frame.line}`);

    for (const scope of frame.scopes()) {
      console.log(`\t${scope.name}:`);
      for (const var of scope.variables()) {
        console.log(
          `\t\t- Name:\t${var.name}\n` +
          `\t\t  Value:\t${var.value}\n` +
          `\t\t  Type:\t${var.type}`
        );
      }
    }
  }

  stop = await dbg.continue();
}
```

## Implementation Details

The implementation should follow the spec defined in `interface.ts` and should use the same doc-comments.

This implementation should be a thin wrapper around the DAP and not maintain any extra state beyond what is absolutely necessary. For example, methods like `frames` and `scopes` should not cache their result, but rather re-query the DAP each time they are called.

Configuration requests like `setBreakpoints` should wait for the `initialized` event to be returned from the client.

Stepping commands (`continue`, `stepIn`, `stepOut`, `stepOver`) should trigger `configurationDone` if it has not been sent already.

It is valid to call any of the stepping commands without doing any configuration. For example, calling `debugger.continue` without any breakpoints will most likely just wait until the process terminates and return `null`.

All of these operations should be aware of the process terminating before they complete. For example, the process could be terminated while waiting on the `initialized` event. In this case, `setBreakpoints` would return unverified results.

The implementation should be as simple and lightweight as possible.
