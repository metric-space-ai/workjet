const MIN_SCANNER_SIZE = 160;
const MAX_SCANNER_SIZE = 360;
const HORIZONTAL_GUTTER = 40;
const MAX_HEIGHT_FRACTION = 0.42;

export function pairingScannerSize(input: {
  readonly width: number;
  readonly height: number;
}): number {
  const availableWidth = Math.max(MIN_SCANNER_SIZE, input.width - HORIZONTAL_GUTTER);
  const availableHeight = Math.max(MIN_SCANNER_SIZE, input.height * MAX_HEIGHT_FRACTION);
  return Math.floor(Math.min(MAX_SCANNER_SIZE, availableWidth, availableHeight));
}
