import assert from "node:assert/strict";
import test from "node:test";
import * as T from "three";
import { advanceOscillator, oscillatorQuantities, wireDiameterRatio, hangingSpringEnergy, GRAVITY } from "./oscillator-physics";
import { createModellSceneState, trainModellStep, modellLoss, modellLanguageContexts } from "./modell-state";
import { createModellSceneFactories } from "./modell-factories";

const close = (a: number, b: number, tolerance = 1e-9) => assert.ok(Math.abs(a-b) < tolerance, `${a} != ${b}`);

test("softer hanging spring has greater static sag and a longer period", () => {
  const s = { x: 0, v: 0, time: 0 };
  const soft = oscillatorQuantities(s, 1), stiff = oscillatorQuantities(s, 9);
  close(soft.equilibrium, GRAVITY); close(stiff.equilibrium, GRAVITY / 9);
  close(soft.period / stiff.period, 3);
  for (const k of [1, 2.5, 4, 9]) {
    const rest = { x: GRAVITY/k, v: 0, time: 0 };
    const after = advanceOscillator(rest, k, 7);
    close(after.x, rest.x); close(after.v, 0);
  }
});

test("stiffness change preserves position/velocity, with correct adjustment work", () => {
  const before = advanceOscillator({ x: GRAVITY / 4 + .65, v: 0, time: 0 }, 4, .71);
  for (const k of [1, 2.5, 9]) {
    assert.deepEqual(advanceOscillator(before, k, 0), before);
    close(oscillatorQuantities(before, k).energy - oscillatorQuantities(before, 4).energy, .5*(k-4)*before.x**2);
    const dt = 1e-6, after = advanceOscillator(before, k, dt);
    close((after.x-before.x)/dt, before.v, 1e-4);
    close((after.v-before.v)/dt, GRAVITY-k*before.x, 1e-4);
  }
});

test("gravity-inclusive mechanical energy and period survive variable frame rates", () => {
  for (const k of [1, 2.5, 4, 9]) {
    const initial = { x: GRAVITY/k+.65, v: .2, time: 0 };
    const q = oscillatorQuantities(initial, k);
    const cycle = advanceOscillator(initial, k, q.period);
    close(cycle.x, initial.x); close(cycle.v, initial.v);
    let state = initial;
    for (let i=0; i<3000; i++) state=advanceOscillator(state,k,[.016,.033,.065][i%3]);
    close(oscillatorQuantities(state,k).energy,q.energy,1e-8);
  }
});

test("wire thickness follows k ∝ d⁴, not linear visual inflation", () => {
  close(wireDiameterRatio(9)/wireDiameterRatio(1), Math.sqrt(3));
  for(const k of [1,2.5,4,9]) close(wireDiameterRatio(k)**4 * 4,k);
});

function scene(key: "law" | "limits" | "runtime" | "learning" | "language" | "miniature" | "transfer") {
  const state=createModellSceneState(true), root=new T.Group();
  const instance=createModellSceneFactories(T)[key](root, (_a,text)=>({textContent:text} as HTMLElement),state);
  return {state,root,instance};
}

test("law mesh, trace and theme reconstruction share one persistent state", () => {
  const {state,root,instance}=scene("law");
  instance.update(.5,.5);
  const before={...state.oscillator}; const history=structuredClone(state.oscillatorTrace);
  const y=root.getObjectByName("law-mass")!.position.y;
  state.stiffness=9;instance.update(.5,0);
  assert.deepEqual(state.oscillator,before);assert.deepEqual(state.oscillatorTrace,history);
  close(root.getObjectByName("law-mass")!.position.y,y);
  const replacement=new T.Group();
  createModellSceneFactories(T).law(replacement,(_a,text)=>({textContent:text} as HTMLElement),state).update(.5,0);
  close(replacement.getObjectByName("law-mass")!.position.y,y);
  close(root.userData.physics.x,state.oscillator.x);
  assert.equal(root.getObjectByName("law-time-trace")!.type,"Line");
  state.oscillatorTrace.push({x:25,time:state.oscillator.time});
  instance.update(.5,0);
  close(root.getObjectByName("law-mass")!.position.y,y);
});

test("three physical energies share one scale and conserve their sum", () => {
  const bottom=hangingSpringEnergy(0),top=hangingSpringEnergy(Math.PI/2);
  close(bottom.kinetic,0);close(bottom.gravitational,0);
  close(top.kinetic,0);assert.ok(top.gravitational>0);
  assert.ok(bottom.elastic>top.elastic); // Unlike the old cos² 'spring energy'.
  for(let i=0;i<1000;i++){
    const q=hangingSpringEnergy(i*.017);
    close(q.kinetic+q.elastic+q.gravitational,q.totalAtStart);
    close(q.elastic,.5*q.k*q.x**2);
    close(q.gravitational,q.mass*GRAVITY*(bottom.x-q.x));
    assert.ok(q.kinetic>=0&&q.elastic>=0&&q.gravitational>=-1e-12);
  }
});

test("force vanishes at equilibrium; all three rendered energy bars use physical joules", () => {
  const {root,instance}=scene("limits");
  for(let i=0;i<=24;i++) {
    instance.update(i*Math.PI/24,0);
    const q=root.userData.physics;
    close(q.kinetic+q.elastic+q.gravitational,q.totalAtStart);
    assert.ok(q.force*q.displacement<=1e-12);
    for(const key of ["kinetic","elastic","gravitational"]){
      close(root.getObjectByName(`energy-${key}`)!.scale.y,2.4*q[key]/q.totalAtStart);
    }
  }
  instance.update(Math.PI/4,0);
  assert.equal(root.children.find(o=>o.type==="ArrowHelper")!.visible,false);
});

test("pausing and rebuilding actuator never teleports its actual angle to the target", () => {
  const {root,state,instance}=scene("runtime");
  instance.update(.1,.1); const angle=state.servoAngle;
  assert.ok(angle>0&&angle<state.outputAngle);
  state.outputAngle=-60;instance.update(.1,0);close(state.servoAngle,angle);
  state.executing=false;instance.update(2,1.9);close(state.servoAngle,angle);
  createModellSceneFactories(T).runtime(root,(_a,text)=>({textContent:text} as HTMLElement),state).update(2,0);
  close(state.servoAngle,angle);
});

test("learning really reduces error and zero time never consumes queued steps", () => {
  const state=createModellSceneState(true), before=modellLoss(state);
  state.trainingRunning=true;state.accumulator=3;
  trainModellStep(state,0);assert.equal(state.steps,0);
  for(let i=0;i<200;i++)trainModellStep(state,.05);
  assert.equal(state.steps,600);assert.equal(state.trainingRunning,false);
  assert.ok(modellLoss(state)<before/100);
  for(const context of modellLanguageContexts)close(context.candidates.reduce((s,[,p])=>s+Number(p),0),100);
});
