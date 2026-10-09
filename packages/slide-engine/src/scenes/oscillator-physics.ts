/** Ideal, undamped hanging spring: x is extension below the unstretched position
 * in m (positive down), v in m/s, m in kg, k in N/m.
 * Changing k preserves x and v. The external adjustment does work
 * ΔE = ½ Δk x²; energy is conserved only while k is constant.
 */
export type OscillatorState = { x: number; v: number; time: number };
export const OSCILLATOR_MASS = 1;
export const INITIAL_DISPLACEMENT = 0.65;
export const GRAVITY = 9.81;

// Dimensionless geometry of the ideal close-coiled spring demonstration.
// Fixed shear modulus, mean coil diameter and active turn count: k ∝ d⁴.
// This is not a material-strength or finite-deformation design calculation.
export function wireDiameterRatio(k: number, referenceK = 4) {
  if (!(k > 0) || !(referenceK > 0)) throw new RangeError("Stiffness must be positive.");
  return (k / referenceK) ** 0.25;
}

export function advanceOscillator(state: OscillatorState, k: number, dt: number, mass = OSCILLATOR_MASS, gravity = GRAVITY): OscillatorState {
  if (!Number.isFinite(k) || k <= 0 || !Number.isFinite(mass) || mass <= 0 || !Number.isFinite(dt) || dt < 0) {
    throw new RangeError("Spring stiffness and mass must be positive; time step must be finite and non-negative.");
  }
  if (dt === 0) return { ...state };
  const omega = Math.sqrt(k / mass);
  const equilibrium = mass * gravity / k;
  const displacement = state.x - equilibrium;
  const c = Math.cos(omega * dt), s = Math.sin(omega * dt);
  return { x: equilibrium + displacement * c + state.v / omega * s, v: state.v * c - displacement * omega * s, time: state.time + dt };
}

export function oscillatorQuantities(state: OscillatorState, k: number, mass = OSCILLATOR_MASS, gravity = GRAVITY) {
  const omega = Math.sqrt(k / mass);
  const kinetic = mass * state.v ** 2 / 2;
  const potential = k * state.x ** 2 / 2;
  const gravitational = -mass * gravity * state.x;
  return { omega, period: 2 * Math.PI / omega, equilibrium: mass * gravity / k,
    force: mass * gravity - k * state.x, kinetic, potential, gravitational, energy: kinetic + potential + gravitational };
}

/** Fixed-k comparison scene. Gravitational potential is zero at the lower
 * turning point, a fixed reference, so all three energy bars are non-negative.
 * The spring energy uses absolute extension, NOT displacement from equilibrium.
 */
export function hangingSpringEnergy(time: number) {
  const k = 4, mass = OSCILLATOR_MASS, amplitude = INITIAL_DISPLACEMENT;
  const equilibrium = mass * GRAVITY / k;
  const bottom = equilibrium + amplitude;
  const state = advanceOscillator({ x: bottom, v: 0, time: 0 }, k, time);
  const q = oscillatorQuantities(state, k);
  const gravitational = q.gravitational + mass * GRAVITY * bottom;
  return { ...state, k, mass, amplitude, displacement: state.x - equilibrium,
    equilibrium, force: q.force, kinetic: q.kinetic, elastic: q.potential,
    gravitational, total: q.kinetic + q.potential + gravitational,
    totalAtStart: k * bottom ** 2 / 2 };
}
