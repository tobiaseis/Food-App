'use strict';

/**
 * Dubletter i offers – oprydningen og den nøgle, der holder dem ude.
 *
 * Baggrunden: flere kæder udgiver den samme tilbudsavis én gang pr. region.
 * ABC Lavpris lå med 16 identiske aviser, så hver eneste vare stod 16 gange i
 * "Alle tilbud". Hver kopi har sit eget catalog_id og sine egne offer id'er,
 * så UNIQUE(external_id) fangede dem ikke.
 *
 * Den naturlige nøgle er, hvad der rent faktisk gør et tilbud til ét tilbud:
 * kæde + overskrift + beskrivelse + pris + løbetid.
 *
 * Reglerne bor her frem for i schema.sql, fordi indekset ikke kan lægges på en
 * base, der allerede indeholder dubletter – og det gør enhver base fra før
 * denne ændring, inklusive det natlige snapshot i GitHub-releaset. Køres
 * oprydningen som en migrering, helbreder basen sig selv, første gang den
 * åbnes, og hverken den daglige kørsel eller en udvikler skal gøre noget.
 */

const INDEX_NAME = 'idx_offers_natural';

const INDEX_SQL = `
  CREATE UNIQUE INDEX ${INDEX_NAME}
      ON offers(chain_id, heading, IFNULL(description, ''), price,
                IFNULL(run_from, ''), IFNULL(run_till, ''))
`;

/** Nøglen som SQL-udtryk. Ét sted, så oprydning og indeks ikke kan blive uenige. */
const KEY_SQL = [
  'chain_id', 'heading', "IFNULL(description, '')", 'price',
  "IFNULL(run_from, '')", "IFNULL(run_till, '')",
].join(" || '|' || ");

/**
 * Sammentrækker linjeskift og dobbelte mellemrum til ét mellemrum.
 *
 * Teksten kommer fra tilbudsavisernes layout, og den samme beskrivelse står
 * med linjeskift i én avis og med mellemrum i den næste. For øjet er det den
 * samme tekst; for en UNIQUE-nøgle er det to forskellige, og uden det her
 * slipper en fjerdedel af dubletterne igennem.
 */
const flat = (s) => (s == null ? null : String(s).replace(/\s+/g, ' ').trim());

function hasIndex(db) {
  return Boolean(db.prepare(
    "SELECT 1 FROM sqlite_master WHERE type = 'index' AND name = ?"
  ).get(INDEX_NAME));
}

/** Trin 1: ret teksten, før den sammenlignes. Returnerer antal rørte rækker. */
function normaliseText(db) {
  const rows = db.prepare('SELECT id, heading, description FROM offers').all();
  const upd = db.prepare('UPDATE offers SET heading = ?, description = ? WHERE id = ?');

  let touched = 0;
  db.transaction(() => {
    for (const r of rows) {
      const h = flat(r.heading) || '';
      const d = r.description == null ? null : flat(r.description);
      if (h !== r.heading || d !== r.description) { upd.run(h, d, r.id); touched++; }
    }
  })();
  return touched;
}

/**
 * Trin 2: find dubletterne og hvilken række der skal overleve.
 *
 * Ved valg af vinder foretrækkes:
 *   1. en rigtig SI-enhed (kg/l) frem for "stk" – kilden angiver af og til
 *      samme flaske vin som "0,75 l" i én avis og "1 stk" i en anden, og kun
 *      den første giver en brugbar kilopris
 *   2. en udregnet kilopris frem for ingen
 *   3. det laveste id, så kørslen er forudsigelig
 */
function findDuplicates(db) {
  const groups = db.prepare(`
    SELECT ${KEY_SQL} AS k, COUNT(*) AS n
      FROM offers
     GROUP BY k
    HAVING n > 1
  `).all();

  const winner = db.prepare(`
    SELECT id FROM offers WHERE ${KEY_SQL} = ?
     ORDER BY (si_symbol IS NOT NULL) DESC, (unit_price IS NOT NULL) DESC, id ASC
     LIMIT 1
  `);
  const members = db.prepare(`SELECT id FROM offers WHERE ${KEY_SQL} = ?`);

  const remap = [];                       // [dubletId, beholdtId]
  for (const g of groups) {
    const keep = winner.get(g.k).id;
    for (const { id } of members.all(g.k)) if (id !== keep) remap.push([id, keep]);
  }
  return { groups: groups.length, remap };
}

/** Trin 3: flyt notifikationerne med, og slet så dubletterne. */
function removeDuplicates(db, remap) {
  // Notifikationerne peger på et konkret tilbud, og offer_id er ON DELETE
  // CASCADE. Uden det her ville brugerens ulæste beskeder forsvinde sammen med
  // dubletten. UNIQUE(watch_id, offer_id) kan kollidere, når to notifikationer
  // for samme overvågning pegede på hver sin dublet – den overflødige ryger
  // med i DELETE bagefter.
  const move = db.prepare('UPDATE OR IGNORE notifications SET offer_id = ? WHERE offer_id = ?');
  const del = db.prepare('DELETE FROM offers WHERE id = ?');

  db.transaction(() => {
    for (const [dup, keep] of remap) move.run(keep, dup);
    for (const [dup] of remap) del.run(dup);
  })();
}

/**
 * Sørger for at den naturlige nøgle findes – og rydder op, hvis den ikke kan
 * lægges på endnu. Kaldes fra migrate() ved hver åbning; er indekset der
 * allerede, koster den ét opslag i sqlite_master.
 *
 * @returns {null | { normalised: number, groups: number, removed: number }}
 */
function ensureNaturalKey(db, log = null) {
  if (hasIndex(db)) return null;

  const normalised = normaliseText(db);
  const { groups, remap } = findDuplicates(db);
  if (remap.length) removeDuplicates(db, remap);
  db.exec(INDEX_SQL);

  const stats = { normalised, groups, removed: remap.length };
  if (log && (normalised || remap.length)) {
    log(`  dubletter ryddet: ${remap.length} rækker i ${groups} grupper` +
        (normalised ? ` · ${normalised} tekster renset` : ''));
  }
  return stats;
}

module.exports = { ensureNaturalKey, findDuplicates, normaliseText, hasIndex, flat, INDEX_NAME };
