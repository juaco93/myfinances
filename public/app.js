/* Finanzas: shared helpers for every page (theme, formatting, charts, rosette, icons). */
(function () {
  'use strict';

  // ---------- Session guard: an expired session sends any page back to the login ----------
  const nativeFetch = window.fetch.bind(window);
  window.fetch = async (...args) => {
    const res = await nativeFetch(...args);
    if (res.status === 401) location.href = 'login';
    return res;
  };

  // ---------- Theme: follows the OS unless the user picked one in Configuración ----------
  const THEME_KEY = 'fin.theme';
  const media = window.matchMedia('(prefers-color-scheme: dark)');
  const listeners = new Set();
  function readTheme() { try { return localStorage.getItem(THEME_KEY) || 'auto'; } catch (e) { return 'auto'; } }
  function applyTheme(pref) {
    if (pref === 'light' || pref === 'dark') document.documentElement.dataset.theme = pref;
    else delete document.documentElement.dataset.theme;
  }
  function effectiveTheme() {
    const pref = readTheme();
    return pref === 'auto' ? (media.matches ? 'dark' : 'light') : pref;
  }
  function setTheme(pref) {
    try { pref === 'auto' ? localStorage.removeItem(THEME_KEY) : localStorage.setItem(THEME_KEY, pref); } catch (e) { /* storage unavailable */ }
    applyTheme(pref);
    listeners.forEach(fn => fn(effectiveTheme()));
  }
  media.addEventListener('change', () => { if (readTheme() === 'auto') listeners.forEach(fn => fn(effectiveTheme())); });
  applyTheme(readTheme());

  // ---------- Tokens ----------
  function token(name) { return getComputedStyle(document.documentElement).getPropertyValue(`--${name}`).trim(); }
  function tokens() {
    const t = {};
    for (const k of ['paper', 'sheet', 'sheet-2', 'ink', 'ink-2', 'ink-3', 'rule', 'rule-strong', 'blue', 'blue-wash', 'aqua', 'orange', 'good', 'bad']) t[k] = token(k);
    return t;
  }

  // ---------- Formatting (es-AR) ----------
  const NBSP = ' ';
  function symbol(currency) { return currency === 'ARS' ? '$' : currency === 'USDT' ? 'USDT' : 'US$'; }
  function money(value, currency, { compact = false, sign = false, decimals } = {}) {
    if (value == null || !Number.isFinite(value)) return '—';
    const abs = Math.abs(value);
    const opts = compact
      ? { notation: 'compact', maximumFractionDigits: abs >= 1e6 ? 1 : 0 }
      : { maximumFractionDigits: decimals ?? (abs >= 1000 ? 0 : 2), minimumFractionDigits: decimals ?? (abs >= 1000 || Number.isInteger(abs) ? 0 : 2) };
    const body = new Intl.NumberFormat('es-AR', opts).format(abs);
    const s = value < 0 ? '−' : (sign && value > 0 ? '+' : '');
    return `${s}${symbol(currency)}${NBSP}${body}`;
  }
  function pct(value, { sign = true, decimals = 1 } = {}) {
    if (value == null || !Number.isFinite(value)) return '—';
    const body = new Intl.NumberFormat('es-AR', { minimumFractionDigits: decimals, maximumFractionDigits: decimals }).format(Math.abs(value));
    const s = value < 0 ? '−' : (sign && value > 0 ? '+' : '');
    return `${s}${body}${NBSP}%`;
  }
  function number(value, decimals = 0) {
    return new Intl.NumberFormat('es-AR', { maximumFractionDigits: decimals }).format(value);
  }
  // Big figure: currency sign set small, decimals (if any) set smaller.
  function figure(el, value, currency) {
    el.textContent = '';
    if (value == null || !Number.isFinite(value)) { el.textContent = '—'; return; }
    const cur = document.createElement('span');
    cur.className = 'cur';
    cur.textContent = symbol(currency);
    const abs = Math.abs(value);
    const decimals = abs < 100000 && currency !== 'ARS' ? 2 : 0;
    const parts = new Intl.NumberFormat('es-AR', { minimumFractionDigits: decimals, maximumFractionDigits: decimals }).formatToParts(abs);
    const intText = parts.filter(p => p.type !== 'decimal' && p.type !== 'fraction').map(p => p.value).join('');
    const frac = parts.find(p => p.type === 'fraction');
    if (value < 0) el.append('−');
    el.append(cur, intText);
    if (frac) {
      const dec = document.createElement('span');
      dec.className = 'dec';
      dec.textContent = `,${frac.value}`;
      el.append(dec);
    }
  }

  const MONTHS = ['ene', 'feb', 'mar', 'abr', 'may', 'jun', 'jul', 'ago', 'sep', 'oct', 'nov', 'dic'];
  const MONTHS_LONG = ['enero', 'febrero', 'marzo', 'abril', 'mayo', 'junio', 'julio', 'agosto', 'septiembre', 'octubre', 'noviembre', 'diciembre'];
  const todayAr = () => new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Argentina/Buenos_Aires' }).format(new Date());
  function parseDay(iso) { const [y, m, d] = iso.slice(0, 10).split('-').map(Number); return { y, m, d }; }
  function shortDate(iso, { year = 'auto' } = {}) {
    if (!iso) return '';
    const { y, m, d } = parseDay(iso);
    const showYear = year === true || (year === 'auto' && String(y) !== todayAr().slice(0, 4));
    return `${d} ${MONTHS[m - 1]}${showYear ? ` ${y}` : ''}`;
  }
  function longDay(iso) {
    const { y, m, d } = parseDay(iso);
    const weekday = new Intl.DateTimeFormat('es-AR', { weekday: 'long', timeZone: 'UTC' }).format(new Date(Date.UTC(y, m - 1, d)));
    const sameYear = String(y) === todayAr().slice(0, 4);
    const text = `${weekday} ${d} de ${MONTHS_LONG[m - 1]}${sameYear ? '' : ` de ${y}`}`;
    return text.charAt(0).toUpperCase() + text.slice(1);
  }
  function monthLabel(ym) { const [y, m] = ym.split('-'); return `${MONTHS[Number(m) - 1]} ${y.slice(2)}`; }
  function relDays(days) {
    if (days == null) return 'sin datos';
    if (days <= 0) return 'hoy';
    if (days === 1) return 'ayer';
    return `hace ${days} días`;
  }

  // ---------- Icons (inline SVG, 24px grid, 1.6 stroke) ----------
  const ICON_PATHS = {
    resumen: '<path d="M4 19V10M10 19V5M16 19v-6M22 19H2"/>',
    movimientos: '<path d="M4 7h11M4 12h16M4 17h9"/><path d="m17 4 3 3-3 3"/>',
    inversiones: '<path d="M3 17l5.5-5.5 4 4L21 7"/><path d="M15 7h6v6"/>',
    config: '<path d="M4 7h8.5M17.5 7H20M4 17h2.5M11.5 17H20"/><circle cx="15" cy="7" r="2.5"/><circle cx="9" cy="17" r="2.5"/>',
    search: '<circle cx="11" cy="11" r="6.5"/><path d="m16 16 4.5 4.5"/>',
    close: '<path d="M6 6l12 12M18 6 6 18"/>',
    check: '<path d="m5 12.5 4.5 4.5L19 7.5"/>',
    alert: '<path d="M12 3.5 2.8 19.5h18.4z"/><path d="M12 10v4.5M12 17.2v.3"/>',
    clock: '<circle cx="12" cy="12" r="8.5"/><path d="M12 7.5V12l3 2"/>',
    dot: '<circle cx="12" cy="12" r="5" fill="currentColor" stroke="none"/>',
    sync: '<path d="M4 12a8 8 0 0 1 13.7-5.6L20 8.5M20 4v4.5h-4.5"/><path d="M20 12a8 8 0 0 1-13.7 5.6L4 15.5M4 20v-4.5h4.5"/>'
  };
  function icon(name, extra = '') {
    return `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" ${extra}>${ICON_PATHS[name] || ''}</svg>`;
  }

  // ---------- Guilloche rosette: the security-print mark behind the main figure ----------
  const ROSETTE_BANDS = [
    { r: 238, amp: 9, lobes: 60, copies: 4 },
    { r: 200, amp: 22, lobes: 36, copies: 10 },
    { r: 138, amp: 30, lobes: 24, copies: 12, amp2: 8, lobes2: 6 },
    { r: 76, amp: 20, lobes: 16, copies: 8 },
    { r: 30, amp: 10, lobes: 10, copies: 5 }
  ];
  function rosette(svg, { animate = true, bands = ROSETTE_BANDS, stroke = 0.6 } = {}) {
    if (!svg) return;
    const NS = 'http://www.w3.org/2000/svg';
    const S = 520;
    svg.setAttribute('viewBox', `${-S / 2} ${-S / 2} ${S} ${S}`);
    svg.setAttribute('aria-hidden', 'true');
    svg.textContent = '';
    const reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    let index = 0;
    for (const b of bands) {
      for (let c = 0; c < b.copies; c++) {
        const phase = (2 * Math.PI * c) / b.copies;
        const steps = b.lobes * 24;
        let d = '';
        for (let i = 0; i <= steps; i++) {
          const t = (i / steps) * 2 * Math.PI;
          const r = b.r + b.amp * Math.sin(b.lobes * t + phase) + (b.amp2 || 0) * Math.cos((b.lobes2 || 0) * t);
          d += `${i ? 'L' : 'M'}${(r * Math.cos(t)).toFixed(1)} ${(r * Math.sin(t)).toFixed(1)}`;
        }
        const p = document.createElementNS(NS, 'path');
        p.setAttribute('d', `${d}Z`);
        p.setAttribute('fill', 'none');
        p.setAttribute('stroke', 'currentColor');
        p.setAttribute('stroke-width', String(stroke));
        if (animate && !reduce) {
          // One orchestrated moment: the print is engraved once, outside in.
          p.setAttribute('pathLength', '1');
          p.style.strokeDasharray = '1';
          p.style.strokeDashoffset = '1';
          p.style.animation = `rosette-draw 1.6s cubic-bezier(.3,.6,.2,1) ${index * 0.035}s forwards`;
        }
        svg.appendChild(p);
        index++;
      }
    }
  }
  const style = document.createElement('style');
  style.textContent = '@keyframes rosette-draw { to { stroke-dashoffset: 0; } }';
  document.head.appendChild(style);

  // Brand mark: a coin with an engraved two-strand ring.
  function mark(svg) {
    if (!svg) return;
    const ring = ph => {
      let d = '';
      for (let i = 0; i <= 144; i++) {
        const t = (i / 144) * 2 * Math.PI;
        const r = 8.6 + 2.1 * Math.sin(9 * t + ph);
        d += `${i ? 'L' : 'M'}${(16 + r * Math.cos(t)).toFixed(2)} ${(16 + r * Math.sin(t)).toFixed(2)}`;
      }
      return `<path d="${d}Z" fill="none" stroke="currentColor" stroke-width="1.15"/>`;
    };
    svg.setAttribute('viewBox', '0 0 32 32');
    svg.setAttribute('aria-hidden', 'true');
    svg.innerHTML = `<circle cx="16" cy="16" r="14.6" fill="none" stroke="currentColor" stroke-width="1.6"/>${ring(0)}${ring(Math.PI)}<circle cx="16" cy="16" r="1.7" fill="currentColor"/>`;
  }

  // Fill every [data-icon] placeholder and the brand marks.
  function hydrate(root = document) {
    root.querySelectorAll('[data-icon]').forEach(el => {
      if (!el.querySelector('svg')) el.insertAdjacentHTML('afterbegin', icon(el.dataset.icon));
    });
    root.querySelectorAll('svg[data-mark]').forEach(mark);
  }

  // ---------- Charts ----------
  function chartDefaults() {
    if (!window.Chart) return;
    const t = tokens();
    const C = window.Chart;
    C.defaults.font.family = "'Chivo', system-ui, sans-serif";
    C.defaults.font.size = 12;
    C.defaults.color = t['ink-3'];
    C.defaults.borderColor = t.rule;
    C.defaults.animation.duration = 300;
    C.defaults.maintainAspectRatio = false;
    C.defaults.plugins.legend.display = false;
    const tip = C.defaults.plugins.tooltip;
    Object.assign(tip, {
      backgroundColor: t.sheet, borderColor: t['rule-strong'], borderWidth: 1, titleColor: t['ink-2'], bodyColor: t.ink,
      footerColor: t['ink-3'], padding: 10, cornerRadius: 8, caretSize: 0, boxPadding: 6, boxWidth: 12, boxHeight: 2,
      titleFont: { weight: '500', size: 12 }, bodyFont: { weight: '600', size: 13 }, footerFont: { weight: '400', size: 12 },
      displayColors: true, usePointStyle: false
    });
  }

  // Vertical hairline that follows the hovered X (line charts).
  const crosshair = {
    id: 'crosshair',
    afterDatasetsDraw(chart) {
      const active = chart.tooltip?.getActiveElements?.() || [];
      if (!active.length) return;
      const { ctx, chartArea } = chart;
      const x = active[0].element.x;
      ctx.save();
      ctx.beginPath();
      ctx.moveTo(x, chartArea.top);
      ctx.lineTo(x, chartArea.bottom);
      ctx.lineWidth = 1;
      ctx.strokeStyle = token('rule-strong');
      ctx.stroke();
      ctx.restore();
    }
  };

  // Month-start ticks for a category axis of ISO dates: one label per month, thinned to fit.
  function monthTicks(dates, maxLabels = 8) {
    const starts = [];
    dates.forEach((d, i) => { if (i === 0 || d.slice(0, 7) !== dates[i - 1].slice(0, 7)) starts.push(i); });
    const step = Math.max(1, Math.ceil(starts.length / maxLabels));
    const keep = new Set(starts.filter((_, k) => k % step === 0));
    return function (value, index) {
      if (!keep.has(index)) return '';
      const iso = dates[index];
      const m = Number(iso.slice(5, 7));
      const showYear = m === 1 || index === starts[0];
      return showYear ? `${MONTHS[m - 1]} ${iso.slice(2, 4)}` : MONTHS[m - 1];
    };
  }

  function lineGradient(color) {
    return ctx => {
      const { chart } = ctx;
      const area = chart.chartArea;
      if (!area) return color;
      const g = chart.ctx.createLinearGradient(0, area.top, 0, area.bottom);
      g.addColorStop(0, color);
      g.addColorStop(1, 'transparent');
      return g;
    };
  }

  // Nav: mark the current page.
  function markNav(current) {
    document.querySelectorAll('[data-nav]').forEach(a => {
      if (a.dataset.nav === current) a.setAttribute('aria-current', 'page');
      else a.removeAttribute('aria-current');
    });
  }

  window.Fin = {
    theme: { read: readTheme, set: setTheme, effective: effectiveTheme, onChange: fn => listeners.add(fn) },
    token, tokens, money, pct, number, figure, symbol, MONTHS, MONTHS_LONG, todayAr, shortDate, longDay, monthLabel, relDays,
    icon, mark, hydrate, rosette, chartDefaults, crosshair, monthTicks, lineGradient, markNav
  };
})();
