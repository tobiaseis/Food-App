'use strict';

/**
 * Opskriftskilder.
 *
 * Kravet var opskrifter fra anerkendte madsider – ikke AI-genererede. Alle
 * kilder her er etablerede udgivere, alle udstiller struktureret opskriftsdata
 * (schema.org), og alle tillader crawl af opskriftsstier i robots.txt.
 *
 * Vi henter fakta (titel, ingrediensliste, næringsindhold, billede, link) og
 * lader fremgangsmåden blive hos kilden – brugeren klikker videre dertil.
 */

const SOURCES = [
  {
    key: 'valdemarsro',
    name: 'Valdemarsro',
    lang: 'da',
    homepage: 'https://www.valdemarsro.dk',
    // Dansk hverdagsmad – rygraden i "klassisk"-planen.
    tierHint: 'classic',
    isRecipeUrl: (u) => /^https:\/\/www\.valdemarsro\.dk\/[a-z0-9æøå-]+\/$/i.test(u),
    delayMs: 900,

    /**
     * Bloggens post-sitemap blander opskrifter med boganmeldelser, så den er
     * ubrugelig som kilde. I stedet bladres der gennem kategorien "aftensmad"
     * – dét er præcis de retter, en madplan skal bruge. Kategorisiderne
     * trækkes fra, så nav-links ikke forveksles med opskrifter.
     */
    async discover({ fetchText, sleep }, limit) {
      // Kategorisider OG statiske sider (madplan, kogebøger, FAQ …) skal ud,
      // ellers ligner bloggens egne nav-links opskrifter på URL-form alene.
      const excluded = new Set();
      for (const map of ['category-sitemap.xml', 'page-sitemap.xml']) {
        const xml = await fetchText(`https://www.valdemarsro.dk/${map}`);
        for (const m of (xml || '').matchAll(/<loc>\s*([^<\s]+)\s*<\/loc>/gi)) excluded.add(m[1]);
        await sleep(400);
      }
      const categories = excluded;

      const seen = new Set();
      const out = [];
      for (let page = 1; page <= 60 && out.length < limit * 2; page++) {
        const url = `https://www.valdemarsro.dk/aftensmad/${page > 1 ? `page/${page}/` : ''}`;
        const html = await fetchText(url);
        if (!html) break;

        let added = 0;
        for (const m of html.matchAll(/href=["'](https:\/\/www\.valdemarsro\.dk\/[^"'#?]+)["']/gi)) {
          const u = m[1];
          if (seen.has(u) || categories.has(u)) continue;
          if (!/^https:\/\/www\.valdemarsro\.dk\/[a-z0-9æøå-]+\/$/i.test(u)) continue;
          seen.add(u);
          out.push(u);
          added++;
        }
        if (!added) break;
        await sleep(700);
      }
      return out;
    },
  },
  {
    key: 'arla',
    name: 'Arla',
    lang: 'da',
    homepage: 'https://www.arla.dk',
    // Har næringsdeklaration på de fleste opskrifter.
    tierHint: 'classic',
    sitemapIndex: 'https://www.arla.dk/sitemap.index.xml',
    pickSitemaps: (urls) => urls.filter((u) => /RecipeSitemapUrlWriter/i.test(u)),
    isRecipeUrl: (u) => /arla\.dk\/opskrifter\/[^/]+\/?$/i.test(u),
    delayMs: 900,
  },
  {
    key: 'bbcgoodfood',
    name: 'BBC Good Food',
    lang: 'en',
    homepage: 'https://www.bbcgoodfood.com',
    // Fuld næringsdeklaration + stort udvalg af både sunde og finere retter.
    tierHint: null,
    sitemapIndex: 'https://www.bbcgoodfood.com/sitemap.xml',
    pickSitemaps: (urls) => urls.filter((u) => /-recipe\.xml$/i.test(u)),
    isRecipeUrl: (u) => /bbcgoodfood\.com\/recipes\/[^/]+\/?$/i.test(u),
    delayMs: 900,

    // Redaktionelt kuraterede samlinger. Sitemappet er tilfældigt sorteret og
    // fyldt med kager; de her rammer direkte det, "sund & proteinrig"-sporet
    // mangler. De hentes først, resten fyldes op fra sitemappet.
    collections: [
      'high-protein-recipes', 'high-protein-dinner-recipes',
      'high-protein-lunch-recipes', 'high-protein-breakfast-recipes',
      'low-carb-recipes', 'low-carb-dinner-recipes',
      'healthy-recipes', 'healthy-dinner-recipes',
      'healthy-chicken-recipes', 'healthy-fish-recipes', 'healthy-beef-recipes',
      'low-calorie-chicken-recipes', 'healthy-salad-recipes',
    ],

    async discover({ fetchText, sleep }, limit) {
      const seen = new Set();
      const out = [];

      const collect = (html) => {
        for (const m of html.matchAll(/https:\/\/www\.bbcgoodfood\.com\/recipes\/([a-z0-9-]{4,})/gi)) {
          const u = m[0];
          if (/\/recipes\/collection/.test(u) || seen.has(u)) continue;
          seen.add(u);
          out.push(u);
        }
      };

      for (const slug of this.collections) {
        for (let page = 1; page <= 6; page++) {
          const url = `https://www.bbcgoodfood.com/recipes/collection/${slug}${page > 1 ? `?page=${page}` : ''}`;
          const html = await fetchText(url);
          if (!html) break;                      // 404 = ikke flere sider
          const before = out.length;
          collect(html);
          if (out.length === before) break;      // ingen nye = udtømt
          await sleep(600);
        }
        if (out.length >= limit * 2) break;
      }

      // Fyld op fra sitemappet, hvis samlingerne ikke rakte
      if (out.length < limit) {
        const indexXml = await fetchText(this.sitemapIndex);
        for (const map of this.pickSitemaps(
          [...(indexXml || '').matchAll(/<loc>\s*([^<\s]+)\s*<\/loc>/gi)].map((m) => m[1])
        )) {
          const xml = await fetchText(map);
          for (const m of (xml || '').matchAll(/<loc>\s*([^<\s]+)\s*<\/loc>/gi)) {
            if (this.isRecipeUrl(m[1]) && !seen.has(m[1])) { seen.add(m[1]); out.push(m[1]); }
          }
          if (out.length >= limit * 2) break;
          await sleep(400);
        }
      }

      return out;
    },
  },
  {
    key: 'greatbritishchefs',
    name: 'Great British Chefs',
    lang: 'en',
    homepage: 'https://www.greatbritishchefs.com',
    // Restaurantkokke, ikke hverdagsmad. Bærer "gourmet"-sporet.
    tierHint: 'premium',
    premiumBias: 0.25,
    sitemapIndex: 'https://www.greatbritishchefs.com/sitemap.xml',
    pickSitemaps: (urls) => urls.filter((u) => /sitemap-\d{4}-recipes\.xml$/i.test(u)),
    isRecipeUrl: (u) => /greatbritishchefs\.com\/recipes\/[^/]+\/?$/i.test(u),
    delayMs: 1000,
  },
];

const BY_KEY = new Map(SOURCES.map((s) => [s.key, s]));

module.exports = { SOURCES, BY_KEY };
