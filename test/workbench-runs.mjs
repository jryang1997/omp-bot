import assert from 'node:assert/strict';
import { createRunClient } from '../web/workbench-runs.js';

const target = { kind: 'bot', id: 'bot' };
const run = (id, state) => ({ id, botId: target.id, state });
const event = (client, seq, value) => client.handleEvent({ type: 'run_updated', seq, run: value });

{
  const client = createRunClient({});
  event(client, 10, run('historical', 'running'));
  client.restore({ activeRuns: [], lastSeq: 20 });
  assert.deepEqual(client.activeFor(target), []);
  assert.equal(client.statusText(target), '');
}

{
  const client = createRunClient({});
  event(client, 21, run('new', 'running'));
  client.restore({ activeRuns: [], lastSeq: 20 });
  event(client, 21, run('new', 'waiting_approval'));
  assert.deepEqual(client.activeFor(target), [run('new', 'running')]);
}

{
  const client = createRunClient({});
  event(client, 21, run('recent', 'completed'));
  client.restore({ activeRuns: [run('recent', 'running')], lastSeq: 20 });
  assert.deepEqual(client.all(), [run('recent', 'completed')]);
  assert.equal(client.statusText(target), '');
}

{
  const client = createRunClient({});
  client.restore({ activeRuns: [run('active', 'running')], lastSeq: 20 });
  assert.deepEqual(client.activeFor(target), [run('active', 'running')]);
  event(client, 21, run('active', 'completed'));
  assert.deepEqual(client.activeFor(target), []);
  assert.deepEqual(client.all(), [run('active', 'completed')]);
}

{
  const stream = { close() {} };
  let replay = [];
  let snapshot = { activeRuns: [], lastSeq: 20 };
  const messages = [];
  const gaps = [];
  const client = createRunClient({
    request: async () => ({ events: replay, lastSeq: 23 }),
    onGap: (from, to) => gaps.push([from, to]),
  });
  const close = client.connect({
    openStream: () => stream,
    synchronize: async () => {
      client.restore(snapshot);
      return snapshot;
    },
    onConversationEvent: message => messages.push(message.text),
  });
  const roomMessage = (seq, text) => ({ seq, type: 'room_bot_post', roomId: 'room', text });
  const emit = value => stream.onmessage({ data: JSON.stringify(value) });
  try {
    emit(roomMessage(19, 'before snapshot'));
    await stream.onopen();
    emit(roomMessage(20, 'already saved'));
    emit(roomMessage(21, 'new room message'));
    emit(roomMessage(21, 'duplicate room message'));
    emit({ seq: 22, type: 'run_updated', run: run('new', 'running') });
    assert.deepEqual(client.activeFor(target), [run('new', 'running')]);
    snapshot = { activeRuns: [], lastSeq: 20 };
    replay = [
      { seq: 22, type: 'run_updated', run: run('new', 'running') },
      { seq: 23, type: 'run_updated', run: run('new', 'completed') },
    ];
    await stream.onopen();
    assert.deepEqual(client.all(), [run('new', 'completed')]);
    assert.equal(client.statusText(target), '');
    assert.deepEqual(messages, ['new room message']);
    emit({ seq: 26, type: 'run_updated', run: run('after gap', 'running') });
    assert.deepEqual(gaps, [[0, 19], [23, 26]]);
    assert.deepEqual(client.activeFor(target), [run('after gap', 'running')]);
  } finally {
    close();
  }
}

{
  const stream = { close() {} };
  const client = createRunClient({});
  const errors = [];
  const messages = [];
  let fail = true;
  const close = client.connect({
    openStream: () => stream,
    synchronize: async () => {
      if (fail) throw new Error('Snapshot unavailable');
      const snapshot = { activeRuns: [], lastSeq: 4 };
      client.restore(snapshot);
      return snapshot;
    },
    onSyncError: error => errors.push(error.message),
    onConversationEvent: message => messages.push(message.text),
  });
  const emit = value => stream.onmessage({ data: JSON.stringify(value) });
  try {
    await stream.onopen();
    emit({ seq: 5, type: 'run_updated', run: run('during failure', 'running') });
    emit({ seq: 6, type: 'room_bot_post', text: 'unsynchronized room event' });
    assert.deepEqual(client.activeFor(target), [run('during failure', 'running')]);
    assert.deepEqual(errors, ['Snapshot unavailable']);
    assert.deepEqual(messages, []);
    emit({ seq: 7, type: 'run_updated', run: run('during failure', 'completed') });
    fail = false;
    await stream.onopen();
    emit({ seq: 8, type: 'room_bot_post', text: 'synchronized room event' });
    assert.deepEqual(client.all(), [run('during failure', 'completed')]);
    assert.deepEqual(messages, ['synchronized room event']);
  } finally {
    close();
  }
}

// 头像状态：等审批 alerting、工具 working、其余 thinking、出错 sad、刚完成 happy 再回 idle；重放的旧事件不算刚发生。
{
  const ended = [];
  const client = createRunClient({ onRunEnded: (value) => ended.push(value.id) });
  const face = () => client.avatarState(target.id).face;
  assert.deepEqual(client.avatarState(target.id), { face: 'idle', busy: false, moving: false, until: 0 });
  client.handleEvent({ type: 'hello', lastSeq: 5 });
  event(client, 4, run('old', 'completed'));
  assert.equal(face(), 'idle', '重放的完成不开心');
  assert.equal(client.avatarState(target.id).moving, false, '重放的事件不让头像动');
  assert.deepEqual(ended, [], '重放的完成不记未读');
  event(client, 6, { ...run('r1', 'running'), createdAt: 10 });
  assert.equal(face(), 'thinking');
  assert.equal(client.avatarState(target.id).moving, true);
  client.handleEvent({ type: 'native_event', seq: 7, runId: 'r1', event: { type: 'tool_execution_start', toolCallId: 't1', toolName: 'bash' } });
  assert.equal(face(), 'working');
  client.handleEvent({ type: 'native_event', seq: 8, runId: 'r1', event: { type: 'tool_execution_end', toolCallId: 't1', toolName: 'bash' } });
  assert.equal(face(), 'thinking', '工具结束回到 thinking');
  event(client, 9, { ...run('r1', 'waiting_approval'), createdAt: 10 });
  assert.equal(face(), 'alerting');
  event(client, 10, { ...run('r1', 'completed'), createdAt: 10 });
  assert.equal(face(), 'happy');
  assert.deepEqual(ended, ['r1']);
  const later = client.avatarState(target.id, Date.now() + 10_000);
  assert.deepEqual([later.face, later.moving], ['idle', false], '开心一下再回 idle，过了窗口停下');
  event(client, 11, { ...run('r2', 'running'), createdAt: 20 });
  event(client, 12, { ...run('r2', 'failed'), createdAt: 20 });
  assert.equal(face(), 'sad');
  assert.equal(client.avatarState(target.id, Date.now() + 10_000).face, 'sad', '出错一直 sad 到下一次运行');
  event(client, 13, { ...run('r3', 'running'), createdAt: 30 });
  event(client, 14, { ...run('r3', 'cancelled'), createdAt: 30 });
  assert.equal(face(), 'idle', '取消不算出错');
}

console.log('Workbench replay/snapshot, reconnect and avatar state regressions 7/7 passed.');
