'use strict';

/**
 * Dansk fødevare-taksonomi.
 *
 * Dette er appens omdrejningspunkt. Den løser tre problemer på én gang:
 *
 *   1. STABIL VARE-IDENTITET  – "Kyllingebryst 1 kg" i uge 12 og
 *      "Kyllingebrystfilet, ca. 900 g" i uge 13 skal blive til SAMME produkt,
 *      ellers findes der ingen prishistorik.
 *   2. OPSKRIFT-MATCH         – "500 g hakket oksekød" i en opskrift skal
 *      kunne kobles til et tilbud på hakket oksekød.
 *   3. SPROG-BRO              – engelske opskrifter ("chicken breast") skal
 *      kunne matche danske tilbud ("kyllingebryst").
 *
 * `p` = gram protein pr. 100 g, `kcal` = kcal pr. 100 g. Bruges til at
 * estimere makroer for opskrifter uden næringsdeklaration, så "sund og
 * proteinrig"-planen kan rangere korrekt.
 *
 * Afgrænsningen er praktisk, ikke principiel: står varen i skabet i forvejen,
 * købes den sjældent på tilbud, og den bruges i så små mængder, at prisen
 * alligevel ikke flytter noget. En madplan, der ventede på tilbud på
 * salt og paprika, ville aldrig blive til noget.
 *
 * `class` ('fresh' | 'baseline' | 'essential') og `keeps`
 * ('perishable' | 'keeps' | 'pantry') beskriver sammen hvor ofte varen
 * købes, og hvor længe den holder, når den er købt. 'essential' er varer,
 * man antages at have hjemme i forvejen – de tæller hverken som krav eller
 * som "match", når vi vurderer hvor meget af en opskrift der er på tilbud.
 */

// cat: poultry | meat | fish | dairy | cheese | eggs | veg | fruit | grain
//      | legume | pantry | bakery | drink | snack | nonfood
const SEED = [
  // ── Fjerkræ ───────────────────────────────────────────────────────────────
  { key: 'kyllingebryst', name: 'Kyllingebryst', cat: 'poultry',
    class: 'fresh', keeps: 'perishable', p: 23, kcal: 110, c: 0,
    da: ['kyllingebrystfilet', 'kyllingebryst', 'kyllingefilet', 'kyllinge inderfilet',
         'kyllingeinderfilet', 'brystfilet'],
    en: ['chicken breast', 'chicken fillet', 'chicken breasts'] },
  { key: 'kyllingelaar', name: 'Kyllingelår', cat: 'poultry',
    class: 'fresh', keeps: 'perishable', p: 19, kcal: 145, c: 0,
    da: ['kyllingeoverlår', 'kyllingelår', 'kyllingeunderlår', 'kyllingekøller'],
    en: ['chicken thigh', 'chicken thighs', 'chicken drumstick', 'chicken legs'] },
  { key: 'hel_kylling', name: 'Hel kylling', cat: 'poultry',
    class: 'fresh', keeps: 'perishable', p: 20, kcal: 160, c: 0,
    da: ['hel kylling', 'grillkylling', 'kylling hel'], en: ['whole chicken', 'roast chicken'] },
  { key: 'kylling', name: 'Kylling', cat: 'poultry',
    class: 'fresh', keeps: 'perishable', p: 21, kcal: 130, c: 0,
    // 'majskylling' skal stå for sig: ellers vinder 'majs' på position, og
    // en fransk majskylling bliver til en majskolbe.
    da: ['majskylling', 'kyllingekød', 'kylling'], en: ['chicken'] },
  { key: 'hakket_kylling', name: 'Hakket kyllingekød', cat: 'poultry',
    class: 'fresh', keeps: 'perishable', p: 20, kcal: 125, c: 0, fatGrades: true,
    da: ['hakket kylling', 'hakket kyllingekød'], en: ['minced chicken', 'ground chicken'] },
  { key: 'kalkun', name: 'Kalkun', cat: 'poultry',
    class: 'fresh', keeps: 'perishable', p: 24, kcal: 115, c: 0, fatGrades: true,
    // Kalkunudskæringerne skal stå for sig: ellers vinder det korte
    // 'brystfilet' som helt ord over 'kalkun' som orddel.
    da: ['kalkunbrystfilet', 'kalkunstrimler', 'kalkunschnitzel', 'kalkunoverlår',
         'kalkununderlår', 'kalkunfilet', 'kalkunbryst', 'hakket kalkun', 'kalkun'],
    en: ['turkey breast', 'turkey'] },
  { key: 'and', name: 'And', cat: 'poultry',
    class: 'fresh', keeps: 'perishable', p: 18, kcal: 200, c: 0,
    da: ['andebryst', 'andelår', 'and'], en: ['duck', 'duck breast'], premium: true },

  // ── Kød ───────────────────────────────────────────────────────────────────
  { key: 'hakket_oksekoed', name: 'Hakket oksekød', cat: 'meat',
    class: 'fresh', keeps: 'perishable', p: 20, kcal: 175, c: 0, fatGrades: true,
    da: ['hakket oksekød', 'hakket okse', 'oksefars', 'hakket kalv og flæsk', 'hakket kalv & flæsk'],
    en: ['minced beef', 'ground beef', 'beef mince'] },
  { key: 'hakket_svinekoed', name: 'Hakket svinekød', cat: 'meat',
    class: 'fresh', keeps: 'perishable', p: 18, kcal: 220, c: 0, fatGrades: true,
    da: ['hakket svinekød', 'hakket grisekød', 'svinefars', 'hakket flæsk', 'grisekød'],
    en: ['minced pork', 'ground pork', 'pork mince'] },
  { key: 'oksemoerbrad', name: 'Oksemørbrad', cat: 'meat',
    class: 'fresh', keeps: 'perishable', p: 21, kcal: 145, c: 0,
    da: ['oksemørbrad', 'oksefilet', 'oksehøjreb'], en: ['beef tenderloin', 'fillet of beef'], premium: true },
  { key: 'boef', name: 'Bøf / steak', cat: 'meat',
    class: 'fresh', keeps: 'perishable', p: 22, kcal: 190, c: 0,
    da: ['ribeye', 'entrecote', 'culotte', 'tournedos', 'flanksteak', 'bøf'],
    en: ['ribeye', 'sirloin', 'steak', 'entrecote'], premium: true },
  { key: 'oksekoed', name: 'Oksekød', cat: 'meat',
    class: 'fresh', keeps: 'perishable', p: 21, kcal: 180, c: 0,
    da: ['tykstegsfilet', 'oksekød', 'okseklump', 'oksetykkam', 'oksebov',
         'okseinderlår', 'okseyderlår', 'oksespidsbryst', 'oksebryst'],
    en: ['beef', 'brisket'] },
  { key: 'svinemoerbrad', name: 'Svinemørbrad', cat: 'meat',
    class: 'fresh', keeps: 'perishable', p: 21, kcal: 140, c: 0,
    da: ['svinemørbrad', 'svinefilet', 'mørbrad'], en: ['pork tenderloin', 'pork fillet'] },
  { key: 'flaeskesteg', name: 'Flæskesteg', cat: 'meat',
    class: 'fresh', keeps: 'perishable', p: 20, kcal: 260, c: 0,
    da: ['flæskesteg', 'svinekam', 'nakkefilet', 'nakkekam', 'ribbensteg', 'ribbenssteg',
         'spareribs', 'stegeflæsk', 'flæsk i skiver', 'svinekæber', 'svineskank'],
    en: ['pork roast', 'pork loin', 'pork shoulder', 'pork belly', 'pulled pork'] },
  { key: 'svinekoteletter', name: 'Svinekoteletter', cat: 'meat',
    class: 'fresh', keeps: 'perishable', p: 21, kcal: 200, c: 0,
    da: ['svinekoteletter', 'koteletter', 'nakkekoteletter'], en: ['pork chops', 'chops'] },
  { key: 'bacon', name: 'Bacon', cat: 'meat',
    class: 'fresh', keeps: 'perishable', p: 13, kcal: 400, c: 1,
    da: ['bacon', 'baconskiver', 'bacon i tern'], en: ['bacon', 'pancetta', 'streaky bacon'] },
  { key: 'lam', name: 'Lammekød', cat: 'meat',
    class: 'fresh', keeps: 'perishable', p: 20, kcal: 230, c: 0,
    da: ['lammekølle', 'lammekød', 'lammekoteletter', 'lammefilet',
         'lammekrone', 'lammebov', 'lammehals', 'lammeskank'],
    en: ['lamb', 'rack of lamb', 'leg of lamb'], premium: true },
  { key: 'kalvekoed', name: 'Kalvekød', cat: 'meat',
    class: 'fresh', keeps: 'perishable', p: 21, kcal: 150, c: 0,
    da: ['kalveculotte', 'kalvekød', 'kalvefilet', 'kalvetykkam', 'kalveschnitzel'],
    en: ['veal'], premium: true },
  { key: 'poelser', name: 'Pølser', cat: 'meat',
    class: 'fresh', keeps: 'perishable', p: 12, kcal: 290, c: 3,
    da: ['grillpølser', 'medisterpølse', 'pølser', 'wienerpølser', 'chorizo'],
    en: ['sausages', 'chorizo', 'sausage'] },
  { key: 'paalaeg', name: 'Pålæg', cat: 'meat',
    class: 'fresh', keeps: 'perishable', p: 16, kcal: 200, c: 2,
    da: ['baconleverpostej', 'kyllingeleverpostej', 'baconpostej', 'leverpostej',
         'pålæg', 'spegepølse', 'skinke i skiver', 'rullepølse'],
    en: ['cold cuts', 'ham', 'salami', 'prosciutto', 'mortadella'] },
  { key: 'skinke', name: 'Skinke', cat: 'meat',
    class: 'fresh', keeps: 'perishable', p: 21, kcal: 145, c: 1,
    da: ['skinke', 'skinkeschnitzel'], en: ['ham', 'gammon'] },

  // ── Fisk & skaldyr ────────────────────────────────────────────────────────
  { key: 'laks', name: 'Laks', cat: 'fish',
    class: 'fresh', keeps: 'perishable', p: 20, kcal: 200, c: 0,
    da: ['laksefilet', 'laks', 'røget laks', 'koldrøget laks', 'varmrøget laks'],
    en: ['salmon', 'smoked salmon', 'salmon fillet'] },
  { key: 'torsk', name: 'Torsk', cat: 'fish',
    class: 'fresh', keeps: 'perishable', p: 18, kcal: 82, c: 0,
    da: ['torskefilet', 'torsk'], en: ['cod', 'cod fillet'] },
  { key: 'rejer', name: 'Rejer', cat: 'fish',
    class: 'fresh', keeps: 'perishable', p: 20, kcal: 100, c: 0,
    da: ['rejer', 'kæmperejer', 'tigerrejer'], en: ['prawns', 'shrimp', 'king prawns'] },
  { key: 'tun', name: 'Tun', cat: 'fish',
    class: 'fresh', keeps: 'perishable', p: 24, kcal: 115, c: 0,
    da: ['tunsteak', 'tunbøf', 'tun i vand', 'tun i olie', 'tun'],
    en: ['tuna steak', 'tuna'] },
  { key: 'fiskefars', name: 'Fiskefars', cat: 'fish',
    class: 'fresh', keeps: 'perishable', p: 12, kcal: 130, c: 6,
    da: ['laksefars', 'torskefars', 'fiskefars', 'fiskefrikadeller'], en: ['fish cakes'] },
  { key: 'rodspaette', name: 'Rødspætte', cat: 'fish',
    class: 'fresh', keeps: 'perishable', p: 17, kcal: 90, c: 0,
    da: ['rødspættefilet', 'rødspætte', 'fiskefilet'], en: ['plaice', 'white fish'] },
  { key: 'sild', name: 'Sild', cat: 'fish',
    class: 'fresh', keeps: 'perishable', p: 18, kcal: 160, c: 3,
    da: ['sild', 'marinerede sild'], en: ['herring'] },
  { key: 'makrel', name: 'Makrel', cat: 'fish',
    class: 'fresh', keeps: 'perishable', p: 19, kcal: 205, c: 0,
    da: ['makrel', 'makrel i tomat'], en: ['mackerel'] },
  { key: 'muslinger', name: 'Muslinger', cat: 'fish',
    class: 'fresh', keeps: 'perishable', p: 12, kcal: 86, c: 4,
    da: ['blåmuslinger', 'muslinger'], en: ['mussels', 'clams'] },
  { key: 'kammuslinger', name: 'Kammuslinger', cat: 'fish',
    class: 'fresh', keeps: 'perishable', p: 17, kcal: 90, c: 3,
    da: ['kammuslinger', 'jomfruhummer'], en: ['scallops', 'langoustine'], premium: true },

  // ── Mejeri ────────────────────────────────────────────────────────────────
  { key: 'skyr', name: 'Skyr', cat: 'dairy',
    class: 'fresh', keeps: 'perishable', p: 11, kcal: 63, c: 4,
    da: ['skyr'], en: ['skyr'] },
  { key: 'ymer', name: 'Ymer', cat: 'dairy',
    class: 'fresh', keeps: 'perishable', p: 6, kcal: 75, c: 5, da: ['ymer', 'tykmælk'], en: [] },
  { key: 'yoghurt', name: 'Yoghurt', cat: 'dairy',
    class: 'fresh', keeps: 'perishable', base_unit: 'l', density_g_ml: 1.0, p: 5, kcal: 70, c: 5,
    da: ['yoghurt', 'græsk yoghurt', 'youghurt', 'a38', 'labneh'],
    en: ['yogurt', 'yoghurt', 'greek yogurt'] },
  { key: 'maelk', name: 'Mælk', cat: 'dairy',
    class: 'fresh', keeps: 'perishable', base_unit: 'l', density_g_ml: 1.0, p: 3.5, kcal: 46, c: 4.7,
    da: ['minimælk', 'letmælk', 'sødmælk', 'skummetmælk', 'plantedrik', 'havredrik',
         'sojadrik', 'mandeldrik', 'mælk'],
    en: ['oat milk', 'soy milk', 'almond milk', 'whole milk', 'milk'] },
  { key: 'floede', name: 'Fløde', cat: 'dairy',
    class: 'fresh', keeps: 'perishable', base_unit: 'l', density_g_ml: 1.0, p: 2, kcal: 340, c: 3,
    da: ['piskefløde', 'madlavningsfløde', 'fløde', 'kaffefløde'],
    en: ['cream', 'double cream', 'heavy cream', 'single cream'] },
  { key: 'creme_fraiche', name: 'Creme fraiche', cat: 'dairy',
    class: 'fresh', keeps: 'perishable', p: 3, kcal: 200, c: 3.5,
    // 'fraiche' og accentformen manglede — varen fandtes allerede, så batch 2's
    // "nye" creme_fraiche-post blev slået sammen hertil i stedet for duplikeret.
    da: ['creme fraiche', 'cremefraiche', 'æblemost creme', 'crème fraîche', 'fraiche'],
    en: ['creme fraiche', 'soured cream', 'sour cream', 'crema'] },
  { key: 'smoer', name: 'Smør', cat: 'dairy',
    class: 'fresh', keeps: 'perishable', p: 0.5, kcal: 740, c: 0.6,
    da: ['smør', 'kærgården', 'smørbar'], en: ['butter'] },
  { key: 'ost', name: 'Ost', cat: 'cheese',
    class: 'fresh', keeps: 'perishable', p: 25, kcal: 350, c: 1,
    da: ['revet ost', 'skæreost', 'ostehaps', 'jarlsberg', 'myseost', 'danbo', 'havarti', 'cheddar', 'ost',
         'blåskimmelost', 'taleggio', 'stilton', 'emmental', 'queso fresco', 'stracciatella'],
    en: ['cheese', 'cheddar', 'blue cheese', 'gorgonzola'] },
  { key: 'flodeost', name: 'Flødeost', cat: 'cheese',
    class: 'fresh', keeps: 'perishable', p: 6, kcal: 250, c: 4,
    da: ['flødeost', 'friskost', 'philadelphia', 'buko'], en: ['cream cheese'] },
  { key: 'mozzarella', name: 'Mozzarella', cat: 'cheese',
    class: 'fresh', keeps: 'perishable', p: 18, kcal: 250, c: 2,
    da: ['mozzarella'], en: ['mozzarella'] },
  { key: 'feta', name: 'Feta', cat: 'cheese',
    class: 'fresh', keeps: 'perishable', p: 14, kcal: 265, c: 1.5,
    da: ['feta', 'salatost'], en: ['feta'] },
  { key: 'parmesan', name: 'Parmesan', cat: 'cheese',
    class: 'fresh', keeps: 'perishable', p: 33, kcal: 400, c: 0,
    da: ['parmesan', 'grana padano'], en: ['parmesan', 'parmigiano', 'pecorino'], premium: true },
  { key: 'hytteost', name: 'Hytteost', cat: 'dairy',
    class: 'fresh', keeps: 'perishable', p: 12, kcal: 100, c: 3,
    da: ['hytteost'], en: ['cottage cheese'] },
  { key: 'aeg', name: 'Æg', cat: 'eggs',
    class: 'fresh', keeps: 'keeps', base_unit: 'stk', p: 13, kcal: 145, c: 0.6,
    da: ['æg', 'økologiske æg', 'frilandsæg'], en: ['egg', 'eggs'] },

  // ── Grønt ─────────────────────────────────────────────────────────────────
  // Rodfrugter, løg og kål er 'baseline', ikke 'fresh': prisen står stort set
  // stille året rundt, så den behøver ikke genbesøges hver tredje måned, som
  // en tomat eller en agurk gør. 'keeps' er stadig 'keeps' – en rest gulerod
  // eller et halvt løg er ikke spild i morgen.
  { key: 'kartofler', name: 'Kartofler', cat: 'veg',
    class: 'baseline', keeps: 'keeps', p: 2, kcal: 77, c: 17,
    // Bevidst 'bagekartoffel' (ental) og ikke bar 'kartoffel': den korte
    // stamme ville kapre 'kartoffelmel' og 'kartoffelchips' fra hhv. mel-
    // og chips-varen.
    da: ['kartofler', 'bagekartofler', 'bagekartoffel', 'nye kartofler'], en: ['potatoes', 'potato'] },
  { key: 'loeg', name: 'Løg', cat: 'veg',
    class: 'baseline', keeps: 'keeps', p: 1.1, kcal: 40, c: 9,
    da: ['løg', 'rødløg', 'skalotteløg', 'zittauerløg', 'løgpulver'],
    en: ['onion', 'onions', 'shallot', 'red onion', 'onion powder'] },
  // Stod i STAPLE_KEYS, men købes: den bruges i portioner, ikke i teskefulde.
  // Ikke 'baseline' som løg/gulerod ved siden af: prisen svinger som en
  // fersk vare, selvom et fed hvidløg holder i ugevis, når det først er købt.
  { key: 'hvidloeg', name: 'Hvidløg', cat: 'veg',
    class: 'fresh', keeps: 'keeps', p: 6, kcal: 149, c: 33,
    da: ['hvidløg'], en: ['garlic', 'garlic clove', 'garlic cloves'] },
  { key: 'gulerod', name: 'Gulerødder', cat: 'veg',
    class: 'baseline', keeps: 'keeps', p: 0.9, kcal: 41, c: 8,
    da: ['gulerødder', 'gulerod'], en: ['carrot', 'carrots'] },
  { key: 'tomat', name: 'Tomater', cat: 'veg',
    class: 'fresh', keeps: 'perishable', p: 0.9, kcal: 18, c: 3.5,
    da: ['tomater', 'tomat', 'cherrytomater', 'snacktomater'], en: ['tomato', 'tomatoes'] },
  { key: 'hakkede_tomater', name: 'Flåede/hakkede tomater', cat: 'pantry',
    class: 'baseline', keeps: 'pantry', p: 1.2, kcal: 30, c: 4,
    da: ['hakkede tomater', 'flåede tomater', 'tomatkonserves', 'tomatkoncentrat', 'tomatpuré',
         'tomatpure', 'passata'],
    en: ['chopped tomatoes', 'plum tomatoes', 'tomato purée', 'tomato puree',
         'canned tomatoes', 'passata'] },
  { key: 'agurk', name: 'Agurk', cat: 'veg',
    class: 'fresh', keeps: 'perishable', p: 0.7, kcal: 15, c: 2, da: ['agurk'], en: ['cucumber'] },
  { key: 'peberfrugt', name: 'Peberfrugt', cat: 'veg',
    class: 'fresh', keeps: 'perishable', p: 1, kcal: 26, c: 5,
    da: ['peberfrugt', 'peberfrugter'], en: ['pepper', 'bell pepper', 'red pepper'] },
  { key: 'broccoli', name: 'Broccoli', cat: 'veg',
    class: 'fresh', keeps: 'perishable', p: 2.8, kcal: 34, c: 7, da: ['broccoli'], en: ['broccoli'] },
  { key: 'blomkaal', name: 'Blomkål', cat: 'veg',
    class: 'fresh', keeps: 'perishable', p: 1.9, kcal: 25, c: 5, da: ['blomkål'], en: ['cauliflower'] },
  { key: 'salat', name: 'Salat', cat: 'veg',
    class: 'fresh', keeps: 'perishable', p: 1.4, kcal: 15, c: 2,
    da: ['salat', 'icebergsalat', 'romainesalat', 'salatblanding', 'babyleaf'],
    en: ['lettuce', 'salad', 'rocket', 'mixed leaves', 'radicchio', 'iceberg'] },
  { key: 'spinat', name: 'Spinat', cat: 'veg',
    class: 'fresh', keeps: 'perishable', p: 2.9, kcal: 23, c: 1.5, da: ['spinat'], en: ['spinach'] },
  { key: 'champignon', name: 'Champignon', cat: 'veg',
    class: 'fresh', keeps: 'perishable', p: 3, kcal: 22, c: 3,
    da: ['champignon', 'kantareller', 'markchampignon', 'svampe'], en: ['mushroom', 'mushrooms'] },
  { key: 'squash', name: 'Squash', cat: 'veg',
    class: 'fresh', keeps: 'perishable', p: 1.2, kcal: 17, c: 3,
    da: ['squash', 'hokkaido græskar'], en: ['courgette', 'zucchini'] },
  { key: 'aubergine', name: 'Aubergine', cat: 'veg',
    class: 'fresh', keeps: 'perishable', p: 1, kcal: 25, c: 6, da: ['aubergine'], en: ['aubergine', 'eggplant'] },
  { key: 'porre', name: 'Porre', cat: 'veg',
    class: 'fresh', keeps: 'perishable', p: 1.5, kcal: 61, c: 14, da: ['porrer', 'porre'], en: ['leek', 'leeks'] },
  { key: 'selleri', name: 'Selleri', cat: 'veg',
    class: 'fresh', keeps: 'perishable', p: 0.7, kcal: 16, c: 2,
    // 'knoldselleri' er allerede dansk for selleriknold — 'celeriac' var den
    // engelske form, der manglede.
    da: ['bladselleri', 'knoldselleri', 'selleri'],
    en: ['celery', 'celery stick', 'celery sticks', 'celeriac'] },
  // Stod i STAPLE_KEYS, men købes: den bruges i portioner, ikke i teskefulde.
  { key: 'persille', name: 'Persille & krydderurter', cat: 'veg',
    class: 'fresh', keeps: 'perishable', p: 3, kcal: 36, c: 6,
    // 'sage' er sikkert som engelsk synonym: den engelske matchregel kræver
    // ordgrænse til venstre, så den ikke kaprer "sausage"/"grøntsager".
    //
    // 'rosmarin'/'timian'/'rosemary'/'thyme' (bar/frisk form) flyttet hertil fra
    // krydderi (opgave 8, fix-runde): frisk rosmarin/timian købes og visner som
    // salvie/estragon ved siden af — kun de TØRREDE former ('tørret rosmarin',
    // 'dried rosemary' osv.) hører hjemme i krydderi (essential, antages i
    // skabet). Det længere 'tørret ...'/'dried ...'-synonym vinder stadig i
    // krydderi, fordi det matcher tidligere/længere på samme position — se
    // krydderi-varens kommentar og lookup()-tjek i commit-beskeden.
    da: ['persille', 'dild', 'purløg', 'koriander', 'basilikum', 'krydderurter',
         'salvie', 'estragon', 'karse', 'rosmarin', 'frisk rosmarin', 'timian'],
    en: ['parsley', 'dill', 'chives', 'coriander', 'cilantro', 'basil leaves',
         'sage', 'tarragon', 'watercress', 'rosemary', 'thyme'] },
  // Stod i STAPLE_KEYS, men købes: den bruges i portioner, ikke i teskefulde.
  { key: 'ingefaer', name: 'Ingefær', cat: 'veg',
    class: 'fresh', keeps: 'keeps', p: 1.8, kcal: 80, c: 18,
    da: ['ingefær'], en: ['ginger'] },
  { key: 'kaal', name: 'Kål', cat: 'veg',
    class: 'baseline', keeps: 'keeps', p: 1.3, kcal: 25, c: 5,
    da: ['hvidkål', 'rødkål', 'spidskål', 'grønkål', 'kål'], en: ['cabbage', 'kale'] },
  { key: 'majs', name: 'Majs', cat: 'veg',
    class: 'fresh', keeps: 'perishable', p: 3.3, kcal: 86, c: 19,
    da: ['majskolbe', 'majs'], en: ['sweetcorn', 'corn'] },
  { key: 'aerter', name: 'Ærter', cat: 'veg',
    class: 'fresh', keeps: 'perishable', p: 5, kcal: 81, c: 14, da: ['ærter'], en: ['peas'] },
  { key: 'bonner', name: 'Bønner', cat: 'legume',
    class: 'baseline', keeps: 'pantry', p: 8, kcal: 130, c: 20,
    da: ['bønner', 'kidneybønner', 'sorte bønner', 'haricots verts'],
    // 'butter beans' er bønner, ikke smør – hele udtrykket skal stå her,
    // ellers vinder det korte 'butter'.
    en: ['butter beans', 'butterbeans', 'haricot beans', 'borlotti beans', 'cannellini beans',
         'kidney beans', 'black beans', 'green beans', 'beans'] },
  { key: 'kikaerter', name: 'Kikærter', cat: 'legume',
    class: 'baseline', keeps: 'pantry', p: 9, kcal: 160, c: 27,
    da: ['kikærter'], en: ['chickpeas'] },
  { key: 'linser', name: 'Linser', cat: 'legume',
    class: 'baseline', keeps: 'pantry', p: 9, kcal: 116, c: 20, da: ['linser'], en: ['lentils'] },
  { key: 'avocado', name: 'Avocado', cat: 'fruit',
    class: 'fresh', keeps: 'perishable', p: 2, kcal: 160, c: 2,
    da: ['avocado', 'guacamole'], en: ['avocado'] },
  // Rodfrugt ligesom kartofler: prisen står stille, og den holder i ugevis.
  { key: 'sodkartoffel', name: 'Sødkartoffel', cat: 'veg',
    class: 'baseline', keeps: 'keeps', p: 1.6, kcal: 86, c: 20,
    da: ['sødkartofler', 'sødkartoffel', 'sød kartoffel'], en: ['sweet potato', 'sweet potatoes'] },
  { key: 'asparges', name: 'Asparges', cat: 'veg',
    class: 'fresh', keeps: 'perishable', p: 2.2, kcal: 20, c: 4,
    da: ['asparges'], en: ['asparagus'], premium: true },

  // ── Frugt ─────────────────────────────────────────────────────────────────
  { key: 'banan', name: 'Bananer', cat: 'fruit',
    class: 'fresh', keeps: 'perishable', p: 1.1, kcal: 89, c: 23, da: ['bananer', 'banan'], en: ['banana', 'bananas'] },
  { key: 'aeble', name: 'Æbler', cat: 'fruit',
    class: 'fresh', keeps: 'perishable', p: 0.3, kcal: 52, c: 14, da: ['æbler', 'æble'], en: ['apple', 'apples'] },
  { key: 'citron', name: 'Citron', cat: 'fruit',
    class: 'fresh', keeps: 'perishable', p: 1, kcal: 29, c: 9,
    da: ['citron', 'citroner', 'lime'], en: ['lemon', 'lime', 'lemons'] },
  { key: 'appelsin', name: 'Appelsiner', cat: 'fruit',
    class: 'fresh', keeps: 'perishable', p: 0.9, kcal: 47, c: 12,
    da: ['appelsiner', 'appelsin', 'clementiner'], en: ['orange', 'oranges'] },
  { key: 'baer', name: 'Bær', cat: 'fruit',
    class: 'fresh', keeps: 'perishable', p: 1, kcal: 50, c: 8,
    da: ['jordbær', 'blåbær', 'hindbær', 'bær'], en: ['strawberries', 'blueberries', 'raspberries', 'berries'] },
  { key: 'druer', name: 'Druer', cat: 'fruit',
    class: 'fresh', keeps: 'perishable', p: 0.7, kcal: 69, c: 17, da: ['druer'], en: ['grapes'] },

  // ── Korn, pasta, ris ──────────────────────────────────────────────────────
  { key: 'pasta', name: 'Pasta', cat: 'grain',
    class: 'baseline', keeps: 'pantry', p: 12, kcal: 350, c: 71,
    da: ['pasta', 'spaghetti', 'penne', 'fusilli', 'lasagneplader', 'tagliatelle', 'orzo',
         'tortellini', 'pappardelle', 'macaroni', 'rigatoni'],
    en: ['egg noodles', 'rice noodles', 'noodles', 'lasagne sheets', 'orzo', 'linguine',
         'spaghetti', 'penne', 'tagliatelle', 'pasta'] },
  { key: 'ris', name: 'Ris', cat: 'grain',
    class: 'baseline', keeps: 'pantry', p: 7, kcal: 355, c: 78,
    da: ['ris', 'basmatiris', 'jasminris', 'risotto ris', 'grødris'],
    en: ['rice', 'basmati rice', 'risotto rice', 'arborio'] },
  { key: 'bulgur', name: 'Bulgur / couscous', cat: 'grain',
    class: 'baseline', keeps: 'pantry', p: 12, kcal: 340, c: 65,
    da: ['bulgur', 'couscous', 'quinoa'], en: ['bulgur', 'couscous', 'quinoa'] },
  { key: 'havregryn', name: 'Havregryn', cat: 'grain',
    class: 'baseline', keeps: 'pantry', p: 13, kcal: 370, c: 60,
    da: ['havregryn', 'havregrød'], en: ['oats', 'porridge oats', 'rolled oats'] },
  // 'durummel'/'semolina' og 'kokosmel' flyttet ud herfra (fix-runde) til
  // egne baseline-poster — se dem nedenfor. 'bagepulver'/'baking powder' er
  // almindeligt bagepulver og bliver på mel (essential), det er ikke en
  // specialvare.
  { key: 'mel', name: 'Mel', cat: 'pantry',
    class: 'essential', keeps: 'pantry', p: 10, kcal: 340, c: 72,
    da: ['majsstivelse', 'maizena', 'hvedemel', 'rugmel', 'mel', 'bagepulver'],
    en: ['cornflour', 'cornstarch', 'plain flour', 'flour', 'baking powder'] },
  { key: 'brod', name: 'Brød', cat: 'bakery',
    class: 'fresh', keeps: 'perishable', base_unit: 'stk', p: 8, kcal: 260, c: 45,
    da: ['rugbrød', 'brød', 'franskbrød', 'flute', 'boller', 'toastbrød'],
    en: ['bread', 'rye bread', 'baguette', 'buns', 'sourdough'] },
  { key: 'tortilla', name: 'Tortilla / wraps', cat: 'bakery',
    class: 'fresh', keeps: 'keeps', base_unit: 'stk', p: 8, kcal: 300, c: 50,
    da: ['tortilla', 'wraps', 'tortillas'], en: ['tortilla', 'wraps', 'tortillas'] },
  { key: 'rasp', name: 'Rasp', cat: 'pantry',
    class: 'essential', keeps: 'pantry', p: 11, kcal: 350, c: 70,
    da: ['rasp', 'pankorasp', 'panko'],
    en: ['breadcrumbs', 'panko breadcrumbs', 'panko', 'brioche crumbs'] },

  // ── Kolonial ──────────────────────────────────────────────────────────────
  { key: 'olie', name: 'Olie', cat: 'pantry',
    class: 'essential', keeps: 'pantry', base_unit: 'l', density_g_ml: 0.92, p: 0, kcal: 880, c: 0,
    // 'sesamolie' o.l. skal stå som sit eget synonym: ellers vinder det korte
    // 'sesam' i sesamfroe på position, og sesamolie bliver til sesamfrø.
    // 'kokosolie' flyttet ud herfra (fix-runde) til egen baseline-post:
    // specialolie, ikke noget der antages i skabet ligesom oliven-/rapsolie.
    da: ['olivenolie', 'rapsolie', 'solsikkeolie', 'sesamolie', 'olie'],
    en: ['olive oil', 'oil', 'vegetable oil', 'sesame oil', 'toasted sesame oil', 'baking spray'] },
  { key: 'eddike', name: 'Eddike', cat: 'pantry',
    class: 'essential', keeps: 'pantry', base_unit: 'l', density_g_ml: 1.01, p: 0, kcal: 20, c: 1,
    da: ['eddike', 'balsamico'],
    en: ['apple cider vinegar', 'rice wine vinegar', 'rice vinegar',
         'white wine vinegar', 'red wine vinegar', 'cider vinegar',
         'vinegar', 'balsamic'] },
  // 'glukosesirup'/'liquid glucose'/'glucose syrup', 'kokossukker' og
  // 'black treacle'/'mørk sirup' flyttet ud herfra (fix-runde) til egne
  // baseline-poster. 'brun farin'/'farin'/'flormelis' er almindelige danske
  // sukkerformer og bliver på sukker (essential) — det er ikke specialvarer.
  { key: 'sukker', name: 'Sukker', cat: 'pantry',
    class: 'essential', keeps: 'pantry', p: 0, kcal: 400, c: 100,
    da: ['sukker', 'brun farin', 'farin', 'flormelis'],
    en: ['sugar'] },
  // ── Specialvarer, der IKKE er "i skabet i forvejen" (fix-runde) ───────────
  // Samme mønster som ghee/lønnesirup: hver har sin egen pris og skal købes
  // specifikt, i modsætning til de almindelige former på sukker/mel/olie/
  // ketchup ovenfor, der reelt er husstandsstandard i Danmark.
  { key: 'sirup_moerk', name: 'Sirup (mørk)', cat: 'pantry', class: 'baseline', keeps: 'pantry',
    p: 0.5, kcal: 290, c: 72, da: ['mørk sirup'], en: ['black treacle', 'treacle'] },
  { key: 'glukosesirup', name: 'Glukosesirup', cat: 'pantry', class: 'baseline', keeps: 'pantry',
    p: 0, kcal: 320, c: 80, da: ['glukosesirup'], en: ['liquid glucose', 'glucose syrup'] },
  { key: 'durummel', name: 'Durummel / semulje', cat: 'pantry', class: 'baseline', keeps: 'pantry',
    p: 13, kcal: 350, c: 71, da: ['durummel'], en: ['semolina'] },
  { key: 'kokosmel', name: 'Kokosmel', cat: 'pantry', class: 'baseline', keeps: 'pantry',
    p: 20, kcal: 440, c: 20, da: ['kokosmel'], en: ['coconut flour'] },
  { key: 'kokosolie', name: 'Kokosolie', cat: 'pantry', class: 'baseline', keeps: 'pantry',
    base_unit: 'l', density_g_ml: 0.92, p: 0, kcal: 862, c: 0,
    da: ['kokosolie'], en: ['coconut oil'] },
  { key: 'kokossukker', name: 'Kokossukker', cat: 'pantry', class: 'baseline', keeps: 'pantry',
    p: 0, kcal: 375, c: 95, da: ['kokossukker'], en: ['coconut sugar'] },
  { key: 'salt', name: 'Salt', cat: 'pantry',
    class: 'essential', keeps: 'pantry', p: 0, kcal: 0, c: 0, da: ['salt'], en: ['salt'] },
  { key: 'peber', name: 'Peber', cat: 'pantry',
    class: 'essential', keeps: 'pantry', p: 0, kcal: 0, c: 0,
    // 'peppercorns' fanger alle farverne (black/pink/green/white/sichuan/...)
    // i ét ord — ingen grund til at stave hver variant ud.
    da: ['peber', 'sort peber'], en: ['pepper', 'black pepper', 'peppercorns'] },
  { key: 'bouillon', name: 'Bouillon', cat: 'pantry',
    class: 'essential', keeps: 'pantry', p: 0, kcal: 10, c: 1,
    // Sammensat skal fonden staves ud. Ellers vinder 'kylling' på position,
    // og en risotto bliver planlagt som en kyllingeret.
    da: ['kyllingefond', 'hønsefond', 'oksefond', 'kalvefond', 'fiskefond',
         'grøntsagsfond', 'hønsebouillon', 'oksebouillon', 'bouillon', 'fond'],
    en: ['stock', 'chicken stock', 'beef stock', 'broth'] },
  { key: 'kokosmaelk', name: 'Kokosmælk', cat: 'pantry',
    class: 'baseline', keeps: 'pantry', base_unit: 'l', density_g_ml: 1.0, p: 2, kcal: 200, c: 3,
    da: ['kokosmælk'], en: ['coconut milk'] },
  { key: 'ketchup', name: 'Ketchup / sauce', cat: 'pantry',
    class: 'essential', keeps: 'pantry', p: 1, kcal: 100, c: 20,
    // 'tabasco'/'sriracha'/'sambal oelek' flyttet ud herfra (fix-runde):
    // essential betyder "antages i skabet", og det gælder ikke chilisauce-
    // mærker på samme måde som ketchup/sennep/mayonnaise gør i et dansk
    // køkken. Se de tre nye poster nedenfor.
    da: ['tomat ketchup', 'tomatketchup', 'ketchup', 'remoulade', 'mayonnaise', 'dressing',
         'sennep', 'sauce'],
    en: ['tomato ketchup', 'ketchup', 'mayonnaise', 'mustard', 'dressing'] },
  { key: 'sriracha', name: 'Sriracha', cat: 'pantry', class: 'baseline', keeps: 'pantry',
    p: 2, kcal: 93, c: 19, da: ['sriracha'], en: ['sriracha'] },
  { key: 'sambal_oelek', name: 'Sambal oelek', cat: 'pantry', class: 'baseline', keeps: 'pantry',
    p: 1.5, kcal: 35, c: 6, da: ['sambal oelek'], en: ['sambal oelek'] },
  { key: 'tabasco', name: 'Tabasco', cat: 'pantry', class: 'baseline', keeps: 'pantry',
    p: 0.5, kcal: 12, c: 0.8, da: ['tabasco'], en: ['tabasco'] },
  { key: 'soja', name: 'Sojasauce', cat: 'pantry',
    class: 'essential', keeps: 'pantry', base_unit: 'l', density_g_ml: 1.2, p: 6, kcal: 60, c: 5,
    // Bar 'soja' manglede ved siden af 'sojasauce'/'soya' — 71 opskrifter
    // skriver bare "soja".
    da: ['sojasauce', 'soya', 'soja'],
    // 'tamari' skal kun stå som engelsk: det engelske matchregelsæt kræver
    // en ordgrænse til venstre, så det ikke kaprer "tamarind paste" (helt
    // andet råvare) via det fælles præfiks.
    en: ['soy sauce', 'soya sauce', 'tamari'] },
  { key: 'krydderi', name: 'Krydderier', cat: 'pantry',
    class: 'essential', keeps: 'pantry', p: 0, kcal: 0, c: 0,
    // De tørrede urter/krydderier under er blandt de hyppigste blokkere —
    // de findes typisk i skabet i forvejen, ligesom resten af krydderi-varen.
    //
    // Kun de TØRREDE former af rosmarin/timian står her — de friske/bare
    // former ('rosmarin', 'timian', 'rosemary', 'thyme') hører til på
    // persille-varen (fresh, købes) og blev flyttet dertil i en fix-runde.
    // Det længere 'tørret ...'/'dried ...'-synonym vinder stadig her, fordi
    // det matcher tidligere/længere på samme position end det bare ord i
    // persille — verificeret med lookup(), se commit-beskeden.
    //
    // 'cloves' (bar) TILFØJET i samme fix-runde: oprindeligt bevidst udeladt,
    // fordi ordet kan kapre "garlic cloves" (hvidløgsfed). Men det længere,
    // allerede registrerede 'garlic clove(s)' på hvidløg-varen vinder altid
    // over bar 'cloves' på samme position (længde slår ved lige exact-score),
    // så tilføjelsen er sikker — verificeret mod hele korpus, ingen eksisterende
    // hvidløg-match ændrer sig. De 16 opskrifter, der kun skriver "N cloves"
    // uden "garlic" i samme linje, har i 12 af 16 tilfælde en SEPARAT
    // "N garlic cloves"-linje i samme opskrift, hvilket viser at "N cloves"
    // alene er krydderiet (hele nelliker), ikke endnu en hvidløgsangivelse.
    da: ['krydderi', 'paprika', 'spidskommen', 'karry', 'oregano', 'basilikum', 'chili',
         'tørret rosmarin', 'tørret timian', 'laurbærblade',
         'stødt kanel', 'kanel', 'muskatnød', 'nellike', 'stødt nellike', 'allehånde'],
    en: ['cayenne pepper', 'chilli flakes', 'lemon thyme',
         'chillies', 'chilies', 'paprika', 'cumin', 'curry', 'oregano',
         'basil', 'chilli', 'chili', 'dried rosemary', 'dried thyme',
         'bay leaves', 'bay leaf', 'cinnamon', 'nutmeg',
         'ground cloves', 'cloves', 'allspice', 'caraway seeds', 'five spice', 'mixed herbs',
         'dried mixed herbs', 'mixed spice', "za'atar", 'za’atar',
         'cajun spice mix', 'cajun seasoning', 'mixed dried herbs', 'ground mace'] },
  { key: 'noedder', name: 'Nødder', cat: 'snack',
    class: 'baseline', keeps: 'pantry', p: 20, kcal: 600, c: 15,
    da: ['mandler', 'nødder', 'valnødder', 'cashewnødder', 'pistaciekerner', 'pistacienødder',
         'hasselnødder'],
    en: ['almonds', 'nuts', 'walnuts', 'cashews', 'peanuts', 'peanut butter', 'peanutbutter',
         'pistachios', 'hazelnuts'] },
  { key: 'safran', name: 'Safran', cat: 'pantry',
    class: 'baseline', keeps: 'pantry', p: 0, kcal: 0, c: 0,
    da: ['safran'], en: ['saffron'], premium: true },
  { key: 'troffel', name: 'Trøffel', cat: 'pantry',
    class: 'baseline', keeps: 'pantry', p: 0, kcal: 0, c: 0,
    da: ['trøffel', 'trøffelolie'], en: ['truffle', 'truffle oil'], premium: true },
  { key: 'sesamfroe', name: 'Sesamfrø', cat: 'pantry', class: 'baseline', keeps: 'pantry',
    // Ingen bar stamme ('sesam'/'sesame') her: dansk matcher orddele, og det
    // korte stammeord ville kapre 'sesamolie' fra 'olie' på position.
    p: 18, kcal: 570, c: 12,
    da: ['sesamfrø', 'sorte sesamfrø'], en: ['sesame seeds', 'sesame seed'] },
  { key: 'garam_masala', name: 'Garam masala', cat: 'pantry', class: 'baseline', keeps: 'pantry',
    p: 0, kcal: 380, c: 45,
    da: ['garam masala'], en: ['garam masala'] },
  { key: 'gurkemeje', name: 'Gurkemeje', cat: 'pantry', class: 'baseline', keeps: 'pantry',
    p: 0, kcal: 350, c: 65,
    da: ['stødt gurkemeje', 'gurkemeje'], en: ['ground turmeric', 'turmeric'] },
  { key: 'kardemomme', name: 'Kardemomme', cat: 'pantry', class: 'baseline', keeps: 'pantry',
    p: 0, kcal: 310, c: 68,
    da: ['stødt kardemomme', 'kardemomme'], en: ['ground cardamom', 'cardamom', 'cardamom pods'] },
  { key: 'gaer', name: 'Gær', cat: 'pantry', class: 'essential', keeps: 'pantry',
    // Gær stod slet ikke som vare — den bruges i teskefulde og står i skabet
    // ligesom resten af essential/pantry-gruppen.
    p: 37, kcal: 325, c: 41,
    da: ['tørgær', 'frisk gær', 'gær'], en: ['dried yeast', 'fresh yeast', 'yeast'] },

  // ── Drikkevarer & snacks ──────────────────────────────────────────────────
  { key: 'sodavand', name: 'Sodavand', cat: 'drink',
    class: 'baseline', keeps: 'pantry', p: 0, kcal: 40, c: 10,
    da: ['sodavand', 'cola', 'pepsi', 'faxe kondi', 'fanta', 'sprite'], en: ['soda', 'cola'] },
  { key: 'oel', name: 'Øl', cat: 'drink',
    class: 'baseline', keeps: 'pantry', p: 0, kcal: 43, c: 3.5, da: ['øl', 'pilsner'],
    // 'cider' fanger også 'dry cider': ordet står for sig selv med ordgrænse.
    // Kolliderer ikke med 'æblecidereddike'/'apple cider vinegar' — eddikes
    // egne (længere) synonymer vinder på position, og linjer, hvor 'cider'
    // sidder midt i et sammensat ord uden ordgrænse, giver exact=0.
    en: ['beer', 'lager', 'cider'] },
  { key: 'vin', name: 'Vin', cat: 'drink',
    class: 'baseline', keeps: 'pantry', p: 0, kcal: 83, c: 2.5,
    da: ['rødvin', 'hvidvin', 'lambrusco', 'prosecco', 'champagne', 'vin', 'rosé', 'vermouth',
         'noilly prat'],
    // 'sake' kun som engelsk: den strenge venstregraense forhindrer den i at
    // matche midt inde i et ord (fx "forsake" — ses ikke i korpus, men koster intet at sikre).
    en: ['red wine', 'white wine', 'prosecco', 'champagne', 'wine', 'vermouth', 'sake'] },
  { key: 'spiritus', name: 'Spiritus', cat: 'drink',
    class: 'baseline', keeps: 'pantry', p: 0, kcal: 250, c: 0,
    da: ['vodka', 'whisky', 'cognac', 'likør', 'snaps', 'spiritus'],
    en: ['vodka', 'whisky', 'whiskey', 'liqueur'] },
  { key: 'kaffe', name: 'Kaffe', cat: 'drink',
    class: 'baseline', keeps: 'pantry', p: 0, kcal: 0, c: 0,
    // "Lavazza hele bønner" er kaffe. Uden de sammensatte former ville
    // 'bønner' vinde, og en chili con carne ville blive planlagt om kaffe.
    da: ['kaffebønner', 'formalet kaffe', 'helbønner', 'hele bønner', 'kaffe'],
    en: ['coffee beans', 'coffee'] },
  { key: 'the', name: 'Te', cat: 'drink',
    class: 'baseline', keeps: 'pantry', p: 0, kcal: 0, c: 0, da: ['te'], en: ['tea'] },
  { key: 'juice', name: 'Juice', cat: 'drink',
    class: 'fresh', keeps: 'perishable', p: 0.5, kcal: 45, c: 10,
    // 'hyldeblomstsaft' fanger også 'koncentreret hyldeblomstsaft': ordet
    // står for sig selv med ordgrænse (adskilt af mellemrum), ikke sammensat.
    da: ['juice', 'appelsinjuice', 'æblejuice', 'most', 'hyldeblomstsaft'],
    en: ['juice', 'orange juice', 'elderflower cordial'] },
  { key: 'laeskedrik', name: 'Læskedrik', cat: 'drink',
    class: 'baseline', keeps: 'pantry', p: 0, kcal: 30, c: 7,
    da: ['læskedrik', 'energidrik', 'sportsdrik', 'iste', 'aloe vera', 'drik'],
    en: ['energy drink', 'iced tea'] },
  { key: 'vand', name: 'Vand', cat: 'drink',
    class: 'essential', keeps: 'pantry', p: 0, kcal: 0, c: 0,
    // Bar 'vand' manglede: 190 opskrifter med bare "vand" i ingredienslisten
    // matchede intet, selvom 'kildevand'/'danskvand' allerede var dækket.
    da: ['kildevand', 'danskvand', 'vand'],
    // 'ice' rammer ikke 'iceberg': engelsk kraever ren ordgraense til hoejre,
    // og 'berg' matcher hverken flertals-mønsteret eller en tom rest.
    en: ['water', 'sparkling water', 'ice', 'ice cubes'] },
  { key: 'chips', name: 'Chips', cat: 'snack',
    class: 'baseline', keeps: 'pantry', p: 6, kcal: 530, c: 50,
    da: ['chips', 'nachos'], en: ['crisps', 'chips', 'nachos'] },
  { key: 'chokolade', name: 'Chokolade & slik', cat: 'snack',
    class: 'baseline', keeps: 'pantry', p: 7, kcal: 540, c: 55,
    // marcipanbrød er konfekt, ikke brød – skal stå før 'brød' kan fange det
    da: ['marcipanbrød', 'marcipan', 'flødeboller', 'skildpadder', 'lakrids', 'chokolade', 'slik'],
    en: ['chocolate', 'candy', 'marzipan'] },
  { key: 'is', name: 'Is', cat: 'snack',
    class: 'baseline', keeps: 'pantry', p: 4, kcal: 200, c: 25, da: ['flødeis', 'is'], en: ['ice cream'] },
  { key: 'kiks', name: 'Kiks / kage', cat: 'snack',
    class: 'baseline', keeps: 'pantry', p: 6, kcal: 450, c: 65,
    da: ['flødekage', 'lagkage', 'kiks', 'kage', 'småkager'],
    en: ['biscuits', 'cookies', 'cake'] },

  // ── Færdigretter & diverse ────────────────────────────────────────────────
  { key: 'suppe', name: 'Suppe', cat: 'pantry',
    class: 'baseline', keeps: 'pantry', p: 2, kcal: 55, c: 5,
    da: ['specialsuppe', 'suppe', 'hønsekødssuppe', 'tomatsuppe'], en: ['soup'] },
  { key: 'honning', name: 'Honning', cat: 'pantry',
    class: 'essential', keeps: 'pantry', p: 0.3, kcal: 300, c: 80,
    da: ['honning'], en: ['honey'] },
  { key: 'frikadeller', name: 'Frikadeller', cat: 'meat',
    class: 'fresh', keeps: 'perishable', p: 15, kcal: 240, c: 8,
    da: ['frikadeller', 'kødboller', 'melboller'], en: ['meatballs'] },
  { key: 'pizza', name: 'Pizza', cat: 'grain',
    class: 'fresh', keeps: 'perishable', p: 10, kcal: 250, c: 30,
    da: ['pizza', 'pizzabund'], en: ['pizza'] },

  // ── Batch 2: de 20 hyppigste nye blokkere ─────────────────────────────────
  { key: 'foraarsloeg', name: 'Forårsløg', cat: 'veg', class: 'fresh', keeps: 'perishable',
    p: 2, kcal: 32, c: 6,
    da: ['stængler forårsløg', 'forårsløg'], en: ['spring onions', 'spring onion', 'scallions'] },
  { key: 'pinjekerner', name: 'Pinjekerner', cat: 'pantry', class: 'baseline', keeps: 'pantry',
    p: 14, kcal: 670, c: 13, da: ['pinjekerner'], en: ['pine nuts'] },
  { key: 'mynte', name: 'Mynte', cat: 'veg', class: 'fresh', keeps: 'perishable',
    p: 3, kcal: 44, c: 8, da: ['frisk mynte', 'mynte'], en: ['fresh mint', 'mint'] },
  { key: 'nudler', name: 'Nudler', cat: 'grain', class: 'baseline', keeps: 'pantry',
    p: 12, kcal: 350, c: 71,
    da: ['risnudler', 'æggenudler', 'nudler'], en: ['rice noodles', 'egg noodles', 'noodles'] },
  { key: 'kapers', name: 'Kapers', cat: 'pantry', class: 'baseline', keeps: 'pantry',
    p: 2, kcal: 23, c: 5, da: ['kapers'], en: ['capers'] },
  { key: 'aeggeblomme', name: 'Æggeblommer', cat: 'eggs', class: 'fresh', keeps: 'perishable',
    p: 16, kcal: 320, c: 4, da: ['æggeblommer', 'æggeblomme'], en: ['egg yolks', 'egg yolk'] },
  { key: 'ricotta', name: 'Ricotta', cat: 'cheese', class: 'fresh', keeps: 'perishable',
    p: 11, kcal: 174, c: 3, da: ['ricotta'], en: ['ricotta'] },
  { key: 'tahini', name: 'Tahin', cat: 'pantry', class: 'baseline', keeps: 'pantry',
    p: 17, kcal: 595, c: 21, da: ['tahin', 'tahini'], en: ['tahini'] },
  { key: 'halloumi', name: 'Halloumi', cat: 'cheese', class: 'fresh', keeps: 'keeps',
    p: 22, kcal: 320, c: 2, da: ['halloumi'], en: ['halloumi'] },
  { key: 'mango', name: 'Mango', cat: 'fruit', class: 'fresh', keeps: 'perishable',
    p: 1, kcal: 60, c: 15, da: ['mango'], en: ['mango', 'mangoes'] },
  { key: 'fennikelfroe', name: 'Fennikelfrø', cat: 'pantry', class: 'baseline', keeps: 'pantry',
    p: 16, kcal: 345, c: 52, da: ['fennikelfrø'], en: ['fennel seeds'] },
  { key: 'jalapeno', name: 'Jalapeños', cat: 'veg', class: 'fresh', keeps: 'keeps',
    p: 1, kcal: 29, c: 6, da: ['jalapenos', 'jalapeño', 'jalapeños'], en: ['jalapenos', 'jalapeño'] },
  { key: 'pesto', name: 'Pesto', cat: 'pantry', class: 'baseline', keeps: 'keeps',
    p: 5, kcal: 450, c: 6, da: ['pesto'], en: ['pesto'] },
  { key: 'roedbede', name: 'Rødbeder', cat: 'veg', class: 'fresh', keeps: 'keeps',
    p: 2, kcal: 43, c: 10, da: ['rødbeder', 'rødbede'], en: ['beetroot', 'beets'] },
  { key: 'cornichoner', name: 'Cornichoner', cat: 'pantry', class: 'baseline', keeps: 'pantry',
    p: 1, kcal: 15, c: 3, da: ['cornichoner', 'asier', 'syltede agurker'], en: ['cornichons', 'gherkins'] },
  { key: 'stjerneanis', name: 'Stjerneanis', cat: 'pantry', class: 'baseline', keeps: 'pantry',
    p: 18, kcal: 337, c: 50, da: ['stjerneanis'], en: ['star anise'] },
  { key: 'mirin', name: 'Mirin', cat: 'pantry', class: 'baseline', keeps: 'pantry',
    p: 0, kcal: 250, c: 43, da: ['mirin'], en: ['mirin'] },
  { key: 'burrata', name: 'Burrata', cat: 'cheese', class: 'fresh', keeps: 'perishable',
    p: 17, kcal: 330, c: 2, da: ['burrata'], en: ['burrata'] },
  { key: 'kaernemaelk', name: 'Kærnemælk', cat: 'dairy', class: 'fresh', keeps: 'perishable',
    p: 3, kcal: 37, c: 4, base_unit: 'l', da: ['kærnemælk'], en: ['buttermilk'] },

  // ── Batch 4: naeste lag nye varer ──────────────────────────────────────────
  // Specifikke sammensatte ord/fraser i stedet for bare stammer, hvor stammen
  // ville have kapret en anden vare (fx bar 'vanilje' ville tage
  // 'vaniljesukker' fra sukker-varen, bar 'kakao' ville tage 'kakaomælk').
  { key: 'vanilje', name: 'Vanilje', cat: 'pantry', class: 'baseline', keeps: 'pantry',
    p: 0.1, kcal: 288, c: 13,
    da: ['vaniljeekstrakt', 'vaniljestang', 'vaniljepasta', 'vaniljebønnepasta'],
    en: ['vanilla extract', 'vanilla bean paste', 'vanilla pod', 'vanilla paste'] },
  { key: 'kakao', name: 'Kakaopulver', cat: 'pantry', class: 'baseline', keeps: 'pantry',
    p: 20, kcal: 228, c: 58, da: ['kakaopulver'], en: ['cocoa powder'] },
  { key: 'chipotle', name: 'Chipotle', cat: 'pantry', class: 'baseline', keeps: 'pantry',
    p: 2, kcal: 150, c: 20, da: ['chipotle'], en: ['chipotle'] },
  { key: 'lonnesirup', name: 'Lønnesirup', cat: 'pantry', class: 'baseline', keeps: 'pantry',
    p: 0, kcal: 260, c: 67, da: ['lønnesirup', 'ahornsirup'], en: ['maple syrup'] },
  { key: 'sumak', name: 'Sumak', cat: 'pantry', class: 'baseline', keeps: 'pantry',
    p: 3, kcal: 300, c: 70, da: ['sumak'], en: ['sumac'] },
  // 'radise' (ental) fjernet (fix-runde): det matcher som orddel midt i
  // "grains of paradise" (pa|RADISE) med ren højregrænse, og korpus viser at
  // det er den ENESTE ting, det bare ord fanger — "grains of paradise" er en
  // helt anden vare (peberfrugt-krydderi), ikke radiser. 'radiser'/'radish'/
  // 'radishes' dækker alt det ægte.
  { key: 'radiser', name: 'Radiser', cat: 'veg', class: 'fresh', keeps: 'perishable',
    p: 0.7, kcal: 16, c: 3.4, da: ['radiser'], en: ['radishes', 'radish'] },
  { key: 'mascarpone', name: 'Mascarpone', cat: 'cheese', class: 'fresh', keeps: 'perishable',
    p: 5, kcal: 450, c: 4, da: ['mascarpone'], en: ['mascarpone'] },
  { key: 'nigella', name: 'Nigellafrø', cat: 'pantry', class: 'baseline', keeps: 'pantry',
    p: 16, kcal: 375, c: 33, da: ['nigellafrø'], en: ['nigella seeds'] },
  { key: 'gnocchi', name: 'Gnocchi', cat: 'grain', class: 'baseline', keeps: 'pantry',
    p: 2, kcal: 150, c: 31, da: ['gnocchi'], en: ['gnocchi'] },
  { key: 'fennikel', name: 'Fennikel', cat: 'veg', class: 'fresh', keeps: 'perishable',
    // 'fennikelfrø' er en anden vare (frø, ikke knold) og har forrang, fordi
    // dens synonym matcher hele ordet — se fennikelfroe.
    p: 1.2, kcal: 31, c: 7, da: ['fennikel'], en: ['fennel', 'fennel bulb'] },
  { key: 'kerner_froe', name: 'Kerner & frø', cat: 'pantry', class: 'baseline', keeps: 'pantry',
    p: 20, kcal: 550, c: 20,
    da: ['hampefrø', 'græskarkerner', 'solsikkekerner', 'chiafrø', 'kokosflager', 'hørfrø'],
    en: ['hemp seeds', 'pumpkin seeds', 'sunflower seeds', 'chia seeds', 'desiccated coconut',
         'fenugreek seeds', 'flaxseed', 'poppy seeds', 'mixed seeds'] },
  { key: 'gochujang', name: 'Gochujang', cat: 'pantry', class: 'baseline', keeps: 'pantry',
    p: 5, kcal: 170, c: 34, da: ['gochujang'], en: ['gochujang'] },
  { key: 'ansjoser', name: 'Ansjoser', cat: 'fish', class: 'baseline', keeps: 'pantry',
    p: 20, kcal: 130, c: 0,
    da: ['ansjoser', 'ansjosfileter'], en: ['anchovy fillets', 'anchovies', 'anchovy fillet', 'anchovy'] },
  { key: 'husblas', name: 'Husblas', cat: 'pantry', class: 'baseline', keeps: 'pantry',
    p: 85, kcal: 335, c: 0,
    da: ['husblas', 'blade husblas', 'blad husblas'],
    en: ['gelatine leaves', 'leaf gelatine', 'gelatin sheets', 'powdered gelatine'] },
  { key: 'ghee', name: 'Ghee', cat: 'pantry', class: 'baseline', keeps: 'pantry',
    p: 0, kcal: 900, c: 0, da: ['ghee'], en: ['ghee'] },
  { key: 'harissa', name: 'Harissa', cat: 'pantry', class: 'baseline', keeps: 'pantry',
    p: 3, kcal: 120, c: 10, da: ['harissa'], en: ['harissa'] },
  { key: 'gruyere', name: 'Gruyère', cat: 'cheese', class: 'fresh', keeps: 'perishable',
    p: 27, kcal: 410, c: 0.4, da: ['gruyère', 'gruyere'], en: ['gruyère', 'gruyere'] },
  { key: 'miso', name: 'Miso', cat: 'pantry', class: 'baseline', keeps: 'pantry',
    p: 12, kcal: 200, c: 25,
    da: ['misopasta', 'miso'], en: ['white miso', 'miso paste', 'miso'] },
  { key: 'oliven', name: 'Oliven', cat: 'pantry', class: 'baseline', keeps: 'pantry',
    p: 1, kcal: 145, c: 4,
    da: ['oliven', 'sorte oliven', 'grønne oliven'], en: ['olives', 'black olives', 'green olives'] },
  { key: 'boennespirer', name: 'Bønnespirer', cat: 'veg', class: 'fresh', keeps: 'perishable',
    p: 3, kcal: 30, c: 6,
    da: ['bønnespirer'], en: ['bean sprouts', 'beansprouts'] },
  { key: 'pak_choi', name: 'Pak choi', cat: 'veg', class: 'fresh', keeps: 'perishable',
    p: 1.5, kcal: 13, c: 2.2, da: ['pak choi'], en: ['pak choi'] },
  { key: 'aeggehvide', name: 'Æggehvider', cat: 'eggs', class: 'fresh', keeps: 'perishable',
    p: 11, kcal: 52, c: 0.7,
    da: ['æggehvider', 'æggehvide'], en: ['egg whites', 'egg white'] },
  { key: 'tamarind', name: 'Tamarind', cat: 'pantry', class: 'baseline', keeps: 'pantry',
    p: 2.8, kcal: 239, c: 62,
    da: ['tamarindpasta', 'tamarind'],
    en: ['tamarind paste', 'tamarind concentrate', 'tamarind pulp', 'tamarind'] },
  { key: 'granatæble', name: 'Granatæble', cat: 'fruit', class: 'fresh', keeps: 'perishable',
    p: 1.7, kcal: 83, c: 19, da: ['granatæblekerner'], en: ['pomegranate seeds'] },
  { key: 'rabarber', name: 'Rabarber', cat: 'fruit', class: 'fresh', keeps: 'perishable',
    p: 0.9, kcal: 21, c: 4.5, da: ['rabarber'], en: ['rhubarb'] },

  // ── Batch 5: sidste lag foer udbyttet falder ──────────────────────────────
  { key: 'jordskokker', name: 'Jordskokker', cat: 'veg', class: 'fresh', keeps: 'keeps',
    p: 2, kcal: 73, c: 17, da: ['jordskokker'], en: ['jerusalem artichokes'] },
  { key: 'paere', name: 'Pærer', cat: 'fruit', class: 'fresh', keeps: 'perishable',
    p: 0.4, kcal: 57, c: 15, da: ['pærer', 'pære'], en: ['pears', 'pear'] },
  { key: 'toerret_frugt', name: 'Tørret frugt', cat: 'pantry', class: 'baseline', keeps: 'pantry',
    // Tørret frugt er en pantry-vare, ikke fersk — den deler hverken class
    // eller keeps med bær/frugt-varerne, selvom den handler om samme råvare.
    p: 2, kcal: 300, c: 65,
    // 'dadler' fanger også 'dadler uden sten' og 'grofthakkede tørrede dadler':
    // ordet står for sig selv med ordgrænse i alle tre linjer i korpus.
    da: ['tørrede tranebær', 'tranebær', 'tørrede abrikoser', 'dadler', 'rosiner'],
    // 'coconut flakes' fanger også 'toasted coconut flakes' på samme måde —
    // ingen grund til begge. 'dates' fanger 'medjool dates' tilsvarende.
    en: ['dried cranberries', 'dried apricots', 'dried apricot', 'dates', 'raisins',
         'sultanas', 'mixed dried fruit', 'cranberries', 'coconut flakes'] },
  { key: 'kombu', name: 'Kombu', cat: 'pantry', class: 'baseline', keeps: 'pantry',
    p: 1, kcal: 43, c: 10, da: ['kombu'], en: ['kombu', 'dried kombu'] },
  { key: 'lard', name: 'Lard', cat: 'pantry', class: 'baseline', keeps: 'pantry',
    // Svinefedt/lardo holder som en pantry-vare, ligesom ghee — ikke som
    // smør, der er fersk. Kun engelsk-tagget: dansk tillader delmatch uden
    // ordgraense til hoejre, og det ville kapre "lardons" (baconterninger,
    // en helt anden vare) via det faelles praefiks.
    p: 0, kcal: 890, c: 0, da: [], en: ['lard', 'lardo'] },
  { key: 'krabbekoed', name: 'Krabbekød', cat: 'fish', class: 'fresh', keeps: 'perishable',
    p: 18, kcal: 90, c: 0, da: ['krabbekød'], en: ['crab meat', 'white crab meat', 'brown crab meat'] },
  { key: 'stenbiderrogn', name: 'Stenbiderrogn', cat: 'fish', class: 'fresh', keeps: 'perishable',
    p: 20, kcal: 130, c: 3, da: ['stenbiderrogn'], en: ['lumpfish roe'] },
  { key: 'ananas', name: 'Ananas', cat: 'fruit', class: 'fresh', keeps: 'perishable',
    p: 0.5, kcal: 50, c: 13, da: ['ananas'], en: ['pineapple'] },

  // ── Batch 6: udbyttet naermer sig graensen ────────────────────────────────
  { key: 'havbars', name: 'Havbars', cat: 'fish', class: 'fresh', keeps: 'perishable',
    p: 18, kcal: 97, c: 0,
    // Bar 'sea bass' fanger også 'sea bass fillets'/'sea bass heads' o.l.:
    // ordet står for sig selv med ordgrænse, uanset hvad der følger efter.
    da: ['havbars'], en: ['sea bass'] },
  // Marmite er IKKE lagt ind under gær (essential), selvom det er en
  // gærekstrakt-pålæg: det er et engelsk special-produkt, ikke noget et
  // dansk køkken har liggende i forvejen, modsat gær selv.
  { key: 'marmite', name: 'Marmite', cat: 'pantry', class: 'baseline', keeps: 'pantry',
    p: 30, kcal: 230, c: 20, da: [], en: ['marmite'] },
  // Chaat masala og gochugaru får egne poster, samme mønster som garam
  // masala/gochujang/harissa: specifikke, ikke-danske krydderiblandinger,
  // man skal ud og købe — modsat de almindelige krydderier i krydderi-varen.
  { key: 'chaat_masala', name: 'Chaat masala', cat: 'pantry', class: 'baseline', keeps: 'pantry',
    p: 0, kcal: 300, c: 55, da: ['chaat masala'], en: [] },
  { key: 'gochugaru', name: 'Gochugaru', cat: 'pantry', class: 'baseline', keeps: 'pantry',
    p: 12, kcal: 280, c: 55, da: ['gochugaru'], en: [] },
  // Stenfrugt samler kirsebær/blommer/ferskner/nektariner i én vare, samme
  // greb som bær-varen gør for jordbær/blåbær/hindbær: én pris for en hel
  // frugtfamilie, der prissættes ens.
  //
  // Bevidst UDELADT: bar 'cherry' (ental) og 'plum' (ental) — de ville kapre
  // "cherry tomatoes" og "plum tomato" (ental, uden det registrerede
  // 'plum tomatoes'-flertalssynonym) fra tomat-varerne, verificeret mod hele
  // korpus. Flertalsformerne 'cherries'/'plums' rammer ikke det problem.
  { key: 'stenfrugt', name: 'Stenfrugt', cat: 'fruit', class: 'fresh', keeps: 'perishable',
    p: 0.8, kcal: 50, c: 11,
    da: ['nektarin', 'kirsebær', 'blommer', 'fersken'],
    en: ['cherries', 'peaches', 'peach', 'plums', 'nectarines', 'nectarine'] },
  // Fortykningsmiddel samler agar agar/xanthan gum/ultratex: alle tre bruges
  // i knappenålshoved-mængder og prissættes ens, ligesom husblas.
  { key: 'fortykningsmiddel', name: 'Fortykningsmiddel', cat: 'pantry', class: 'baseline', keeps: 'pantry',
    p: 0, kcal: 0, c: 0,
    da: ['agar agar', 'agar-agar'], en: ['agar agar', 'xanthan gum', 'ultratex'] },

  // ── Fix-runde: flyttet ud af krydderi (essential) ─────────────────────────
  // Samme begrundelse som chaat_masala/gochugaru: specifikke, ikke-danske
  // krydderier, man skal ud og købe, ikke noget der antages i skabet.
  { key: 'wasabi', name: 'Wasabi', cat: 'pantry', class: 'baseline', keeps: 'pantry',
    p: 3, kcal: 109, c: 23, da: ['wasabi'], en: ['wasabi'] },
  // 'kaffirblade' og 'lime leaves' er samme vare (kaffirlimeblade) — samlet
  // her i stedet for at lade det danske og engelske navn splittes over to
  // forskellige poster/klasser, den fejl der blev fundet i rosmarin/timian.
  { key: 'kaffirblade', name: 'Kaffirlimeblade', cat: 'pantry', class: 'baseline', keeps: 'pantry',
    p: 3, kcal: 90, c: 15, da: ['kaffirblade'], en: ['lime leaves'] },
  { key: 'fenugreekblade', name: 'Tørrede bukkehornsblade', cat: 'pantry', class: 'baseline', keeps: 'pantry',
    p: 20, kcal: 320, c: 45, da: [], en: ['dried fenugreek leaves'] },

  // ── Non-food (skal aldrig ende i en madplan) ──────────────────────────────
  { key: 'toiletpapir', name: 'Toiletpapir', cat: 'nonfood',
    class: 'baseline', keeps: 'pantry',
    da: ['toiletpapir', 'køkkenrulle', 'husholdningspapir', 'papir'], en: [] },
  { key: 'elektronik', name: 'Elektronik', cat: 'nonfood',
    class: 'baseline', keeps: 'pantry',
    da: ['harddisk', 'hovedtelefoner', 'højttaler', 'oplader', 'tastatur',
         'trådløs mus', 'powerbank', 'smartwatch'], en: [] },
  { key: 'fest', name: 'Fest & pynt', cat: 'nonfood',
    class: 'baseline', keeps: 'pantry',
    da: ['gender reveal', 'babyshower', 'konfetti', 'balloner', 'servietter',
         'gavepapir', 'lyskæde'], en: [] },
  { key: 'rengoering', name: 'Rengøring', cat: 'nonfood',
    class: 'baseline', keeps: 'pantry',
    da: ['opvasketabs', 'vaskemiddel', 'rengøring', 'sæbe', 'skyllemiddel'], en: [] },
  { key: 'personlig_pleje', name: 'Personlig pleje', cat: 'nonfood',
    class: 'baseline', keeps: 'pantry',
    da: ['personlig pleje', 'shampoo', 'tandpasta', 'deodorant', 'bleer', 'hudpleje', 'hårpleje',
         'hudcreme', 'helsekost', 'kosttilskud', 'vitaminer', 'creme'], en: [] },
  { key: 'dyrefoder', name: 'Dyrefoder', cat: 'nonfood',
    class: 'baseline', keeps: 'pantry',
    da: ['fuglefoder', 'hundefoder', 'kattefoder', 'kattegrus'], en: [] },
];

// Selve opslaget (BY_KEY, SYNONYMS, lookup) er flyttet til src/lib/items.js
// og bygges nu af index() nedenfor, ud fra basen. NON_MEAL_CATS lever samme
// sted, fordi buildIndex() bruger den til isMealCapable.
const { buildIndex, NON_MEAL_CATS } = require('./items');
const { PIECE_G } = require('./units');

/**
 * Er teksten her engelsk?
 *
 * Opskriftskilderne er både danske og britiske, og de korte danske ord er
 * farlige i en engelsk sætning: "3 boneless and skinless chicken thighs"
 * blev til AND, fordi bindeordet står før hovedordet. Er teksten engelsk,
 * lukkes de korte danske synonymer ude.
 */
const EN_HINT = /(^|[^a-zæøå])(and|the|with|into|chopped|sliced|diced|finely|boneless|skinless|freshly|roughly|thinly|drained|deseeded|peeled|grated|halved|plus|about|handful|bunch|large|small|fresh|ground|cut)([^a-zæøå]|$)/i;
const DA_HINT = /[æøå]|(^|[^a-z])(og|eller|med|uden|frit|valg|hakket|dansk|danske|stk|pr|kg|gram)([^a-z]|$)/i;

function looksEnglish(text) {
  return EN_HINT.test(text) && !DA_HINT.test(text);
}

// ── Forarbejdede varer ───────────────────────────────────────────────────────

/**
 * Varen INDEHOLDER råvaren, men ER den ikke.
 *
 * "Rahbek indbagte rejer" er butterdej og rejesauce, ikke rejer, og
 * "kyllingenuggets" er ikke kyllingelår. Uden dette tjek ser madplanen dem
 * som råvaren på tilbud og lover en opskrift, tilbuddet ikke kan lave.
 *
 * De ryger ikke ud af basen – de har stadig en pris, en historik og en plads
 * i "Alle tilbud". De kan bare ikke længere gøre det ud for en råvare i en
 * opskrift.
 *
 * Afgrænsningen går ved, om varen kan bruges som den råvare, opskriften
 * beder om. Røget og gravad laks, marineret kyllingebryst og hakket kød er
 * derfor IKKE forarbejdede i denne forstand: de går direkte ind i en ret.
 */
const PREPARED_FORMS = [
  { key: 'paneret', label: 'paneret',
    re: /indbagt|paneret|panerede|panering|tempura|\bcrispy\b|golden crumb/ },
  { key: 'nuggets', label: 'nuggets o.l.',
    re: /nuggets?|dippers|pops(?![a-zæøå])|popcorn|fiskepinde|fish\s*(&|and)\s*chips|hotwings|chicken bucket/ },
  { key: 'faerdigboeffer', label: 'færdige bøffer',
    re: /burgerbøf|hakkebøf|karbonade|herregårdsbøf|sliders|burgerboost/ },
  { key: 'kebab', label: 'kebab/spyd',
    re: /kebab|gyros|shawarma|spyd(?![a-zæøå])/ },
  { key: 'faerdigret', label: 'færdigret',
    re: /færdigret|cordon bleu|pokebowl|poke bowl|biksemad|bami goreng|tikka masala|tandoori|lasagne(?!plader)|empanada|quesadilla|sushi|sashimi|pulled (pork|chicken|beef)|slow cooked|nøglehulsret|flødekartofler|rösti|rosti|pommes|nudler|yum yum|teriyaki|hapsermenu|menuboks/ },
  { key: 'blandet', label: 'blandet pakke',
    re: /kødpakke|grillpakke|bakkemarked|kyllingemarked|fiskemarked|kæmpepose|storkøb|marked(?![a-zæøå])|hapser|grillmarked|blandet bakke/ },
  { key: 'tilbehoer', label: 'tilbehør',
    re: /kraftsky|(^|[^a-zæøå])sky(?![a-zæøå])|topping|pålægssalat|snacks?(?![a-zæøå])|flæskesvær/ },
];

/**
 * Hvilken forarbejdet form er varen – hvis nogen? Returnerer `null` for
 * almindelige råvarer.
 */
function preparedForm(text) {
  if (!text) return null;
  const hay = String(text).toLowerCase();
  for (const f of PREPARED_FORMS) if (f.re.test(hay)) return f;
  return null;
}

/**
 * Ligner denne ingredienslinje en hovedråvare, taksonomien ikke kendte?
 *
 * Madplanen lover, at rettens hovedråvare er på tilbud. Det løfte kan kun
 * holdes for råvarer, vi kan genkende: en opskrift med "750 g lammebov" ser
 * uden dette tjek ud som en vegetarret, og så ville planen blive bygget op
 * om kartoflerne ved siden af – og love et tilbud på et lam, den aldrig har
 * kigget efter.
 *
 * Retter, der rammes af dette, udelades hellere end at blive lovet forkert.
 * Listen er derfor kød- og fiske-ord, der IKKE allerede har en varetype.
 */
const MAIN_HINT = new RegExp(
  '(^|[^a-zæøå])(' + [
    // dansk
    'lamme', 'okse', 'svine', 'kalve', 'kyllinge', 'kalkun', 'andebryst', 'andelår',
    'ribbenssteg', 'ribbensteg', 'mørbrad', 'schnitzel', 'kotelet', 'culotte',
    'spareribs', 'kæber', 'skank', 'lever', 'fiskefars', 'kødet af',
    // engelsk
    'pork', 'beef', 'chicken', 'lamb', 'turkey', 'duck', 'venison', 'veal', 'mutton',
    'prawn', 'shrimp', 'salmon', 'haddock', 'mackerel', 'tuna', 'squid', 'octopus',
    'crab', 'lobster', 'scallop', 'mussel', 'oyster', 'anchov',
    'chorizo', 'pancetta', 'salami', 'brisket', 'mince', 'steak', 'sausage',
  ].join('|') + ')', 'i'
);

function hintsAtMainIngredient(text) {
  return !!text && MAIN_HINT.test(String(text));
}

/**
 * Indekset bygges én gang pr. proces, ud fra basen.
 *
 * Falder tilbage til seed-arrayet, når tabellen endnu ikke findes eller er
 * tom — så kan scripts køre på en frisk base, før seed-scriptet har kørt.
 *
 * Bemærk at fallbacket IKKE undgår databasen: getDb() åbner og migrerer
 * filen først, og først derefter opdager vi, at `items` er tom.
 *
 * Enhver anden fejl kastes videre. Et bart `catch {}` her ville gøre "basen
 * er låst", "schema.sql fejler" og "alt er fint" til samme udfald — og
 * resten af processen kalder getDb() og fejler alligevel, så taksonomien
 * ville stille og roligt være uenig med sin egen proces.
 */
let _index = null;
let _warned = false;

function index() {
  if (_index) return _index;
  try {
    const { getDb } = require('../db');
    const db = getDb();
    const items = db.prepare('SELECT * FROM items').all();
    if (items.length) {
      const syns = db.prepare('SELECT item_key, lang, text FROM item_synonyms').all();
      _index = buildIndex(items, syns);
      return _index;
    }
    if (!_warned) {
      _warned = true;
      console.warn('taxonomy: items er tom – bruger seed-data. Kør `npm run seed:items`.');
    }
  } catch (err) {
    if (!/no such table: items/.test(err.message)) throw err;
  }

  _index = buildIndex(
    SEED.map((e) => ({
      key: e.key, name: e.name, category: e.cat, class: e.class, keeps: e.keeps,
      base_unit: e.base_unit || 'kg', piece_g: PIECE_G[e.key] ?? null,
      density_g_ml: e.density_g_ml ?? null,
      protein_per_100g: e.p ?? null, kcal_per_100g: e.kcal ?? null,
      // 0/1 og ikke true/false: SQLite har ingen boolean, og de to veje skal
      // levere samme type, ellers virker et fremtidigt `=== 1` kun på den ene.
      carbs_per_100g: e.c ?? null,
      premium: e.premium ? 1 : 0, fat_grades: e.fatGrades ? 1 : 0,
    })),
    SEED.flatMap((e) => [
      ...(e.da || []).map((t) => ({ item_key: e.key, lang: 'da', text: t })),
      ...(e.en || []).map((t) => ({ item_key: e.key, lang: 'en', text: t })),
    ]),
  );
  return _index;
}

/** Tømmer memoiseringen. Kun til brug efter seed-scriptet har skrevet. */
function reload() { _index = null; }

module.exports = {
  SEED, PREPARED_FORMS, NON_MEAL_CATS, reload,
  get:           (k) => index().get(k),
  lookup:        (t) => index().lookup(t),
  all:           ()  => index().all(),
  isEssential:   (k) => index().isEssential(k),
  isPremium:     (k) => index().isPremium(k),
  isNonFood:     (k) => index().isNonFood(k),
  isMealCapable: (k) => index().isMealCapable(k),
  looksEnglish,
  hintsAtMainIngredient,
  preparedForm,
};
