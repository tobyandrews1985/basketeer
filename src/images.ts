export interface ImageSize {
  width: number;
  height: number;
}

function assertPositiveInteger(value: number, name: string): void {
  if (!Number.isInteger(value) || value < 1) {
    throw new RangeError(`${name} must be a positive integer`);
  }
}

export function resizeImageUrl(imageUrl: string | null, size: ImageSize): string | null {
  if (imageUrl === null) return null;
  assertPositiveInteger(size.width, "width");
  assertPositiveInteger(size.height, "height");

  const url = new URL(imageUrl);
  url.searchParams.set("w", String(size.width));
  url.searchParams.set("h", String(size.height));
  return url.toString();
}
