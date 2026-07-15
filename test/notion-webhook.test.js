/**
 * Notion webhook connector-contract — unit tests (Stage 1, WEBHOOK_SYNC_PLAN.md).
 *
 * These are pure functions (no Firestore, no network) — no emulator needed.
 *
 * Run:  node --test test/notion-webhook.test.js
 */

const { describe, it } = require('node:test');
const assert = require('node:assert');
const crypto = require('crypto');

const { Connector } = require('../src/domains/connector/interface');
const NotionConnector = require('../src/domains/connector/notion');
const TickTickConnector = require('../src/domains/connector/ticktick');

describe('Connector base class — webhook capability defaults', () => {
  it('supportsWebhooks() defaults to false', () => {
    assert.strictEqual(Connector.supportsWebhooks(), false);
  });

  it('verifyWebhookSignature() defaults to false (fails closed), not throw', () => {
    assert.strictEqual(Connector.verifyWebhookSignature('body', 'sig', 'secret'), false);
  });

  it('parseWebhookEvent() defaults to throw', () => {
    assert.throws(() => Connector.parseWebhookEvent({}), /not supported/);
  });

  it('a connector without webhook support (TickTick) inherits the false/throw defaults', () => {
    assert.strictEqual(TickTickConnector.supportsWebhooks(), false);
    assert.strictEqual(TickTickConnector.verifyWebhookSignature('body', 'sig', 'secret'), false);
    assert.throws(() => TickTickConnector.parseWebhookEvent({}), /not supported/);
  });
});

describe('NotionConnector.supportsWebhooks', () => {
  it('returns true', () => {
    assert.strictEqual(NotionConnector.supportsWebhooks(), true);
  });
});

describe('NotionConnector.verifyWebhookSignature', () => {
  const secret = 'test-signing-secret';
  const rawBody = JSON.stringify({ type: 'page.created', entity: { id: 'p1', type: 'page' }, workspace_id: 'w1' });

  function sign(body, key) {
    return 'sha256=' + crypto.createHmac('sha256', key).update(body).digest('hex');
  }

  it('accepts a correctly-signed body', () => {
    const sig = sign(rawBody, secret);
    assert.strictEqual(NotionConnector.verifyWebhookSignature(rawBody, sig, secret), true);
  });

  it('rejects a tampered body', () => {
    const sig = sign(rawBody, secret);
    const tampered = rawBody.replace('page.created', 'page.deleted');
    assert.strictEqual(NotionConnector.verifyWebhookSignature(tampered, sig, secret), false);
  });

  it('rejects a signature made with the wrong secret', () => {
    const sig = sign(rawBody, 'wrong-secret');
    assert.strictEqual(NotionConnector.verifyWebhookSignature(rawBody, sig, secret), false);
  });

  it('rejects a signature missing the "sha256=" prefix', () => {
    const sig = crypto.createHmac('sha256', secret).update(rawBody).digest('hex');
    assert.strictEqual(NotionConnector.verifyWebhookSignature(rawBody, sig, secret), false);
  });

  it('rejects when signatureHeader is missing', () => {
    assert.strictEqual(NotionConnector.verifyWebhookSignature(rawBody, undefined, secret), false);
  });

  it('rejects when secret is missing', () => {
    const sig = sign(rawBody, secret);
    assert.strictEqual(NotionConnector.verifyWebhookSignature(rawBody, sig, undefined), false);
  });

  it('rejects a garbage/short signature string without throwing', () => {
    assert.strictEqual(NotionConnector.verifyWebhookSignature(rawBody, 'sha256=abc', secret), false);
  });
});

describe('NotionConnector.isVerificationHandshake', () => {
  it('identifies a verification-token payload', () => {
    assert.strictEqual(NotionConnector.isVerificationHandshake({ verification_token: 'tok_123' }), true);
  });

  it('rejects a real event payload (has type)', () => {
    assert.strictEqual(
      NotionConnector.isVerificationHandshake({ type: 'page.created', verification_token: 'tok_123' }),
      false
    );
  });

  it('rejects null/undefined/empty payloads', () => {
    assert.strictEqual(NotionConnector.isVerificationHandshake(null), false);
    assert.strictEqual(NotionConnector.isVerificationHandshake(undefined), false);
    assert.strictEqual(NotionConnector.isVerificationHandshake({}), false);
  });
});

describe('NotionConnector.parseWebhookEvent', () => {
  it('normalizes a valid page event', () => {
    const result = NotionConnector.parseWebhookEvent({
      type: 'page.properties_updated',
      entity: { id: 'page-abc', type: 'page' },
      workspace_id: 'ws-1',
    });
    assert.deepStrictEqual(result, {
      workspaceId: 'ws-1',
      entityId: 'page-abc',
      entityType: 'page',
      eventType: 'page.properties_updated',
    });
  });

  it('normalizes a valid data_source event', () => {
    const result = NotionConnector.parseWebhookEvent({
      type: 'data_source.content_updated',
      entity: { id: 'ds-1', type: 'data_source' },
      workspace_id: 'ws-2',
    });
    assert.strictEqual(result.eventType, 'data_source.content_updated');
  });

  it('throws on an unrecognized event type', () => {
    assert.throws(
      () => NotionConnector.parseWebhookEvent({ type: 'comment.created', entity: { id: 'c1', type: 'comment' }, workspace_id: 'w1' }),
      /Unsupported or unrecognized/
    );
  });

  it('throws on a missing type', () => {
    assert.throws(
      () => NotionConnector.parseWebhookEvent({ entity: { id: 'p1', type: 'page' }, workspace_id: 'w1' }),
      /Unsupported or unrecognized/
    );
  });

  it('throws on a missing entity', () => {
    assert.throws(
      () => NotionConnector.parseWebhookEvent({ type: 'page.created', workspace_id: 'w1' }),
      /missing entity/
    );
  });

  it('throws on an entity missing id or type', () => {
    assert.throws(
      () => NotionConnector.parseWebhookEvent({ type: 'page.created', entity: { id: 'p1' }, workspace_id: 'w1' }),
      /missing entity/
    );
  });

  it('throws on a missing workspace_id', () => {
    assert.throws(
      () => NotionConnector.parseWebhookEvent({ type: 'page.created', entity: { id: 'p1', type: 'page' } }),
      /missing workspace_id/
    );
  });

  it('throws on an empty/null payload', () => {
    assert.throws(() => NotionConnector.parseWebhookEvent(null), /Unsupported or unrecognized/);
    assert.throws(() => NotionConnector.parseWebhookEvent(undefined), /Unsupported or unrecognized/);
  });
});
