'use strict';

/**
 * Arbejdstid og tid i alt.
 *
 * To tal, fordi de betyder to ting: en lammeculotte kan tage et kvarters
 * arbejde og halvanden time i alt. Appen viser begge, og aftensmaden måles
 * på begge: højst en times arbejde (engine.DINNER_MAX_MINUTES) og højst to
 * timer i alt (engine.DINNER_MAX_TOTAL_MINUTES).
 *
 * Valdemarsro mærker felterne omvendt: "Tid i alt" står i itemprop="cookTime"
 * og "Arbejdstid" i itemprop="totalTime" (målt på fire sider 2026-09-30).
 * De synlige etiketter læses derfor først — de er det, forfatteren selv har
 * skrevet — og schema.org-felterne bruges kun, hvor siden ikke har dem.
 */

// Timer før minutter i alternationen: "time" må ikke blive læst som "t".
const DURATION = '((?:\\d+(?:[.,]\\d+)?\\s*(?:timer|time|t\\b\\.?|minutter|min\\.?)\\s*(?:og\\s*)?){1,2})';
const LABEL_TOTAL = new RegExp(`tid i alt\\s*:?\\s*${DURATION}`, 'i');
const LABEL_ACTIVE = new RegExp(`arbejdstid\\s*:?\\s*${DURATION}`, 'i');

/** "1 t. 30 min." / "1 time og 30 min" / "2 timer" / "45 min." → minutter. */
function danishMinutes(text) {
  const s = String(text || '').toLowerCase();
  const h = s.match(/(\d+(?:[.,]\d+)?)\s*(?:timer|time|t\b|t\.)/);
  const m = s.match(/(\d+)\s*(?:minutter|min)/);
  if (!h && !m) return null;
  const hours = h ? parseFloat(h[1].replace(',', '.')) : 0;
  return Math.round(hours * 60) + (m ? parseInt(m[1], 10) : 0);
}

/** Tiderne, som siden selv skriver dem ("Tid i alt …", "Arbejdstid …"). */
function labelledTimes(text) {
  const t = String(text || '');
  const total = t.match(LABEL_TOTAL);
  const active = t.match(LABEL_ACTIVE);
  return {
    total: total ? danishMinutes(total[1]) : null,
    active: active ? danishMinutes(active[1]) : null,
  };
}

/**
 * Vælger de to tider. Etiketterne vinder; ellers er tid i alt `totalTime`
 * (eller forberedelse + tilberedning), og arbejdstiden er forberedelsen —
 * Arlas `prepTime` ER deres arbejdstid, og BBC's er den nærmeste, de har.
 */
function pickTimes({ labelled = {}, prep = null, cook = null, total = null } = {}) {
  let all = labelled.total ?? total ?? ((prep || 0) + (cook || 0) || null);
  let active = labelled.active ?? prep ?? null;
  if (all != null && active != null && active > all) [all, active] = [active, all];
  return { total_minutes: all || null, active_minutes: active || null };
}

module.exports = { danishMinutes, labelledTimes, pickTimes };
