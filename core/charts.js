/**
 * Pure native SVG & DOM chart renderers shared by Dhirna Desktop & Browser Extension.
 * Theme-aware via CSS custom properties (--chart-*), zero external dependencies, 100% offline.
 */

import { formatDuration } from "./analytics.js";
import { t } from "./i18n.js";

const SVG_NS = "http://www.w3.org/2000/svg";

function svgEl(tag, attrs = {}) {
  const el = document.createElementNS(SVG_NS, tag);
  for (const [k, v] of Object.entries(attrs)) {
    el.setAttribute(k, String(v));
  }
  return el;
}

/**
 * Renders the main daily focus vs distraction SVG bar chart with interactive crosshair & tooltip.
 */
export function renderDailyFocusChart(container, series, lang = "fr") {
  container.innerHTML = "";

  if (!Array.isArray(series) || series.length === 0) {
    const empty = document.createElement("div");
    empty.className = "empty-placeholder";
    empty.textContent = t("dash_empty_state", lang);
    container.appendChild(empty);
    return;
  }

  const maxMs = Math.max(
    60 * 60_000,
    ...series.map((d) => Math.max(d.focusMs, d.distractionMs))
  );
  const maxMin = Math.ceil(maxMs / 60_000 / 30) * 30;
  const maxValMs = maxMin * 60_000;

  const width = 620;
  const height = 248;
  const pad = { top: 18, right: 14, bottom: 34, left: 48 };
  const plotW = width - pad.left - pad.right;
  const plotH = height - pad.top - pad.bottom;

  const wrap = document.createElement("div");
  wrap.className = "chart-svg-wrap";

  const tooltip = document.createElement("div");
  tooltip.className = "chart-tooltip hidden";
  wrap.appendChild(tooltip);

  const svg = svgEl("svg", {
    viewBox: `0 0 ${width} ${height}`,
    class: "focus-svg",
    role: "img",
    "aria-label": t("dash_chart_title", lang)
  });

  // Architectural horizontal baseline & dashed subdivisions
  const gridSteps = 3;
  for (let i = 0; i <= gridSteps; i += 1) {
    const ratio = i / gridSteps;
    const y = pad.top + plotH - ratio * plotH;
    svg.appendChild(
      svgEl("line", {
        x1: pad.left,
        x2: width - pad.right,
        y1: y.toFixed(1),
        y2: y.toFixed(1),
        stroke: "var(--chart-grid)",
        "stroke-width": i === 0 ? "1.2" : "1",
        ...(i > 0 ? { "stroke-dasharray": "3 4" } : {})
      })
    );

    const valMin = Math.round(maxMin * ratio);
    const lblText =
      valMin >= 60 ? `${(valMin / 60).toFixed(valMin % 60 === 0 ? 0 : 1)}h` : `${valMin}m`;
    const label = svgEl("text", {
      x: pad.left - 10,
      y: (y + 4).toFixed(1),
      "text-anchor": "end",
      fill: "var(--chart-text)",
      "font-family": "var(--font-mono)",
      "font-size": "11"
    });
    label.textContent = lblText;
    svg.appendChild(label);
  }

  // Interactive vertical guide crosshair
  const crosshair = svgEl("line", {
    x1: pad.left,
    x2: pad.left,
    y1: pad.top,
    y2: pad.top + plotH,
    stroke: "var(--chart-crosshair)",
    "stroke-width": "1",
    "stroke-dasharray": "2 3",
    opacity: "0",
    "pointer-events": "none"
  });
  svg.appendChild(crosshair);

  const slotW = plotW / series.length;
  const barGap = series.length > 14 ? 2 : 5;
  const maxBarW = series.length === 1 ? 52 : series.length <= 7 ? 26 : 11;
  const focusW = Math.max(4, Math.min(maxBarW, Math.floor((slotW - barGap * 2) * 0.64)));
  const distW = Math.max(3, Math.floor(focusW * 0.44));
  const labelStride = series.length <= 7 ? 1 : series.length <= 15 ? 2 : 5;

  series.forEach((row, idx) => {
    const cx = pad.left + idx * slotW + slotW / 2;
    const focusH = Math.max(row.focusMs > 0 ? 4 : 0, (row.focusMs / maxValMs) * plotH);
    const distH = Math.max(row.distractionMs > 0 ? 4 : 0, (row.distractionMs / maxValMs) * plotH);

    const totalGroupW = focusW + 3 + distW;
    const startX = cx - totalGroupW / 2;

    const group = svgEl("g", { class: "bar-group" });

    const hit = svgEl("rect", {
      x: (pad.left + idx * slotW).toFixed(1),
      y: pad.top,
      width: slotW.toFixed(1),
      height: plotH,
      rx: 4,
      fill: "transparent",
      class: "bar-hit"
    });
    group.appendChild(hit);

    if (focusH > 0) {
      group.appendChild(
        svgEl("rect", {
          x: startX.toFixed(1),
          y: (pad.top + plotH - focusH).toFixed(1),
          width: focusW,
          height: focusH.toFixed(1),
          rx: 4,
          fill: "var(--chart-focus)",
          class: "bar-focus"
        })
      );
    }

    if (distH > 0) {
      group.appendChild(
        svgEl("rect", {
          x: (startX + focusW + 3).toFixed(1),
          y: (pad.top + plotH - distH).toFixed(1),
          width: distW,
          height: distH.toFixed(1),
          rx: 3,
          fill: "var(--chart-dist)",
          class: "bar-dist"
        })
      );
    }

    if (idx % labelStride === 0 || idx === series.length - 1) {
      const xLbl = svgEl("text", {
        x: cx.toFixed(1),
        y: height - 9,
        "text-anchor": "middle",
        fill: "var(--chart-text)",
        "font-family": "var(--font-mono)",
        "font-size": "11"
      });
      xLbl.textContent = row.shortLabel;
      svg.appendChild(xLbl);
    }

    group.addEventListener("mouseenter", () => {
      crosshair.setAttribute("x1", cx.toFixed(1));
      crosshair.setAttribute("x2", cx.toFixed(1));
      crosshair.setAttribute("opacity", "1");

      const focusLbl = t("dash_chart_legend_focus", lang);
      const distLbl = t("dash_chart_legend_dist", lang);
      const blkLbl = t("dash_kpi_blocked", lang);
      const totalDay = row.focusMs + row.distractionMs;
      const sharePct = totalDay > 0 ? Math.round((row.focusMs / totalDay) * 100) : null;

      tooltip.innerHTML = "";
      const head = document.createElement("div");
      head.className = "tt-day";
      head.textContent = sharePct !== null ? `${row.day} (${sharePct}%)` : row.day;
      tooltip.appendChild(head);

      const line1 = document.createElement("div");
      line1.className = "tt-row";
      line1.innerHTML = `<span class="tt-label"><i class="dot dot-work"></i>${focusLbl}</span><strong>${formatDuration(row.focusMs)}</strong>`;
      tooltip.appendChild(line1);

      const line2 = document.createElement("div");
      line2.className = "tt-row";
      line2.innerHTML = `<span class="tt-label"><i class="dot dot-muted"></i>${distLbl}</span><span>${formatDuration(row.distractionMs)}</span>`;
      tooltip.appendChild(line2);

      const line3 = document.createElement("div");
      line3.className = "tt-row";
      line3.innerHTML = `<span class="tt-label"><i class="dot dot-block"></i>${blkLbl}</span><span>${row.blockedCount}</span>`;
      tooltip.appendChild(line3);

      tooltip.classList.remove("hidden");
      const leftPct = Math.min(68, Math.max(4, (cx / width) * 100 - 11));
      tooltip.style.left = `${leftPct}%`;
      tooltip.style.top = "8px";
    });

    group.addEventListener("mouseleave", () => {
      crosshair.setAttribute("opacity", "0");
      tooltip.classList.add("hidden");
    });

    svg.appendChild(group);
  });

  wrap.appendChild(svg);
  container.appendChild(wrap);
}

/**
 * Renders a compact ranked list with proportional architectural bars (Top Blocked or Time by Tool).
 */
export function renderRankedList(container, items, mode = "count", lang = "fr") {
  container.innerHTML = "";

  if (!Array.isArray(items) || items.length === 0) {
    const empty = document.createElement("div");
    empty.className = "empty-placeholder";
    empty.textContent = t("dash_empty_state", lang);
    container.appendChild(empty);
    return;
  }

  const maxVal = Math.max(
    1,
    ...items.map((item) => (mode === "duration" ? item.durationMs : item.count))
  );

  for (const item of items) {
    const val = mode === "duration" ? item.durationMs : item.count;
    const pct = Math.max(4, Math.round((val / maxVal) * 100));

    const row = document.createElement("div");
    row.className = "ranked-row";

    const top = document.createElement("div");
    top.className = "ranked-top";

    const nameWrap = document.createElement("div");
    nameWrap.className = "ranked-name-wrap";

    const dot = document.createElement("span");
    dot.className =
      mode === "duration" && item.kind === "work"
        ? "dot dot-work"
        : mode === "duration" && item.kind === "neutral"
          ? "dot dot-muted"
          : "dot dot-block";
    nameWrap.appendChild(dot);

    const name = document.createElement("span");
    name.className = "ranked-name";
    name.textContent = item.target;
    nameWrap.appendChild(name);

    const metric = document.createElement("span");
    metric.className = "ranked-val";
    metric.textContent = mode === "duration" ? formatDuration(val) : String(val);

    top.appendChild(nameWrap);
    top.appendChild(metric);

    const track = document.createElement("div");
    track.className = "ranked-track";
    const fill = document.createElement("div");
    fill.className =
      mode === "duration" && item.kind === "work"
        ? "ranked-fill fill-work"
        : mode === "count"
          ? "ranked-fill fill-block"
          : "ranked-fill";
    fill.style.width = `${pct}%`;
    track.appendChild(fill);

    row.appendChild(top);
    row.appendChild(track);
    container.appendChild(row);
  }
}

/**
 * Renders the 24-hour (00h..23h) distraction strip highlighting the peak slip hour.
 */
export function renderHourlyStrip(container, hourly, lang = "fr") {
  container.innerHTML = "";
  const hours = hourly?.hours || [];
  const maxCount = hourly?.maxCount || 0;
  const peakHour = hourly?.peakHour;

  if (maxCount === 0) {
    const empty = document.createElement("div");
    empty.className = "empty-placeholder";
    empty.textContent = t("dash_hourly_none", lang);
    container.appendChild(empty);
    return;
  }

  const width = 460;
  const height = 142;
  const pad = { top: 14, right: 8, bottom: 26, left: 8 };
  const plotW = width - pad.left - pad.right;
  const plotH = height - pad.top - pad.bottom;
  const slotW = plotW / 24;
  const barW = Math.max(7, Math.floor(slotW - 4));

  const svg = svgEl("svg", {
    viewBox: `0 0 ${width} ${height}`,
    class: "hourly-svg",
    role: "img",
    "aria-label": t("dash_hourly_title", lang)
  });

  svg.appendChild(
    svgEl("line", {
      x1: pad.left,
      x2: width - pad.right,
      y1: pad.top + plotH,
      y2: pad.top + plotH,
      stroke: "var(--chart-grid)",
      "stroke-width": "1.2"
    })
  );

  for (const h of hours) {
    const x = pad.left + h.hour * slotW + (slotW - barW) / 2;
    const barH = h.count > 0 ? Math.max(5, (h.count / maxCount) * plotH) : 3;
    const isPeak = h.hour === peakHour;

    const rect = svgEl("rect", {
      x: x.toFixed(1),
      y: (pad.top + plotH - barH).toFixed(1),
      width: barW,
      height: barH.toFixed(1),
      rx: 3,
      fill: isPeak
        ? "var(--chart-peak)"
        : h.count > 0
          ? "var(--chart-dist)"
          : "var(--chart-empty)",
      class: isPeak ? "hourly-bar hourly-bar-peak" : "hourly-bar"
    });
    const titleEl = svgEl("title");
    titleEl.textContent = `${h.label} : ${h.count}`;
    rect.appendChild(titleEl);
    svg.appendChild(rect);

    if (h.hour === 0 || h.hour === 6 || h.hour === 12 || h.hour === 18 || h.hour === 23) {
      const lbl = svgEl("text", {
        x: (x + barW / 2).toFixed(1),
        y: height - 5,
        "text-anchor": "middle",
        fill: "var(--chart-text)",
        "font-family": "var(--font-mono)",
        "font-size": "10"
      });
      lbl.textContent = h.label;
      svg.appendChild(lbl);
    }
  }

  container.appendChild(svg);
}
