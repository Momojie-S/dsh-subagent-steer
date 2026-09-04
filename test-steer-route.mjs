/**
 * Unit tests for the pure steering contract (gate ① of the development
 * verification flow). Imports the compiled lib/index.js — run after build:
 *
 *   node --test
 */
import test from 'node:test'
import assert from 'node:assert/strict'

import { resolveRoute, buildToolDescription, renderSteer } from './lib/index.js'

test('resolveRoute: mode turn wins over residency (hard redirect)', () => {
  assert.equal(resolveRoute('turn', true, true), 'turn')
  assert.equal(resolveRoute('turn', true, false), 'turn')
  assert.equal(resolveRoute('turn', false, false), 'turn')
})

test('resolveRoute: step mode on a live running child takes the steer path', () => {
  assert.equal(resolveRoute(undefined, true, true), 'step')
  assert.equal(resolveRoute('step', true, true), 'step')
})

test('resolveRoute: step mode falls back to wakeup for a live idle child', () => {
  assert.equal(resolveRoute(undefined, true, false), 'wakeup')
  assert.equal(resolveRoute('step', true, false), 'wakeup')
})

test('resolveRoute: unknown mode reads as step (default)', () => {
  assert.equal(resolveRoute('aggressive', true, true), 'step')
  assert.equal(resolveRoute(undefined, false, false), 'cold-resume')
})

test('resolveRoute: a cold target always cold-resumes via the service path', () => {
  assert.equal(resolveRoute(undefined, false, false), 'cold-resume')
  assert.equal(resolveRoute('step', false, false), 'cold-resume')
})

test('tool description teaches the difference from the stock tools', () => {
  const d = buildToolDescription()
  // names the stock queue tool and states its queueing semantics
  assert.match(d, /send_message/)
  assert.match(d, /queues the message as a LATER turn/)
  // states this tool's insert semantics and what is kept
  assert.match(d, /INTO the current turn/)
  assert.match(d, /next step boundary/)
  assert.match(d, /work already completed is kept/)
  // names the stock interrupt tool and the hard-mode equivalence
  assert.match(d, /interrupt_agent/)
  // usage guidance: when to prefer which
  assert.match(d, /additional work that can safely wait/)
  assert.match(d, /redirect work that is underway/)
  // fallback semantics match send_message
  assert.match(d, /same FIFO guarantees as `send_message`/)
})

test('renderSteer covers every route', () => {
  assert.match(renderSteer('step', 'c-1'), /inserted into the current turn/)
  assert.match(renderSteer('turn', 'c-1'), /interrupted/)
  assert.match(renderSteer('cold-resume', 'c-1'), /cold resume/)
  assert.match(renderSteer('wakeup', 'c-1'), /idle/)
})
