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
 */

// cat: poultry | meat | fish | dairy | cheese | eggs | veg | fruit | grain
//      | legume | pantry | bakery | drink | snack | nonfood
const TAXONOMY = [
  // ── Fjerkræ ───────────────────────────────────────────────────────────────
  { key: 'kyllingebryst', name: 'Kyllingebryst', cat: 'poultry', p: 23, kcal: 110, c: 0,
    da: ['kyllingebrystfilet', 'kyllingebryst', 'kyllingefilet', 'kyllinge inderfilet',
         'kyllingeinderfilet', 'brystfilet'],
    en: ['chicken breast', 'chicken fillet', 'chicken breasts'] },
  { key: 'kyllingelaar', name: 'Kyllingelår', cat: 'poultry', p: 19, kcal: 145, c: 0,
    da: ['kyllingeoverlår', 'kyllingelår', 'kyllingeunderlår', 'kyllingekøller'],
    en: ['chicken thigh', 'chicken thighs', 'chicken drumstick', 'chicken legs'] },
  { key: 'hel_kylling', name: 'Hel kylling', cat: 'poultry', p: 20, kcal: 160, c: 0,
    da: ['hel kylling', 'grillkylling', 'kylling hel'], en: ['whole chicken', 'roast chicken'] },
  { key: 'kylling', name: 'Kylling', cat: 'poultry', p: 21, kcal: 130, c: 0,
    // 'majskylling' skal stå for sig: ellers vinder 'majs' på position, og
    // en fransk majskylling bliver til en majskolbe.
    da: ['majskylling', 'kyllingekød', 'kylling'], en: ['chicken'] },
  { key: 'hakket_kylling', name: 'Hakket kyllingekød', cat: 'poultry', p: 20, kcal: 125, c: 0, fatGrades: true,
    da: ['hakket kylling', 'hakket kyllingekød'], en: ['minced chicken', 'ground chicken'] },
  { key: 'kalkun', name: 'Kalkun', cat: 'poultry', p: 24, kcal: 115, c: 0, fatGrades: true,
    // Kalkunudskæringerne skal stå for sig: ellers vinder det korte
    // 'brystfilet' som helt ord over 'kalkun' som orddel.
    da: ['kalkunbrystfilet', 'kalkunstrimler', 'kalkunschnitzel', 'kalkunoverlår',
         'kalkununderlår', 'kalkunfilet', 'kalkunbryst', 'hakket kalkun', 'kalkun'],
    en: ['turkey breast', 'turkey'] },
  { key: 'and', name: 'And', cat: 'poultry', p: 18, kcal: 200, c: 0,
    da: ['andebryst', 'andelår', 'and'], en: ['duck', 'duck breast'], premium: true },

  // ── Kød ───────────────────────────────────────────────────────────────────
  { key: 'hakket_oksekoed', name: 'Hakket oksekød', cat: 'meat', p: 20, kcal: 175, c: 0, fatGrades: true,
    da: ['hakket oksekød', 'hakket okse', 'oksefars', 'hakket kalv og flæsk', 'hakket kalv & flæsk'],
    en: ['minced beef', 'ground beef', 'beef mince'] },
  { key: 'hakket_svinekoed', name: 'Hakket svinekød', cat: 'meat', p: 18, kcal: 220, c: 0, fatGrades: true,
    da: ['hakket svinekød', 'hakket grisekød', 'svinefars', 'hakket flæsk', 'grisekød'],
    en: ['minced pork', 'ground pork', 'pork mince'] },
  { key: 'oksemoerbrad', name: 'Oksemørbrad', cat: 'meat', p: 21, kcal: 145, c: 0,
    da: ['oksemørbrad', 'oksefilet', 'oksehøjreb'], en: ['beef tenderloin', 'fillet of beef'], premium: true },
  { key: 'boef', name: 'Bøf / steak', cat: 'meat', p: 22, kcal: 190, c: 0,
    da: ['ribeye', 'entrecote', 'culotte', 'tournedos', 'flanksteak', 'bøf'],
    en: ['ribeye', 'sirloin', 'steak', 'entrecote'], premium: true },
  { key: 'oksekoed', name: 'Oksekød', cat: 'meat', p: 21, kcal: 180, c: 0,
    da: ['tykstegsfilet', 'oksekød', 'okseklump', 'oksetykkam', 'oksebov',
         'okseinderlår', 'okseyderlår', 'oksespidsbryst', 'oksebryst'],
    en: ['beef', 'brisket'] },
  { key: 'svinemoerbrad', name: 'Svinemørbrad', cat: 'meat', p: 21, kcal: 140, c: 0,
    da: ['svinemørbrad', 'svinefilet', 'mørbrad'], en: ['pork tenderloin', 'pork fillet'] },
  { key: 'flaeskesteg', name: 'Flæskesteg', cat: 'meat', p: 20, kcal: 260, c: 0,
    da: ['flæskesteg', 'svinekam', 'nakkefilet', 'nakkekam', 'ribbensteg', 'ribbenssteg',
         'spareribs', 'stegeflæsk', 'flæsk i skiver', 'svinekæber', 'svineskank'],
    en: ['pork roast', 'pork loin', 'pork shoulder', 'pork belly', 'pulled pork'] },
  { key: 'svinekoteletter', name: 'Svinekoteletter', cat: 'meat', p: 21, kcal: 200, c: 0,
    da: ['svinekoteletter', 'koteletter', 'nakkekoteletter'], en: ['pork chops', 'chops'] },
  { key: 'bacon', name: 'Bacon', cat: 'meat', p: 13, kcal: 400, c: 1,
    da: ['bacon', 'baconskiver', 'bacon i tern'], en: ['bacon', 'pancetta', 'streaky bacon'] },
  { key: 'lam', name: 'Lammekød', cat: 'meat', p: 20, kcal: 230, c: 0,
    da: ['lammekølle', 'lammekød', 'lammekoteletter', 'lammefilet',
         'lammekrone', 'lammebov', 'lammehals', 'lammeskank'],
    en: ['lamb', 'rack of lamb', 'leg of lamb'], premium: true },
  { key: 'kalvekoed', name: 'Kalvekød', cat: 'meat', p: 21, kcal: 150, c: 0,
    da: ['kalveculotte', 'kalvekød', 'kalvefilet', 'kalvetykkam', 'kalveschnitzel'],
    en: ['veal'], premium: true },
  { key: 'poelser', name: 'Pølser', cat: 'meat', p: 12, kcal: 290, c: 3,
    da: ['grillpølser', 'medisterpølse', 'pølser', 'wienerpølser', 'chorizo'],
    en: ['sausages', 'chorizo', 'sausage'] },
  { key: 'paalaeg', name: 'Pålæg', cat: 'meat', p: 16, kcal: 200, c: 2,
    da: ['baconleverpostej', 'kyllingeleverpostej', 'baconpostej', 'leverpostej',
         'pålæg', 'spegepølse', 'skinke i skiver', 'rullepølse'],
    en: ['cold cuts', 'ham', 'salami', 'prosciutto'] },
  { key: 'skinke', name: 'Skinke', cat: 'meat', p: 21, kcal: 145, c: 1,
    da: ['skinke', 'skinkeschnitzel'], en: ['ham', 'gammon'] },

  // ── Fisk & skaldyr ────────────────────────────────────────────────────────
  { key: 'laks', name: 'Laks', cat: 'fish', p: 20, kcal: 200, c: 0,
    da: ['laksefilet', 'laks', 'røget laks', 'koldrøget laks', 'varmrøget laks'],
    en: ['salmon', 'smoked salmon', 'salmon fillet'] },
  { key: 'torsk', name: 'Torsk', cat: 'fish', p: 18, kcal: 82, c: 0,
    da: ['torskefilet', 'torsk'], en: ['cod', 'cod fillet'] },
  { key: 'rejer', name: 'Rejer', cat: 'fish', p: 20, kcal: 100, c: 0,
    da: ['rejer', 'kæmperejer', 'tigerrejer'], en: ['prawns', 'shrimp', 'king prawns'] },
  { key: 'tun', name: 'Tun', cat: 'fish', p: 24, kcal: 115, c: 0,
    da: ['tunsteak', 'tunbøf', 'tun i vand', 'tun i olie', 'tun'],
    en: ['tuna steak', 'tuna'] },
  { key: 'fiskefars', name: 'Fiskefars', cat: 'fish', p: 12, kcal: 130, c: 6,
    da: ['laksefars', 'torskefars', 'fiskefars', 'fiskefrikadeller'], en: ['fish cakes'] },
  { key: 'rodspaette', name: 'Rødspætte', cat: 'fish', p: 17, kcal: 90, c: 0,
    da: ['rødspættefilet', 'rødspætte', 'fiskefilet'], en: ['plaice', 'white fish'] },
  { key: 'sild', name: 'Sild', cat: 'fish', p: 18, kcal: 160, c: 3,
    da: ['sild', 'marinerede sild'], en: ['herring'] },
  { key: 'makrel', name: 'Makrel', cat: 'fish', p: 19, kcal: 205, c: 0,
    da: ['makrel', 'makrel i tomat'], en: ['mackerel'] },
  { key: 'muslinger', name: 'Muslinger', cat: 'fish', p: 12, kcal: 86, c: 4,
    da: ['blåmuslinger', 'muslinger'], en: ['mussels', 'clams'] },
  { key: 'kammuslinger', name: 'Kammuslinger', cat: 'fish', p: 17, kcal: 90, c: 3,
    da: ['kammuslinger', 'jomfruhummer'], en: ['scallops', 'langoustine'], premium: true },

  // ── Mejeri ────────────────────────────────────────────────────────────────
  { key: 'skyr', name: 'Skyr', cat: 'dairy', p: 11, kcal: 63, c: 4,
    da: ['skyr'], en: ['skyr'] },
  { key: 'ymer', name: 'Ymer', cat: 'dairy', p: 6, kcal: 75, c: 5, da: ['ymer', 'tykmælk'], en: [] },
  { key: 'yoghurt', name: 'Yoghurt', cat: 'dairy', p: 5, kcal: 70, c: 5,
    da: ['yoghurt', 'græsk yoghurt', 'youghurt', 'a38'], en: ['yogurt', 'yoghurt', 'greek yogurt'] },
  { key: 'maelk', name: 'Mælk', cat: 'dairy', p: 3.5, kcal: 46, c: 4.7,
    da: ['minimælk', 'letmælk', 'sødmælk', 'skummetmælk', 'plantedrik', 'havredrik',
         'sojadrik', 'mandeldrik', 'mælk'],
    en: ['oat milk', 'soy milk', 'almond milk', 'whole milk', 'milk'] },
  { key: 'floede', name: 'Fløde', cat: 'dairy', p: 2, kcal: 340, c: 3,
    da: ['piskefløde', 'madlavningsfløde', 'fløde', 'kaffefløde'],
    en: ['cream', 'double cream', 'heavy cream', 'single cream'] },
  { key: 'creme_fraiche', name: 'Creme fraiche', cat: 'dairy', p: 3, kcal: 200, c: 3.5,
    da: ['creme fraiche', 'cremefraiche', 'æblemost creme'], en: ['creme fraiche', 'soured cream', 'sour cream'] },
  { key: 'smoer', name: 'Smør', cat: 'dairy', p: 0.5, kcal: 740, c: 0.6,
    da: ['smør', 'kærgården', 'smørbar'], en: ['butter'] },
  { key: 'ost', name: 'Ost', cat: 'cheese', p: 25, kcal: 350, c: 1,
    da: ['revet ost', 'skæreost', 'ostehaps', 'jarlsberg', 'myseost', 'danbo', 'havarti', 'cheddar', 'ost'],
    en: ['cheese', 'cheddar'] },
  { key: 'flodeost', name: 'Flødeost', cat: 'cheese', p: 6, kcal: 250, c: 4,
    da: ['flødeost', 'friskost', 'philadelphia', 'buko'], en: ['cream cheese'] },
  { key: 'mozzarella', name: 'Mozzarella', cat: 'cheese', p: 18, kcal: 250, c: 2,
    da: ['mozzarella'], en: ['mozzarella'] },
  { key: 'feta', name: 'Feta', cat: 'cheese', p: 14, kcal: 265, c: 1.5,
    da: ['feta', 'salatost'], en: ['feta'] },
  { key: 'parmesan', name: 'Parmesan', cat: 'cheese', p: 33, kcal: 400, c: 0,
    da: ['parmesan', 'grana padano'], en: ['parmesan', 'parmigiano', 'pecorino'], premium: true },
  { key: 'hytteost', name: 'Hytteost', cat: 'dairy', p: 12, kcal: 100, c: 3,
    da: ['hytteost'], en: ['cottage cheese'] },
  { key: 'aeg', name: 'Æg', cat: 'eggs', p: 13, kcal: 145, c: 0.6,
    da: ['æg', 'økologiske æg', 'frilandsæg'], en: ['egg', 'eggs'] },

  // ── Grønt ─────────────────────────────────────────────────────────────────
  { key: 'kartofler', name: 'Kartofler', cat: 'veg', p: 2, kcal: 77, c: 17,
    da: ['kartofler', 'bagekartofler', 'nye kartofler'], en: ['potatoes', 'potato'] },
  { key: 'loeg', name: 'Løg', cat: 'veg', p: 1.1, kcal: 40, c: 9,
    da: ['løg', 'rødløg', 'skalotteløg', 'zittauerløg'], en: ['onion', 'onions', 'shallot', 'red onion'] },
  { key: 'hvidloeg', name: 'Hvidløg', cat: 'veg', p: 6, kcal: 149, c: 33,
    da: ['hvidløg'], en: ['garlic', 'garlic clove', 'garlic cloves'] },
  { key: 'gulerod', name: 'Gulerødder', cat: 'veg', p: 0.9, kcal: 41, c: 8,
    da: ['gulerødder', 'gulerod'], en: ['carrot', 'carrots'] },
  { key: 'tomat', name: 'Tomater', cat: 'veg', p: 0.9, kcal: 18, c: 3.5,
    da: ['tomater', 'tomat', 'cherrytomater', 'snacktomater'], en: ['tomato', 'tomatoes'] },
  { key: 'hakkede_tomater', name: 'Flåede/hakkede tomater', cat: 'pantry', p: 1.2, kcal: 30, c: 4,
    da: ['hakkede tomater', 'flåede tomater', 'tomatkonserves', 'tomatkoncentrat', 'tomatpuré',
         'tomatpure', 'passata'],
    en: ['chopped tomatoes', 'plum tomatoes', 'tomato purée', 'tomato puree',
         'canned tomatoes', 'passata'] },
  { key: 'agurk', name: 'Agurk', cat: 'veg', p: 0.7, kcal: 15, c: 2, da: ['agurk'], en: ['cucumber'] },
  { key: 'peberfrugt', name: 'Peberfrugt', cat: 'veg', p: 1, kcal: 26, c: 5,
    da: ['peberfrugt', 'peberfrugter'], en: ['pepper', 'bell pepper', 'red pepper'] },
  { key: 'broccoli', name: 'Broccoli', cat: 'veg', p: 2.8, kcal: 34, c: 7, da: ['broccoli'], en: ['broccoli'] },
  { key: 'blomkaal', name: 'Blomkål', cat: 'veg', p: 1.9, kcal: 25, c: 5, da: ['blomkål'], en: ['cauliflower'] },
  { key: 'salat', name: 'Salat', cat: 'veg', p: 1.4, kcal: 15, c: 2,
    da: ['salat', 'icebergsalat', 'romainesalat', 'salatblanding', 'babyleaf'],
    en: ['lettuce', 'salad', 'rocket', 'mixed leaves'] },
  { key: 'spinat', name: 'Spinat', cat: 'veg', p: 2.9, kcal: 23, c: 1.5, da: ['spinat'], en: ['spinach'] },
  { key: 'champignon', name: 'Champignon', cat: 'veg', p: 3, kcal: 22, c: 3,
    da: ['champignon', 'kantareller', 'markchampignon', 'svampe'], en: ['mushroom', 'mushrooms'] },
  { key: 'squash', name: 'Squash', cat: 'veg', p: 1.2, kcal: 17, c: 3, da: ['squash'], en: ['courgette', 'zucchini'] },
  { key: 'aubergine', name: 'Aubergine', cat: 'veg', p: 1, kcal: 25, c: 6, da: ['aubergine'], en: ['aubergine', 'eggplant'] },
  { key: 'porre', name: 'Porre', cat: 'veg', p: 1.5, kcal: 61, c: 14, da: ['porrer', 'porre'], en: ['leek', 'leeks'] },
  { key: 'selleri', name: 'Selleri', cat: 'veg', p: 0.7, kcal: 16, c: 2,
    da: ['bladselleri', 'knoldselleri', 'selleri'], en: ['celery', 'celery stick', 'celery sticks'] },
  { key: 'persille', name: 'Persille & krydderurter', cat: 'veg', p: 3, kcal: 36, c: 6,
    da: ['persille', 'dild', 'purløg', 'koriander', 'basilikum', 'krydderurter'],
    en: ['parsley', 'dill', 'chives', 'coriander', 'cilantro', 'basil leaves'] },
  { key: 'ingefaer', name: 'Ingefær', cat: 'veg', p: 1.8, kcal: 80, c: 18,
    da: ['ingefær'], en: ['ginger'] },
  { key: 'kaal', name: 'Kål', cat: 'veg', p: 1.3, kcal: 25, c: 5,
    da: ['hvidkål', 'rødkål', 'spidskål', 'grønkål', 'kål'], en: ['cabbage', 'kale'] },
  { key: 'majs', name: 'Majs', cat: 'veg', p: 3.3, kcal: 86, c: 19,
    da: ['majskolbe', 'majs'], en: ['sweetcorn', 'corn'] },
  { key: 'aerter', name: 'Ærter', cat: 'veg', p: 5, kcal: 81, c: 14, da: ['ærter'], en: ['peas'] },
  { key: 'bonner', name: 'Bønner', cat: 'legume', p: 8, kcal: 130, c: 20,
    da: ['bønner', 'kidneybønner', 'sorte bønner', 'haricots verts'],
    // 'butter beans' er bønner, ikke smør – hele udtrykket skal stå her,
    // ellers vinder det korte 'butter'.
    en: ['butter beans', 'haricot beans', 'borlotti beans', 'cannellini beans',
         'kidney beans', 'black beans', 'green beans', 'beans'] },
  { key: 'kikaerter', name: 'Kikærter', cat: 'legume', p: 9, kcal: 160, c: 27,
    da: ['kikærter'], en: ['chickpeas'] },
  { key: 'linser', name: 'Linser', cat: 'legume', p: 9, kcal: 116, c: 20, da: ['linser'], en: ['lentils'] },
  { key: 'avocado', name: 'Avocado', cat: 'fruit', p: 2, kcal: 160, c: 2, da: ['avocado'], en: ['avocado'] },
  { key: 'sodkartoffel', name: 'Sødkartoffel', cat: 'veg', p: 1.6, kcal: 86, c: 20,
    da: ['sødkartofler', 'sødkartoffel'], en: ['sweet potato', 'sweet potatoes'] },
  { key: 'asparges', name: 'Asparges', cat: 'veg', p: 2.2, kcal: 20, c: 4,
    da: ['asparges'], en: ['asparagus'], premium: true },

  // ── Frugt ─────────────────────────────────────────────────────────────────
  { key: 'banan', name: 'Bananer', cat: 'fruit', p: 1.1, kcal: 89, c: 23, da: ['bananer', 'banan'], en: ['banana', 'bananas'] },
  { key: 'aeble', name: 'Æbler', cat: 'fruit', p: 0.3, kcal: 52, c: 14, da: ['æbler', 'æble'], en: ['apple', 'apples'] },
  { key: 'citron', name: 'Citron', cat: 'fruit', p: 1, kcal: 29, c: 9,
    da: ['citron', 'citroner', 'lime'], en: ['lemon', 'lime', 'lemons'] },
  { key: 'appelsin', name: 'Appelsiner', cat: 'fruit', p: 0.9, kcal: 47, c: 12,
    da: ['appelsiner', 'appelsin', 'clementiner'], en: ['orange', 'oranges'] },
  { key: 'baer', name: 'Bær', cat: 'fruit', p: 1, kcal: 50, c: 8,
    da: ['jordbær', 'blåbær', 'hindbær', 'bær'], en: ['strawberries', 'blueberries', 'raspberries', 'berries'] },
  { key: 'druer', name: 'Druer', cat: 'fruit', p: 0.7, kcal: 69, c: 17, da: ['druer'], en: ['grapes'] },

  // ── Korn, pasta, ris ──────────────────────────────────────────────────────
  { key: 'pasta', name: 'Pasta', cat: 'grain', p: 12, kcal: 350, c: 71,
    da: ['pasta', 'spaghetti', 'penne', 'fusilli', 'lasagneplader', 'tagliatelle'],
    en: ['egg noodles', 'rice noodles', 'noodles', 'lasagne sheets',
         'spaghetti', 'penne', 'tagliatelle', 'pasta'] },
  { key: 'ris', name: 'Ris', cat: 'grain', p: 7, kcal: 355, c: 78,
    da: ['ris', 'basmatiris', 'jasminris', 'risotto ris', 'grødris'],
    en: ['rice', 'basmati rice', 'risotto rice', 'arborio'] },
  { key: 'bulgur', name: 'Bulgur / couscous', cat: 'grain', p: 12, kcal: 340, c: 65,
    da: ['bulgur', 'couscous', 'quinoa'], en: ['bulgur', 'couscous', 'quinoa'] },
  { key: 'havregryn', name: 'Havregryn', cat: 'grain', p: 13, kcal: 370, c: 60,
    da: ['havregryn', 'havregrød'], en: ['oats', 'porridge oats', 'rolled oats'] },
  { key: 'mel', name: 'Mel', cat: 'pantry', p: 10, kcal: 340, c: 72,
    da: ['majsstivelse', 'maizena', 'hvedemel', 'rugmel', 'mel'],
    en: ['cornflour', 'cornstarch', 'plain flour', 'flour'] },
  { key: 'brod', name: 'Brød', cat: 'bakery', p: 8, kcal: 260, c: 45,
    da: ['rugbrød', 'brød', 'franskbrød', 'flute', 'boller', 'toastbrød'],
    en: ['bread', 'rye bread', 'baguette', 'buns'] },
  { key: 'tortilla', name: 'Tortilla / wraps', cat: 'bakery', p: 8, kcal: 300, c: 50,
    da: ['tortilla', 'wraps', 'tortillas'], en: ['tortilla', 'wraps', 'tortillas'] },

  // ── Kolonial ──────────────────────────────────────────────────────────────
  { key: 'olie', name: 'Olie', cat: 'pantry', p: 0, kcal: 880, c: 0,
    da: ['olivenolie', 'rapsolie', 'solsikkeolie', 'olie'], en: ['olive oil', 'oil', 'vegetable oil'] },
  { key: 'eddike', name: 'Eddike', cat: 'pantry', p: 0, kcal: 20, c: 1,
    da: ['eddike', 'balsamico'],
    en: ['apple cider vinegar', 'rice wine vinegar', 'rice vinegar',
         'white wine vinegar', 'red wine vinegar', 'cider vinegar',
         'vinegar', 'balsamic'] },
  { key: 'sukker', name: 'Sukker', cat: 'pantry', p: 0, kcal: 400, c: 100, da: ['sukker'], en: ['sugar'] },
  { key: 'salt', name: 'Salt', cat: 'pantry', p: 0, kcal: 0, c: 0, da: ['salt'], en: ['salt'] },
  { key: 'peber', name: 'Peber', cat: 'pantry', p: 0, kcal: 0, c: 0,
    da: ['peber', 'sort peber'], en: ['pepper', 'black pepper'] },
  { key: 'bouillon', name: 'Bouillon', cat: 'pantry', p: 0, kcal: 10, c: 1,
    // Sammensat skal fonden staves ud. Ellers vinder 'kylling' på position,
    // og en risotto bliver planlagt som en kyllingeret.
    da: ['kyllingefond', 'hønsefond', 'oksefond', 'kalvefond', 'fiskefond',
         'grøntsagsfond', 'hønsebouillon', 'oksebouillon', 'bouillon', 'fond'],
    en: ['stock', 'chicken stock', 'beef stock', 'broth'] },
  { key: 'kokosmaelk', name: 'Kokosmælk', cat: 'pantry', p: 2, kcal: 200, c: 3,
    da: ['kokosmælk'], en: ['coconut milk'] },
  { key: 'ketchup', name: 'Ketchup / sauce', cat: 'pantry', p: 1, kcal: 100, c: 20,
    da: ['tomat ketchup', 'tomatketchup', 'ketchup', 'remoulade', 'mayonnaise', 'dressing',
         'sennep', 'sauce'],
    en: ['tomato ketchup', 'ketchup', 'mayonnaise', 'mustard', 'dressing'] },
  { key: 'soja', name: 'Sojasauce', cat: 'pantry', p: 6, kcal: 60, c: 5,
    da: ['sojasauce', 'soya'], en: ['soy sauce', 'soya sauce'] },
  { key: 'krydderi', name: 'Krydderier', cat: 'pantry', p: 0, kcal: 0, c: 0,
    da: ['krydderi', 'paprika', 'spidskommen', 'karry', 'oregano', 'timian', 'basilikum', 'chili'],
    en: ['cayenne pepper', 'chilli flakes', 'lemon thyme', 'lime leaves',
         'chillies', 'chilies', 'paprika', 'cumin', 'curry', 'oregano',
         'thyme', 'basil', 'chilli', 'chili'] },
  { key: 'noedder', name: 'Nødder', cat: 'snack', p: 20, kcal: 600, c: 15,
    da: ['mandler', 'nødder', 'valnødder', 'cashewnødder'], en: ['almonds', 'nuts', 'walnuts', 'cashews'] },
  { key: 'safran', name: 'Safran', cat: 'pantry', p: 0, kcal: 0, c: 0,
    da: ['safran'], en: ['saffron'], premium: true },
  { key: 'troffel', name: 'Trøffel', cat: 'pantry', p: 0, kcal: 0, c: 0,
    da: ['trøffel', 'trøffelolie'], en: ['truffle', 'truffle oil'], premium: true },

  // ── Drikkevarer & snacks ──────────────────────────────────────────────────
  { key: 'sodavand', name: 'Sodavand', cat: 'drink', p: 0, kcal: 40, c: 10,
    da: ['sodavand', 'cola', 'pepsi', 'faxe kondi', 'fanta', 'sprite'], en: ['soda', 'cola'] },
  { key: 'oel', name: 'Øl', cat: 'drink', p: 0, kcal: 43, c: 3.5, da: ['øl', 'pilsner'], en: ['beer', 'lager'] },
  { key: 'vin', name: 'Vin', cat: 'drink', p: 0, kcal: 83, c: 2.5,
    da: ['rødvin', 'hvidvin', 'lambrusco', 'prosecco', 'champagne', 'vin', 'rosé'],
    en: ['red wine', 'white wine', 'prosecco', 'champagne', 'wine'] },
  { key: 'spiritus', name: 'Spiritus', cat: 'drink', p: 0, kcal: 250, c: 0,
    da: ['vodka', 'whisky', 'cognac', 'likør', 'snaps', 'spiritus'],
    en: ['vodka', 'whisky', 'whiskey', 'liqueur'] },
  { key: 'kaffe', name: 'Kaffe', cat: 'drink', p: 0, kcal: 0, c: 0,
    // "Lavazza hele bønner" er kaffe. Uden de sammensatte former ville
    // 'bønner' vinde, og en chili con carne ville blive planlagt om kaffe.
    da: ['kaffebønner', 'formalet kaffe', 'helbønner', 'hele bønner', 'kaffe'],
    en: ['coffee beans', 'coffee'] },
  { key: 'the', name: 'Te', cat: 'drink', p: 0, kcal: 0, c: 0, da: ['te'], en: ['tea'] },
  { key: 'juice', name: 'Juice', cat: 'drink', p: 0.5, kcal: 45, c: 10,
    da: ['juice', 'appelsinjuice', 'æblejuice', 'most'], en: ['juice', 'orange juice'] },
  { key: 'laeskedrik', name: 'Læskedrik', cat: 'drink', p: 0, kcal: 30, c: 7,
    da: ['læskedrik', 'energidrik', 'sportsdrik', 'iste', 'aloe vera', 'drik'],
    en: ['energy drink', 'iced tea'] },
  { key: 'vand', name: 'Vand', cat: 'drink', p: 0, kcal: 0, c: 0,
    da: ['kildevand', 'danskvand'], en: ['water', 'sparkling water'] },
  { key: 'chips', name: 'Chips', cat: 'snack', p: 6, kcal: 530, c: 50, da: ['chips'], en: ['crisps', 'chips'] },
  { key: 'chokolade', name: 'Chokolade & slik', cat: 'snack', p: 7, kcal: 540, c: 55,
    // marcipanbrød er konfekt, ikke brød – skal stå før 'brød' kan fange det
    da: ['marcipanbrød', 'marcipan', 'flødeboller', 'skildpadder', 'lakrids', 'chokolade', 'slik'],
    en: ['chocolate', 'candy', 'marzipan'] },
  { key: 'is', name: 'Is', cat: 'snack', p: 4, kcal: 200, c: 25, da: ['flødeis', 'is'], en: ['ice cream'] },
  { key: 'kiks', name: 'Kiks / kage', cat: 'snack', p: 6, kcal: 450, c: 65,
    da: ['flødekage', 'lagkage', 'kiks', 'kage', 'småkager'],
    en: ['biscuits', 'cookies', 'cake'] },

  // ── Færdigretter & diverse ────────────────────────────────────────────────
  { key: 'suppe', name: 'Suppe', cat: 'pantry', p: 2, kcal: 55, c: 5,
    da: ['specialsuppe', 'suppe', 'hønsekødssuppe', 'tomatsuppe'], en: ['soup'] },
  { key: 'honning', name: 'Honning', cat: 'pantry', p: 0.3, kcal: 300, c: 80,
    da: ['honning'], en: ['honey'] },
  { key: 'frikadeller', name: 'Frikadeller', cat: 'meat', p: 15, kcal: 240, c: 8,
    da: ['frikadeller', 'kødboller', 'melboller'], en: ['meatballs'] },
  { key: 'pizza', name: 'Pizza', cat: 'grain', p: 10, kcal: 250, c: 30,
    da: ['pizza', 'pizzabund'], en: ['pizza'] },

  // ── Non-food (skal aldrig ende i en madplan) ──────────────────────────────
  { key: 'toiletpapir', name: 'Toiletpapir', cat: 'nonfood',
    da: ['toiletpapir', 'køkkenrulle', 'husholdningspapir', 'papir'], en: [] },
  { key: 'elektronik', name: 'Elektronik', cat: 'nonfood',
    da: ['harddisk', 'hovedtelefoner', 'højttaler', 'oplader', 'tastatur',
         'trådløs mus', 'powerbank', 'smartwatch'], en: [] },
  { key: 'fest', name: 'Fest & pynt', cat: 'nonfood',
    da: ['gender reveal', 'babyshower', 'konfetti', 'balloner', 'servietter',
         'gavepapir', 'lyskæde'], en: [] },
  { key: 'rengoering', name: 'Rengøring', cat: 'nonfood',
    da: ['opvasketabs', 'vaskemiddel', 'rengøring', 'sæbe', 'skyllemiddel'], en: [] },
  { key: 'personlig_pleje', name: 'Personlig pleje', cat: 'nonfood',
    da: ['personlig pleje', 'shampoo', 'tandpasta', 'deodorant', 'bleer', 'hudpleje', 'hårpleje',
         'hudcreme', 'helsekost', 'kosttilskud', 'vitaminer', 'creme'], en: [] },
  { key: 'dyrefoder', name: 'Dyrefoder', cat: 'nonfood',
    da: ['fuglefoder', 'hundefoder', 'kattefoder', 'kattegrus'], en: [] },
];

// Basisvarer man antages at have hjemme. De tæller hverken som krav eller som
// "match", når vi vurderer hvor meget af en opskrift der er på tilbud.
//
// Afgrænsningen er praktisk, ikke principiel: står varen i skabet i forvejen,
// købes den sjældent på tilbud, og den bruges i så små mængder, at prisen
// alligevel ikke flytter noget. En madplan, der ventede på tilbud på
// hvidløg og paprika, ville aldrig blive til noget.
const STAPLE_KEYS = new Set([
  // kolonial
  'salt', 'peber', 'krydderi', 'olie', 'eddike', 'sukker', 'mel', 'vand',
  'bouillon', 'soja', 'honning', 'ketchup',
  // friske aromater der bruges i teskefulde, ikke i portioner
  'hvidloeg', 'ingefaer', 'persille',
]);

const NONFOOD_CATS = new Set(['nonfood']);

// Kategorier der ikke kan bære et aftensmåltid.
const NON_MEAL_CATS = new Set(['nonfood', 'drink', 'snack']);

// ── Opslagsindeks ────────────────────────────────────────────────────────────
// Alle synonymer i ét fladt indeks, sorteret længst-først så det mest
// specifikke match vinder ("hakket oksekød" slår "oksekød").

const BY_KEY = new Map(TAXONOMY.map((t) => [t.key, t]));

const SYNONYMS = [];
for (const entry of TAXONOMY) {
  for (const s of entry.da || []) SYNONYMS.push({ term: s.toLowerCase(), lang: 'da', entry });
  for (const s of entry.en || []) SYNONYMS.push({ term: s.toLowerCase(), lang: 'en', entry });
}
SYNONYMS.sort((a, b) => b.term.length - a.term.length);

const isWordChar = (c) => c !== undefined && /[a-zæøå0-9]/.test(c);

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

/**
 * Finder den bedste taksonomi-post i en fritekst.
 *
 * Dansk er et sammensætningssprog: "jomfruolivenolie" og "kaffebønner" er ét
 * ord, hvor betydningen sidder i en del af ordet. Derfor accepteres delmatch
 * inde i sammensatte ord, men kun for DANSKE synonymer på 4+ tegn – ellers
 * ville "is" ramme "ris" og "and" ramme hvad som helst.
 *
 * Engelsk sætter derimod ikke ord sammen. Et engelsk synonym skal stå som
 * helt ord, højst med et flertals-s: "courgettes" er courgette, men
 * "pepperoni" er ikke pepper, "reveal" er ikke veal og "Lambi" ikke lamb.
 *
 * Rangering: flest ordgrænser først (helt ord slår orddel), derefter
 * tidligste position (dansk sætter hovedordet forrest i varenavne:
 * "Skinkeculotte" er skinke, ikke culotte, og "Indbagt laks med spinat" er
 * laks, ikke spinat), derefter længste synonym.
 *
 * Når et længere udtryk skal vinde over sin egen første del – "tomat
 * ketchup" over "tomat", "butter beans" over "butter" – står det som sit
 * eget synonym. Så starter de samme sted, og længden afgør.
 */
function lookup(text) {
  if (!text) return null;
  const hay = String(text).toLowerCase();
  const english = looksEnglish(hay);
  let best = null;

  for (const syn of SYNONYMS) {
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

function get(key) { return BY_KEY.get(key) || null; }
function isStaple(key) { return STAPLE_KEYS.has(key); }
function isNonFood(key) { const e = BY_KEY.get(key); return !!e && NONFOOD_CATS.has(e.cat); }
function isMealCapable(key) { const e = BY_KEY.get(key); return !!e && !NON_MEAL_CATS.has(e.cat); }
function isPremium(key) { const e = BY_KEY.get(key); return !!e && !!e.premium; }

module.exports = {
  TAXONOMY, BY_KEY, SYNONYMS, PREPARED_FORMS,
  lookup, get, isStaple, isNonFood, isMealCapable, isPremium,
  hintsAtMainIngredient, preparedForm, looksEnglish,
  STAPLE_KEYS, NON_MEAL_CATS,
};
