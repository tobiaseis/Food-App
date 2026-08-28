-- ─────────────────────────────────────────────────────────────────────────────
-- Supabase-skema  (kør én gang i SQL Editor på supabase.com)
--
-- Dette er IKKE en kopi af SQLite-skemaet. Supabase holder kun det, frontenden
-- skal læse, plus det brugeren selv skriver:
--
--   · råtabeller      – tilbud, varer, kæder, opskrifter (kilden til historik)
--   · færdigregnede   – prisstatistik, ugeserier, madplaner, ugens fund
--   · brugerdata      – overvågninger og notifikationer
--
-- Al tung beregning (taksonomi, normalisering, madplans-scoring) sker i
-- GitHub Actions mod en lokal SQLite-fil og skrives hertil som resultat.
-- Frontenden laver derfor kun simple SELECTs.
-- ─────────────────────────────────────────────────────────────────────────────

-- ── Stamdata ────────────────────────────────────────────────────────────────

create table if not exists chains (
  id      text primary key,
  name    text not null,
  slug    text not null,
  logo    text,
  color   text,
  website text
);

create table if not exists products (
  id            bigint primary key,
  slug          text not null unique,
  name          text not null,
  category      text,
  taxonomy_key  text,
  fat_grade     text,          -- '3-7' | '8-12' | '15-20' | '22-26'
  organic       smallint default 0
);
create index if not exists idx_products_tax on products(taxonomy_key);
create index if not exists idx_products_cat on products(category);

create table if not exists stores (
  id       text primary key,
  chain_id text references chains(id),
  name     text,
  street   text,
  city     text,
  zip      text,
  lat      double precision,
  lng      double precision
);
create index if not exists idx_stores_geo on stores(lat, lng);

-- Hele historikken. ~1.200 nye rækker om ugen ≈ 62k/år ≈ 20 MB/år,
-- rigeligt inden for free tier'ens 500 MB.
create table if not exists offers (
  id          bigint primary key,
  external_id text unique,
  product_id  bigint references products(id),
  chain_id    text references chains(id),
  heading     text not null,
  description text,
  price       double precision,
  pre_price   double precision,
  unit_price  double precision,
  base_unit   text,
  base_qty    double precision,
  image       text,
  run_from    timestamptz,
  run_till    timestamptz,
  week        int,
  year        int,
  observed_at timestamptz
);
create index if not exists idx_offers_product on offers(product_id);
create index if not exists idx_offers_window  on offers(run_till);
create index if not exists idx_offers_chain   on offers(chain_id);

create table if not exists recipes (
  id            bigint primary key,
  url           text not null unique,
  title         text not null,
  source_name   text,
  image         text,
  servings      int,
  total_minutes int,
  kcal          double precision,
  protein_g     double precision,
  carbs_g       double precision,
  nutrition_src text,
  tier          text
);

-- ── Færdigregnet (skrives af GitHub Actions) ────────────────────────────────

-- Normalpris pr. varetype. Frontenden skal ikke regne medianer.
create table if not exists price_stats (
  product_id bigint references products(id),
  base_unit  text,
  median     double precision,
  min_price  double precision,
  max_price  double precision,
  samples    int,
  chains     int,
  periods    int,
  primary key (product_id, base_unit)
);

-- Ugentlige punkter til prisgrafen.
create table if not exists price_series (
  product_id bigint references products(id),
  base_unit  text,
  period     text,           -- '2026-35'
  median     double precision,
  min_price  double precision,
  max_price  double precision,
  n          int,
  primary key (product_id, base_unit, period)
);

-- Hele madplanen som JSON. Flere varianter pr. spor, så "Ny plan" kan
-- skifte uden at regne noget – generatoren kan ikke køre serverless.
create table if not exists meal_plans (
  tier        text not null,
  week        int not null,
  year        int not null,
  variant     int not null default 0,
  est_cost    double precision,
  est_savings double precision,
  payload     jsonb not null,
  created_at  timestamptz default now(),
  primary key (tier, year, week, variant)
);

-- ── Madplans-indeks ─────────────────────────────────────────────────────────
--
-- Favoritbutikker kan ikke forudberegnes: femten kæder giver 32.767 mulige
-- kombinationer, og brugerens er kun kendt i browseren. Derfor forudberegner
-- vi ikke selve planen, men de to opslagstabeller, planen bygges af – de er
-- små nok til at hentes hjem, og så kører madplans-motoren (public/engine.js)
-- i browseren med præcis de butikker, brugeren har valgt.

-- Billigste aktive tilbud pr. varetype PR. KÆDE. Frontenden vælger selv
-- rækkerne for sine favoritter og reducerer dem til ét kort.
create table if not exists offer_index (
  taxonomy_key      text not null,
  chain_id          text not null references chains(id),
  offer_id          bigint,
  product_id        bigint,
  product_name      text,
  heading           text,
  price             double precision,
  unit_price        double precision,
  base_unit         text,
  normal_unit_price double precision,   -- varens egen normalpris (median)
  image             text,
  run_till          timestamptz,
  primary key (taxonomy_key, chain_id)
);
create index if not exists idx_offer_index_chain on offer_index(chain_id);

-- Normalpris pr. varetype på tværs af kæder. Bruges til at prissætte de
-- ingredienser, der IKKE er på tilbud – de skal jo også købes.
create table if not exists taxonomy_prices (
  taxonomy_key text primary key,
  name         text,
  unit_price   double precision,
  base_unit    text,
  samples      int
);

-- Opskrifterne i planlægningsklar form: ingredienserne er allerede slået op i
-- taksonomien, så browseren hverken skal kende den eller regne mængder om.
create table if not exists recipe_index (
  recipe_id     bigint primary key,
  title         text not null,
  url           text not null,
  image         text,
  source        text,
  source_name   text,
  servings      int,
  total_minutes int,
  kcal          double precision,
  protein_g     double precision,
  carbs_g       double precision,
  nutrition_src text,
  score_healthy double precision,
  score_classic double precision,
  score_premium double precision,
  unknown_main  boolean default false,
  items         jsonb not null          -- [{key,cat,staple,grams,ingredient}]
);
create index if not exists idx_recipe_index_healthy on recipe_index(score_healthy);
create index if not exists idx_recipe_index_classic on recipe_index(score_classic);
create index if not exists idx_recipe_index_premium on recipe_index(score_premium);

-- "Ugens fund" med færdig vurdering.
create table if not exists deals (
  offer_id     bigint primary key references offers(id),
  product_id   bigint references products(id),
  verdict      text,
  discount_pct double precision,
  confidence   text,
  is_cheapest  boolean,
  rank         int
);

-- ── Brugerdata ──────────────────────────────────────────────────────────────
-- device_id genereres i browseren og gemmes i localStorage.

create table if not exists watches (
  id             bigserial primary key,
  device_id      text not null,
  label          text not null,
  query          text not null,
  taxonomy_key   text,
  chain_ids      jsonb default '[]'::jsonb,
  max_km         double precision,
  min_discount   double precision,
  max_unit_price double precision,
  home_lat       double precision,
  home_lng       double precision,
  active         boolean default true,
  created_at     timestamptz default now()
);
create index if not exists idx_watches_device on watches(device_id);

create table if not exists notifications (
  id            bigserial primary key,
  watch_id      bigint references watches(id) on delete cascade,
  offer_id      bigint references offers(id) on delete cascade,
  device_id     text not null,
  reason        text,
  unit_price    double precision,
  discount      double precision,
  nearest_km    double precision,
  nearest_store text,
  created_at    timestamptz default now(),
  read_at       timestamptz,
  unique (watch_id, offer_id)
);
create index if not exists idx_notif_device on notifications(device_id, read_at);

-- Sidste kørsel, så frontenden kan vise hvor friske data er.
create table if not exists sync_state (
  key        text primary key,
  value      jsonb,
  updated_at timestamptz default now()
);

-- ── Row Level Security ──────────────────────────────────────────────────────
--
-- anon-nøglen ligger i frontenden – den er beregnet til at være offentlig.
-- Katalogdata er offentlige tilbudsaviser, så fri læseadgang er i orden.
--
-- BEMÆRK: overvågninger adskilles kun af device_id, ikke af login. Enhver med
-- anon-nøglen kan i princippet skrive en overvågning på et gættet device_id.
-- Det er acceptabelt for en personlig app; skal den deles med fremmede, så
-- slå Supabase Auth til og udskift policyerne nedenfor med auth.uid()-tjek.

alter table chains       enable row level security;
alter table products     enable row level security;
alter table stores       enable row level security;
alter table offers       enable row level security;
alter table recipes      enable row level security;
alter table price_stats  enable row level security;
alter table price_series enable row level security;
alter table meal_plans   enable row level security;
alter table offer_index     enable row level security;
alter table taxonomy_prices enable row level security;
alter table recipe_index    enable row level security;
alter table deals        enable row level security;
alter table sync_state   enable row level security;
alter table watches      enable row level security;
alter table notifications enable row level security;

do $$
declare t text;
begin
  -- Offentlig læsning af katalogdata
  foreach t in array array['chains','products','stores','offers','recipes',
                           'price_stats','price_series','meal_plans','deals','sync_state',
                           'offer_index','taxonomy_prices','recipe_index']
  loop
    execute format('drop policy if exists read_all on %I', t);
    execute format('create policy read_all on %I for select to anon, authenticated using (true)', t);
  end loop;
end $$;

-- Brugeren må selv styre sine overvågninger
drop policy if exists watches_all on watches;
create policy watches_all on watches
  for all to anon, authenticated using (true) with check (true);

drop policy if exists notif_read on notifications;
create policy notif_read on notifications
  for select to anon, authenticated using (true);

drop policy if exists notif_update on notifications;
create policy notif_update on notifications
  for update to anon, authenticated using (true) with check (true);

-- service_role (GitHub Actions) omgår RLS automatisk og behøver ingen policy.
