import EventEmitter from 'events';

import { DapAdapter } from '../../pkg/engine';
import type { WorkerMessage } from './process';
import { Internals } from './util';

type DebuggerEventMap = {
  event: [unknown];
  artifact: [Artifact];
};

export class Artifact {
  public readonly name: string;
  public readonly data: Uint8Array;

  constructor(name: string, data: Uint8Array) {
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
  /**
   * Access to internal properties of the debugger.
   * These are put under a special symbol so that they cannot be accessed by
   * clients of the library.
   */
  [Internals]: {
    /** Receives a message from the worker running the debuggee. */
    receive(message: WorkerMessage): void;
  };

  private readonly dap = new DapAdapter();

  /** @param filterInternals Omit internal (bridge) frames from Python stack traces. */
  constructor(filterInternals = false) {
    super();
    this.dap.setFilterInternals(filterInternals);
    this.dap.on((message: unknown) => this.emit('event', message));
    this[Internals] = {
      receive: (message) => {
        if (message.type === 'artifact')
          this.emit(
            'artifact',
            new Artifact(message.name as string, new Uint8Array(message.data as Uint8Array))
          );
        else this.dap.receive(message);
      }
    };
  }

  /** Sends a DAP request, synchronously returning its response. Events are emitted via `on('event')`. */
  public send(message: unknown): unknown {
    return this.dap.sendMessage(message);
  }
}
