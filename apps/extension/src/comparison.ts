/** Keep the printed chart order and show the selected size's immediate neighbours. */
export function neighbouringSizes<T extends { size: string }>(
  sizes: readonly T[],
  selected: string,
): T[] {
  const index = sizes.findIndex((size) => size.size === selected);
  return sizes.slice(Math.max(0, index - 1), index < 0 ? 3 : index + 2);
}
