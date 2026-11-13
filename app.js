import { Simulator, importScenario, scenarios } from './core.js';
const $ = (id) => document.getElementById(id);
const escape = (value) =>
  String(value).replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c],
  );
let sim = importScenario(scenarios.concurrent),
  page = 0,
  revision = 0,
  nextComparison = 'a';
const pageSize = 50;
function notice(text, error = false) {
  $('notice').textContent = text;
  $('notice').className = error ? 'error' : '';
  $('settings-notice').textContent = text;
  $('settings-notice').className = error ? 'error' : '';
}
function download(name, value) {
  const url = URL.createObjectURL(
      new Blob([JSON.stringify(value, null, 2)], { type: 'application/json' }),
    ),
    link = document.createElement('a');
  link.href = url;
  link.download = name;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
function select(id, options, fallback = 0) {
  const el = $(id),
    previous = el.value;
  el.replaceChildren();
  for (const [value, label] of options) {
    const option = document.createElement('option');
    option.value = value;
    option.textContent = label;
    el.append(option);
  }
  el.value = options.some(([value]) => value === previous)
    ? previous
    : (options[fallback]?.[0] ?? '');
  el.disabled = !options.length;
}
function apply(command) {
  revision++;
  try {
    sim.apply(command);
    page = Math.max(0, Math.ceil(sim.snapshot().events.length / pageSize) - 1);
    render();
    notice(
      {
        local: 'Local event recorded.',
        send: 'Message queued. You control when it arrives.',
        deliver: 'Message delivered; receiver clocks merged and advanced.',
        drop: 'Message dropped. No receive event was created.',
        partition: 'Directed link partitioned. Messages stay queued.',
        heal: 'Link healed. Deliver its pending messages explicitly.',
        crash: 'Replica paused. Its clocks are retained.',
        recover: 'Replica recovered with its previous clocks.',
      }[command.type],
    );
  } catch (error) {
    notice(error.message, true);
  }
}
function renderNodes(state) {
  $('nodes').innerHTML = state.order
    .map((id, index) => {
      const n = state.nodes[id];
      return `<article class="node ${n.alive ? '' : 'crashed'}"><div class="node-top"><span class="node-name">${id}</span><span class="node-status">${n.alive ? '● RUNNING' : '○ CRASHED'}</span></div><div class="vector" aria-label="${id} vector clock">[${n.vector.map((v, i) => (i === index ? `<span class="own">${v}</span>` : v)).join(', ')}]</div><div class="lamport">Lamport ${n.lamport}</div><div class="node-actions"><button data-action="local" data-node="${id}" ${n.alive ? '' : 'disabled'} aria-label="Local event on ${id}">Local event +</button><button data-action="${n.alive ? 'crash' : 'recover'}" data-node="${id}" aria-label="${n.alive ? 'Crash' : 'Recover'} node ${id}">${n.alive ? 'Crash' : 'Recover'}</button></div></article>`;
    })
    .join('');
  $('vector-order').textContent = 'VECTOR ORDER: ' + state.order.join(' / ');
}
function renderSequence(state) {
  const root = $('sequence'),
    ns = 'http://www.w3.org/2000/svg';
  const make = (tag, attrs, text) => {
    const n = document.createElementNS(ns, tag);
    for (const [key, value] of Object.entries(attrs)) n.setAttribute(key, value);
    if (text !== undefined) n.textContent = text;
    return n;
  };
  const width = Math.max(620, state.order.length * 180),
    height = Math.max(180, state.events.length * 34 + 70);
  root.setAttribute('viewBox', `0 0 ${width} ${height}`);
  root.setAttribute('width', width);
  root.setAttribute('height', height);
  root.replaceChildren();
  const positions = new Map(
    state.events.map((e, i) => [
      e.id,
      {
        x: 70 + (state.order.indexOf(e.node) * (width - 220)) / Math.max(1, state.order.length - 1),
        y: 62 + i * 34,
      },
    ]),
  );
  const defs = make('defs', {}),
    marker = make('marker', {
      id: 'causal-arrow',
      viewBox: '0 0 10 10',
      refX: 9,
      refY: 5,
      markerWidth: 5,
      markerHeight: 5,
      orient: 'auto-start-reverse',
    });
  marker.append(make('path', { d: 'M 0 0 L 10 5 L 0 10 Z', fill: '#8799a3' }));
  defs.append(marker);
  root.append(defs);
  state.order.forEach((id, index) => {
    const x = 70 + (index * (width - 220)) / Math.max(1, state.order.length - 1);
    root.append(
      make('line', { x1: x, x2: x, y1: 40, y2: height - 10, class: 'lane' }),
      make('text', { x, y: 24, 'text-anchor': 'middle', class: 'lane-label' }, id),
    );
  });
  for (const e of state.events) {
    const b = positions.get(e.id);
    for (const dep of e.dependencies) {
      const a = positions.get(dep);
      if (!a) continue;
      root.append(
        make('line', {
          x1: a.x,
          y1: a.y + 8,
          x2: b.x,
          y2: b.y - 10,
          class: 'causal-edge',
          'marker-end': 'url(#causal-arrow)',
        }),
      );
    }
  }
  for (const e of state.events) {
    const p = positions.get(e.id),
      group = make('g', {
        class: 'trace-event',
        'data-event': e.id,
        role: 'button',
        tabindex: 0,
        'aria-label': `Select ${e.id}, ${e.node}, ${e.kind}`,
      });
    group.append(
      make('circle', { cx: p.x, cy: p.y, r: 9 }),
      make('text', { x: p.x + 16, y: p.y + 4 }, `${e.id} ${e.kind}`),
      make('title', {}, `${e.label} · [${e.vector.join(', ')}] · Lamport ${e.lamport}`),
    );
    const choose = () => {
      $('event-' + nextComparison).value = e.id;
      nextComparison = nextComparison === 'a' ? 'b' : 'a';
      $('pick-next').textContent = `Click an event to set ${nextComparison.toUpperCase()}`;
      renderComparison();
    };
    group.addEventListener('click', choose);
    group.addEventListener('keydown', (event) => {
      if (event.key === 'Enter' || event.key === ' ') {
        event.preventDefault();
        choose();
      }
    });
    root.append(group);
  }
}
function renderComparison() {
  for (const event of $('sequence').querySelectorAll('[data-event]')) {
    event.classList.toggle('picked-a', event.dataset.event === $('event-a').value);
    event.classList.toggle('picked-b', event.dataset.event === $('event-b').value);
  }
  if (!$('event-a').value || !$('event-b').value) {
    $('comparison').innerHTML = '<p>Record at least one event to inspect its clock.</p>';
    return;
  }
  const { first: a, second: b, relation } = sim.compare($('event-a').value, $('event-b').value);
  const titles = {
    before: `${a.id} happened before ${b.id}`,
    after: `${b.id} happened before ${a.id}`,
    equal: 'The same recorded event',
    concurrent: 'Concurrent histories',
  };
  const descriptions = {
    before: 'Every component of the first vector is no greater; at least one is smaller.',
    after: 'Every component of the second vector is no greater; at least one is smaller.',
    equal: 'Both selectors point to the same event. It is not strictly before itself.',
    concurrent:
      'Each event knows something the other does not. Neither event causally precedes the other.',
  };
  $('comparison').innerHTML =
    `<h3>${titles[relation]}</h3><p><code>${a.id} / ${a.node} [${a.vector.join(', ')}]</code> &nbsp; ↔ &nbsp; <code>${b.id} / ${b.node} [${b.vector.join(', ')}]</code></p><p>${descriptions[relation]}</p><p>Lamport: ${a.lamport} and ${b.lamport}. ${relation === 'concurrent' ? 'Different scalar timestamps can still describe concurrent events.' : 'Lamport clocks respect causality; scalar ordering alone does not prove it.'}</p>`;
  renderEvents(sim.snapshot());
}
function renderMessages(state) {
  const pending = state.messages.filter((m) => m.status === 'pending');
  $('messages').innerHTML =
    pending
      .map((m) => {
        const reason = !state.nodes[m.to].alive
          ? `Node ${m.to} is crashed`
          : state.blocked.includes(m.from + '>' + m.to)
            ? `${m.from} → ${m.to} is partitioned`
            : '';
        return `<article class="message"><div><h3><span class="message-id">${m.id}</span>${m.from} → ${m.to}</h3><p>${escape(m.label)}</p><p>Sent at [${m.vector.join(', ')}] · L${m.lamport}</p>${reason ? `<p class="reason">${reason}</p>` : ''}</div><div class="actions"><button data-message="${m.id}" data-action="deliver" ${reason ? 'disabled' : ''} aria-label="Deliver ${m.id}">Deliver →</button><button data-message="${m.id}" data-action="drop" aria-label="Drop ${m.id}">Drop</button></div></article>`;
      })
      .join('') || '<p class="empty">No messages in transit.</p>';
  $('blocked').innerHTML = state.blocked
    .map((key) => {
      const [from, to] = key.split('>');
      return `<div class="blocked-link"><span>${from} → ${to}</span><button data-from="${from}" data-to="${to}">Heal link</button></div>`;
    })
    .join('');
}
function renderEvents(state) {
  const from = page * pageSize,
    to = Math.min(from + pageSize, state.events.length),
    selected = [$('event-a').value, $('event-b').value];
  $('events').innerHTML =
    state.events
      .slice(from, to)
      .map(
        (e) =>
          `<tr class="${selected.includes(e.id) ? 'picked' : ''}"><td class="event-id">${e.id}</td><td>${e.node}</td><td class="label">${e.kind} · ${escape(e.label)}</td><td class="clock">[${e.vector.join(', ')}]</td><td>${e.lamport}</td><td class="clock">${e.dependencies.join(', ') || '—'}</td></tr>`,
      )
      .join('') ||
    '<tr><td colspan="6">No events yet. Start with a local event or send a message.</td></tr>';
  $('trace-count').textContent = `${state.events.length} EVENTS`;
  $('pages').hidden = state.events.length <= pageSize;
  $('page-range').textContent = `${from + 1}–${to} of ${state.events.length}`;
  $('previous').disabled = page === 0;
  $('next').disabled = to === state.events.length;
}
function render() {
  const state = sim.snapshot();
  $('event-total').textContent = state.events.length;
  $('pending-total').textContent = state.messages.filter((m) => m.status === 'pending').length;
  $('partition-total').textContent = state.blocked.length;
  renderNodes(state);
  renderSequence(state);
  renderMessages(state);
  const ids = state.order.map((id) => [id, id]);
  for (const id of ['from', 'link-from']) select(id, ids);
  for (const id of ['to', 'link-to']) select(id, ids, 1);
  const events = state.events.map((e) => [e.id, `${e.id} · ${e.node} · ${e.kind}`]);
  select('event-a', events, Math.min(1, events.length - 1));
  select('event-b', events, Math.min(2, events.length - 1));
  renderComparison();
  renderEvents(state);
  $('export-events').disabled = !state.events.length;
}
$('settings-open').addEventListener('click', () => {
  $('settings-notice').textContent = '';
  $('settings-panel').showModal();
});
$('settings-close').addEventListener('click', () => $('settings-panel').close());
$('send-form').addEventListener('submit', (event) => {
  event.preventDefault();
  apply({ type: 'send', from: $('from').value, to: $('to').value, label: $('label').value });
});
$('nodes').addEventListener('click', (event) => {
  const button = event.target.closest('button[data-node]');
  if (button && !button.disabled) apply({ type: button.dataset.action, node: button.dataset.node });
});
$('messages').addEventListener('click', (event) => {
  const button = event.target.closest('button[data-message]');
  if (button && !button.disabled)
    apply({ type: button.dataset.action, message: button.dataset.message });
});
$('partition').addEventListener('click', () =>
  apply({ type: 'partition', from: $('link-from').value, to: $('link-to').value }),
);
$('blocked').addEventListener('click', (event) => {
  const button = event.target.closest('button[data-from]');
  if (button) apply({ type: 'heal', from: button.dataset.from, to: button.dataset.to });
});
for (const id of ['event-a', 'event-b']) $(id).addEventListener('change', renderComparison);
$('scenario').addEventListener('change', () => {
  revision++;
  sim = importScenario(scenarios[$('scenario').value]);
  page = 0;
  render();
  notice('Scenario loaded. Control the next delivery or compare its events.');
});
$('clear').addEventListener('click', () => {
  revision++;
  sim = new Simulator(
    Array.from({ length: Number($('node-count').value) }, (_, i) => String.fromCharCode(65 + i)),
  );
  page = 0;
  render();
  notice('Empty scenario ready. Record local events or queue a message.');
});
$('export').addEventListener('click', () => download('causal-scenario.json', sim.export()));
$('export-events').addEventListener('click', () =>
  download('causal-event-log.json', sim.snapshot()),
);
$('previous').addEventListener('click', () => {
  page = Math.max(0, page - 1);
  renderEvents(sim.snapshot());
});
$('next').addEventListener('click', () => {
  page = Math.min(Math.ceil(sim.snapshot().events.length / pageSize) - 1, page + 1);
  renderEvents(sim.snapshot());
});
$('import').addEventListener('change', async () => {
  const file = $('import').files[0];
  $('import').value = '';
  if (!file) return;
  const version = ++revision;
  try {
    if (file.size > 600000) throw Error('Scenario file exceeds 600 KB.');
    const buffer = await file.arrayBuffer();
    if (buffer.byteLength > 600000) throw Error('Scenario file exceeds 600 KB.');
    let text;
    try {
      text = new TextDecoder('utf-8', { fatal: true }).decode(buffer);
    } catch {
      throw Error('Scenario file must be UTF-8.');
    }
    const candidate = importScenario(text);
    if (version !== revision) return;
    sim = candidate;
    page = 0;
    render();
    notice('Scenario imported and replayed successfully.');
  } catch (error) {
    if (version === revision)
      notice(error.message + ' Your current simulation is unchanged.', true);
  }
});
render();
