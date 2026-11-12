/*
 * Mi presupuesto v2 · capa de datos (Supabase)
 * Lee las tablas del usuario, construye el mismo objeto `S` que devolvía el API v16
 * (así las pantallas casi no cambian) y ejecuta cada acción de la app contra la base de datos.
 * crearDatos(sb, L): sb = cliente de Supabase (o uno de prueba), L = Logica.
 */
(function (raiz, fabrica) {
  if (typeof module === 'object' && module.exports) module.exports = fabrica;
  else raiz.crearDatos = fabrica;
})(typeof self !== 'undefined' ? self : this, function crearDatos(sb, L) {
  'use strict';
  const TABLAS = ['accounts', 'household_members', 'categories', 'movements', 'recurring', 'subscriptions', 'metals', 'category_rules', 'cycle_history'];
  const ESTADOS = ['Previsto', 'Por confirmar', 'Confirmado', 'Anulado'];
  const conHacia = (t) => t === 'Transferencia' || t === 'Ahorro / inversión';
  const red = L.red;
  const hoy = () => { const d = new Date(); return L.ymd(d); };
  const ahora = () => new Date().toISOString();

  let D = null;     // filas tal cual vienen de la base de datos
  let X = null;     // índices y datos derivados
  let uid = null;

  /* ───── Lectura ───── */
  const ok = (r) => { if (r.error) throw traducirError(r.error); return r.data; };
  /** Como ok, pero exige que se haya guardado al menos una fila (si no, el cambio se perdería sin avisar). */
  const ok1 = (r) => {
    const d = ok(r);
    if (!Array.isArray(d) || !d.length) throw new Error('No se ha podido guardar: no encuentro ese dato. Pulsa ↻ para actualizar y vuelve a intentarlo.');
    return d;
  };
  function traducirError(e) {
    const m = String((e && e.message) || e);
    if (/duplicate key|23505/.test(m + (e && e.code))) return new Error('Ya existe uno con ese nombre.');
    if (/JWT|not authenticated|401/.test(m)) return new Error('Tu sesión ha caducado. Vuelve a entrar.');
    if (/Failed to fetch|NetworkError|Load failed/i.test(m)) return new Error('Sin conexión. Inténtalo de nuevo.');
    return new Error(m);
  }
  async function todas(tabla, orden) {
    const out = [];
    for (let desde = 0; ; desde += 1000) {
      const filas = ok(await sb.from(tabla).select('*').order(orden || 'id').range(desde, desde + 999));
      out.push(...filas);
      if (filas.length < 1000) return out;
    }
  }
  async function leer() {
    const ses = (await sb.auth.getSession()).data.session;
    if (!ses) throw new Error('Sin sesión');
    uid = ses.user.id;
    const [settings, ...resto] = await Promise.all([
      sb.from('settings').select('*').then(ok),
      ...TABLAS.map((t) => todas(t, t === 'movements' ? 'creado_en' : t === 'category_rules' ? 'palabra' : t === 'cycle_history' ? 'inicio' : 'id')),
    ]);
    D = { settings: settings[0] || null, email: ses.user.email };
    TABLAS.forEach((t, i) => { D[t] = resto[i]; });
    if (!D.settings) { // por si el trigger no llegó a crearla
      D.settings = ok(await sb.from('settings').insert({ user_id: uid }).select())[0];
    }
    indexar();
  }

  /* ───── Índices y movimientos en forma interna ───── */
  const porOrden = (a, b) => (a.orden || 0) - (b.orden || 0) || String(a.nombre).localeCompare(String(b.nombre));
  function indexar() {
    const x = {};
    x.cuentas = D.accounts.filter((a) => !a.archivada).sort(porOrden);
    x.cats = D.categories.filter((c) => !c.archivada).sort(porOrden);
    x.miembros = D.household_members.slice().sort((a, b) => (b.es_yo - a.es_yo) || porOrden(a, b));
    const mapa = (lista) => { const id = {}, nombre = {}; lista.forEach((f) => { id[f.id] = f; nombre[f.nombre] = f; }); return { id, nombre }; };
    x.acc = mapa(D.accounts); x.cat = mapa(D.categories); x.mem = mapa(D.household_members);
    x.h = L.hogar(x.miembros.map((m) => ({ nombre: m.nombre, esYo: m.es_yo, peso: Number(m.peso) || 1 })));
    x.compartidas = x.cats.filter((c) => c.compartida && c.grupo !== 'ahorro').map((c) => c.nombre);
    x.ciclo = L.ciclo(hoy(), D.settings.ciclo_dia);
    const nombre = (m, id) => (id && m.id[id] ? m.id[id].nombre : '');
    x.movs = D.movements.map((f, n) => ({
      id: f.id, fila: f.id, n: n, fecha: f.fecha, tipo: f.tipo, cat: nombre(x.cat, f.category_id), conc: f.concepto,
      imp: Number(f.importe), cuenta: nombre(x.acc, f.account_id), hacia: nombre(x.acc, f.hacia_account_id), estado: f.estado,
      notas: f.notas || '', parte: Number(f.mi_parte), pagadoPor: nombre(x.mem, f.pagado_por), de: nombre(x.mem, f.de_member_id),
      pagoA: nombre(x.mem, f.pago_a_member_id), ajuste: !!f.es_ajuste, origen: f.origen || '', confirmadoEn: f.confirmado_en || '',
      recurrente: !!f.origen,
    }));
    x.saldos = L.saldos(D.accounts.map((a) => ({ nombre: a.nombre, saldoBase: Number(a.saldo_base), fechaBase: a.fecha_base, baseEn: a.base_en })), x.movs);
    x.movs.forEach((m) => {
      const a = x.acc.nombre[m.cuenta];
      m.enSaldo = m.estado === 'Confirmado' && !!a && L.enSaldoTras(m, a.fecha_base, a.base_en);
      if (m.pagadoPor && !m.cuenta) m.cuenta = 'Pagó ' + m.pagadoPor;
    });
    x.reglas = {};
    D.category_rules.forEach((r) => { x.reglas[r.palabra] = { c: nombre(x.cat, r.category_id), t: r.tipo, u: nombre(x.acc, r.account_id), n: r.n }; });
    X = x;
  }

  /* ───── Construir S (misma forma que el API v16) ───── */
  function planHogar(c) {
    if (c.total_hogar != null) return Number(c.total_hogar);
    return red(Number(c.plan) * X.h.pesoTotal / X.h.miPeso);
  }
  function compartidosDe(c) {
    if (!X.h.otros.length) return null;
    const plan = {};
    X.cats.filter((k) => X.compartidas.includes(k.nombre)).forEach((k) => { plan[k.nombre] = planHogar(k); });
    return L.compartidos(X.movs, X.h, plan, c, X.compartidas, hoy());
  }
  const catsLogica = () => X.cats.map((c) => ({ nombre: c.nombre, tipo: c.tipo, grupo: c.grupo, plan: Number(c.plan) }));
  const rolDe = (nombre) => (X.acc.nombre[nombre] || {}).rol || '';
  const patrimonio = () => red(X.cuentas.reduce((s, a) => s + (X.saldos[a.nombre] || 0), 0) + metales().valor);
  const banco = () => red(X.cuentas.filter((a) => a.rol === 'dia_a_dia').reduce((s, a) => s + (X.saldos[a.nombre] || 0), 0));
  function metales() {
    const activos = D.metals.map((m) => {
      const u = Number(m.unidades), coste = Number(m.coste), precio = Number(m.precio);
      return { fila: m.id, nombre: m.nombre, unidades: u, coste, precio, invertido: red(u * coste), valor: red(u * precio), ganancia: red(u * precio - u * coste), fecha: m.fecha_precio ? L.dmy(m.fecha_precio) : '' };
    });
    const suma = (k) => red(activos.reduce((s, a) => s + a[k], 0));
    return { activos, valor: D.settings.metales ? suma('valor') : 0, invertido: suma('invertido'), ganancia: suma('ganancia') };
  }

  function construir() {
    const c = X.ciclo, st = D.settings;
    const res = L.resumen(catsLogica(), X.movs, c);
    const pend = L.pendientes(X.movs, hoy(), 8);
    res.pendientes = pend.length;
    const comp = compartidosDe(c);
    const met = metales();
    const cuentas = X.cuentas.map((a) => ({ fila: a.id, nombre: a.nombre, saldo: X.saldos[a.nombre] || 0, fecha: L.dmy(a.fecha_base), calculado: true, rol: a.rol }));
    const totalCuentas = red(cuentas.reduce((s, a) => s + a.saldo, 0));
    const ini = c.inicio, fin = c.fin;
    const cobrado = {};
    X.movs.forEach((m) => { const r = /^SUB\|([^|]+)\|/.exec(m.origen); if (r && m.fecha >= ini && m.fecha <= fin) cobrado[r[1]] = { imp: m.imp, estado: m.estado, fecha: m.fecha, fila: m.id }; });
    const nombre = (m, id) => (id && m.id[id] ? m.id[id].nombre : '');
    return {
      v2: true,
      config: Object.assign({}, st, { email: D.email }),
      necesitaBienvenida: !st.onboarding_hecho,
      cuentasDetalle: X.cuentas.map((a) => ({ id: a.id, nombre: a.nombre, rol: a.rol, orden: a.orden, saldo: X.saldos[a.nombre] || 0 })),
      catIds: Object.fromEntries(X.cats.map((k) => [k.nombre, k.id])),
      cuentasArchivadas: D.accounts.filter((a) => a.archivada).map((a) => ({ id: a.id, nombre: a.nombre })),
      miembros: X.miembros.map((m) => ({ id: m.id, nombre: m.nombre, esYo: m.es_yo, peso: Number(m.peso), email: m.email || '', conectado: !!m.cuenta_user_id })),
      datos: {
        personasProximo: null, finCiclo: fin,
        tipos: L.TIPOS.slice(), categorias: X.cats.map((k) => k.nombre), cuentas: X.cuentas.map((a) => a.nombre), estados: ESTADOS.slice(),
        personas: X.h.personas, hogar: X.compartidas.slice(), hoy: hoy(),
        roles: Object.fromEntries(X.cuentas.map((a) => [a.nombre, a.rol])),
        tiposCat: Object.fromEntries(X.cats.map((k) => [k.nombre, k.tipo])),
        ciclo: { nombre: c.nombre, inicio: L.dmy(ini), fin: L.dmy(fin), cierre: L.dmy(c.cierre) },
      },
      resumen: res,
      pendientes: pend.map((m) => ({ fila: m.id, fecha: m.fecha, tipo: m.tipo, cat: m.cat, conc: m.conc, imp: m.imp, cuenta: m.cuenta, estado: m.estado })),
      recientes: [],
      movimientos: X.movs,
      inversiones: { cuentas, activos: met.activos, totalCuentas, totalMetales: met.valor, totalInvertido: met.invertido, totalGanancia: met.ganancia, patrimonio: red(totalCuentas + met.valor) },
      historico: D.cycle_history.map((h) => ({ id: h.id, inicio: h.inicio, mes: h.nombre, ingresos: Number(h.ingresos), gastos: Number(h.gastos), ahorro: Number(h.ahorro),
        margen: Number(h.margen), banco: h.banco == null ? 0 : Number(h.banco), estado: h.estado, patrimonio: h.patrimonio == null ? null : Number(h.patrimonio) })),
      serie: L.serie(X.movs, c, hoy(), res.planGastos),
      hogar: { personas: X.h.personas, divisor: X.h.pesoTotal / X.h.miPeso, conceptos: X.cats.filter((k) => X.compartidas.includes(k.nombre)).map((k) => ({ fila: k.id, nombre: k.nombre, total: planHogar(k), parte: Number(k.plan) })) },
      ajustesApp: st.ajustes && Object.keys(st.ajustes).length ? st.ajustes : null,
      autoCat: { aprendidas: X.reglas, base: L.PALABRAS_CAT, vacias: L.VACIAS },
      compartidos: comp,
      suscripciones: {
        subs: D.subscriptions.slice().sort((a, b) => String(a.nombre).localeCompare(b.nombre)).map((s) => ({ fila: s.id, nombre: s.nombre, imp: Number(s.importe), dia: s.dia, estado: s.activa ? 'Activa' : 'Cancelada', notas: s.notas, cobrado: cobrado[s.id] || null })),
        fijos: D.recurring.slice().sort((a, b) => (a.dia || 0) - (b.dia || 0)).map((r) => ({ fila: r.id, activo: r.activo, dia: r.dia, tipo: r.tipo, cat: nombre(X.cat, r.category_id), conc: r.concepto, imp: Number(r.importe), cuenta: nombre(X.acc, r.account_id), hacia: nombre(X.acc, r.hacia_account_id), de: nombre(X.mem, r.de_member_id), hasta: r.hasta || '', notas: r.notas })),
      },
      categoriasPres: {
        personas: X.h.pesoTotal / X.h.miPeso,
        libres: 99,
        lista: X.cats.map((k) => {
          const r = res.categorias.find((x) => x.cat === k.nombre) || { real: 0 };
          return { fila: k.id, cat: k.nombre, tipo: k.tipo, plan: Number(k.plan), real: r.real, cuenta: nombre(X.acc, k.account_id), formula: false, ligadaHogar: false,
            grupo: k.grupo === 'ingreso' ? 'variable' : k.grupo, esIngreso: k.grupo === 'ingreso', compartida: X.compartidas.includes(k.nombre), totalHogar: k.total_hogar == null ? null : Number(k.total_hogar) };
        }).filter((k) => !k.esIngreso),
      },
    };
  }

  /* ───── Escribir movimientos ───── */
  function aFila(m) {
    const tipo = m.tipo;
    if (!L.TIPOS.includes(tipo)) throw new Error('Tipo no válido.');
    const conc = String(m.conc || '').trim();
    if (!conc) throw new Error('Escribe un concepto.');
    const imp = red(Number(m.imp));
    if (!(imp > 0)) throw new Error('El importe tiene que ser mayor que 0.');
    if (!/^\d{4}-\d{2}-\d{2}$/.test(String(m.fecha || ''))) throw new Error('Fecha no válida.');
    let notas = String(m.notas || '');
    const yo = X.miembros.find((x) => x.es_yo);
    const otro = (n) => { const f = X.mem.nombre[String(n || '').trim()]; return f && f !== yo ? f : null; };
    let pagado = otro(m.pagadoPor);
    const rp = /Pag[oó]:\s*([^.]+)\.\s*/.exec(notas);
    if (rp && otro(rp[1])) { pagado = otro(rp[1]); notas = notas.replace(rp[0], '').trim(); }
    let de = tipo === 'Reintegro' ? otro(m.de) : null;
    if (tipo === 'Reintegro' && !de) {
      const rn = /^([^·]+?)\s*·/.exec(conc);
      de = rn ? otro(rn[1]) : null;
      if (!de && X.h.otros.length === 1 && X.compartidas.includes(m.cat)) de = X.mem.nombre[X.h.otros[0].nombre];
    }
    const pagoA = tipo === 'Transferencia' ? otro(m.pagoA) : null;
    const ajuste = (tipo === 'Reintegro' || tipo === 'Transferencia') && (!!m.ajuste || /ajuste|saldo de gastos compartidos/i.test(conc + ' ' + notas));
    const cuenta = pagado ? null : (X.acc.nombre[m.cuenta] || null);
    const hacia = conHacia(tipo) ? (X.acc.nombre[m.hacia] || null) : null;
    return {
      fecha: m.fecha, tipo, category_id: (X.cat.nombre[m.cat] || {}).id || null, concepto: conc.slice(0, 120), importe: imp,
      account_id: cuenta ? cuenta.id : null, hacia_account_id: hacia && (!cuenta || hacia.id !== cuenta.id) ? hacia.id : null,
      estado: ESTADOS.includes(m.estado) ? m.estado : 'Confirmado', notas: notas.slice(0, 500),
      mi_parte: L.miParte({ tipo, cat: m.cat, imp }, X.compartidas, X.h),
      pagado_por: pagado ? pagado.id : null, de_member_id: de ? de.id : null, pago_a_member_id: pagoA ? pagoA.id : null, es_ajuste: ajuste,
    };
  }
  async function insertarMovs(lista) {
    if (!lista.length) return 0;
    const r = await sb.from('movements').insert(lista).select('id');
    if (!r.error) return r.data.length;
    if (!/duplicate|23505/.test(r.error.message + r.error.code)) throw traducirError(r.error);
    let n = 0; // alguno ya existía (otro móvil lo creó a la vez): se insertan uno a uno
    for (const f of lista) { const x = await sb.from('movements').insert(f).select('id'); if (!x.error) n++; }
    return n;
  }
  async function aprender(lista) {
    try {
      const filas = {};
      lista.forEach((m) => {
        if (!m.cat || !m.conc || !X.cat.nombre[m.cat]) return;
        const cambios = L.aprender(X.reglas, { conc: m.conc, cat: m.cat, tipo: m.tipo, cuenta: X.acc.nombre[m.cuenta] ? m.cuenta : '' });
        Object.keys(cambios).forEach((w) => { const r = cambios[w]; filas[w] = { user_id: uid, palabra: w, category_id: X.cat.nombre[r.c].id, tipo: r.t, account_id: (X.acc.nombre[r.u] || {}).id || null, n: r.n }; });
      });
      const l = Object.values(filas);
      if (l.length) await sb.from('category_rules').upsert(l, { onConflict: 'user_id,palabra' });
    } catch (e) { /* aprender nunca impide guardar */ }
  }
  const movPorId = (id) => { const m = X.movs.find((x) => x.id === id); if (!m) throw new Error('Este movimiento ya no existe. Actualiza la app.'); return m; };
  const cuentaPrincipal = () => { const a = X.cuentas.find((x) => x.rol === 'dia_a_dia') || X.cuentas[0]; return a ? a.nombre : ''; };

  /* ───── Al abrir: recurrentes del ciclo y cierre de ciclos terminados ───── */
  async function preparar() {
    if (!D.settings.onboarding_hecho) return false;
    let cambios = false;
    const c = X.ciclo, nombre = (m, id) => (id && m.id[id] ? m.id[id].nombre : '');
    const origenes = X.movs.map((m) => m.origen).filter(Boolean);
    const catSub = (X.cats.find((k) => /suscrip/i.test(k.nombre)) || {}).nombre || '';
    const nuevos = L.recurrentesDelCiclo(
      D.recurring.map((r) => ({ id: r.id, activo: r.activo, dia: r.dia, tipo: r.tipo, cat: nombre(X.cat, r.category_id), conc: r.concepto, imp: Number(r.importe), cuenta: nombre(X.acc, r.account_id), hacia: nombre(X.acc, r.hacia_account_id), de: nombre(X.mem, r.de_member_id), hasta: r.hasta, notas: r.notas })),
      D.subscriptions.map((s) => ({ id: s.id, nombre: s.nombre, imp: Number(s.importe), dia: s.dia, activa: s.activa, cat: nombre(X.cat, s.category_id), cuenta: nombre(X.acc, s.account_id) || cuentaPrincipal() })),
      c, origenes, catSub).filter((m) => m.imp > 0 && m.conc);
    if (nuevos.length) {
      const filas = [];
      nuevos.forEach((m) => { try { filas.push(Object.assign(aFila(m), { origen: m.origen })); } catch (e) { /* recurrente incompleto: se salta */ } });
      if (await insertarMovs(filas)) cambios = true;
    }
    // Ciclos terminados que no están en el histórico
    const primera = X.movs.reduce((min, m) => (m.fecha && (!min || m.fecha < min) ? m.fecha : min), '');
    const porCerrar = L.ciclosPorCerrar(hoy(), D.settings.ciclo_dia, primera, D.cycle_history.map((h) => h.inicio));
    if (porCerrar.length) {
      const filas = porCerrar.map((cc) => Object.assign({ user_id: uid }, L.filaHistorico(cc, catsLogica(), X.movs, compartidosDe(cc), patrimonio(), banco(), hoy())));
      const r = await sb.from('cycle_history').upsert(filas, { onConflict: 'user_id,inicio', ignoreDuplicates: true });
      if (!r.error) cambios = true;
    }
    return cambios;
  }

  /* ───── Acciones (mismos nombres que el API v16) ───── */
  const A = {
    async agregarMovimiento(m) {
      const f = aFila(m);
      ok(await sb.from('movements').insert(f).select('id'));
      await aprender([m]);
      return 'Añadido: ' + f.concepto + ' · ' + f.importe.toFixed(2).replace('.', ',') + ' €';
    },
    async editarMovimiento(id, conc, m) {
      const antes = movPorId(id);
      // Quién pagó / de quién es el reintegro no se ven en el formulario: se conservan
      const f = aFila(Object.assign({ pagadoPor: antes.pagadoPor, de: antes.de, pagoA: antes.pagoA, ajuste: antes.ajuste }, m));
      ok1(await sb.from('movements').update(f).eq('id', id).select('id'));
      await aprender([m]);
      return 'Guardado: ' + f.concepto;
    },
    async eliminarMovimiento(id) {
      const m = movPorId(id);
      ok1(await sb.from('movements').delete().eq('id', id).select('id'));
      return 'Eliminado: ' + m.conc;
    },
    async confirmarMovimiento(id, conc, fecha, imp) {
      const m = movPorId(id);
      const f = aFila(Object.assign({}, m, { fecha, imp, estado: 'Confirmado' }));
      ok1(await sb.from('movements').update({ fecha: f.fecha, importe: f.importe, mi_parte: f.mi_parte, estado: 'Confirmado' }).eq('id', id).select('id'));
      return 'Confirmado: ' + m.conc;
    },
    async anularMovimiento(id) {
      const m = movPorId(id);
      ok1(await sb.from('movements').update({ estado: 'Anulado' }).eq('id', id).select('id'));
      return 'Anulado: ' + m.conc;
    },
    async agregarCuenta(c) {
      const nombre = String(c.nombre || '').trim();
      if (!nombre) throw new Error('Escribe el nombre.');
      const rol = c.rol || (/emergencia|imprevist/i.test(c.nota) ? 'emergencia' : /inversi|bolsa|etf|broker/i.test(c.nota) ? 'inversion' : /ahorro|hucha/i.test(c.nota) ? 'ahorro' : 'dia_a_dia');
      ok(await sb.from('accounts').insert({ nombre, rol, saldo_base: red(Number(c.saldo) || 0), fecha_base: hoy(), base_en: ahora(), orden: D.accounts.length }).select('id'));
      return 'Cuenta añadida: ' + nombre;
    },
    async actualizarSaldo(id, saldo) {
      ok1(await sb.from('accounts').update({ saldo_base: red(Number(saldo)), fecha_base: hoy(), base_en: ahora() }).eq('id', id).select('id'));
      return 'Saldo actualizado';
    },
    async guardarCuenta(d) { // Ajustes: nombre, papel, orden, archivada
      const cambios = {};
      if (d.nombre != null) { cambios.nombre = String(d.nombre).trim(); if (!cambios.nombre) throw new Error('Escribe el nombre.'); }
      ['rol', 'orden', 'archivada'].forEach((k) => { if (d[k] != null) cambios[k] = d[k]; });
      ok1(await sb.from('accounts').update(cambios).eq('id', d.id).select('id'));
      return 'Cuenta guardada';
    },
    async actualizarPrecio(id, precio) {
      ok1(await sb.from('metals').update({ precio: red(precio), fecha_precio: hoy() }).eq('id', id).select('id'));
      return 'Precio actualizado';
    },
    async comprarMetal(d) {
      const uds = Number(d.unidades), precio = red(Number(d.precio));
      if (!(uds > 0) || !(precio > 0)) throw new Error('Indica unidades y precio.');
      let nombre;
      if (d.fila) {
        const a = D.metals.find((x) => x.id === d.fila); if (!a) throw new Error('Metal no encontrado.');
        const u0 = Number(a.unidades), u1 = u0 + uds;
        ok1(await sb.from('metals').update({ unidades: u1, coste: red((u0 * Number(a.coste) + uds * precio) / u1) }).eq('id', a.id).select('id'));
        nombre = a.nombre;
      } else {
        nombre = String(d.nombre || '').trim(); if (!nombre) throw new Error('Escribe el nombre del metal.');
        ok(await sb.from('metals').insert({ nombre, unidades: uds, coste: precio, precio, fecha_precio: d.fecha || hoy() }).select('id'));
      }
      if (d.registrar) {
        const catAho = (X.cats.find((k) => k.tipo === 'Ahorro / inversión' && /invers|metal/i.test(k.nombre)) || X.cats.find((k) => k.tipo === 'Ahorro / inversión') || {}).nombre || '';
        await A.agregarMovimiento({ fecha: d.fecha || hoy(), tipo: 'Ahorro / inversión', cat: catAho, conc: 'Compra ' + nombre, imp: red(uds * precio), cuenta: d.cuenta, hacia: '', estado: 'Confirmado', notas: 'Compra de metal.' });
      }
      return 'Compra guardada: ' + nombre;
    },
    async editarMetal(d) { // corregir lo que tienes: nombre, unidades, coste medio y precio actual
      const a = D.metals.find((x) => x.id === d.id); if (!a) throw new Error('Metal no encontrado. Pulsa ↻ y vuelve a intentarlo.');
      const nombre = String(d.nombre || '').trim(); if (!nombre) throw new Error('Escribe el nombre del metal.');
      const uds = Number(d.unidades), coste = red(Number(d.coste)), precio = red(Number(d.precio));
      if (!(uds > 0)) throw new Error('Las unidades tienen que ser mayores que 0. Para quitarlo del todo, usa «Eliminar» o «Vender».');
      if (!(coste >= 0) || !(precio >= 0)) throw new Error('Revisa el coste y el precio.');
      const cambios = { nombre, unidades: uds, coste };
      if (Math.abs(precio - Number(a.precio)) > 0.004) { cambios.precio = precio; cambios.fecha_precio = hoy(); }
      ok1(await sb.from('metals').update(cambios).eq('id', a.id).select('id'));
      return 'Guardado: ' + nombre;
    },
    async venderMetal(d) {
      const a = D.metals.find((x) => x.id === d.id); if (!a) throw new Error('Metal no encontrado. Pulsa ↻ y vuelve a intentarlo.');
      const tiene = Number(a.unidades), uds = Number(d.unidades), precio = red(Number(d.precio));
      if (!(uds > 0) || uds > tiene + 1e-9) throw new Error('Puedes vender entre 0 y ' + String(tiene).replace('.', ',') + ' uds.');
      if (!(precio > 0)) throw new Error('Indica el precio de venta por unidad.');
      const quedan = Math.round((tiene - uds) * 10000) / 10000;
      if (quedan <= 0) ok1(await sb.from('metals').delete().eq('id', a.id).select('id'));
      else ok1(await sb.from('metals').update({ unidades: quedan, precio, fecha_precio: d.fecha || hoy() }).eq('id', a.id).select('id'));
      const total = red(uds * precio), ganancia = red((precio - Number(a.coste)) * uds);
      const fmt = (n) => n.toFixed(2).replace('.', ',') + ' €';
      if (d.registrar && d.cuenta) {
        // Entra en la cuenta sin contar como ingreso del mes (es tu dinero que vuelve de la inversión)
        await A.agregarMovimiento({ fecha: d.fecha || hoy(), tipo: 'Reintegro', cat: '', conc: 'Venta ' + a.nombre, imp: total, cuenta: d.cuenta, estado: 'Confirmado',
          notas: 'Venta de metal: ' + String(uds).replace('.', ',') + ' uds a ' + fmt(precio) + '. ' + (ganancia >= 0 ? 'Ganancia ' : 'Pérdida ') + fmt(Math.abs(ganancia)) + '.' });
      }
      return 'Venta guardada: ' + fmt(total) + (ganancia >= 0 ? ' · ganas ' : ' · pierdes ') + fmt(Math.abs(ganancia));
    },
    async eliminarMetal(id) {
      const a = D.metals.find((x) => x.id === id); if (!a) throw new Error('Metal no encontrado.');
      ok1(await sb.from('metals').delete().eq('id', a.id).select('id'));
      return 'Eliminado: ' + a.nombre;
    },
    async guardarHogar(h) {
      for (const c of h.conceptos || []) {
        const k = X.cat.id[c.fila]; if (!k) continue;
        const total = red(Number(c.total) || 0);
        ok1(await sb.from('categories').update({ total_hogar: total, plan: red(total * X.h.miPeso / X.h.pesoTotal) }).eq('id', k.id).select('id'));
      }
      return 'Gastos del hogar guardados.';
    },
    async guardarAjustesApp(a) {
      ok1(await sb.from('settings').update({ ajustes: a }).eq('user_id', uid).select('user_id'));
      return 'Ajustes guardados';
    },
    async guardarConfig(c) { // Ajustes de v2: día de cobro, metales, email, Inicio…
      const permitidos = ['ciclo_dia', 'metales', 'email_resumen', 'email_dia', 'email_avisos', 'inicio_tarjetas', 'acciones_rapidas', 'nombre', 'nomina', 'onboarding_hecho'];
      const cambios = {};
      permitidos.forEach((k) => { if (k in c) cambios[k] = c[k]; });
      ok1(await sb.from('settings').update(cambios).eq('user_id', uid).select('user_id'));
      return 'Ajustes guardados';
    },
    async guardarMiembro(m) {
      const nombre = String(m.nombre || '').trim(); if (!nombre) throw new Error('Escribe el nombre.');
      const fila = { nombre, peso: Number(m.peso) > 0 ? Number(m.peso) : 1, email: String(m.email || '').trim() || null };
      if (m.id) ok1(await sb.from('household_members').update(fila).eq('id', m.id).select('id'));
      else ok(await sb.from('household_members').insert(Object.assign(fila, { es_yo: !!m.esYo, orden: D.household_members.length })).select('id'));
      await rehacerPartes();
      return 'Guardado: ' + nombre;
    },
    async quitarMiembro(id) {
      const m = X.mem.id[id]; if (!m) throw new Error('No encontrado.');
      if (m.es_yo) throw new Error('No puedes quitarte a ti.');
      ok1(await sb.from('household_members').delete().eq('id', id).select('id'));
      await rehacerPartes();
      return 'Quitado: ' + m.nombre;
    },
    async saldarCompartidos(nombre) {
      const comp = compartidosDe(X.ciclo);
      const p = comp && comp.gente.find((x) => x.nombre === nombre);
      const mov = L.movimientoSaldar(p, hoy(), X.compartidas[0] || '', cuentaPrincipal());
      if (!mov) return 'No hay nada que saldar con ' + nombre + '.';
      ok(await sb.from('movements').insert(aFila(mov)).select('id'));
      return 'Cuentas saldadas con ' + nombre + ' (' + Math.abs(p.saldo).toFixed(2).replace('.', ',') + ' €).';
    },
    async guardarSuscripcion(d) {
      const nombre = String(d.nombre || '').trim(); if (!nombre) throw new Error('Escribe el nombre.');
      const imp = red(Number(d.imp)); if (!(imp >= 0)) throw new Error('Precio no válido.');
      const catSub = X.cats.find((k) => /suscrip/i.test(k.nombre));
      const fila = { nombre, importe: imp, dia: Math.max(1, Math.min(31, Math.round(Number(d.dia) || 1))), activa: !!d.activa, notas: d.notas || 'Mensual' };
      if (d.fila) ok1(await sb.from('subscriptions').update(fila).eq('id', d.fila).select('id'));
      else ok(await sb.from('subscriptions').insert(Object.assign(fila, { category_id: catSub ? catSub.id : null, account_id: (X.acc.nombre[cuentaPrincipal()] || {}).id || null })).select('id'));
      return (d.fila ? 'Guardada: ' : 'Añadida: ') + nombre;
    },
    async guardarRecurrente(d) {
      const f = {
        activo: d.activo !== false, dia: Math.max(1, Math.min(31, Math.round(Number(d.dia) || 1))), tipo: d.tipo,
        category_id: (X.cat.nombre[d.cat] || {}).id || null, concepto: String(d.conc || '').trim(), importe: red(Number(d.imp) || 0),
        account_id: (X.acc.nombre[d.cuenta] || {}).id || null, hacia_account_id: conHacia(d.tipo) ? ((X.acc.nombre[d.hacia] || {}).id || null) : null,
        de_member_id: d.tipo === 'Reintegro' ? ((X.mem.nombre[d.de] || {}).id || null) : null, hasta: d.hasta || null, notas: d.notas || '',
      };
      if (!f.concepto) throw new Error('Escribe el concepto.');
      if (!L.TIPOS.includes(f.tipo)) throw new Error('Tipo no válido.');
      if (d.fila) ok1(await sb.from('recurring').update(f).eq('id', d.fila).select('id'));
      else ok(await sb.from('recurring').insert(f).select('id'));
      return 'Guardado: ' + f.concepto;
    },
    async eliminarRecurrente(id) { ok1(await sb.from('recurring').delete().eq('id', id).select('id')); return 'Eliminado'; },
    async importarMovimientos(d) {
      const cuenta = d.cuenta || cuentaPrincipal();
      const nuevos = (d.nuevos || []).slice(0, 400).map((m) => Object.assign({}, m, { cuenta: m.cuenta || cuenta, estado: 'Confirmado', notas: m.notas || 'Importado del extracto.' }));
      let nConf = 0;
      for (const c of d.confirmar || []) {
        try {
          const m = movPorId(c.fila); if (m.estado === 'Confirmado') continue;
          const f = aFila(Object.assign({}, m, { fecha: c.fecha, imp: c.imp, estado: 'Confirmado' }));
          ok1(await sb.from('movements').update({ fecha: f.fecha, importe: f.importe, mi_parte: f.mi_parte, estado: 'Confirmado', notas: (m.notas ? m.notas + ' ' : '') + 'Confirmado con el extracto.' }).eq('id', m.id).select('id'));
          nConf++;
        } catch (e) { /* sigue con el resto */ }
      }
      const filas = [];
      nuevos.forEach((m) => { try { filas.push(aFila(m)); } catch (e) {} });
      const n = await insertarMovs(filas);
      await aprender(nuevos);
      return 'Importados ' + n + ' movimientos' + (nConf ? ' y confirmados ' + nConf + ' previstos' : '') + '.';
    },
    async guardarCategorias(d) {
      const n = X.h.pesoTotal / X.h.miPeso;
      if (d.nueva) {
        const x = d.nueva, nombre = String(x.cat || '').trim(); if (!nombre) throw new Error('Escribe el nombre.');
        const grupo = ['fijo', 'variable', 'ahorro', 'ingreso'].includes(x.grupo) ? x.grupo : 'variable';
        const comp = !!x.compartida && grupo !== 'ahorro' && grupo !== 'ingreso';
        const tipo = grupo === 'ahorro' ? 'Ahorro / inversión' : grupo === 'ingreso' ? 'Ingreso' : 'Gasto';
        const total = comp ? red(x.total != null ? Number(x.total) : Number(x.plan) * n) : null;
        ok(await sb.from('categories').insert({ nombre, tipo, grupo, compartida: comp, plan: comp ? red(total / n) : red(Number(x.plan) || 0), total_hogar: total,
          account_id: (X.acc.nombre[x.cuenta] || {}).id || null, orden: D.categories.length }).select('id'));
        await rehacerPartes();
        return 'Categoría creada: ' + nombre;
      }
      let cambioComp = false;
      for (const c of d.cambios || []) {
        const k = X.cat.id[c.fila]; if (!k) continue;
        const grupo = ['fijo', 'variable', 'ahorro'].includes(c.grupo) ? c.grupo : k.grupo;
        const comp = !!c.compartida && grupo !== 'ahorro';
        if (comp !== X.compartidas.includes(k.nombre)) cambioComp = true;
        const tipo = grupo === 'ahorro' ? 'Ahorro / inversión' : (k.tipo === 'Ahorro / inversión' ? 'Gasto' : k.tipo);
        ok1(await sb.from('categories').update({ grupo, tipo, compartida: comp, plan: red(Number(c.plan) || 0), total_hogar: comp ? red(c.total != null ? Number(c.total) : Number(c.plan) * n) : null }).eq('id', k.id).select('id'));
      }
      if (d.ajustes) await A.guardarAjustesApp(d.ajustes);
      if (cambioComp) await rehacerPartes();
      const nc = (d.cambios || []).length;
      return nc ? 'Guardados ' + nc + (nc === 1 ? ' cambio' : ' cambios') : 'Nómina guardada';
    },
    async guardarCategoria(d) { // Ajustes: renombrar, archivar
      const cambios = {};
      if (d.nombre != null) { cambios.nombre = String(d.nombre).trim(); if (!cambios.nombre) throw new Error('Escribe el nombre.'); }
      if (d.archivada != null) cambios.archivada = !!d.archivada;
      if (d.account_id !== undefined) cambios.account_id = d.account_id;
      ok1(await sb.from('categories').update(cambios).eq('id', d.id).select('id'));
      return 'Categoría guardada';
    },
    async gastoRapido(p) {
      const g = L.leerGastoRapido(p.texto);
      const auto = L.categorizar(g.conc, X.cats.map((k) => k.nombre), X.reglas) || {};
      let tipo = auto.tipo || 'Gasto';
      if (g.entrada && tipo === 'Gasto') tipo = 'Ingreso';
      const deTipo = X.cats.filter((k) => k.tipo === (tipo === 'Reintegro' ? 'Gasto' : tipo));
      const cat = auto.cat || ((deTipo.find((k) => /personal|otros|varios/i.test(k.nombre)) || deTipo[0] || X.cats[0] || {}).nombre || '');
      const cuenta = auto.cuenta && X.acc.nombre[auto.cuenta] ? auto.cuenta : cuentaPrincipal();
      const fecha = /^\d{4}-\d{2}-\d{2}$/.test(p.fecha || '') ? p.fecha : hoy();
      await A.agregarMovimiento({ fecha, tipo, cat, conc: g.conc, imp: g.imp, cuenta, estado: 'Confirmado', notas: p.notas || 'Anotado con gasto rápido.' });
      return '✓ ' + g.imp.toFixed(2).replace('.', ',') + ' € · ' + g.conc + ' → ' + (cat || 'sin categoría');
    },
    async enviarResumenPrueba() { // manda ya el resumen del último mes cerrado a mi email (máx. 3 por hora)
      const r = await sb.functions.invoke('resumen-mensual', { body: { prueba: true } });
      if (r.error) {
        let m = '';
        try { m = (await r.error.context.json()).error; } catch (e) { /* sin detalle */ }
        throw new Error(m || 'No se pudo mandar el email. Inténtalo más tarde.');
      }
      return (r.data && r.data.mensaje) || 'Email enviado';
    },
  };

  /** Si cambia qué categorías son compartidas o el hogar, "mi parte" de los gastos del ciclo actual se recalcula. */
  async function rehacerPartes() {
    await leer();
    for (const k of X.cats) { // el plan de las compartidas es mi parte del total del hogar
      if (!X.compartidas.includes(k.nombre) || k.total_hogar == null) continue;
      const p = red(Number(k.total_hogar) * X.h.miPeso / X.h.pesoTotal);
      if (Math.abs(p - Number(k.plan)) > 0.004) await sb.from('categories').update({ plan: p }).eq('id', k.id);
    }
    const c = X.ciclo;
    for (const m of X.movs) {
      if (m.tipo !== 'Gasto' || m.fecha < c.inicio) continue;
      const p = L.miParte(m, X.compartidas, X.h);
      if (Math.abs(p - m.parte) > 0.004) await sb.from('movements').update({ mi_parte: p }).eq('id', m.id);
    }
  }
  A.rehacerPartes = async () => { await rehacerPartes(); return 'Recalculado'; };

  /* ───── Bienvenida: crea todo de una vez (se puede repetir sin duplicar) ───── */
  async function completarBienvenida(w) {
    await A.guardarConfig({ ciclo_dia: w.cicloDia, nombre: w.nombre || null, metales: !!w.metales, email_resumen: !!w.email, email_dia: w.emailDia || null,
      inicio_tarjetas: w.tarjetas, acciones_rapidas: w.acciones, nomina: Number(w.nomina) > 0 ? red(w.nomina) : null });
    if (w.ajustes) await A.guardarAjustesApp(w.ajustes);
    const cuentas = w.cuentas.filter((c) => String(c.nombre || '').trim()).map((c, i) => ({ user_id: uid, nombre: c.nombre.trim(), rol: c.rol, saldo_base: red(Number(c.saldo) || 0), fecha_base: hoy(), base_en: ahora(), orden: i }));
    if (!cuentas.length) throw new Error('Añade al menos una cuenta.');
    const accs = ok(await sb.from('accounts').upsert(cuentas, { onConflict: 'user_id,nombre' }).select());
    const yoNombre = String(w.nombre || '').trim() || 'Yo';
    const gente = [{ user_id: uid, nombre: yoNombre, es_yo: true, peso: Number(w.miPeso) > 0 ? Number(w.miPeso) : 1, orden: 0 }]
      .concat(w.hogar.filter((p) => String(p.nombre || '').trim() && p.nombre.trim() !== yoNombre).map((p, i) => ({ user_id: uid, nombre: p.nombre.trim(), es_yo: false, peso: Number(p.peso) > 0 ? Number(p.peso) : 1, email: String(p.email || '').trim() || null, orden: i + 1 })));
    ok(await sb.from('household_members').upsert(gente, { onConflict: 'user_id,nombre' }).select());
    const pesoTotal = gente.reduce((s, p) => s + p.peso, 0), miPeso = gente[0].peso;
    const porRol = (r) => (accs.find((a) => a.rol === r) || {}).id || null;
    const cats = w.categorias.filter((c) => c.on && String(c.nombre || '').trim()).map((c, i) => {
      const comp = !!c.compartida && gente.length > 1 && c.grupo !== 'ahorro' && c.grupo !== 'ingreso';
      const importe = red(Number(c.plan) || 0);
      return { user_id: uid, nombre: c.nombre.trim(), grupo: c.grupo, tipo: c.grupo === 'ahorro' ? 'Ahorro / inversión' : c.grupo === 'ingreso' ? 'Ingreso' : 'Gasto',
        compartida: comp, plan: comp ? red(importe * miPeso / pesoTotal) : importe, total_hogar: comp ? importe : null,
        account_id: c.grupo === 'ahorro' ? porRol(c.rol || 'ahorro') : null, orden: i };
    });
    if (cats.length) ok(await sb.from('categories').upsert(cats, { onConflict: 'user_id,nombre' }).select());
    await A.guardarConfig({ onboarding_hecho: true });
  }

  /* ───── Detalle de un mes cerrado ───── */
  function detalleMes(mes) {
    const h = D.cycle_history.find((x) => x.nombre === mes);
    if (!h) return { mes, cats: [], movs: [], sinHoja: true };
    const d = h.detalle || {};
    return { mes, cats: d.cats || [], movs: (d.movs || []).map((m, i) => Object.assign({ fila: 'h' + i }, m)), sinHoja: false };
  }

  /* ───── Mis datos: descargar y borrar ───── */
  async function exportar() {
    await leer();
    const out = { app: 'Mi presupuesto', version: 2, exportado: ahora(), email: D.email, settings: D.settings };
    TABLAS.forEach((t) => { out[t] = D[t]; });
    return out;
  }
  async function borrarTodo() { ok(await sb.rpc('borrar_mis_datos')); }

  return {
    sb, L,
    async cargar() { await leer(); if (await preparar()) await leer(); return construir(); },
    /** Solo lectura (para el email): resumen de un ciclo sin generar ni cerrar nada. anterior = el último ciclo terminado. */
    async foto(anterior) {
      await leer();
      const c = anterior ? L.cicloAnterior(X.ciclo, D.settings.ciclo_dia) : X.ciclo;
      return { ciclo: c, settings: D.settings, email: D.email, resumen: L.resumen(catsLogica(), X.movs, c), compartidos: compartidosDe(c),
        cuentas: X.cuentas.map((a) => ({ nombre: a.nombre, rol: a.rol, saldo: X.saldos[a.nombre] || 0 })), patrimonio: patrimonio(), banco: banco(),
        pendientes: X.movs.filter((m) => m.fecha >= c.inicio && m.fecha <= c.fin && L.PENDIENTES.indexOf(m.estado) !== -1).length };
    },
    async accion(nombre, ...args) {
      if (!A[nombre]) throw new Error('Acción desconocida: ' + nombre);
      if (!X) await leer();
      const mensaje = await A[nombre](...args);
      await leer();
      return { mensaje, datos: construir() };
    },
    async completarBienvenida(w) { await leer(); await completarBienvenida(w); await leer(); await preparar(); await leer(); return construir(); },
    detalleMes, exportar, borrarTodo,
    /** Clave del atajo de Siri: se crea aquí, se enseña una vez y solo se guarda su hash. */
    atajo: {
      async estado() { return ok(await sb.from('api_tokens').select('id,creado_en,usado_en').order('creado_en')); },
      async crear() {
        const ses = (await sb.auth.getSession()).data.session;
        if (!ses) throw new Error('Tu sesión ha caducado. Vuelve a entrar.');
        const b = new Uint8Array(24); crypto.getRandomValues(b);
        const clave = 'mp_' + Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');
        ok(await sb.from('api_tokens').delete().eq('user_id', ses.user.id).select('id')); // una sola clave: la anterior deja de valer
        ok(await sb.from('api_tokens').insert({ user_id: ses.user.id, hash: await L.hashClave(clave) }).select('id'));
        return clave;
      },
      async borrar() {
        const ses = (await sb.auth.getSession()).data.session;
        if (!ses) throw new Error('Tu sesión ha caducado. Vuelve a entrar.');
        ok(await sb.from('api_tokens').delete().eq('user_id', ses.user.id).select('id'));
      },
    },
    /** Hogar compartido: invitar a alguien del hogar y, si me han invitado a mí, ver y anotar en ese hogar. */
    hogar: {
      async invitar(memberId) { return ok(await sb.rpc('crear_invitacion', { p_member: memberId })); },
      async desconectar(memberId) { ok1(await sb.from('household_members').update({ cuenta_user_id: null }).eq('id', memberId).select('id')); },
      async verInvitacion(codigo) { return ok(await sb.rpc('ver_invitacion', { p_codigo: codigo })); },
      async aceptar(codigo) { return ok(await sb.rpc('aceptar_invitacion', { p_codigo: codigo })); },
      async mios() { return ok(await sb.rpc('mis_hogares')) || []; },
      async salir(owner) { ok(await sb.rpc('salir_de_hogar', { p_owner: owner })); },
      async anotar(owner, d) {
        return ok(await sb.rpc('anotar_en_hogar', { p_owner: owner, p_tipo: d.tipo, p_cat: d.cat || null, p_concepto: d.conc || '', p_importe: red(Number(d.imp)), p_fecha: d.fecha || hoy() }));
      },
      /** Lo que ve la persona invitada, ya calculado: quién debe a quién en el ciclo de ese hogar. */
      async ver(owner) {
        const r = ok(await sb.rpc('hogar_compartido', { p_owner: owner }));
        const c = L.ciclo(hoy(), r.ciclo_dia);
        const h = L.hogar((r.miembros || []).map((m) => ({ nombre: m.nombre, esYo: m.es_yo, peso: Number(m.peso) || 1 })));
        const cats = (r.categorias || []).map((k) => k.nombre);
        const plan = {};
        (r.categorias || []).forEach((k) => { plan[k.nombre] = k.total_hogar != null ? Number(k.total_hogar) : red(Number(k.plan) * h.pesoTotal / h.miPeso); });
        const movs = (r.movimientos || []).map((m) => ({ id: m.id, fecha: m.fecha, tipo: m.tipo, cat: m.cat || '', conc: m.conc, imp: Number(m.imp), parte: Number(m.parte),
          estado: m.estado, ajuste: !!m.ajuste, pagadoPor: m.pagadoPor || '', de: m.de || '', pagoA: m.pagoA || '' }));
        const comp = L.compartidos(movs, h, plan, c, cats, hoy());
        const yo = comp.gente.find((g) => g.nombre === r.yo) || null;
        return { de: r.de, yo: r.yo, ciclo: c, categorias: r.categorias || [], comp, mio: yo, movs: movs.filter((m) => m.fecha >= c.inicio && m.fecha <= c.fin), plan };
      },
    },
    uid: () => uid,
    _interno: () => ({ D, X }),
  };
});
