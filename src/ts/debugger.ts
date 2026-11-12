import EventEmitter from 'events';

import { DapAdapter } from '../../pkg/engine';
import { Pipe, type WorkerMessage } from './process';
import { internal, Internals } from './util';

type DebuggerEventMap = {
  event: [unknown];
};

/**
 * A Debug Adapter Protocol (DAP) debugger, tied to one process.
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
   */
  constructor(key: typeof Internals) {
    super();
    internal(key);
    this.#dap.on((message: unknown) => this.emit('event', message));
    this[Internals] = {
      receive: (message) => this.#dap.receive(message),
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
