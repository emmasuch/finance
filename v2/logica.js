/*
 * Mi presupuesto v2 · lógica (sin hoja de Google)
 * Portado de planner-script/Codigo.gs (API v16). Sin dependencias: funciona en el navegador
 * (window.Logica) y en Node (require) para las pruebas.
 *
 * Fechas: siempre texto 'yyyy-mm-dd' (se comparan como texto). Importes: números con 2 decimales.
 * Movimiento (forma interna, igual que todosMovimientos_ de v16 pero con campos en vez de texto):
 *   { id, fecha, tipo, cat, conc, imp, cuenta, hacia, estado, notas, parte,
 *     pagadoPor, de, pagoA, ajuste, origen }   ← cat/cuenta/pagadoPor… son nombres
 */
(function (raiz, fabrica) {
  if (typeof module === 'object' && module.exports) module.exports = fabrica();
  else raiz.Logica = fabrica();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const MESES = ['enero', 'febrero', 'marzo', 'abril', 'mayo', 'junio', 'julio', 'agosto', 'septiembre', 'octubre', 'noviembre', 'diciembre'];
  const PENDIENTES = ['Previsto', 'Por confirmar'];
  const TIPOS = ['Gasto', 'Ingreso', 'Reintegro', 'Transferencia', 'Ahorro / inversión'];
  const ROLES = { dia_a_dia: 'Día a día', emergencia: 'Fondo de emergencia', inversion: 'Inversión', ahorro: 'Ahorro' };
  const red = (x) => Math.round((Number(x) || 0) * 100) / 100;

  /* ───── Fechas ───── */
  const pad = (n) => String(n).padStart(2, '0');
  const ymd = (d) => d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate());
  const aFecha = (s) => { const [y, m, d] = String(s).split('-').map(Number); return new Date(y, m - 1, d); };
  const diasDelMes = (y, m) => new Date(y, m + 1, 0).getDate();
  const sumarDias = (s, n) => { const d = aFecha(s); return ymd(new Date(d.getFullYear(), d.getMonth(), d.getDate() + n)); };
  const dmy = (s) => { const [y, m, d] = s.split('-'); return d + '/' + m + '/' + y; };
  const mayus = (s) => s ? s.charAt(0).toUpperCase() + s.slice(1) : s;

  /** Día `dia` del mes (y, m), sin pasarse del último día. */
  const diaEnMes = (y, m, dia) => new Date(y, m, Math.min(dia, diasDelMes(y, m)));

  /**
   * Ciclo que contiene `hoy`, empezando el día de cobro. Con dia = 28: del 28 al 27 del mes siguiente.
   * Igual que v16: fin = EDATE(inicio, 1) − 1.
   */
  function ciclo(hoy, dia) {
    dia = Number(dia) || 28;
    const h = aFecha(hoy);
    let ini = diaEnMes(h.getFullYear(), h.getMonth(), dia);
    if (ini > h) ini = diaEnMes(h.getFullYear(), h.getMonth() - 1, dia);
    return cicloDesde(ymd(ini), dia);
  }
  function cicloDesde(inicio, dia) {
    const i = aFecha(inicio);
    dia = Number(dia) || i.getDate();
    const sig = diaEnMes(i.getFullYear(), i.getMonth() + 1, dia);
    const fin = ymd(new Date(sig.getFullYear(), sig.getMonth(), sig.getDate() - 1));
    const f = aFecha(fin);
    return { inicio: inicio, fin: fin, cierre: sumarDias(fin, 1), nombre: MESES[f.getMonth()] + ' ' + f.getFullYear() };
  }
  /** Ciclo anterior a uno dado. */
  function cicloAnterior(c, dia) { return ciclo(sumarDias(c.inicio, -1), dia); }

  /** Fecha dentro del ciclo para un recurrente del día `dia` (v16 fechaEnCiclo_). */
  function fechaEnCiclo(dia, c) {
    dia = Number(dia);
    if (!dia) return c.inicio;
    const ini = aFecha(c.inicio), fin = aFecha(c.fin);
    const base = dia >= ini.getDate() ? ini : fin;
    let d = ymd(diaEnMes(base.getFullYear(), base.getMonth(), dia));
    if (d < c.inicio) d = c.inicio;
    if (d > c.fin) d = c.fin;
    return d;
  }

  /* ───── Hogar ───── */
  /** miembros: [{nombre, esYo, peso}] → {personas, pesoTotal, miPeso, otros:[...] } */
  function hogar(miembros) {
    const lista = (miembros || []).length ? miembros : [{ nombre: 'Yo', esYo: true, peso: 1 }];
    const yo = lista.find((m) => m.esYo) || lista[0];
    const pesoTotal = lista.reduce((s, m) => s + (Number(m.peso) || 1), 0);
    return {
      personas: lista.length, pesoTotal: pesoTotal, miPeso: Number(yo.peso) || 1, yo: yo.nombre,
      otros: lista.filter((m) => m !== yo).map((m) => ({ nombre: m.nombre, peso: Number(m.peso) || 1 })),
    };
  }

  /** Mi coste personal de un movimiento (v16 formulaParte_). */
  function miParte(m, compartidas, h) {
    if (m.tipo === 'Reintegro') return 0;
    if (m.tipo === 'Gasto' && compartidas.indexOf(m.cat) !== -1 && h.personas > 1) return red(m.imp * h.miPeso / h.pesoTotal);
    return red(m.imp);
  }

  /* ───── Saldos ───── */
  /** [[cuenta, delta]] que mueve un movimiento confirmado (v16 efectosSaldo_). */
  function efectosSaldo(m) {
    const imp = Number(m.imp) || 0;
    if (!imp) return [];
    if (m.tipo === 'Gasto') return [[m.cuenta, -imp]];
    if (m.tipo === 'Ingreso' || m.tipo === 'Reintegro') return [[m.cuenta, imp]];
    if (m.tipo === 'Transferencia' || m.tipo === 'Ahorro / inversión') {
      const e = [[m.cuenta, -imp]];
      if (m.hacia && m.hacia !== m.cuenta) e.push([m.hacia, imp]);
      return e;
    }
    return [];
  }

  /**
   * cuentas: [{nombre, saldoBase, fechaBase, baseEn}] · movs con confirmadoEn (ISO).
   * Saldo = revisado + confirmados posteriores a la revisión (misma regla que la vista SQL `saldos`).
   */
  function saldos(cuentas, movs) {
    const out = {};
    cuentas.forEach((c) => { out[c.nombre] = Number(c.saldoBase) || 0; });
    const porNombre = {};
    cuentas.forEach((c) => { porNombre[c.nombre] = c; });
    movs.forEach((m) => {
      if (m.estado !== 'Confirmado') return;
      efectosSaldo(m).forEach(([cuenta, delta]) => {
        const c = porNombre[cuenta];
        if (!c) return;
        const cuenta_ = m.fecha > c.fechaBase || (m.fecha === c.fechaBase && (m.confirmadoEn || '') > (c.baseEn || ''));
        if (cuenta_) out[cuenta] += delta;
      });
    });
    Object.keys(out).forEach((k) => { out[k] = red(out[k]); });
    return out;
  }

  /* ───── Resumen del ciclo ───── */
  const enCiclo = (m, c) => m.fecha && m.fecha >= c.inicio && m.fecha <= c.fin;

  /**
   * categorias: [{nombre, tipo, grupo, plan}] → totales del ciclo como Presupuesto!H5:H8 y E12:E27 de v16.
   * real de cada categoría = suma de "mi parte" de sus movimientos confirmados del mismo tipo.
   */
  function resumen(categorias, movs, c) {
    const conf = movs.filter((m) => m.estado === 'Confirmado' && enCiclo(m, c));
    const cats = categorias.map((k) => {
      const real = conf.filter((m) => m.cat === k.nombre && m.tipo === k.tipo).reduce((s, m) => s + m.parte, 0);
      return { cat: k.nombre, tipo: k.tipo, plan: Number(k.plan) || 0, real: red(real), fijo: k.grupo === 'fijo', grupo: k.grupo };
    });
    const suma = (tipo, campo) => red(conf.filter((m) => m.tipo === tipo).reduce((s, m) => s + m[campo], 0));
    const ingresos = suma('Ingreso', 'imp');
    const gastos = suma('Gasto', 'parte');
    const ahorro = suma('Ahorro / inversión', 'imp');
    const plan = (t) => red(cats.filter((x) => x.tipo === t).reduce((s, x) => s + x.plan, 0));
    return {
      ciclo: c.nombre, inicio: dmy(c.inicio), fin: dmy(c.fin), cierre: dmy(c.cierre),
      ingresos: ingresos, gastos: gastos, ahorro: ahorro, neto: red(ingresos - gastos - ahorro),
      planGastos: plan('Gasto'), planAhorro: plan('Ahorro / inversión'), ingresosAnotados: plan('Ingreso'),
      categorias: cats,
    };
  }

  /** Pendientes con fecha hasta hoy + dias (v16 pendientes). */
  function pendientes(movs, hoy, dias) {
    const limite = sumarDias(hoy, dias == null ? 8 : dias);
    return movs.filter((m) => PENDIENTES.indexOf(m.estado) !== -1 && (!m.fecha || m.fecha <= limite))
      .sort((a, b) => (a.fecha < b.fecha ? -1 : a.fecha > b.fecha ? 1 : 0));
  }

  /** Gasto personal confirmado por día (gráfica de Inicio). */
  function serie(movs, c, hoy, plan) {
    const dias = {};
    movs.forEach((m) => {
      if (m.estado !== 'Confirmado' || m.tipo !== 'Gasto' || !enCiclo(m, c)) return;
      dias[m.fecha] = red((dias[m.fecha] || 0) + m.parte);
    });
    return { inicio: c.inicio, fin: c.fin, hoy: hoy, plan: plan, dias: dias };
  }

  /* ───── Recurrentes y suscripciones ───── */
  /**
   * Movimientos "Previsto" del ciclo que faltan. Cada uno lleva `origen` único (REC|id|inicio, SUB|id|inicio),
   * y la base de datos no deja repetirlo, así nunca se duplican aunque se abra la app en dos móviles a la vez.
   * rec: [{id, activo, dia, tipo, cat, conc, imp, cuenta, hacia, de, hasta, notas}]
   * subs: [{id, nombre, imp, dia, activa, cat, cuenta}]
   */
  function recurrentesDelCiclo(rec, subs, c, origenesExistentes, catSuscripciones) {
    const ya = new Set(origenesExistentes || []);
    const nombre = c.nombre;
    const out = [];
    (rec || []).forEach((r) => {
      const conc = String(r.conc || '').trim();
      if (!r.activo || !conc || !r.tipo || !r.cat) return;
      if (r.hasta) { const h = aFecha(r.hasta); if (c.fin > ymd(new Date(h.getFullYear(), h.getMonth() + 1, 0))) return; }
      const origen = 'REC|' + r.id + '|' + c.inicio;
      if (ya.has(origen)) return;
      out.push({ fecha: fechaEnCiclo(r.dia, c), tipo: r.tipo, cat: r.cat, conc: conc + ' · ' + nombre, imp: red(r.imp),
        cuenta: r.cuenta || '', hacia: r.hacia || '', de: r.de || '', estado: 'Previsto', origen: origen,
        notas: 'Recurrente generado automáticamente.' + (r.notas ? ' ' + r.notas : '') });
    });
    (subs || []).forEach((s) => {
      if (!s.activa || !(Number(s.imp) > 0)) return;
      const origen = 'SUB|' + s.id + '|' + c.inicio;
      if (ya.has(origen)) return;
      out.push({ fecha: fechaEnCiclo(s.dia, c), tipo: 'Gasto', cat: s.cat || catSuscripciones || '', conc: 'Suscripción ' + s.nombre + ' · ' + nombre,
        imp: red(s.imp), cuenta: s.cuenta || '', hacia: '', estado: 'Previsto', origen: origen, notas: 'Suscripción generada automáticamente.' });
    });
    return out.sort((a, b) => (a.fecha < b.fecha ? -1 : 1));
  }

  /* ───── Cuentas compartidas (v16 calcularCompartidos_) ─────
   * - Una categoría está prepagada para una persona cuando esa persona ya me ha pasado su parte este ciclo
   *   (reintegro confirmado en esa categoría, sin marcar como ajuste).
   * - Los gastos de una categoría prepagada salen del fondo común: no crean deuda a mitad de ciclo,
   *   salvo que se gaste más que el fondo.
   * - Al cierre (hoy ≥ fin) todo se cuadra: si se gastó más de lo aportado me debe la diferencia; si menos, se la debo.
   * - Las categorías no prepagadas reparten cada gasto según la parte de cada persona.
   * Diferencia con v16: quién pagó / quién aporta / a quién pago van en campos (pagadoPor, de, pagoA, ajuste),
   * y la parte de cada persona sale de su peso (con pesos iguales da lo mismo que v16).
   */
  function compartidos(movs, h, plan, c, cats, hoy) {
    const cierre = !!hoy && hoy >= c.fin;
    const P = {};
    h.otros.forEach((o) => { P[o.nombre] = { nombre: o.nombre, peso: o.peso, aport: {}, pagado: {}, prev: {}, pagoEl: 0, leDebes: 0, aportado: 0, devuelto: 0, pagadoAEl: 0, previsto: 0 }; });
    const K = {};
    cats.forEach((cat) => { K[cat] = { cat: cat, total: 0, tuParte: 0, plan: plan[cat] || 0, pagadoOtros: 0, aportado: 0, previstoAport: 0 }; });
    const filas = [];
    const unSoloOtro = h.otros.length === 1 ? h.otros[0].nombre : '';
    movs.forEach((m) => {
      if (!enCiclo(m, c) || m.estado === 'Anulado') return;
      const conf = m.estado === 'Confirmado';
      if (m.tipo === 'Gasto' && K[m.cat]) {
        if (!conf) return;
        filas.push(m.id);
        const k = K[m.cat]; k.total += m.imp; k.tuParte += m.parte;
        const x = m.pagadoPor && P[m.pagadoPor];
        if (x) { x.pagoEl += m.imp; x.leDebes += m.parte; k.pagadoOtros += m.imp; x.pagado[m.cat] = (x.pagado[m.cat] || 0) + m.imp; }
      } else if (m.tipo === 'Reintegro') {
        const n = m.de || (unSoloOtro && K[m.cat] ? unSoloOtro : '');
        const x = P[n];
        if (!x) return;
        filas.push(m.id);
        if (!m.ajuste && K[m.cat]) {
          if (conf) { x.aport[m.cat] = (x.aport[m.cat] || 0) + m.imp; x.aportado += m.imp; K[m.cat].aportado += m.imp; }
          else { x.prev[m.cat] = (x.prev[m.cat] || 0) + m.imp; x.previsto += m.imp; K[m.cat].previstoAport += m.imp; }
        } else if (conf) x.devuelto += m.imp;
        else x.previsto += m.imp;
      } else if (m.tipo === 'Transferencia' && conf && m.pagoA && P[m.pagoA]) {
        P[m.pagoA].pagadoAEl += m.imp; filas.push(m.id);
      }
    });
    const gente = h.otros.map((o) => {
      const x = P[o.nombre];
      let hoyDebe = 0, total = 0, suParte = 0;
      cats.forEach((cat) => {
        const parte = K[cat].total * x.peso / h.pesoTotal, aport = x.aport[cat] || 0;
        const dif = parte - (x.pagado[cat] || 0) - aport;   // > 0: me debe; < 0: le debo
        suParte += parte; total += dif;
        hoyDebe += aport > 0 && !cierre ? Math.max(0, dif) : dif;
      });
      const ajustes = x.pagadoAEl - x.devuelto;
      const porCat = {};
      cats.forEach((cat) => { porCat[cat] = { aportado: red(x.aport[cat] || 0), previsto: red(x.prev[cat] || 0) }; });
      return { nombre: o.nombre, saldo: red(hoyDebe + ajustes), siAcabaHoy: red(total + ajustes), suParte: red(suParte),
        pagoEl: red(x.pagoEl), aportado: red(x.aportado), devuelto: red(x.devuelto), pagadoAEl: red(x.pagadoAEl),
        previsto: red(x.previsto), leDebes: red(x.leDebes), porCat: porCat };
    });
    const pesoOtros = h.pesoTotal - h.miPeso;
    return {
      personas: h.personas, cierre: cierre, fin: c.fin, gente: gente,
      cats: cats.map((cat) => {
        const x = K[cat];
        const fondo = x.aportado > 0 && pesoOtros > 0 ? x.aportado * h.pesoTotal / pesoOtros : 0;
        return { cat: cat, total: red(x.total), tuParte: red(x.tuParte), plan: x.plan, pagadoOtros: red(x.pagadoOtros),
          aportado: red(x.aportado), previstoAport: red(x.previstoAport), fondo: red(fondo), fondoRestante: red(fondo - x.total) };
      }),
      filas: filas,
    };
  }

  /** Movimiento que deja a cero las cuentas con una persona (v16 saldarCompartidos). */
  function movimientoSaldar(persona, hoy, catDefecto, cuenta) {
    if (!persona || Math.abs(persona.saldo) < 0.01) return null;
    return persona.saldo > 0
      ? { fecha: hoy, tipo: 'Reintegro', cat: catDefecto, conc: persona.nombre + ' · ajuste gastos compartidos', imp: red(persona.saldo),
          cuenta: cuenta, estado: 'Confirmado', de: persona.nombre, ajuste: true, notas: 'Saldo de gastos compartidos.' }
      : { fecha: hoy, tipo: 'Transferencia', cat: '', conc: 'Pago a ' + persona.nombre + ' · gastos compartidos', imp: red(-persona.saldo),
          cuenta: cuenta, estado: 'Confirmado', pagoA: persona.nombre, ajuste: true, notas: 'Saldo de gastos compartidos.' };
  }

  /* ───── Categorías automáticas (v16) ───── */
  const PALABRAS_CAT = [
    ['comida', 'mercadona lidl carrefour aldi alcampo eroski consum hipercor supermercado super dia ahorramas froiz gadis bonpreu caprabo condis spar coviran panaderia fruteria carniceria mercado'],
    ['gasolina', 'gasolina gasolinera repsol cepsa galp shell petronor ballenoil plenoil bp combustible diesel'],
    ['gimnasio', 'gimnasio gym basicfit mcfit altafit crossfit yoga pilates'],
    ['suscrip', 'netflix spotify hbo max disney primevideo icloud apple youtube chatgpt openai claude anthropic capcut canva dropbox adobe suscripcion'],
    ['luz', 'luz iberdrola endesa naturgy holaluz totalenergies electricidad factura agua'],
    ['internet', 'internet digi movistar vodafone orange masmovil pepephone lowi fibra jazztel yoigo'],
    ['alquiler', 'alquiler renta casero'],
    ['viaje', 'ryanair vueling iberia booking airbnb hotel viaje vuelo easyjet'],
    ['personal', 'zara primark amazon sephora druni corte ingles peluqueria farmacia regalo shein mango decathlon pull bershka stradivarius estetica'],
    ['nómina', 'nomina salario sueldo cofares paga'],
  ];
  const VACIAS = ['de', 'del', 'la', 'el', 'los', 'las', 'con', 'para', 'por', 'en', 'compra', 'pago', 'cuota', 'recibo', 'tarjeta',
    'transferencia', 'bizum', 'hogar', 'mes', 'hoy', 'euros', 'eur', 'enero', 'febrero', 'marzo', 'abril', 'mayo', 'junio', 'julio',
    'agosto', 'septiembre', 'octubre', 'noviembre', 'diciembre', 'suscripcion', 'compras', 'cargo', 'adeudo', 'operacion'];

  function palabras(t) {
    return String(t || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '')
      .replace(/[^a-zñ ]/g, ' ').split(/\s+/).filter((w) => w.length >= 3 && VACIAS.indexOf(w) === -1);
  }
  /** Devuelve las reglas a guardar: {palabra: {c, t, u, n}} (solo las dos primeras palabras, como v16). */
  function aprender(reglas, m) {
    const cambios = {};
    palabras(m.conc).slice(0, 2).forEach((w) => {
      const r = reglas[w];
      cambios[w] = r && r.c === m.cat && r.t === m.tipo ? { c: r.c, t: r.t, u: m.cuenta || r.u, n: (r.n || 1) + 1 } : { c: m.cat, t: m.tipo, u: m.cuenta || '', n: 1 };
      reglas[w] = cambios[w];
    });
    return cambios;
  }
  function categorizar(conc, categorias, reglas) {
    const ws = palabras(conc);
    let mejor = null;
    ws.forEach((w) => { const r = reglas[w]; if (r && (!mejor || (r.n || 1) > (mejor.n || 1))) mejor = r; });
    if (mejor && categorias.indexOf(mejor.c) !== -1) return { cat: mejor.c, tipo: mejor.t, cuenta: mejor.u, origen: 'aprendida' };
    for (const [frag, lista] of PALABRAS_CAT) {
      const claves = lista.split(' ');
      if (ws.some((w) => claves.indexOf(w) !== -1)) {
        const cat = categorias.filter((x) => x.toLowerCase().indexOf(frag) !== -1)[0];
        if (cat) return { cat: cat, tipo: frag === 'nómina' ? 'Ingreso' : 'Gasto', cuenta: '', origen: 'palabra' };
      }
    }
    return null;
  }

  /** "12,50 Mercadona" → {imp, conc, entrada}. Con + delante es una entrada. */
  function leerGastoRapido(texto) {
    texto = String(texto || '').trim();
    const m = /([+-]?)\s*(\d+(?:[.,]\d{1,2})?)\s*(?:€|euros?)?/i.exec(texto);
    if (!m) throw new Error('No encuentro el importe en "' + texto + '".');
    let conc = (texto.slice(0, m.index) + ' ' + texto.slice(m.index + m[0].length)).replace(/\s+/g, ' ').trim() || 'Gasto rápido';
    return { imp: red(Number(m[2].replace(',', '.'))), conc: mayus(conc), entrada: m[1] === '+' };
  }

  /* ───── Cierre del ciclo ───── */
  /** Ciclos terminados que aún no están en el histórico (del más antiguo al más reciente). */
  function ciclosPorCerrar(hoy, dia, inicioPrimerDato, cerrados) {
    const hechos = new Set(cerrados || []);
    const out = [];
    if (!inicioPrimerDato) return out;
    let c = cicloAnterior(ciclo(hoy, dia), dia);
    while (c.fin >= inicioPrimerDato && out.length < 24) {
      if (!hechos.has(c.inicio)) out.unshift(c);
      c = cicloAnterior(c, dia);
    }
    return out;
  }
  /** Fila del histórico + foto fija de un ciclo (v16 cerrarCiclo_ pasos 1–4). */
  function filaHistorico(c, categorias, movs, comp, patrimonio, banco, hoy) {
    const r = resumen(categorias, movs, c);
    const delCiclo = movs.filter((m) => enCiclo(m, c));
    const sinConfirmar = delCiclo.filter((m) => PENDIENTES.indexOf(m.estado) !== -1).length;
    let estado = 'Cerrado automáticamente el ' + dmy(hoy);
    if (sinConfirmar) estado += ' · ' + sinConfirmar + ' previstos sin confirmar';
    return {
      inicio: c.inicio, fin: c.fin, nombre: mayus(c.nombre),
      ingresos: r.ingresos, gastos: r.gastos, ahorro: r.ahorro, margen: r.neto,
      banco: banco, patrimonio: patrimonio, estado: estado,
      detalle: { cats: r.categorias.map((x) => ({ cat: x.cat, tipo: x.tipo, plan: x.plan, real: x.real })),
        movs: delCiclo.map((m) => ({ fecha: m.fecha, tipo: m.tipo, cat: m.cat, conc: m.conc, imp: m.imp, cuenta: m.cuenta, estado: m.estado, parte: m.parte })),
        compartidos: comp || null },
    };
  }

  return {
    MESES, PENDIENTES, TIPOS, ROLES, PALABRAS_CAT, VACIAS, red, ymd, aFecha, sumarDias, dmy, mayus,
    ciclo, cicloDesde, cicloAnterior, fechaEnCiclo, hogar, miParte, efectosSaldo, saldos, resumen, pendientes, serie,
    recurrentesDelCiclo, compartidos, movimientoSaldar, palabras, aprender, categorizar, leerGastoRapido,
    ciclosPorCerrar, filaHistorico,
  };
});
