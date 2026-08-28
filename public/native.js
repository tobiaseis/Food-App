'use strict';

/**
 * Broen til den native skal.
 *
 * Appen er den samme kode på nettet og i APK'en. Derfor har hver funktion her
 * to udgange: den native plugin, hvis Capacitor-broen findes, og web-API'et
 * ellers. Ingen af kaldene må kaste, uanset hvor de kører – en manglende
 * plugin skal give en dårligere oplevelse, ikke en hvid skærm.
 *
 * Uden bundler findes plugins på window.Capacitor.Plugins, som broen selv
 * fylder ud ved opstart. Derfor slås de op ved brug og ikke via import.
 */

const plugin = (name) => window.Capacitor?.Plugins?.[name] || null;

const IS_NATIVE = Boolean(window.Capacitor?.isNativePlatform?.());
const PLATFORM = window.Capacitor?.getPlatform?.() || 'web';

/* ── Vedvarende værdier ───────────────────────────────────────────────────────
   Appen læser localStorage synkront flere steder (device-id, favoritbutikker),
   og det skal den blive ved med – at gøre dem asynkrone ville brede sig
   gennem hele datalaget. Men en WebView kan blive ryddet af systemet, og så
   ville brugeren miste sine overvågninger, fordi device-id'et var væk.

   Derfor: localStorage er stadig sandheden, og Preferences er en kopi, der
   overlever oprydningen. Ved opstart hentes kopien frem igen, hvis
   localStorage står tom. Native.init() ventes på, før appen læser noget.    */

const MIRRORED = ['madplan_device', 'madplan_favorite_chains', 'madplan_home'];

async function hydrateFromPreferences() {
  const prefs = plugin('Preferences');
  if (!prefs) return;
  for (const key of MIRRORED) {
    try {
      if (localStorage.getItem(key) !== null) continue;
      const stored = await prefs.get({ key });
      if (stored?.value != null) localStorage.setItem(key, stored.value);
    } catch { /* en manglende nøgle er ikke en fejl */ }
  }
}

/** Skriver en værdi videre til den native kopi. Kaldes efter localStorage. */
async function persist(key, value) {
  const prefs = plugin('Preferences');
  if (!prefs) return;
  try {
    if (value == null) await prefs.remove({ key });
    else await prefs.set({ key, value: String(value) });
  } catch { /* ignoreres */ }
}

/* ── Udseende ─────────────────────────────────────────────────────────────── */

async function styleShell() {
  const dark = window.matchMedia?.('(prefers-color-scheme: dark)').matches;

  const bar = plugin('StatusBar');
  if (bar) {
    try {
      // Style styrer ikonernes farve, ikke baggrundens: LIGHT betyder lys
      // baggrund og dermed MØRKE ikoner. Den skal altså følge temaet omvendt
      // af, hvad navnet lyder som.
      await bar.setStyle({ style: dark ? 'DARK' : 'LIGHT' });

      // setBackgroundColor er uden virkning fra Android 15, hvor kant-til-kant
      // er obligatorisk for apps med targetSdk 35+. Kaldet bliver stående for
      // de ældre telefoner, minSdk 24 stadig dækker – og farven er headerens,
      // ikke accentens, så mørke ikoner har noget at stå på.
      if (PLATFORM === 'android') {
        await bar.setBackgroundColor({ color: dark ? '#171c24' : '#ffffff' });
      }
    } catch { /* ignoreres */ }
  }

  const splash = plugin('SplashScreen');
  if (splash) { try { await splash.hide(); } catch { /* ignoreres */ } }
}

/* ── Tilbage-knappen ──────────────────────────────────────────────────────────
   Android har en systemknap, appen skal svare på. Uden det lukker den ved
   første tryk – også midt i en dialog, hvilket føles som et nedbrud.

   Rækkefølgen er den, brugeren forventer: luk det øverste lag først, gå
   derefter et skridt tilbage i ruterne, og luk kun appen fra forsiden.      */

function bindBackButton() {
  const capApp = plugin('App');
  if (!capApp) return;

  capApp.addListener('backButton', ({ canGoBack }) => {
    const modal = document.getElementById('modal');
    if (modal?.open) { modal.close(); return; }

    const onHome = !location.hash || location.hash.startsWith('#/plan');
    if (!onHome && canGoBack) { window.history.back(); return; }
    if (!onHome) { location.hash = '#/plan'; return; }

    capApp.exitApp();
  });
}

/** Dybe links: et delt link med #/deals skal åbne fanen, ikke bare appen. */
function bindDeepLinks() {
  const capApp = plugin('App');
  if (!capApp) return;
  capApp.addListener('appUrlOpen', ({ url }) => {
    const hash = String(url || '').split('#')[1];
    if (hash) location.hash = '#' + hash;
  });
}

/* ── Push ─────────────────────────────────────────────────────────────────────
   Tilladelsen bedes der IKKE om ved opstart. En bruger, der bliver spurgt,
   før appen har vist hvad den kan, siger nej – og fra Android 13 er et nej
   svært at komme tilbage fra. Der spørges først, når den første overvågning
   oprettes; det er dér, beskeden giver mening. Se Native.enablePush().      */

let pushBound = false;

function bindPushListeners() {
  const push = plugin('PushNotifications');
  if (!push || pushBound) return;
  pushBound = true;

  push.addListener('registration', async (token) => {
    try { await window.Data?.registerPushToken?.(token.value, PLATFORM); } catch { /* ignoreres */ }
  });

  push.addListener('registrationError', () => { /* uden token er der ingen push */ });

  // Er appen åben, er en systemnotifikation forkert – brugeren kigger jo på
  // skærmen. Tallet på "Følg varer" opdateres i stedet.
  push.addListener('pushNotificationReceived', () => {
    window.dispatchEvent(new CustomEvent('madplan:push'));
  });

  push.addListener('pushNotificationActionPerformed', (action) => {
    location.hash = action?.notification?.data?.route || '#/watch';
  });
}

/**
 * Beder om tilladelse og registrerer enheden. Kaldes fra "Følg varer".
 * @returns {Promise<'granted'|'denied'|'unavailable'>}
 */
async function enablePush() {
  const push = plugin('PushNotifications');
  if (!push) return 'unavailable';
  try {
    bindPushListeners();
    let status = await push.checkPermissions();
    if (status.receive === 'prompt' || status.receive === 'prompt-with-rationale') {
      status = await push.requestPermissions();
    }
    if (status.receive !== 'granted') return 'denied';
    await push.register();
    return 'granted';
  } catch {
    return 'unavailable';
  }
}

/**
 * Er der allerede sagt ja, registreres enheden igen ved hver opstart – FCM
 * kan udskifte token'et når som helst, og et forældet token er en stille
 * fejl: notifikationerne bliver bare væk.
 */
async function resumePush() {
  const push = plugin('PushNotifications');
  if (!push) return;
  try {
    const status = await push.checkPermissions();
    if (status.receive !== 'granted') return;
    bindPushListeners();
    await push.register();
  } catch { /* ignoreres */ }
}

/* ── Enhedens funktioner ──────────────────────────────────────────────────── */

/** Position, native eller via browseren. Kaster ved afvisning. */
async function getPosition() {
  const geo = plugin('Geolocation');
  if (geo) {
    const pos = await geo.getCurrentPosition({ enableHighAccuracy: false, timeout: 15000 });
    return { lat: pos.coords.latitude, lng: pos.coords.longitude };
  }
  if (!navigator.geolocation) throw new Error('Ingen positionstjeneste');
  return new Promise((resolve, reject) => {
    navigator.geolocation.getCurrentPosition(
      (p) => resolve({ lat: p.coords.latitude, lng: p.coords.longitude }),
      reject,
      { enableHighAccuracy: false, timeout: 15000 }
    );
  });
}

/**
 * Deling af indkøbslisten. Falder tilbage på udklipsholderen, så knappen
 * altid gør noget – også i en browser uden Web Share.
 * @returns {Promise<'shared'|'copied'>}
 */
async function share({ title, text, url }) {
  const sh = plugin('Share');
  if (sh) { await sh.share({ title, text, url, dialogTitle: title }); return 'shared'; }
  if (navigator.share) { await navigator.share({ title, text, url }); return 'shared'; }
  await navigator.clipboard.writeText(text);
  return 'copied';
}

/** Lille bekræftelse i fingeren. Stille no-op på nettet. */
async function haptic(style = 'LIGHT') {
  const h = plugin('Haptics');
  if (!h) return;
  try { await h.impact({ style }); } catch { /* ignoreres */ }
}

/* ── Opstart ──────────────────────────────────────────────────────────────── */

async function init() {
  if (!IS_NATIVE) return;
  await hydrateFromPreferences();
  await styleShell();
  bindBackButton();
  bindDeepLinks();
  await resumePush();
}

window.Native = {
  isNative: IS_NATIVE,
  platform: PLATFORM,
  init,
  persist,
  enablePush,
  getPosition,
  share,
  haptic,
};
