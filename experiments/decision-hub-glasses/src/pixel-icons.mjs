// Pixel-Art fuer das 4-Bit-Gruen-Display.
//
// Von Hand auf einem 16x16-Raster gesetzt und beim Zeichnen ganzzahlig
// skaliert. Algorithmisch gezogene Linien sehen auf einem monochromen
// Display ausgefranst aus — hier sitzt jedes Pixel bewusst.
//
//   #  volle Helligkeit      +  gedaempft (Kante/Schatten)      .  leer

const ICONS = {
  // Haken — kräftig, mit kurzer Anlaufkante links unten.
  annehmen: [
    '................',
    '..............#.',
    '.............##.',
    '............##..',
    '...........##...',
    '..........##....',
    '.#.......##.....',
    '.##.....##......',
    '..##...##.......',
    '...##.##........',
    '....###.........',
    '.....#..........',
    '................',
    '................',
    '................',
    '................',
  ],
  // Kreuz — gleichmäßige Diagonalen, kein Ausfransen an den Enden.
  ablehnen: [
    '................',
    '.##..........##.',
    '.###........###.',
    '..###......###..',
    '...###....###...',
    '....###..###....',
    '.....######.....',
    '......####......',
    '......####......',
    '.....######.....',
    '....###..###....',
    '...###....###...',
    '..###......###..',
    '.###........###.',
    '.##..........##.',
    '................',
  ],
  // Stift — Spitze unten links, Radiergummi-Ende oben rechts.
  korrektur: [
    '................',
    '...........###..',
    '..........#####.',
    '.........###.##.',
    '........###..#..',
    '.......###......',
    '......###.......',
    '.....###........',
    '....###.........',
    '...###..........',
    '..###...........',
    '.###............',
    '.##.............',
    '.#..............',
    '................',
    '................',
  ],
  // Uhr — runder Rand aus gesetzten Pixeln, Zeiger auf 12 und 4.
  vertagt: [
    '................',
    '.....######.....',
    '...##......##...',
    '..#....##....#..',
    '.#.....##.....#.',
    '.#.....##.....#.',
    '#......##......#',
    '#......###.....#',
    '#......####....#',
    '#......##......#',
    '.#.....##.....#.',
    '.#............#.',
    '..#..........#..',
    '...##......##...',
    '.....######.....',
    '................',
  ],
  // Doppelpfeil nach unten — Ausklappen (nur in der Rubrikzeile, nicht unten).
  mehr: [
    '................',
    '................',
    '.##..........##.',
    '..##........##..',
    '...##......##...',
    '....##....##....',
    '.....##..##.....',
    '......####......',
    '.##..........##.',
    '..##........##..',
    '...##......##...',
    '....##....##....',
    '.....##..##.....',
    '......####......',
    '................',
    '................',
  ],
  // Doppelpfeil nach oben — Zuklappen.
  kurz: [
    '................',
    '................',
    '......####......',
    '.....##..##.....',
    '....##....##....',
    '...##......##...',
    '..##........##..',
    '.##..........##.',
    '......####......',
    '.....##..##.....',
    '....##....##....',
    '...##......##...',
    '..##........##..',
    '.##..........##.',
    '................',
    '................',
  ],
};

export const ICON_SIZE = 16;

export function iconGrid(name) {
  return ICONS[name] || ICONS.annehmen;
}

/**
 * Icon ins Bitmap zeichnen, ganzzahlig skaliert.
 * @param {object} bmp  Zielbitmap
 * @param {string} name Iconname
 * @param {number} x    linke Kante
 * @param {number} y    obere Kante
 * @param {number} scale ganzzahliger Faktor (2 = 32x32)
 * @param {number} level Helligkeit 0..15
 */
export function drawIcon(bmp, name, x, y, scale, level, setPixel) {
  const grid = iconGrid(name);
  for (let row = 0; row < grid.length; row += 1) {
    const line = grid[row];
    for (let col = 0; col < line.length; col += 1) {
      const ch = line[col];
      if (ch === '.') continue;
      const value = ch === '+' ? Math.max(0, Math.round(level * 0.5)) : level;
      for (let dy = 0; dy < scale; dy += 1) {
        for (let dx = 0; dx < scale; dx += 1) {
          setPixel(bmp, x + col * scale + dx, y + row * scale + dy, value);
        }
      }
    }
  }
}
