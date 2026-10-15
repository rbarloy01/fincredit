import assert from 'node:assert/strict';
import test from 'node:test';
import { effectiveWaRate, loanRateBasis, rateIsSpreadColumn, rateProfile } from '../src/lib/loanTapeRates';

const loan = (rate: number, bal: number, base: string | null = null) => ({ interest_rate: rate, outstanding_balance: bal, rate_base: base }) as any;

test('base por crédito: "TIIE" = sobretasa; "Fija" = tasa total (Afix trae ambos)', () => {
  assert.equal(loanRateBasis({ rate_base: 'TIIE' }, true), 'tiie');
  assert.equal(loanRateBasis({ rate_base: 'Fija' }, true), 'fija');
  assert.equal(loanRateBasis({ rate_base: 'Variable' }, false), 'tiie');
  assert.equal(loanRateBasis({ rate_base: null }, true), 'tiie_supuesto');   // columna "sobretasa" sin base
  assert.equal(loanRateBasis({ rate_base: null }, false), 'fija');
  assert.ok(rateIsSpreadColumn([{ target_term: 'interest_rate', source_header: 'Sobre Tasa' } as any]));
  assert.ok(rateIsSpreadColumn([{ target_term: 'interest_rate', source_header: 'Tasa / Sobretasa Acreditado' } as any]));
  assert.ok(!rateIsSpreadColumn([{ target_term: 'interest_rate', source_header: 'Tasa Interes' } as any]));
});

test('tasa efectiva ponderada = reportada + TIIE × % de la cartera a TIIE', () => {
  // Afix: 600 a TIIE + 13%, 400 fija 24% → reportada 17.4%; con TIIE 7.5%: 17.4% + 7.5% × 60% = 21.9%.
  const p = rateProfile([loan(0.13, 600, 'TIIE'), loan(0.24, 400, 'Fija')], true);
  assert.ok(Math.abs(p.waReported! - 0.174) < 1e-12);
  assert.ok(Math.abs(p.variableShare - 0.6) < 1e-12);
  assert.equal(p.assumedShare, 0);
  assert.ok(Math.abs(effectiveWaRate(p, 7.5)! - 0.219) < 1e-12);
  assert.equal(effectiveWaRate(p, null), null);                      // sin TIIE no se inventa
  // Swell: todo fijo → la TIIE no cambia nada.
  const fixed = rateProfile([loan(0.26, 100, 'Fija'), loan(0.2, 100, 'Fija')], false);
  assert.equal(effectiveWaRate(fixed, null), 0.23);
});

test('archivo con columna de base: base vacía = tasa fija (no supuesto)', () => {
  const p = rateProfile([loan(0.13, 340, 'TIIE'), loan(0.24, 660, null)], true);
  assert.ok(Math.abs(p.variableShare - 0.34) < 1e-12);
  assert.equal(p.assumedShare, 0);
  const q = rateProfile([loan(0.115, 100, null)], true);       // COFINE: sin columna de base → supuesto
  assert.equal(q.assumedShare, 1);
});
