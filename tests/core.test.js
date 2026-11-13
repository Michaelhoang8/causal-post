import test from 'node:test';
import assert from 'node:assert/strict';
import { Simulator, compareVectors, importScenario, scenarios } from '../core.js';
test('vector comparison distinguishes order, equality and concurrency', () => {
  assert.equal(compareVectors([1, 0], [2, 1]), 'before');
  assert.equal(compareVectors([2, 1], [1, 0]), 'after');
  assert.equal(compareVectors([2, 0], [0, 1]), 'concurrent');
  assert.equal(compareVectors([2, 1], [2, 1]), 'equal');
  assert.throws(() => compareVectors([1], [1, 0]));
  assert.throws(() => compareVectors([NaN], [0]));
});
test('send stamps a snapshot and receive merges then ticks its own component', () => {
  const sim = new Simulator();
  sim.apply({ type: 'local', node: 'A' });
  sim.apply({ type: 'send', from: 'A', to: 'B' });
  sim.apply({ type: 'local', node: 'A' });
  sim.apply({ type: 'deliver', message: 'm1' });
  const s = sim.snapshot();
  assert.deepEqual(s.messages[0].vector, [2, 0, 0]);
  assert.deepEqual(s.nodes.A.vector, [3, 0, 0]);
  assert.deepEqual(s.nodes.B.vector, [2, 1, 0]);
  assert.equal(s.nodes.B.lamport, 3);
  assert.deepEqual(s.events[3].dependencies, ['e2']);
  assert.equal(sim.compare('e3', 'e4').relation, 'concurrent');
});
test('Lamport timestamps alone do not establish causality', () => {
  const sim = importScenario(scenarios.concurrent),
    r = sim.compare('e2', 'e3');
  assert.equal(r.relation, 'concurrent');
  assert.ok(r.first.lamport > r.second.lamport);
  assert.equal(sim.compare('e2', 'e7').relation, 'before');
});
test('partitions are directed, block delivery atomically, and healing does not auto-deliver', () => {
  const sim = importScenario(scenarios.partition),
    before = sim.snapshot();
  assert.throws(() => sim.apply({ type: 'deliver', message: 'm1' }), /partitioned/);
  assert.deepEqual(sim.snapshot(), before);
  sim.apply({ type: 'send', from: 'B', to: 'A' });
  sim.apply({ type: 'deliver', message: 'm3' });
  sim.apply({ type: 'heal', from: 'A', to: 'B' });
  assert.equal(sim.snapshot().messages[0].status, 'pending');
  sim.apply({ type: 'deliver', message: 'm1' });
  assert.equal(sim.snapshot().messages[0].status, 'delivered');
});
test('out-of-order delivery never moves logical clocks backward', () => {
  const sim = importScenario(scenarios.reorder),
    before = sim.snapshot().nodes.B;
  sim.apply({ type: 'deliver', message: 'm1' });
  const after = sim.snapshot().nodes.B;
  assert.deepEqual(before.vector, [2, 1, 0]);
  assert.deepEqual(after.vector, [2, 2, 0]);
  assert.equal(after.lamport, before.lamport + 1);
});
test('crashes block local work and receipt while retaining clocks on recovery', () => {
  const sim = new Simulator();
  sim.apply({ type: 'send', from: 'A', to: 'B' });
  sim.apply({ type: 'crash', node: 'A' });
  sim.apply({ type: 'deliver', message: 'm1' }); // An already-sent message can outlive its sender.
  sim.apply({ type: 'crash', node: 'B' });
  const before = sim.snapshot();
  assert.throws(() => sim.apply({ type: 'local', node: 'B' }), /crashed/);
  assert.deepEqual(sim.snapshot(), before);
  sim.apply({ type: 'recover', node: 'B' });
  sim.apply({ type: 'local', node: 'B' });
  assert.deepEqual(sim.snapshot().nodes.B.vector, [1, 2, 0]);
});
test('dropped or delivered messages cannot be delivered again', () => {
  const sim = new Simulator();
  sim.apply({ type: 'send', from: 'A', to: 'B' });
  sim.apply({ type: 'drop', message: 'm1' });
  assert.throws(() => sim.apply({ type: 'deliver', message: 'm1' }), /pending/);
  assert.equal(sim.snapshot().events.length, 1);
});
test('scenario round-trip is deterministic and failed imports leave existing simulations untouched', () => {
  const sim = importScenario(scenarios.concurrent),
    before = sim.snapshot();
  assert.deepEqual(importScenario(JSON.stringify(sim.export())).snapshot(), before);
  const bad = sim.export();
  bad.commands.push({ type: 'deliver', message: 'm99' });
  assert.throws(() => importScenario(bad), /Command 8/);
  assert.deepEqual(sim.snapshot(), before);
  const copy = sim.snapshot();
  copy.nodes.A.vector[0] = 999;
  assert.notEqual(sim.snapshot().nodes.A.vector[0], 999);
});
test('strict command and configuration validation never records failed operations', () => {
  for (const nodes of [[], ['A'], ['A', 'A'], ['__proto__', 'B'], ['a', 'B']])
    assert.throws(() => new Simulator(nodes));
  const sim = new Simulator(),
    before = sim.snapshot();
  for (const command of [
    { type: 'constructor' },
    { type: 'local', node: 'Z' },
    { type: 'local', node: 'A', extra: true },
    { type: 'send', from: 'A', to: 'A' },
    { type: 'local', node: 'A', label: 7 },
  ])
    assert.throws(() => sim.apply(command));
  assert.deepEqual(sim.snapshot(), before);
});
test('event limits preserve the last valid state', () => {
  const sim = new Simulator();
  for (let i = 0; i < 200; i++) sim.apply({ type: 'local', node: 'A' });
  const before = sim.snapshot();
  assert.throws(() => sim.apply({ type: 'send', from: 'A', to: 'B' }), /200-event/);
  assert.deepEqual(sim.snapshot(), before);
});
test('vector order agrees with independently traversed causal edges for every event pair', () => {
  const sim = new Simulator(['A', 'B', 'C', 'D']);
  let seed = 17;
  const random = () => {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    return seed;
  };
  for (let i = 0; i < 100; i++) {
    const s = sim.snapshot(),
      pending = s.messages.filter((m) => m.status === 'pending'),
      from = s.order[random() % 4],
      to = s.order[(s.order.indexOf(from) + 1 + (random() % 3)) % 4];
    if (pending.length && random() % 3 === 0)
      sim.apply({ type: 'deliver', message: pending[random() % pending.length].id });
    else if (random() % 2) sim.apply({ type: 'send', from, to });
    else sim.apply({ type: 'local', node: from });
  }
  const events = sim.snapshot().events,
    ancestors = new Map();
  for (const e of events) {
    const set = new Set(e.dependencies);
    for (const parent of e.dependencies) for (const id of ancestors.get(parent)) set.add(id);
    ancestors.set(e.id, set);
  }
  for (const a of events)
    for (const b of events) {
      const expected =
        a.id === b.id
          ? 'equal'
          : ancestors.get(b.id).has(a.id)
            ? 'before'
            : ancestors.get(a.id).has(b.id)
              ? 'after'
              : 'concurrent';
      assert.equal(compareVectors(a.vector, b.vector), expected, `${a.id} versus ${b.id}`);
      if (expected === 'before') assert.ok(a.lamport < b.lamport);
    }
});
