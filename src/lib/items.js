'use strict';

/**
 * Opslagsindeks over varetyper.
 *
 * Ren funktion over rækker: ingen database, ingen filer. Det er med vilje.
 * Opslagsreglerne nedenfor er projektets mest fejlfølsomme kode, og de skal
 * kunne testes mod seks fikstur-varer på et millisekund.
 *
 * Kilden til rækkerne er `src/lib/taxonomy.js`, som henter dem fra basen.
 */

const NONFOOD_CATS  = new Set(['nonfood']);
const NON_MEAL_CATS = new Set(['nonfood', 'drink', 'snack']);

const isWordChar = (c) => c !== undefined && /[a-zæøå0-9]/.test(c);

// (uændret fra taxonomy.js — se kommentaren dér for hvorfor hvert ord står på listen)
const EN_HINT = /(^|[^a-zæøå])(and|the|with|into|chopped|sliced|diced|finely|boneless|skinless|freshly|roughly|thinly|drained|deseeded|peeled|grated|halved|plus|about|handful|bunch|large|small|fresh|ground|cut)([^a-zæøå]|$)/i;
const DA_HINT = /[æøå]|(^|[^a-z])(og|eller|med|uden|frit|valg|hakket|dansk|danske|stk|pr|kg|gram)([^a-z]|$)/i;

function looksEnglish(text) {
  return EN_HINT.test(text) && !DA_HINT.test(text);
}

function buildIndex(items, synonyms) {
  const byKey = new Map(items.map((it) => [it.key, it]));

  // Længst først, så det mest specifikke match vinder:
  // "hakket oksekød" slår "oksekød".
  const syns = synonyms
    .filter((s) => byKey.has(s.item_key))
    .map((s) => ({ term: String(s.text).toLowerCase(), lang: s.lang, entry: byKey.get(s.item_key) }))
    .sort((a, b) => b.term.length - a.term.length);

  // Kopiér denne krop TEGN FOR TEGN fra src/lib/taxonomy.js. Den er
  // aftrykket af den nuværende lookup(); enhver omskrivning — også en, der
  // ser pænere ud — ændrer hvilke af 26.242 ingredienslinjer der matcher.
  function lookup(text) {
    if (!text) return null;
    const hay = String(text).toLowerCase();
    const english = looksEnglish(hay);
    let best = null;

    for (const syn of syns) {
      const i = hay.indexOf(syn.term);
      if (i === -1) continue;

      const leftOK = !isWordChar(hay[i - 1]);
      const after  = hay.slice(i + syn.term.length);
      let rightOK  = !isWordChar(after[0]);

      if (syn.lang === 'en') {
        if (!leftOK) continue;                         // ikke en orddel på engelsk
        if (!rightOK) {
          if (!/^e?s(?![a-zæøå])/.test(after)) continue;
          rightOK = true;                              // flertal: "courgettes"
        }
      } else if (english && syn.term.length < 5) {
        continue;                                      // kort dansk ord i engelsk tekst
      }

      const exact = (leftOK ? 1 : 0) + (rightOK ? 1 : 0);
      if (exact === 0) continue;                       // midt inde i et ord
      if (exact < 2 && syn.term.length < 4) continue;  // for kort til delmatch

      const cand = { entry: syn.entry, term: syn.term, exact, pos: i, len: syn.term.length };
      const wins = !best
        || cand.exact > best.exact
        || (cand.exact === best.exact && cand.pos < best.pos)
        || (cand.exact === best.exact && cand.pos === best.pos && cand.len > best.len);
      if (wins) best = cand;
    }

    return best ? { entry: best.entry, term: best.term } : null;
  }

  const get = (key) => byKey.get(key) || null;
  const flag = (key, fn) => { const e = byKey.get(key); return !!e && fn(e); };

  return {
    get,
    lookup,
    all: () => items,
    isEssential:   (key) => flag(key, (e) => e.class === 'essential'),
    isPremium:     (key) => flag(key, (e) => !!e.premium),
    isNonFood:     (key) => flag(key, (e) => NONFOOD_CATS.has(e.category)),
    isMealCapable: (key) => flag(key, (e) => !NON_MEAL_CATS.has(e.category)),
    looksEnglish,
  };
}

module.exports = { buildIndex, looksEnglish, NON_MEAL_CATS };
