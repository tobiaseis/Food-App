'use strict';

/**
 * Tests for push-beskederne.
 *
 * Teksten er det eneste, brugeren nogensinde ser af det her lag – den står på
 * en låseskærm uden mulighed for at spørge om noget. Derfor beskriver testene
 * løftet: én besked pr. enhed uanset hvor mange varer der blev fundet, og en
 * tekst der kan læses uden at åbne appen.
 */

const test = require('node:test');
const assert = require('node:assert');

const { compose, listNames } = require('../src/push/send');

// ── Hjælpere ─────────────────────────────────────────────────────────────────

const notif = (label, chain, price, discount) => ({
  watches: { label },
  offers: { heading: `${label} tilbud`, price, base_unit: 'kg', chains: { name: chain } },
  discount,
});

// ── Opremsning ───────────────────────────────────────────────────────────────

test('opremsning bruger dansk "og" før sidste led', () => {
  assert.equal(listNames(['Netto']), 'Netto');
  assert.equal(listNames(['Netto', 'føtex']), 'Netto og føtex');
  assert.equal(listNames(['Netto', 'føtex', 'REMA 1000']), 'Netto, føtex og REMA 1000');
});

test('samme butik nævnes ikke to gange', () => {
  assert.equal(listNames(['Netto', 'Netto', 'føtex']), 'Netto og føtex');
});

test('tom liste giver tom streng, ikke "undefined"', () => {
  assert.equal(listNames([]), '');
  assert.equal(listNames([null, undefined]), '');
});

// ── Én vare ──────────────────────────────────────────────────────────────────

test('én vare nævner pris, butik og rabat', () => {
  const { title, body } = compose([notif('Skyr', 'Netto', 12.95, 28)]);
  assert.equal(title, 'Skyr er på tilbud');
  assert.match(body, /12,95 kr/);
  assert.match(body, /Netto/);
  assert.match(body, /28 %/);
});

test('uden rabattal nævnes rabat ikke', () => {
  const { body } = compose([notif('Skyr', 'Netto', 12.95, null)]);
  assert.match(body, /Netto/);
  assert.doesNotMatch(body, /%/);
});

test('en besked uden pris og rabat er stadig en hel sætning', () => {
  const { title, body } = compose([{ watches: { label: 'Laks' }, offers: {} }]);
  assert.equal(title, 'Laks er på tilbud');
  assert.ok(body.length > 0, 'body må ikke være tom på en låseskærm');
});

// ── Flere varer ──────────────────────────────────────────────────────────────

test('flere varer bliver til ÉN besked, ikke én pr. vare', () => {
  const rows = [
    notif('Skyr', 'Netto', 12.95, 28),
    notif('Hakket oksekød', 'REMA 1000', 35, 20),
    notif('Laks', 'føtex', 59, 15),
  ];
  const { title, body } = compose(rows);
  assert.equal(title, '3 varer du følger er på tilbud');
  assert.match(body, /Skyr/);
  assert.match(body, /Hakket oksekød/);
  assert.match(body, /Laks/);
});

test('flere varer i samme butik nævner butikken én gang', () => {
  const { body } = compose([
    notif('Skyr', 'Netto', 12.95, 28),
    notif('Laks', 'Netto', 59, 15),
  ]);
  assert.equal((body.match(/Netto/g) || []).length, 1);
});

test('manglende varenavn vælter ikke beskeden', () => {
  const { title, body } = compose([
    { watches: null, offers: { heading: 'Skyr 1 kg', chains: { name: 'Netto' } } },
    { watches: null, offers: { heading: 'Laks', chains: { name: 'Netto' } } },
  ]);
  assert.equal(title, '2 varer du følger er på tilbud');
  assert.ok(body.length > 0);
});

// ── Tal ──────────────────────────────────────────────────────────────────────

test('priser skrives med dansk komma', () => {
  const { body } = compose([notif('Skyr', 'Netto', 12.95, null)]);
  assert.match(body, /12,95/);
  assert.doesNotMatch(body, /12\.95/);
});

test('runde priser får ikke overflødige decimaler', () => {
  const { body } = compose([notif('Laks', 'føtex', 59, null)]);
  assert.match(body, /59 kr/);
  assert.doesNotMatch(body, /59,00/);
});
