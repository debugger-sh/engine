import type { DebugProtocol } from '@vscode/debugprotocol';
import EventEmitter from 'events';

export interface DebuggerProtocol extends EventEmitter<{
  event: [DebugProtocol.Event];
}> {
  /**
   * Emitted when the underlying debugger sends a DAP event.
   * @param chunk The event received.
   */
  on(event: 'event', listener: (event: DebugProtocol.Event) => void): this;

  /**
   * Synchronously sends a DAP event and returns the response.
   */
  send(message: DebugProtocol.Request): DebugProtocol.Response;
}

export interface Debugger extends EventEmitter<{
  stop: [Stop];
}> {
  /**
   * Emitted when the program stops on a location for debugging.
   * @param stop A handle to get more information about the current state of the program.
   */
  on(event: 'stop', listener: (stop: Stop) => void): this;

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
  setBreakpoints(
    path: string,
    breakpoints: DebugProtocol.SourceBreakpoint[]
  ): Promise<DebugProtocol.Breakpoint[]>;

  /**
   * Waits for the debugger to stop at the next location.
   * @returns The {@link Stop}, or `null` if the program finishes running.
   */
  continue(): Promise<Stop | null>;

  /**
   * Steps into the current line.
   * @returns The {@link Stop}, or `null` if the program finishes running.
   */
  stepIn(): Promise<Stop | null>;

  /**
   * Steps out of the current line.
   * @returns The {@link Stop}, or `null` if the program finishes running.
   */
  stepOut(): Promise<Stop | null>;

  /**
   * Steps over the current line.
   * @returns The {@link Stop}, or `null` if the program finishes running.
   */
  stepOver(): Promise<Stop | null>;
}

type StopDetails = DebugProtocol.StoppedEvent['body'];

/**
 * Information about the program at a location it has stopped at.
 */
interface Stop extends StopDetails {
  /**
   * Gets the stack frames at this point in the program.
   */
  frames(): Frame[];
}

/**
 * Information about a stack frame (i.e. a function being called).
 */
interface Frame extends DebugProtocol.StackFrame {
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

type VariableOptions = Omit<DebugProtocol.VariablesArguments, 'variablesReference'>;

/**
 * Information about a scope (i.e. a group of related variables).
 */
interface Scope extends DebugProtocol.Scope {
  /**
   * Gets the variables in this scope.
   * @param options Options for determining which variables to return
   */
  vars(options?: VariableOptions): Variable[];
}

/**
 * Information about a variable.
 */
interface Variable extends DebugProtocol.Variable {
  /**
   * Gets any child variables contained in this variable.
   * @param options Options for determining which variables to return
   */
  children(options?: VariableOptions): Variable[];
}
