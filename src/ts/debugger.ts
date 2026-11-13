import type { DebugProtocol } from '@vscode/debugprotocol';
import EventEmitter from 'events';

import { DapAdapter } from '../../pkg/engine';
import { Pipe, type WorkerMessage } from './process';
import { internal, Internals, join } from './util';

type DebuggerProtocolEvents = {
  /**
   * Emitted when the underlying debugger sends a DAP event.
   * @param event The event received.
   */
  event: [event: DebugProtocol.Event];
};

/**
 * The Debug Adapter Protocol (DAP) of a process' debugger.
 */
export class DebuggerProtocol extends EventEmitter<DebuggerProtocolEvents> {
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

  readonly #adapter = new DapAdapter();

  /** @internal */
  constructor(key: typeof Internals) {
    super();
    internal(key);
    this.#adapter.on((event: DebugProtocol.Event) => this.emit('event', event));
    this[Internals] = {
      receive: (message) => this.#adapter.receive(message),
      python: () => {
        const [commands, pauses] = [new Pipe(), new Pipe()];
        // Commands are written in turn, each waiting (in chunks) for the bridge to read it.
        let sent = Promise.resolve();
        const send = (line: string) =>
          (sent = sent.then(() => commands.write(line)).catch(() => {}));
        this.#adapter.receive({ type: 'python_debug', send });
        void (async () => {
          for await (const frame of pauses.lines())
            this.#adapter.receive({ type: 'paused', frame });
        })();
        return { '/__debug__/commands': commands, '/__debug__/pauses': pauses };
      }
    };
  }

  /**
   * Synchronously sends a DAP request and returns the response.
   */
  send(message: DebugProtocol.Request): DebugProtocol.Response {
    return this.#adapter.sendMessage(message);
  }
}

type StopDetails = DebugProtocol.StoppedEvent['body'];

/**
 * Information about the program at a location it has stopped at.
 */
export interface Stop extends StopDetails {
  /**
   * Gets the stack frames at this point in the program.
   *
   * If the returned array has length zero, there are no stack frames available.
   * This means that there is no location information available.
   */
  frames(): Frame[];
}

/**
 * Information about a stack frame (i.e. a function being called).
 */
export interface Frame extends DebugProtocol.StackFrame {
  /**
   * Gets the scopes for this stack frame.
   * A scope is a group of related variables corresponding to this frame.
   */
  scopes(): Scope[];

  /**
   * Gets the local variables of this frame.
   */
  locals(): Scope;

  /**
   * Gets the arguments of this frame.
   */
  args(): Scope;

  /**
   * Gets the global variables of this frame.
   */
  globals(): Scope;
}

export type VariableOptions = Omit<DebugProtocol.VariablesArguments, 'variablesReference'>;

/**
 * Information about a scope (i.e. a group of related variables).
 */
export interface Scope extends DebugProtocol.Scope {
  /**
   * Gets the variables in this scope.
   * @param options Options for determining which variables to return
   */
  vars(options?: VariableOptions): Variable[];
}

/**
 * Information about a variable.
 */
export interface Variable extends DebugProtocol.Variable {
  /**
   * Gets any child variables contained in this variable.
   * @param options Options for determining which variables to return
   */
  children(options?: VariableOptions): Variable[];
}

type DebuggerEvents = {
  /**
   * Emitted when the program stops on a location for debugging.
   * @param stop A handle to get more information about the current state of the program.
   */
  stop: [stop: Stop];
};

/**
 * The debugger of a process.
 */
export class Debugger extends EventEmitter<DebuggerEvents> {
  /** @internal */
  readonly [Internals]: DebuggerProtocol[typeof Internals];

  /**
   * Provides direct access to the Debug Adapter Protocol (DAP).
   *
   * You can learn more about the DAP at [this page](https://microsoft.github.io/debug-adapter-protocol/).
   */
  readonly dap = new DebuggerProtocol(Internals);

  readonly #configurable: Promise<unknown>;

  #seq = 0;
  #initialized = false;
  #configured = false;
  #terminated = false;

  /** @internal */
  constructor(key: typeof Internals) {
    super();
    internal(key);
    this.dap.on('event', ({ event, body }) => {
      if (event === 'stopped') this.emit('stop', this.#stop(body));
      if (event === 'terminated') this.#terminated = true;
    });
    this.#configurable = this.#next('initialized');
    this[Internals] = this.dap[Internals];
  }

  /**
   * Sets the breakpoints for a file. Clears the existing breakpoints, if any.
   * @param path The path to the file. Absolute and relative paths are treated identically.
   * @param breakpoints The breakpoints to set.
   * @returns The resolved breakpoints, one for each submitted breakpoint.
   *
   * Internally, this waits for the debugger to send the {@link DebugProtocol.InitializedEvent} if
   * it has not been sent already. If the process terminates before this event could be sent,
   * the returned breakpoints will be unverified.
   */
  async setBreakpoints(
    path: string,
    breakpoints: DebugProtocol.SourceBreakpoint[]
  ): Promise<DebugProtocol.Breakpoint[]> {
    if (!(await this.#ready())) return breakpoints.map(() => ({ verified: false }));
    const args = { source: { path: join(path) }, breakpoints };
    return this.#send<DebugProtocol.SetBreakpointsResponse>('setBreakpoints', args).breakpoints;
  }

  /**
   * Waits for the debugger to stop at the next location.
   * @returns The {@link Stop}, or `null` if the program finishes running.
   */
  continue(): Promise<Stop | null> {
    return this.#resume('continue');
  }

  /**
   * Steps into the current line.
   * @returns The {@link Stop}, or `null` if the program finishes running.
   */
  stepIn(): Promise<Stop | null> {
    return this.#resume('stepIn');
  }

  /**
   * Steps out of the current line.
   * @returns The {@link Stop}, or `null` if the program finishes running.
   */
  stepOut(): Promise<Stop | null> {
    return this.#resume('stepOut');
  }

  /**
   * Steps over the current line.
   * @returns The {@link Stop}, or `null` if the program finishes running.
   */
  stepOver(): Promise<Stop | null> {
    return this.#resume('next');
  }

  /** Initializes the session (once), and waits until the debuggee can be configured. */
  async #ready(): Promise<boolean> {
    if (!this.#initialized) {
      this.#initialized = true;
      this.#send('initialize', { adapterID: 'debugger-sh' });
    }
    await this.#configurable;
    return !this.#terminated;
  }

  /** Resumes the debuggee (or starts it, the first time), and waits for it to stop. */
  async #resume(command: string): Promise<Stop | null> {
    if (!(await this.#ready())) return null;
    const stopped = this.#next('stopped');
    // The engine is single-threaded.
    if (this.#configured) this.#send(command, { threadId: 1 });
    else this.#send('configurationDone');
    this.#configured = true;
    const event = await stopped;
    return event ? this.#stop(event.body) : null;
  }

  /** Waits for the next `name` event, or resolves `undefined` if the debuggee terminates first. */
  #next(name: string): Promise<DebugProtocol.Event | undefined> {
    return new Promise((resolve) => {
      const listener = (event: DebugProtocol.Event) => {
        if (event.event !== name && event.event !== 'terminated') return;
        this.dap.off('event', listener);
        resolve(event.event === name ? event : undefined);
      };
      this.dap.on('event', listener);
    });
  }

  /** Sends a request, returning the body of its response (or throwing its error). */
  #send<R extends DebugProtocol.Response>(command: string, args?: object): R['body'] {
    const request = { type: 'request', seq: ++this.#seq, command, arguments: args };
    const response = this.dap.send(request);
    if (!response.success) throw new Error(response.message);
    return response.body;
  }

  #stop(body: StopDetails): Stop {
    const frames = () =>
      this.#send<DebugProtocol.StackTraceResponse>('stackTrace', {
        threadId: body.threadId
      }).stackFrames.map((frame) => this.#frame(frame));
    return { ...body, frames };
  }

  #frame(frame: DebugProtocol.StackFrame): Frame {
    const scopes = () =>
      this.#send<DebugProtocol.ScopesResponse>('scopes', { frameId: frame.id }).scopes.map(
        (scope) => this.#scope(scope)
      );
    // Debuggers may omit scopes without any variables.
    const named = (name: string) => () =>
      scopes().find((scope) => scope.name === name) ??
      this.#scope({ name, variablesReference: 0, expensive: false });
    return {
      ...frame,
      scopes,
      locals: named('Locals'),
      args: named('Arguments'),
      globals: named('Globals')
    };
  }

  #scope(scope: DebugProtocol.Scope): Scope {
    return { ...scope, vars: (options) => this.#variables(scope.variablesReference, options) };
  }

  /** Gets the variables of a `variablesReference` (none, for `0`). */
  #variables(variablesReference: number, options?: VariableOptions): Variable[] {
    if (!variablesReference) return [];
    const args = { ...options, variablesReference };
    return this.#send<DebugProtocol.VariablesResponse>('variables', args).variables.map(
      (variable) => ({
        ...variable,
        children: (options) => this.#variables(variable.variablesReference, options)
      })
    );
  }
}
