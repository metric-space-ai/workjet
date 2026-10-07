export function parseModels(value: string): ReadonlyArray<string> | null {
  const models = [
    ...new Set(
      value
        .split(/[,\n]/)
        .map((model) => model.trim())
        .filter(Boolean),
    ),
  ];
  return models.length <= 128 &&
    models.every((model) => model.length <= 128 && !/[\s\x00-\x1f\x7f]/.test(model))
    ? models
    : null;
}

