-- ─────────────────────────────────────────────────────────────────────────────
-- Madplan / Tilbud  –  skema
--
-- Kernebegreb: et PRODUKT er en varetype ("skyr", "hakket oksekød") der
-- overlever fra uge til uge. Et TILBUD er én observation af det produkt i én
-- kæde i én periode. Prishistorik = alle tilbud for et produkt over tid.
-- ─────────────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS chains (
  id          TEXT PRIMARY KEY,      -- Tjek dealer id, fx '11deC'
  name        TEXT NOT NULL,
  slug        TEXT NOT NULL,
  logo        TEXT,
  color       TEXT,
  website     TEXT
);

CREATE TABLE IF NOT EXISTS stores (
  id          TEXT PRIMARY KEY,      -- Tjek store id
  chain_id    TEXT NOT NULL REFERENCES chains(id),
  name        TEXT,
  street      TEXT,
  city        TEXT,
  zip         TEXT,
  lat         REAL,
  lng         REAL
);
CREATE INDEX IF NOT EXISTS idx_stores_geo   ON stores(lat, lng);
CREATE INDEX IF NOT EXISTS idx_stores_chain ON stores(chain_id);

-- Kanonisk varetype. Dét man "følger" og dét prishistorikken hænger på.
CREATE TABLE IF NOT EXISTS products (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  slug             TEXT NOT NULL UNIQUE,  -- stabil nøgle, fx 'hakket-oksekoed'
  name             TEXT NOT NULL,         -- pænt visningsnavn
  category         TEXT,                  -- meat|fish|dairy|produce|pantry|...
  taxonomy_key     TEXT,                  -- match i taxonomy.js, hvis fundet
  -- Varianter der systematisk flytter prisen, og som derfor er en del af
  -- vareidentiteten. Hakket oksekød 8-12 % og 15-20 % er ikke samme vare.
  fat_grade        TEXT,                  -- '3-7' | '8-12' | '15-20' | '22-26'
  organic          INTEGER DEFAULT 0,
  -- Forarbejdet vare: indeholder råvaren, men er den ikke ("indbagte rejer",
  -- "kyllingenuggets"). Har pris og historik som alle andre, men kan ikke
  -- gøre det ud for en råvare i en opskrift.
  prepared         INTEGER DEFAULT 0,
  protein_per_100g REAL,
  kcal_per_100g    REAL,
  created_at       TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_products_cat ON products(category);
CREATE INDEX IF NOT EXISTS idx_products_tax ON products(taxonomy_key);

-- Én observation af et tilbud. external_id gør ingest idempotent.
CREATE TABLE IF NOT EXISTS offers (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  external_id   TEXT NOT NULL UNIQUE,   -- Tjek offer id
  product_id    INTEGER REFERENCES products(id),
  chain_id      TEXT NOT NULL REFERENCES chains(id),

  heading       TEXT NOT NULL,
  description   TEXT,
  brand         TEXT,

  price         REAL NOT NULL,
  pre_price     REAL,                   -- førpris fra avisen, hvis oplyst
  currency      TEXT DEFAULT 'DKK',

  size_from     REAL,                   -- rå mængde, fx 33
  size_to       REAL,
  unit_symbol   TEXT,                   -- fx 'cl'
  si_symbol     TEXT,                   -- fx 'l'
  si_factor     REAL,                   -- fx 0.01
  pieces_from   INTEGER,
  pieces_to     INTEGER,

  base_qty      REAL,                   -- normaliseret mængde i kg / l / stk
  base_unit     TEXT,                   -- 'kg' | 'l' | 'stk'
  unit_price    REAL,                   -- kr pr. base_unit  <- nøgletallet
  size_is_range INTEGER DEFAULT 0,

  run_from      TEXT,
  run_till      TEXT,
  week          INTEGER,
  year          INTEGER,

  page          INTEGER,
  image         TEXT,
  catalog_id    TEXT,
  observed_at   TEXT NOT NULL
);
-- BEMÆRK: den unikke nøgle mod dubletter (idx_offers_natural) lægges IKKE her,
-- men i src/db/dedupe.js, som kaldes fra migrate(). Et CREATE UNIQUE INDEX i
-- denne fil ville fejle på enhver base fra før nøglen blev indført – de
-- indeholder dubletter – og da schema.sql køres ved hver eneste åbning, ville
-- basen så slet ikke kunne åbnes. Migreringen rydder op først og lægger
-- derefter nøglen på.

CREATE INDEX IF NOT EXISTS idx_offers_product ON offers(product_id, run_from);
CREATE INDEX IF NOT EXISTS idx_offers_chain   ON offers(chain_id, run_from);
CREATE INDEX IF NOT EXISTS idx_offers_window  ON offers(run_from, run_till);
CREATE INDEX IF NOT EXISTS idx_offers_unitp   ON offers(product_id, unit_price);

-- Fritekstsøgning over tilbud (drevet af triggere nederst)
CREATE VIRTUAL TABLE IF NOT EXISTS offers_fts USING fts5(
  heading, description, product_name,
  content='', tokenize='unicode61 remove_diacritics 0'
);

-- ── Opskrifter ──────────────────────────────────────────────────────────────
-- Vi gemmer FAKTA (titel, ingrediensliste, næring, link) og linker ud til
-- kilden for fremgangsmåden. Opskriftsteksten kopieres ikke.
CREATE TABLE IF NOT EXISTS recipes (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  url            TEXT NOT NULL UNIQUE,
  source         TEXT NOT NULL,        -- 'valdemarsro' | 'arla' | 'bbcgoodfood'
  source_name    TEXT NOT NULL,        -- pænt navn til kreditering
  title          TEXT NOT NULL,
  description    TEXT,
  image          TEXT,
  lang           TEXT,                 -- 'da' | 'en'
  servings       INTEGER,
  total_minutes  INTEGER,

  kcal           REAL,                 -- pr. portion
  protein_g      REAL,
  carbs_g        REAL,
  fat_g          REAL,
  nutrition_src  TEXT,                 -- 'site' | 'estimated'

  tier           TEXT,                 -- healthy | classic | premium (primær)
  tier_score     REAL,
  -- Alle tre scorer gemmes, så en madplan kan rangere efter det ønskede spor
  -- og ikke kun efter den vindende kategori.
  score_healthy  REAL,
  score_classic  REAL,
  score_premium  REAL,
  keywords       TEXT,
  fetched_at     TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_recipes_tier ON recipes(tier);

CREATE TABLE IF NOT EXISTS recipe_ingredients (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  recipe_id    INTEGER NOT NULL REFERENCES recipes(id) ON DELETE CASCADE,
  raw          TEXT NOT NULL,          -- original linje
  qty          REAL,
  unit         TEXT,
  ingredient   TEXT,                   -- renset ingrediensnavn
  taxonomy_key TEXT,                   -- kobling til varetype
  is_staple    INTEGER DEFAULT 0,      -- salt/peber/olie: tæller ikke i match
  position     INTEGER
);
CREATE INDEX IF NOT EXISTS idx_ri_recipe ON recipe_ingredients(recipe_id);
CREATE INDEX IF NOT EXISTS idx_ri_tax    ON recipe_ingredients(taxonomy_key);

-- ── Madplaner ───────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS meal_plans (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  tier         TEXT NOT NULL,
  week         INTEGER NOT NULL,
  year         INTEGER NOT NULL,
  created_at   TEXT NOT NULL,
  est_cost     REAL,
  est_savings  REAL,
  chains       TEXT,                   -- JSON-array af chain_id
  UNIQUE(tier, week, year)
);

CREATE TABLE IF NOT EXISTS meal_plan_items (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  plan_id       INTEGER NOT NULL REFERENCES meal_plans(id) ON DELETE CASCADE,
  day           INTEGER NOT NULL,      -- 0 = mandag
  recipe_id     INTEGER NOT NULL REFERENCES recipes(id),
  matched_json  TEXT,                  -- hvilke ingredienser er på tilbud
  match_count   INTEGER,
  est_cost      REAL,
  est_savings   REAL
);
CREATE INDEX IF NOT EXISTS idx_mpi_plan ON meal_plan_items(plan_id);

-- ── Følg varer + notifikationer ─────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS watches (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  label          TEXT NOT NULL,        -- fx 'Skyr'
  query          TEXT NOT NULL,        -- søgetekst / taxonomy-nøgle
  taxonomy_key   TEXT,
  chain_ids      TEXT,                 -- JSON-array, tom = alle
  max_km         REAL,                 -- null = ingen afstandsgrænse
  min_discount   REAL,                 -- fx 0.15 = kun ved >=15% under normal
  max_unit_price REAL,                 -- fx kun hvis under 60 kr/kg
  active         INTEGER DEFAULT 1,
  created_at     TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS notifications (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  watch_id    INTEGER NOT NULL REFERENCES watches(id) ON DELETE CASCADE,
  offer_id    INTEGER NOT NULL REFERENCES offers(id) ON DELETE CASCADE,
  reason      TEXT,
  unit_price  REAL,
  discount    REAL,
  nearest_km  REAL,
  nearest_store TEXT,
  created_at  TEXT NOT NULL,
  read_at     TEXT,
  UNIQUE(watch_id, offer_id)
);
CREATE INDEX IF NOT EXISTS idx_notif_unread ON notifications(read_at, created_at);

CREATE TABLE IF NOT EXISTS settings (
  key   TEXT PRIMARY KEY,
  value TEXT
);

-- ── FTS-triggere ────────────────────────────────────────────────────────────
CREATE TRIGGER IF NOT EXISTS offers_fts_ins AFTER INSERT ON offers BEGIN
  INSERT INTO offers_fts(rowid, heading, description, product_name)
  VALUES (new.id, new.heading, COALESCE(new.description, ''),
          COALESCE((SELECT name FROM products WHERE id = new.product_id), ''));
END;

CREATE TRIGGER IF NOT EXISTS offers_fts_del AFTER DELETE ON offers BEGIN
  INSERT INTO offers_fts(offers_fts, rowid, heading, description, product_name)
  VALUES ('delete', old.id, old.heading, COALESCE(old.description, ''), '');
END;
