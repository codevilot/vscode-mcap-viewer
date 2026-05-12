export function remapPositions(
  canonical: string[],
  sampleNames: string[],
  samplePositions: number[],
): number[] {
  if (
    canonical.length === sampleNames.length &&
    canonical.every((name, index) => sampleNames[index] === name)
  ) {
    return samplePositions;
  }
  const sampleIndex = new Map(sampleNames.map((name, index) => [name, index]));
  return canonical.map((name) => {
    const index = sampleIndex.get(name);
    return index == undefined ? Number.NaN : samplePositions[index] ?? Number.NaN;
  });
}

export function nearestTimestampIndex(timestamps: bigint[], target: bigint): number {
  if (timestamps.length <= 1) {
    return 0;
  }
  let low = 0;
  let high = timestamps.length - 1;
  while (low < high) {
    const mid = Math.floor((low + high) / 2);
    if (timestamps[mid] < target) {
      low = mid + 1;
    } else {
      high = mid;
    }
  }
  const right = low;
  const left = Math.max(0, right - 1);
  const leftDelta = absBigint(timestamps[left] - target);
  const rightDelta = absBigint(timestamps[right] - target);
  return leftDelta <= rightDelta ? left : right;
}

export function absBigint(value: bigint): bigint {
  return value < 0n ? -value : value;
}
