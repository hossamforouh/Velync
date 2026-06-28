const { test, describe, it } = require('node:test');
const assert = require('node:assert');

// ── Mute logger during tests ──
process.env.LOG_LEVEL = 'ERROR';

// ── Trigger auto-registration of connectors ──
require('../src/domains/connector');

// ── 1. Errors ──
describe('core/errors', () => {
  test('VelyncError base class', () => {
    const { VelyncError } = require('../src/core/errors');
    const err = new VelyncError('test', 'TEST_CODE');
    assert.ok(err instanceof Error);
    assert.strictEqual(err.message, 'test');
    assert.strictEqual(err.code, 'TEST_CODE');
    assert.strictEqual(err.name, 'VelyncError');
  });

  test('ConnectionError uses 401 code', () => {
    const { ConnectionError } = require('../src/core/errors');
    const err = new ConnectionError('db down');
    assert.ok(err instanceof Error);
    assert.strictEqual(err.code, 401);
  });

  test('SyncError uses 500 code', () => {
    const { SyncError } = require('../src/core/errors');
    const err = new SyncError('sync failed');
    assert.strictEqual(err.code, 500);
  });

  test('AuthError uses 401 code', () => {
    const { AuthError } = require('../src/core/errors');
    const err = new AuthError('token expired');
    assert.strictEqual(err.code, 401);
  });

  test('ValidationError uses 400 code', () => {
    const { ValidationError } = require('../src/core/errors');
    const err = new ValidationError('missing field');
    assert.strictEqual(err.code, 400);
  });
});

// ── 2. Logger ──
describe('core/logger', () => {
  test('exports debug/info/warn/error functions', () => {
    const logger = require('../src/core/logger');
    assert.strictEqual(typeof logger.debug, 'function');
    assert.strictEqual(typeof logger.info, 'function');
    assert.strictEqual(typeof logger.warn, 'function');
    assert.strictEqual(typeof logger.error, 'function');
  });

  test('debug is silent when LOG_LEVEL=ERROR', () => {
    const logger = require('../src/core/logger');
    const out = [];
    const spy = console.log;
    console.log = (...args) => out.push(args.join(' '));
    logger.debug('test', 'should not appear');
    console.log = spy;
    assert.strictEqual(out.length, 0);
  });

  test('error produces JSON output', () => {
    const logger = require('../src/core/logger');
    const out = [];
    const spy = console.log;
    console.log = (...args) => out.push(args.join(' '));
    logger.error('test', 'something broke', { detail: 'x' });
    console.log = spy;
    assert.strictEqual(out.length, 1);
    const parsed = JSON.parse(out[0]);
    assert.strictEqual(parsed.level, 'error');
    assert.strictEqual(parsed.domain, 'test');
    assert.strictEqual(parsed.msg, 'something broke');
    assert.strictEqual(parsed.data.detail, 'x');
  });
});

// ── 3. Config ──
describe('core/config', () => {
  test('reads env vars with defaults', () => {
    const cfg = require('../src/core/config');
    assert.ok(typeof cfg.port === 'number');
    assert.ok(cfg.port > 0);
    assert.ok(cfg.environment === undefined || typeof cfg.environment === 'string');
  });
});

// ── 4. Connector Registry ──
describe('connector/registry', () => {
  test('getRegisteredPlatforms returns ticktick and notion', () => {
    const { getRegisteredPlatforms } = require('../src/domains/connector/registry');
    const platforms = getRegisteredPlatforms();
    assert.ok(platforms.includes('ticktick'));
    assert.ok(platforms.includes('notion'));
  });

  test('getConnector returns a class for registered platform', () => {
    const { getConnector } = require('../src/domains/connector/registry');
    const Cls = getConnector('ticktick');
    assert.ok(Cls);
    assert.strictEqual(typeof Cls.prototype.fetch, 'function');
    assert.strictEqual(typeof Cls.prototype.getSchema, 'function');
  });

  test('getConnector throws for unknown platform', () => {
    const { getConnector } = require('../src/domains/connector/registry');
    assert.throws(() => getConnector('nonexistent'), /No connector registered/);
  });
});

// ── 5. Sync Mapper ──
describe('sync/mapper', () => {
  test('maps title field', () => {
    const { mapSourceToDest } = require('../src/domains/sync/mapper');
    const result = mapSourceToDest(
      { title: 'Hello', desc: 'world' },
      [{ sourceField: 'title', destField: 'Name' }],
      { title: { type: 'title' } },
      { Name: { type: 'title' } }
    );
    assert.ok(result.properties.Name);
    assert.strictEqual(result.properties.Name.title[0].text.content, 'Hello');
  });

  test('maps rich_text field', () => {
    const { mapSourceToDest } = require('../src/domains/sync/mapper');
    const result = mapSourceToDest(
      { desc: 'description here' },
      [{ sourceField: 'desc', destField: 'Notes' }],
      { desc: { type: 'rich_text' } },
      { Notes: { type: 'rich_text' } }
    );
    assert.strictEqual(result.properties.Notes.rich_text[0].text.content, 'description here');
  });

  test('maps status with number 2 to completed', () => {
    const { mapSourceToDest } = require('../src/domains/sync/mapper');
    const destSchema = {
      Status: { type: 'status', status: { options: [{ name: 'Done', color: 'green' }] } }
    };
    const result = mapSourceToDest(
      { status: 2 },
      [{ sourceField: 'status', destField: 'Status' }],
      { status: { type: 'number' } },
      destSchema
    );
    assert.strictEqual(result.properties.Status.status.name, 'Done');
  });

  test('maps tags to multi_select', () => {
    const { mapSourceToDest } = require('../src/domains/sync/mapper');
    const result = mapSourceToDest(
      { tags: ['work', 'urgent'] },
      [{ sourceField: 'tags', destField: 'Tags' }],
      { tags: { type: 'multi_select' } },
      { Tags: { type: 'multi_select', multi_select: { options: [] } } }
    );
    assert.strictEqual(result.properties.Tags.multi_select.length, 2);
    assert.strictEqual(result.properties.Tags.multi_select[0].name, 'work');
  });

  test('maps __content__ separately', () => {
    const { mapSourceToDest } = require('../src/domains/sync/mapper');
    const result = mapSourceToDest(
      { desc: 'body text' },
      [{ sourceField: 'desc', destField: '__content__' }],
      { desc: { type: 'rich_text' } },
      {}
    );
    assert.strictEqual(result.content, 'body text');
    assert.strictEqual(Object.keys(result.properties).length, 0);
  });

  test('skips unknown dest fields', () => {
    const { mapSourceToDest } = require('../src/domains/sync/mapper');
    const result = mapSourceToDest(
      { title: 'test' },
      [{ sourceField: 'title', destField: 'FakeField' }],
      { title: { type: 'title' } },
      {}
    );
    assert.strictEqual(Object.keys(result.properties).length, 0);
  });

  test('falls back to sourceItem.name for title', () => {
    const { mapSourceToDest } = require('../src/domains/sync/mapper');
    const result = mapSourceToDest(
      { name: 'ItemName' },
      [{ sourceField: 'title', destField: 'Name' }],
      { title: { type: 'title' } },
      { Name: { type: 'title' } }
    );
    assert.strictEqual(result.properties.Name.title[0].text.content, 'ItemName');
  });
});

// ── 6. Conflict Resolution ──
describe('sync/conflict', () => {
  test('source_wins when only source changed', () => {
    const { resolveConflict } = require('../src/domains/sync/conflict');
    const result = resolveConflict(
      '2026-06-24T10:00:00Z',
      '2026-06-24T08:00:00Z',
      { sourceLastModified: '2026-06-24T07:00:00Z', destLastEdited: '2026-06-24T07:00:00Z' }
    );
    assert.strictEqual(result, 'source_wins');
  });

  test('dest_wins when only dest changed', () => {
    const { resolveConflict } = require('../src/domains/sync/conflict');
    const result = resolveConflict(
      '2026-06-24T08:00:00Z',
      '2026-06-24T10:00:00Z',
      { sourceLastModified: '2026-06-24T07:00:00Z', destLastEdited: '2026-06-24T07:00:00Z' }
    );
    assert.strictEqual(result, 'dest_wins');
  });

  test('no_change when neither side changed', () => {
    const { resolveConflict } = require('../src/domains/sync/conflict');
    const result = resolveConflict(
      '2026-06-24T07:00:00Z',
      '2026-06-24T07:00:00Z',
      { sourceLastModified: '2026-06-24T07:00:00Z', destLastEdited: '2026-06-24T07:00:00Z' }
    );
    assert.strictEqual(result, 'no_change');
  });

  test('last-writer-wins when both changed', () => {
    const { resolveConflict } = require('../src/domains/sync/conflict');
    const result = resolveConflict(
      '2026-06-24T10:00:00Z',
      '2026-06-24T09:00:00Z',
      { sourceLastModified: '2026-06-24T07:00:00Z', destLastEdited: '2026-06-24T07:00:00Z' }
    );
    assert.strictEqual(result, 'source_wins');
  });
});

// ── 7. Connector Interface ──
describe('connector/interface', () => {
  test('Connector base class throws on unimplemented methods', async () => {
    const { Connector } = require('../src/domains/connector/interface');
    const c = new Connector({});
    await assert.rejects(() => c.connect(), /must be implemented/);
    await assert.rejects(() => c.fetch('x'), /must be implemented/);
    await assert.rejects(() => c.create('x'), /must be implemented/);
    await assert.rejects(() => c.update('x'), /must be implemented/);
    await assert.rejects(() => c.delete('x'), /must be implemented/);
    assert.throws(() => c.getSchema('x'), /must be implemented/);
  });
});
