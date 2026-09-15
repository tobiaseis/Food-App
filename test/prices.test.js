'use strict';

/**
 * Tests for normalpriser og pakkeregning.
 *
 * Den centrale regel: en pris uden en pakkestørrelse kan ikke bruges. Man
 * køber ikke en halv pose kartofler, og hele planens madspilds-optimering
 * hviler på at kende pakken, ikke kun kiloprisen.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const engine = require(path.join(__dirname, '..', 'public', 'engine.js'));

const near = (a, b, eps = 1e-6) => assert.ok(Math.abs(a - b) < eps, `${a} != ${b}`);

test('validUntilFor følger varens klasse', () => {
  const t0 = Date.parse('2026-01-01T00:00:00Z');
  // fresh: 3 måneder. baseline: 6. Essentials prissættes aldrig.
  near(Date.parse(engine.validUntilFor('fresh', new Date(t0))) - t0, 90 * 86400000);
  near(Date.parse(engine.validUntilFor('baseline', new Date(t0))) - t0, 180 * 86400000);
  assert.equal(engine.validUntilFor('essential', new Date(t0)), null);
});
