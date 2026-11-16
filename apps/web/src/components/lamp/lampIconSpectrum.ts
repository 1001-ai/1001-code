/**
 * The colours of the lamp's stars while the agent thinks. Each star keeps its own share of the
 * OKLCH hue wheel; the wheel turns at a pace that swells and slackens, and each star wanders about
 * its place. The motions share no period, so the colours never repeat, and no two stars meet.
 */

/** The hues under reduced motion and before the script runs: blue, red and yellow. */
export const LAMP_STAR_STILL_HUES: readonly number[] = [262, 25, 95];

/** Seconds on the page's clock to each star's hue in degrees, 0 to 360. */
export type LampStarSpectrum = (seconds: number) => number[];

const FULL_TURN = 360;
const RADIANS = Math.PI * 2;
const GOLDEN = (1 + Math.sqrt(5)) / 2;
/** Degrees a second: once round in about 26 seconds. */
const TURN_PACE = 14;
/** Degrees, and radians a second. */
const SWELLS = [
  [38, 0.21],
  [20, 0.21 * GOLDEN],
] as const;
/** Degrees, and radians a second. */
const WANDERS = [
  [24, 0.37],
  [6, 0.29],
] as const;
/** Square roots of square-free numbers, so that no two stars keep time. */
const STAR_PACES = [1, 2, 3, 5, 6, 7, 10, 11].map(Math.sqrt);

const FRAME_MS = 1000 / 30;

/** Its phases are drawn from `random`, so no two lamps turn alike. */
export function createLampStarSpectrum(
  count: number,
  random: () => number = Math.random,
): LampStarSpectrum {
  const start = random() * FULL_TURN;
  const swells = SWELLS.map(() => random() * RADIANS);
  const wanders = Array.from({ length: count }, () => WANDERS.map(() => random() * RADIANS));
  const share = FULL_TURN / Math.max(1, count);

  return (seconds) => {
    let turn = start + TURN_PACE * seconds;
    for (const [index, [degrees, pace]] of SWELLS.entries()) {
      turn += degrees * Math.sin(pace * seconds + (swells[index] ?? 0));
    }
    return Array.from({ length: count }, (_, star) => {
      let hue = turn + share * star;
      for (const [index, [degrees, pace]] of WANDERS.entries()) {
        // The second wander's pace comes from further along, so a star's wanders share no period.
        const own = STAR_PACES[(star + index * 3) % STAR_PACES.length] ?? 1;
        hue += degrees * Math.sin(pace * own * seconds + (wanders[star]?.[index] ?? 0));
      }
      return ((hue % FULL_TURN) + FULL_TURN) % FULL_TURN;
    });
  };
}

interface Follower {
  readonly element: SVGElement;
  readonly spectrum: LampStarSpectrum;
}

const followers = new Set<Follower>();
let frame = 0;
let painted = 0;

function paint(follower: Follower, now: number) {
  for (const [star, hue] of follower.spectrum(now / 1000).entries()) {
    follower.element.style.setProperty(`--lamp-star-hue-${String(star)}`, `${hue.toFixed(1)}deg`);
  }
}

function tick(now: number) {
  frame = requestAnimationFrame(tick);
  // By timestamp, so a 120Hz display does no more work than a 60Hz one.
  if (now - painted < FRAME_MS - 1.5) return;
  painted = now;
  for (const follower of followers) paint(follower, now);
}

/**
 * Turns the hues of `element`'s stars, at most 30 times a second on one frame loop shared by every
 * lamp, until the returned function hands them back to the stylesheet's still hues.
 */
export function followLampStarSpectrum(element: SVGElement, count: number): () => void {
  const follower: Follower = { element, spectrum: createLampStarSpectrum(count) };
  followers.add(follower);
  paint(follower, performance.now());
  if (frame === 0) frame = requestAnimationFrame(tick);
  return () => {
    followers.delete(follower);
    for (let star = 0; star < count; star += 1) {
      element.style.removeProperty(`--lamp-star-hue-${String(star)}`);
    }
    if (followers.size === 0 && frame !== 0) {
      cancelAnimationFrame(frame);
      frame = 0;
    }
  };
}
