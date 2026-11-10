import EventEmitter from 'events';

import { DapAdapter } from '../../pkg/engine';
import { Pipe, type WorkerMessage } from './process';
import { internal, Internals } from './util';

type DebuggerEventMap = {
  event: [unknown];
  artifact: [Artifact];
};

/** A file emitted by the engine while debugging (e.g. the instrumented WebAssembly). */
export class Artifact {
  public readonly name: string;
  public readonly data: Uint8Array;

  /** @internal */
  constructor(key: typeof Internals, name: string, data: Uint8Array) {
    internal(key);
    this.name = name;
    this.data = data;
  }

  public download() {
    const bytes = new Uint8Array(this.data);
    const blob = new Blob([bytes]);
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = this.name;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  }
}

/**
 * A Debug Adapter Protocol (DAP) debugger, tied to one process.
 *
 * The process only makes progress once the DAP handshake (`configurationDone`) completes.
 */
export class Debugger extends EventEmitter<DebuggerEventMap> {
  /** @internal */
  readonly [Internals]: {
    /** Receives a message from the worker running the debuggee. */
    receive(message: WorkerMessage): void;
    /**
     * Creates the devices through which the Python bridge (`bridge.py`) talks to this
     * debugger: pipes of commands and of pauses, each carrying one JSON message per line.
     */
    python(): Record<string, Pipe>;
  };

  readonly #dap = new DapAdapter();

  /**
   * @internal
   * @param filterInternals Omit internal (bridge) frames from Python stack traces.
   */
  constructor(key: typeof Internals, filterInternals = false) {
    super();
    internal(key);
    this.#dap.setFilterInternals(filterInternals);
    this.#dap.on((message: unknown) => this.emit('event', message));
    this[Internals] = {
      receive: (message) => {
        if (message.type === 'artifact')
          this.emit(
            'artifact',
            new Artifact(
              Internals,
              message.name as string,
              new Uint8Array(message.data as Uint8Array)
            )
          );
        else this.#dap.receive(message);
      },
      python: () => {
        const [commands, pauses] = [new Pipe(), new Pipe()];
        // Commands are written in turn, each waiting (in chunks) for the bridge to read it.
        let sent = Promise.resolve();
        const send = (line: string) =>
          (sent = sent.then(() => commands.write(line)).catch(() => {}));
        this.#dap.receive({ type: 'python_debug', send });
        void (async () => {
          for await (const frame of pauses.lines()) this.#dap.receive({ type: 'paused', frame });
        })();
        return { '/__debug__/commands': commands, '/__debug__/pauses': pauses };
      }
    };
  }

  /** Sends a DAP request, synchronously returning its response. Events are emitted via `on('event')`. */
  public send(message: unknown): unknown {
    return this.#dap.sendMessage(message);
  }
}
