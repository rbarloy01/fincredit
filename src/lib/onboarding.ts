// Analyst onboarding: guided tour, favorite-indicator picker and a permanent glossary.
// Content lives here (pure data) so the tour, the help center and the tests share one source, and so the business-rule
// explanations are read from the same constants the app computes with (portfolioRules) instead of being retyped.

import { DPD_PROXY_DAYS, QUALITY_RULES } from './portfolioRules';

export const ONBOARDING_VERSION = 1;
export const onboardingKey = (userId: string) => `finmonitor_onboarding_${userId}`;

export interface OnboardingRecord {
  version: number;
  completedAt?: string;
  skippedAt?: string;
  favorites?: string[];
}

export const needsOnboarding = (record: OnboardingRecord | null | undefined): boolean =>
  !record || (record.version ?? 0) < ONBOARDING_VERSION || (!record.completedAt && !record.skippedAt);

export type TourRoute = 'dashboard' | 'clients' | 'benchmarking' | 'lifecycle' | 'zscore' | 'settings';

export interface TourStep {
  id: string;
  title: string;
  lead: string;
  bullets: string[];
  target?: string;                 // data-tour attribute of the element to highlight
  route?: TourRoute;               // screen to show behind the step
  kind?: 'favorites';
}

const TOUR_STEP_COUNT = 12; // guarded by a test against TOUR_STEPS.length
export const TOUR_STEPS: TourStep[] = [
  {
    id: 'welcome', title: 'Bienvenido a FinMonitor', lead: 'En un par de minutos te mostramos cómo se lee un cliente y cómo dejar la app a tu medida.',
    bullets: [`Este recorrido tiene ${TOUR_STEP_COUNT} pasos y puedes saltarlo o repetirlo cuando quieras desde «Ayuda y tour».`, 'A mitad del recorrido eliges tus indicadores favoritos: aparecerán primero en el seguimiento de cada cliente.'],
  },
  {
    id: 'dashboard', title: 'Dashboard: qué requiere tu atención', lead: 'Es el punto de partida del día.', target: 'nav-dashboard', route: 'dashboard',
    bullets: ['Resume la cartera de clientes y marca cuáles tienen señales de riesgo.', 'Los clientes con estados financieros en revisión no se cuentan hasta que alguien los apruebe.', 'Desde aquí abres directamente el cliente que quieras revisar.'],
  },
  {
    id: 'clients', title: 'Clientes y su estatus', lead: 'Cada cliente tiene un estatus que decide si se monitorea.', target: 'nav-clients', route: 'clients',
    bullets: ['Activo: se monitorea y puede marcarse en alerta o incumplimiento.', 'Dormido o terminado: no se monitorea. Nunca se marca incumplimiento en indicadores, estados financieros ni contrato.', 'Dentro de un cliente encontrarás todas sus pestañas; las siguientes tarjetas te explican las más importantes.'],
  },
  {
    id: 'financials', title: 'Estados financieros y Conciliación', lead: 'Aquí sube y revisa la información contable.',
    bullets: ['Cada estado se califica al subirlo: cuadre del balance, escala (miles contra pesos), signos y coherencia contra el periodo anterior.', 'Si la calidad es baja queda «en revisión» y se excluye del análisis hasta que lo apruebes. Verás cuánto tardó la extracción y qué tan confiable salió.', 'Reclasificar una cuenta se hace en Estados Financieros y sí cambia los cálculos. Conciliación es solo lectura: muestra qué falta o sobra para que cuadre.'],
  },
  {
    id: 'loantape', title: 'Loan Tape: reglas de la cartera', lead: 'Todas las pantallas usan la misma definición de calidad.',
    bullets: [`Vigente: 0 a ${QUALITY_RULES.vigenteMaxDpd} días de atraso. Atrasada: ${QUALITY_RULES.vigenteMaxDpd + 1} a ${QUALITY_RULES.atrasadaMaxDpd}. Vencida: ${QUALITY_RULES.atrasadaMaxDpd + 1} o más.`, '«Al corriente» (0 días) es solo un bucket dentro de vigente.', `Si el archivo trae un monto en mora pero no días, se asignan ${DPD_PROXY_DAYS} días (atrasada, el mínimo) y la carga te avisa cuántos créditos son estimados.`, 'Sin ID de crédito, los cortes se cruzan por una huella (cliente, monto, fechas, renta) y la matriz de migración te dice qué porcentaje del saldo se reencontró.'],
  },
  {
    id: 'indicators', title: 'Indicadores Financieros y mapa de fórmulas', lead: 'Cada indicador muestra de dónde sale su número.',
    bullets: ['El mapa de fórmulas lista las cuentas que alimentan cada indicador y su valor en el último corte.', 'Un insumo sin dato se toma como 0: el mapa lo marca en rojo («sin dato → 0») porque el resultado puede estar mal. Revisa el mapeo de cuentas.', 'ROA, ROE y Deuda/EBITDA se anualizan cuando el periodo es acumulado, salvo que el indicador tenga un límite de contrato (se mide literal).'],
  },
  {
    id: 'favorites', title: 'Elige tus indicadores favoritos', lead: 'Los favoritos aparecen primero en el storyline de cada cliente, con su tendencia y una lectura automática.', kind: 'favorites',
    bullets: ['Parte de una selección sugerida según el tipo de cliente o marca los tuyos.', 'Los puedes cambiar cuando quieras con el pin de cada indicador.'],
  },
  {
    id: 'benchmark', title: 'Benchmarking: compara a tus clientes', lead: 'Ubica a cada cliente contra los demás.', target: 'nav-benchmarking', route: 'benchmarking',
    bullets: ['Muestra cada indicador con su mediana o promedio y permite filtrar la muestra por entidad jurídica, producto, segmento, modelo de fondeo, geografía, antigüedad y más.', 'Distingue periodos mensuales de acumulados para no comparar un cierre de 4 meses contra uno de 12.', 'Los clientes dormidos y terminados forman parte de la muestra como referencia: su historia hace más robusta la comparación.'],
  },
  {
    id: 'lifeline', title: 'Línea de vida del crédito', lead: 'La historia completa de un cliente en un solo lugar.', target: 'nav-lifecycle', route: 'lifecycle',
    bullets: ['Junta en una línea del tiempo las disposiciones, pagos, cambios de aforo, estados financieros, loan tapes y covenants.', 'Incluye las facilities y un «pulso del crédito» con la salud neta: eventos buenos contra eventos de deterioro.', 'Úsala para preparar un comité: ves qué cambió, cuándo y qué pasó antes.'],
  },
  {
    id: 'zscore', title: 'Z-Score y estatus de default', lead: 'Seguimiento de la clasificación de riesgo de cada empresa.', target: 'nav-zscore', route: 'zscore',
    bullets: ['Hoy el Z-Score y su clasificación se capturan manualmente por cliente; la fórmula automática todavía no está definida y la pantalla lo dice.', 'Aquí también registras si una empresa cayó en default, con su fecha y notas.', 'Cuando se defina la fórmula, se calculará en esta misma pantalla sin cambiar cómo la usas.'],
  },
  {
    id: 'assistant', title: 'Asistente IA', lead: 'Pregunta sobre un cliente o sobre toda la cartera, desde cualquier pantalla.', target: 'assistant', route: 'dashboard',
    bullets: ['Se abre y se cierra con este botón o con ⌘/Ctrl + J, y conserva la conversación.', 'Responde solo con lo que la app ya calculó y cita periodo y cifra. Si falta un dato, te dice cuál.', 'El selector de arriba cambia entre Cartera general y cada cliente.'],
  },
  {
    id: 'settings', title: 'Configuración', lead: 'Lo que ajusta la plataforma (solo la ven los managers).', target: 'nav-settings', route: 'settings',
    bullets: ['Motor de IA: qué proveedor y modelo usa cada tarea (estados financieros, contratos, loan tape, asistente…).', 'Usuarios: aprobar a las personas nuevas y asignar su rol de analista o manager.', 'Salud del despliegue y cambio de contraseña. Si no ves esta opción en tu menú, la administra un manager: pídele el ajuste que necesites.'],
  },
];

// ── Favorite indicators ─────────────────────────────────────────────────────────────────────────────────────────────
export interface IndicatorGroup { title: string; items: string[] }
// Names must match the standard ratio labels (guarded by a test) because favorites are stored by indicator name.
export const INDICATOR_GROUPS: IndicatorGroup[] = [
  { title: 'Capitalización y solvencia', items: ['ICAP', 'ICAP Ajustado', 'Apalancamiento', 'Deuda / Capital'] },
  { title: 'Rentabilidad', items: ['ROA', 'ROE', 'Margen Neto', 'Rentabilidad Operativa'] },
  { title: 'Margen y eficiencia', items: ['Margen Financiero', 'Eficiencia Operativa', 'Rendimiento de Cartera (Yield)', 'Costo de Fondeo Aproximado', 'Spread Financiero Aproximado'] },
  { title: 'Calidad de cartera', items: ['Cartera Vencida', 'Cartera Vencida Neta', 'Índice de Cobertura de Cartera Vencida', 'Cartera Vencida / Capital Contable'] },
  { title: 'Liquidez y cobertura de deuda', items: ['Razón Corriente', 'Liquidez Inmediata', 'DSCR', 'Deuda / EBITDA', 'Cobertura de Deuda'] },
];

export interface FavoritePreset { id: string; label: string; hint: string; items: string[] }
export const FAVORITE_PRESETS: FavoritePreset[] = [
  { id: 'arrendadora', label: 'Arrendadora', hint: 'Capital, rentabilidad y servicio de deuda', items: ['ICAP', 'ROA', 'Apalancamiento', 'Razón Corriente', 'DSCR', 'Deuda / EBITDA'] },
  { id: 'sofom', label: 'SOFOM / crédito', hint: 'Calidad de cartera y margen financiero', items: ['ICAP', 'ICAP Ajustado', 'Cartera Vencida', 'Índice de Cobertura de Cartera Vencida', 'Margen Financiero', 'Spread Financiero Aproximado'] },
  { id: 'factoraje', label: 'Factoraje', hint: 'Liquidez, fondeo y cartera', items: ['Cartera Vencida', 'Liquidez Inmediata', 'Apalancamiento', 'ROE', 'Costo de Fondeo Aproximado', 'ICAP'] },
  { id: 'esencial', label: 'Lo esencial', hint: 'Cuatro indicadores para empezar', items: ['ICAP', 'ROA', 'Apalancamiento', 'Cartera Vencida'] },
];

// ── Glossary (help center) ──────────────────────────────────────────────────────────────────────────────────────────
export interface GlossaryEntry { term: string; text: string }
export const GLOSSARY: GlossaryEntry[] = [
  { term: 'Vigente / atrasada / vencida', text: `Vigente: 0-${QUALITY_RULES.vigenteMaxDpd} días de atraso; atrasada: ${QUALITY_RULES.vigenteMaxDpd + 1}-${QUALITY_RULES.atrasadaMaxDpd}; vencida: ${QUALITY_RULES.atrasadaMaxDpd + 1} o más. Todas las pantallas, exportaciones y el asistente usan esta definición.` },
  { term: 'DPD estimado', text: `Si el archivo solo trae un monto en mora, los días se derivan de la fecha de vencimiento; sin fecha se asignan ${DPD_PROXY_DAYS} (atrasada). Nunca se asume vencida sin evidencia.` },
  { term: 'Cliente dormido o terminado', text: 'No se monitorea: no se marca incumplimiento y se excluye de alertas. Se ve con la etiqueta «Sin monitoreo».' },
  { term: 'Estado «en revisión»', text: 'Un estado financiero que no pasó la puerta de calidad (cuadre, escala, signos, coherencia). Se excluye del análisis hasta que lo apruebes.' },
  { term: 'Periodo acumulado y anualización', text: 'Los estados intermedios suelen acumular enero→mes. Los ratios de resultados (ROA, ROE, rendimiento, costo de fondeo, Deuda/EBITDA) se anualizan con 12 / meses del periodo para poder compararlos.' },
  { term: 'Indicador con límite de contrato', text: 'Se mide literal, tal como lo define el contrato, sin anualizar. Los indicadores sin límite se comparan anualizados.' },
  { term: 'Sin dato → 0', text: 'En fórmulas propias un insumo sin dato se evalúa como 0. El mapa de fórmulas lo marca para que revises el mapeo de cuentas.' },
  { term: 'Huella del crédito', text: 'Cuando el loan tape no trae ID, el mismo crédito se identifica entre cortes con cliente, monto, fechas, renta, tasa y producto. Solo se aceptan cruces uno a uno.' },
  { term: 'Confianza de la extracción', text: 'Alta, media, baja o bloqueada, según los chequeos del documento. Baja o bloqueada requiere tu revisión.' },
  { term: 'Benchmark', text: 'Compara a los clientes entre sí con la mediana o el promedio de la muestra. Incluye dormidos y terminados como referencia y distingue periodos mensuales de acumulados.' },
  { term: 'Z-Score', text: 'Por ahora se captura manualmente por cliente junto con su clasificación y el estatus de default; el cálculo automático aún no está definido.' },
  { term: 'Línea de vida', text: 'Cronología del crédito de un cliente: disposiciones, pagos, aforo, estados financieros, loan tapes y covenants, con un pulso de salud neta.' },
  { term: 'Favoritos', text: 'Indicadores que marcas con el pin. Van primero en el storyline y tienen su propia lectura: rachas, holgura contra el límite y pronóstico.' },
];

export const SHORTCUTS: GlossaryEntry[] = [
  { term: '⌘/Ctrl + J', text: 'Abrir o cerrar el Asistente IA.' },
  { term: '← / →', text: 'Moverte entre los pasos del tour.' },
];

export function applyPreset(presetId: string): string[] {
  return FAVORITE_PRESETS.find(p => p.id === presetId)?.items ?? [];
}
