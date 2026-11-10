import * as library from 'debugger-sh';
import { Engine } from 'debugger-sh';
import { expect, test } from 'vitest';

import { createEngine } from '../helpers';

type Constructor = new (...args: unknown[]) => unknown;
const constructorOf = (value: object) => value.constructor as Constructor;

test('Engine is the only value exported by the library', () => {
  expect(Object.keys(library)).toEqual(['Engine']);
});

test('engines are only created by Engine.create', () => {
  expect(() => new (Engine as unknown as Constructor)()).toThrow('Illegal constructor');
});

test('library objects cannot be constructed by consumers', async () => {
  const engine = await createEngine({ 'main.py': 'pass' });
  const proc = engine.run('python', { debug: true });
  for (const value of [engine.fs, proc, proc.stdin, proc.stdout, proc.debugger])
    expect(() => new (constructorOf(value))()).toThrow('Illegal constructor');
  proc.kill();
});

test('library objects expose no internals by name', async () => {
  const engine = await createEngine();
  const proc = engine.run('nope');
  expect(Object.keys(engine)).toEqual(['fs']);
  expect(Object.keys(proc).sort()).toEqual(['debugger', 'stderr', 'stdin', 'stdout']);
  expect(Object.keys(proc.stdin)).toEqual([]);
  expect(Object.keys(engine.fs)).toEqual([]);
  await proc;
});
