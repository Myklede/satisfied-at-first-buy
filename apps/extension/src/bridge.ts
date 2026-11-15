/** Only the existing catalogue product route is supported by the studio. */
export function catalogueStudioUrl(value: string | undefined, origin: string): string | null {
  if (!value) return null;
  try {
    const url = new URL(value);
    if (
      url.origin !== new URL(origin).origin ||
      url.pathname !== '/' ||
      !/^[a-f0-9]{64}$/.test(url.searchParams.get('product') ?? '')
    )
      return null;
    return `${url.origin}/?product=${url.searchParams.get('product')}`;
  } catch {
    return null;
  }
}
