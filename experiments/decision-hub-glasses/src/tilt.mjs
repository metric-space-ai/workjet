// Kopf in den Nacken = Anzeige ein, Kopf zurueck = Anzeige aus.
//
// Die Brille meldet IMU-Daten als sysEvent (OsEventTypeList.IMU_DATA_REPORT)
// mit x/y/z. Welche Achse die Neigung traegt, haengt vom Geraet ab; hier
// entscheidet die Achse mit dem groessten Ausschlag gegenueber der Ruhelage.
//
// Zwei Schwellen mit Abstand (Hysterese): ohne sie flackert die Anzeige bei
// jeder Kopfbewegung im Grenzbereich.

export function createTiltGate({ threshold = 25, release = 12, axis = 'auto' } = {}) {
  let ruhe = null;
  let sichtbar = true;

  function pick(sample) {
    if (axis !== 'auto') return sample[axis] ?? 0;
    // Die Achse mit der groessten Abweichung von der Ruhelage fuehrt.
    const kandidaten = ['x', 'y', 'z'].map((key) => ({
      key,
      delta: Math.abs((sample[key] ?? 0) - (ruhe?.[key] ?? 0)),
    }));
    kandidaten.sort((a, b) => b.delta - a.delta);
    return (sample[kandidaten[0].key] ?? 0) - (ruhe?.[kandidaten[0].key] ?? 0);
  }

  return {
    get visible() {
      return sichtbar;
    },
    /** Ruhelage neu setzen (z. B. beim Start). */
    calibrate(sample) {
      ruhe = { x: sample?.x ?? 0, y: sample?.y ?? 0, z: sample?.z ?? 0 };
    },
    /**
     * @returns {'show'|'hide'|null} nur bei einem Wechsel, sonst null
     */
    feed(sample) {
      if (!sample) return null;
      if (!ruhe) {
        this.calibrate(sample);
        return null;
      }
      const delta = pick(sample);
      if (!sichtbar && delta >= threshold) {
        sichtbar = true;
        return 'show';
      }
      if (sichtbar && delta <= -threshold) {
        sichtbar = false;
        return 'hide';
      }
      // Zwischen den Schwellen passiert nichts — das ist die Hysterese.
      if (Math.abs(delta) < release) return null;
      return null;
    },
  };
}
