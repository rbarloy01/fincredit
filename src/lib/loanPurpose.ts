// Destino del crédito: los clientes lo reportan como texto libre que escribe el acreditado (Red Girasol:
// "Project Finances → Loan Use Reason", 134 respuestas distintas). Para el dashboard se agrupa con reglas de
// palabras clave, sin IA. El texto original se conserva; el que viene vacío se reporta como "Sin dato".

export const PURPOSE_NO_DATA = 'Sin dato';
export const PURPOSE_OTHER = 'Otro';

const RULES: Array<[string, RegExp]> = [
  ['Pago de deudas / consolidación', /deud|tarjeta|liquidacion de|liquidar|pagar (mis |un |el |la )?(credito|prestamo|deuda)|consolid|refinanc|saldar|pasivo/],
  ['Energía solar / eficiencia', /solar|fotovolt|panel|energia|bateri|emision|eficien/],
  ['Agro / producción primaria', /siembra|cosecha|cultiv|cafe|miel|apicol|agric|ganad|riego|acopio|huerta|invernader|semilla|fertiliz/],
  ['Terreno / construcción / remodelación', /terreno|constru|contru|obra|departament|residencia|inmobiliar|inmueble|edific|remodel|renovacion|acondicion|lote|hotel|quinta/],
  ['Mejoras al hogar', /mejoras? (a|en) (la |mi )?casa|hogar|vivienda|ampliacion/],
  ['Capital de trabajo / inventario', /mercanc|inventar|materia prima|material|capital de trabajo|insumo|proveedor|nomina|operaci|flujo|empaque|comercializ/],
  ['Maquinaria / equipo / activos', /equip|maquinar|vehicul|camion|activo|tecnolog|herramient|montacarg|planta|refriger|lavador|vitrina/],
  ['Expansión del negocio / proyectos', /expan|sucursal|crecim|proyecto|negocio|invertir|inversion|emprend/],
  ['Gastos personales', /personal|viaje|escuela|colegiatura|salud|medic|modalidad 40|boda|capacitacion/],
];

export function purposeCategory(text: string | null | undefined): string {
  const raw = String(text ?? '').trim();
  if (!raw) return PURPOSE_NO_DATA;
  const n = raw.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');
  return RULES.find(([, rx]) => rx.test(n))?.[0] || PURPOSE_OTHER;
}
