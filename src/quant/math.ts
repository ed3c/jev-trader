/** Small numerical helpers. All public model boundaries validate finite inputs. */
export function finite(value: number, name: string): number {
  if (!Number.isFinite(value)) throw new RangeError(`${name} must be finite`);
  return value;
}

export function positive(value: number, name: string): number {
  finite(value, name);
  if (value <= 0) throw new RangeError(`${name} must be positive`);
  return value;
}

export function nonnegative(value: number, name: string): number {
  finite(value, name);
  if (value < 0) throw new RangeError(`${name} must be nonnegative`);
  return value;
}

export function probability(value: number, name = "probability"): number {
  finite(value, name);
  if (value < 0 || value > 1) throw new RangeError(`${name} must be in [0, 1]`);
  return value;
}

export function mean(values: readonly number[]): number {
  if (!values.length) throw new RangeError("mean requires observations");
  let result = 0;
  values.forEach((value, i) => { result = result * (i / (i + 1)) + finite(value, "observation") / (i + 1); });
  return finite(result, "mean");
}

export function sampleVariance(values: readonly number[]): number {
  if (values.length < 2) throw new RangeError("variance requires two observations");
  const center = mean(values);
  return finite(values.reduce((sum, value) => sum + (value - center) ** 2, 0) / (values.length - 1), "variance");
}

/** Seeded numerical experiments are reproducible, not cryptographically random. */
export function seededUniform(seed: number): () => number {
  if (!Number.isSafeInteger(seed)) throw new RangeError("seed must be a safe integer");
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let value = Math.imul(state ^ (state >>> 15), 1 | state);
    value ^= value + Math.imul(value ^ (value >>> 7), 61 | value);
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  };
}

export function normalRandom(seed: number): () => number {
  const uniform = seededUniform(seed);
  let spare: number | undefined;
  return () => {
    if (spare !== undefined) {
      const value = spare;
      spare = undefined;
      return value;
    }
    const radius = Math.sqrt(-2 * Math.log(Math.max(uniform(), Number.MIN_VALUE)));
    const angle = 2 * Math.PI * uniform();
    spare = radius * Math.sin(angle);
    return radius * Math.cos(angle);
  };
}

export function sigmoid(value: number): number {
  return value >= 0 ? 1 / (1 + Math.exp(-value)) : Math.exp(value) / (1 + Math.exp(value));
}

export function logit(value: number, epsilon = 1e-12): number {
  probability(value);
  const clipped = Math.min(1 - epsilon, Math.max(epsilon, value));
  return Math.log(clipped / (1 - clipped));
}
