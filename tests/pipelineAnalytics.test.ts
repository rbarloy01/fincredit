import assert from 'node:assert/strict';
import test from 'node:test';
import { buildPipelineSummary, computeStageCycleTimes } from '../src/lib/pipelineAnalytics';

test('pipeline summary ignores negative and implausible deal velocity values', () => {
  const clients = [
    { id: 'c1', name: 'Cliente A', createdAt: '2026-01-01T00:00:00Z' },
    { id: 'c2', name: 'Cliente B', createdAt: '2026-01-02T00:00:00Z' },
    { id: 'c3', name: 'Cliente C', createdAt: '2026-01-03T00:00:00Z' },
  ] as any;

  const summary = buildPipelineSummary(clients, {}, {
    c1: { underwriting: null, monitoring: [], historial: [{ resultado: 'Aprobado', dealVelocityDias: -9145 }] },
    c2: { underwriting: null, monitoring: [], historial: [{ resultado: 'Aprobado', dealVelocityDias: 42 }] },
    c3: { underwriting: null, monitoring: [], historial: [{ resultado: 'Aprobado', dealVelocityDias: 5000 }] },
  } as any, new Date('2026-09-03T00:00:00Z'));

  assert.equal(summary.eficiencia.dealVelocityPromedioDias, 42);
});

test('stage cycle times ignore out-of-order activity dates', () => {
  const cycles = computeStageCycleTimes({
    c1: [
      { nextStage: '1. Contacto', createdAt: '2026-02-10T00:00:00Z' },
      { nextStage: '2. Term Sheet', createdAt: '2026-02-01T00:00:00Z' },
    ],
    c2: [
      { nextStage: '1. Contacto', createdAt: '2026-02-01T00:00:00Z' },
      { nextStage: '2. Term Sheet', createdAt: '2026-02-11T00:00:00Z' },
    ],
  } as any);

  assert.equal(cycles.find(item => item.stage === '1. Contacto')?.avgDays, 10);
});
