// Einstellungen der Handy-App.
//
// Das Handy ist die Konfigurationsflaeche: Verbindungen zu CTOX-Instanzen und
// die Regeln dafuer, WAS auf der Brille erscheint. Die Vorgaenge selbst zeigt
// die Brille — hier steht nie derselbe Inhalt noch einmal.
//
// localStorage ueberlebt das Backgrounding der WebView (Even-Hub-Doku,
// background-lifecycle), ist also der richtige Ort dafuer.

const KEY = 'decision-hub.settings.v1';

export const DECISION_TYPES = [
  { id: 'zuordnung', label: 'Zuordnung' },
  { id: 'triage', label: 'Triage' },
  { id: 'mailfreigabe', label: 'Mailfreigabe' },
  { id: 'ergebnisfreigabe', label: 'Ergebnis' },
];

export const GLASS_SECTIONS = [
  { id: 'mail', label: 'Mail' },
  { id: 'antwort', label: 'Antwortvorschlag' },
  { id: 'aufgabe', label: 'Aufgabe' },
  { id: 'notizen', label: 'Notizen' },
];

export const DEFAULTS = {
  instances: [], // { id, name, baseUrl, token, user, role, kind }
  activeInstanceId: null,
  types: DECISION_TYPES.map((t) => t.id),
  sections: ['mail', 'antwort', 'aufgabe'],
  refreshSeconds: 30,
  confirmBeforeSend: true,
  snoozeMinutes: 60,
};

export function loadSettings() {
  try {
    const raw = globalThis.localStorage?.getItem(KEY);
    if (!raw) return { ...DEFAULTS };
    const parsed = JSON.parse(raw);
    return { ...DEFAULTS, ...parsed };
  } catch {
    return { ...DEFAULTS };
  }
}

export function saveSettings(settings) {
  try {
    globalThis.localStorage?.setItem(KEY, JSON.stringify(settings));
  } catch {
    /* Speicher voll oder gesperrt — die App laeuft weiter, nur ohne Merken. */
  }
  return settings;
}

export function activeInstance(settings) {
  return settings.instances.find((i) => i.id === settings.activeInstanceId) || null;
}

/**
 * Eine Pairing-Einladung von CTOX lesen.
 * Akzeptiert den Link aus `ctox business-os desktop invite`, eine nackte URL
 * mit Token-Parameter oder das JSON derselben Einladung.
 */
export function parseInvite(input) {
  const text = String(input || '').trim();
  if (!text) return null;

  if (text.startsWith('{')) {
    try {
      const data = JSON.parse(text);
      const baseUrl = data.base_url || data.url || data.instance_url;
      const token = data.capability_token || data.token;
      if (baseUrl && token) {
        return {
          baseUrl: normalizeBase(baseUrl),
          token,
          user: data.user_id || data.user || '',
          role: data.role || '',
        };
      }
    } catch {
      return null;
    }
    return null;
  }

  try {
    const url = new URL(text.replace(/^ctox:\/\//, 'https://'));
    const token = url.searchParams.get('token') || url.searchParams.get('capability_token');
    if (!token) return null;
    const host = url.searchParams.get('instance') || url.host;
    return {
      baseUrl: normalizeBase(host),
      token,
      user: url.searchParams.get('user') || '',
      role: url.searchParams.get('role') || '',
    };
  } catch {
    return null;
  }
}

export function normalizeBase(value) {
  let text = String(value || '').trim().replace(/\/+$/, '');
  if (!text) return '';
  if (!/^https?:\/\//.test(text)) text = `https://${text}`;
  return text;
}

export function instanceFrom({ baseUrl, token, user, role, name }) {
  const base = normalizeBase(baseUrl);
  const host = base.replace(/^https?:\/\//, '');
  return {
    id: host,
    name: name || host,
    baseUrl: base,
    token: token || '',
    user: user || '',
    role: role || '',
    // ctox.dev-Instanzen sind verwaltet, alles andere selbst betrieben.
    kind: host.endsWith('.ctox.dev') ? 'managed' : 'self-hosted',
  };
}

/** Erscheint diese Entscheidung nach den Filtern auf der Brille? */
export function passesFilter(decision, settings) {
  const typ = decision?.typ || '';
  return settings.types.includes(typ);
}
