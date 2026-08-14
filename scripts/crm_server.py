#!/usr/bin/env python3
import csv
import json
import subprocess
import sys
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import urlparse

from openpyxl import load_workbook


ROOT = Path(__file__).resolve().parents[1]
WORKBOOK_PATH = ROOT / "outputs/financial_monitor/financial_monitor_pipeline.xlsx"
FOLLOWUPS_PATH = ROOT / "config/client_followups.tsv"
RUN_SCRIPT = ROOT / "scripts/run_finmonitor_prod.sh"
FOLLOWUP_COLUMNS = ["client", "responsable", "proxima_accion", "fecha_actualizacion", "seguimiento_notas"]
APP_VERSION = "loan-tape-prod-2026-08-14-2"
CRM_CACHE = {"mtime_ns": None, "payload": None}


HTML = r"""<!doctype html>
<html lang="es">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Financial Monitor CRM</title>
  <style>
    :root {
      color-scheme: light dark;
      --bg: #ffffff;
      --surface: #fbfcfe;
      --surface-alt: #f7f9fc;
      --table-bg: #ffffff;
      --row-hover: #dff4f1;
      --row-selected: #c7ece7;
      --field-bg: #ffffff;
      --field-edit: #fff7d6;
      --ink: #111827;
      --muted: #526070;
      --line: #d8dee8;
      --header: #0f172a;
      --header-line: #263247;
      --accent: #0f766e;
      --link: #0f766e;
      --placeholder: #758195;
      --button-bg: #0f172a;
      --button-border: #0f172a;
      --focus-ring: rgba(15, 118, 110, 0.16);
      --warn: #b45309;
      --bad: #b91c1c;
      --good: #047857;
      --pill-bad-bg: #fecaca;
      --pill-bad-line: #ef4444;
      --pill-warn-bg: #fde68a;
      --pill-warn-line: #f59e0b;
      --pill-good-bg: #bbf7d0;
      --pill-good-line: #22c55e;
    }
    @media (prefers-color-scheme: dark) {
      :root {
        --bg: #050816;
        --surface: #0b1220;
        --surface-alt: #111827;
        --table-bg: #08111f;
        --row-hover: #123f3f;
        --row-selected: #185957;
        --field-bg: #0f172a;
        --field-edit: #2d260f;
        --ink: #f8fafc;
        --muted: #cbd5e1;
        --line: #334155;
        --header: #020617;
        --header-line: #475569;
        --accent: #2dd4bf;
        --link: #5eead4;
        --placeholder: #94a3b8;
        --button-bg: #0f766e;
        --button-border: #14b8a6;
        --focus-ring: rgba(45, 212, 191, 0.24);
        --warn: #fbbf24;
        --bad: #f87171;
        --good: #4ade80;
        --pill-bad-bg: #5f171b;
        --pill-bad-line: #ef4444;
        --pill-warn-bg: #4a3508;
        --pill-warn-line: #f59e0b;
        --pill-good-bg: #103d24;
        --pill-good-line: #22c55e;
      }
    }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      color: var(--ink);
      background: var(--bg);
    }
    .shell {
      min-height: 100vh;
      display: grid;
      grid-template-columns: 260px minmax(0, 1fr) 360px;
    }
    aside {
      border-right: 1px solid var(--line);
      background: var(--surface-alt);
      padding: 18px;
      overflow: auto;
    }
    main {
      min-width: 0;
      padding: 18px;
    }
    .detail {
      border-left: 1px solid var(--line);
      padding: 18px;
      background: var(--surface);
    }
    h1 {
      font-size: 19px;
      margin: 0 0 4px;
      letter-spacing: 0;
    }
    h2 {
      font-size: 13px;
      margin: 22px 0 10px;
      color: var(--muted);
      text-transform: uppercase;
      letter-spacing: 0;
    }
    .stamp {
      color: var(--muted);
      font-size: 12px;
      line-height: 1.35;
      min-height: 18px;
    }
    .metric {
      display: grid;
      grid-template-columns: 1fr auto;
      gap: 10px;
      padding: 9px 0;
      border-bottom: 1px solid var(--line);
      font-size: 13px;
    }
    .metric strong {
      font-size: 16px;
    }
    .process-list {
      display: grid;
      grid-template-columns: repeat(2, minmax(0, 1fr));
      gap: 6px;
    }
    .process {
      border: 1px solid var(--line);
      border-left: 4px solid var(--accent);
      background: var(--surface);
      min-height: 58px;
      padding: 6px 7px;
    }
    .process strong {
      display: block;
      font-size: 11px;
      line-height: 1.25;
      margin-bottom: 2px;
    }
    .process span {
      display: block;
      color: var(--muted);
      font-size: 10px;
      line-height: 1.25;
    }
    .toolbar {
      display: grid;
      grid-template-columns: minmax(220px, 1fr) 150px 150px auto auto;
      gap: 8px;
      align-items: center;
      margin-bottom: 12px;
    }
    input, select, textarea, button {
      font: inherit;
    }
    input, select, textarea {
      width: 100%;
      border: 1px solid var(--line);
      background: var(--field-bg);
      color: var(--ink);
      min-height: 34px;
      padding: 7px 9px;
      outline: none;
    }
    textarea {
      min-height: 92px;
      resize: vertical;
      line-height: 1.35;
    }
    input:focus, select:focus, textarea:focus {
      border-color: var(--accent);
      box-shadow: 0 0 0 2px var(--focus-ring);
    }
    input::placeholder, textarea::placeholder {
      color: var(--placeholder);
      opacity: 1;
    }
    button {
      border: 1px solid var(--button-border);
      background: var(--button-bg);
      color: #ffffff;
      min-height: 34px;
      padding: 7px 11px;
      cursor: pointer;
    }
    button.secondary {
      background: var(--field-bg);
      color: var(--ink);
      border-color: var(--line);
    }
    button:disabled {
      cursor: wait;
      opacity: .65;
    }
    .table-wrap {
      overflow: auto;
      border: 1px solid var(--line);
      max-height: calc(100vh - 88px);
      background: var(--table-bg);
    }
    table {
      width: 100%;
      border-collapse: collapse;
      font-size: 13px;
      min-width: 1320px;
    }
    thead th {
      position: sticky;
      top: 0;
      z-index: 1;
      background: var(--header);
      color: #ffffff;
      text-align: left;
      padding: 8px;
      white-space: nowrap;
      border-right: 1px solid var(--header-line);
    }
    tbody td {
      padding: 8px;
      border-top: 1px solid var(--line);
      vertical-align: top;
      white-space: nowrap;
    }
    tbody tr {
      cursor: pointer;
    }
    tbody tr:hover {
      background: var(--row-hover);
    }
    tbody tr.selected {
      background: var(--row-selected);
      outline: 2px solid var(--accent);
      outline-offset: -2px;
    }
    .num {
      text-align: right;
      font-variant-numeric: tabular-nums;
    }
    .pill {
      display: inline-block;
      padding: 3px 7px;
      font-size: 12px;
      border: 1px solid transparent;
      white-space: nowrap;
      font-weight: 700;
    }
    .Alta, .Requiere, .Revisar { background: var(--pill-bad-bg); color: var(--bad); border-color: var(--pill-bad-line); }
    .Media, .Sin { background: var(--pill-warn-bg); color: var(--warn); border-color: var(--pill-warn-line); }
    .Baja, .Actualizado, .Listo, .OK { background: var(--pill-good-bg); color: var(--good); border-color: var(--pill-good-line); }
    a {
      color: var(--link);
    }
    .fields {
      display: grid;
      gap: 10px;
    }
    label {
      display: grid;
      gap: 5px;
      color: var(--muted);
      font-size: 12px;
    }
    label span {
      color: var(--ink);
      font-size: 13px;
      font-weight: 600;
    }
    .edit {
      background: var(--field-edit);
    }
    .readonly {
      display: grid;
      gap: 8px;
      margin: 14px 0;
      padding: 12px 0;
      border-top: 1px solid var(--line);
      border-bottom: 1px solid var(--line);
      font-size: 13px;
    }
    .readonly div {
      display: grid;
      grid-template-columns: 130px 1fr;
      gap: 10px;
    }
    .readonly b {
      color: var(--muted);
      font-weight: 600;
    }
    .statusline {
      min-height: 18px;
      margin-top: 10px;
      color: var(--muted);
      font-size: 12px;
      line-height: 1.35;
      white-space: pre-wrap;
    }
    @media (max-width: 1100px) {
      .shell { grid-template-columns: 1fr; }
      aside, .detail { border: 0; border-bottom: 1px solid var(--line); }
      .toolbar { grid-template-columns: 1fr 1fr; }
      .table-wrap { max-height: 55vh; }
    }
  </style>
</head>
<body>
  <div class="shell">
    <aside>
      <h1>Financial Monitor CRM</h1>
      <div id="stamp" class="stamp"></div>
      <h2>Resumen</h2>
      <div id="metrics"></div>
      <h2>Procesos</h2>
      <div id="processes" class="process-list"></div>
      <h2>Salida</h2>
      <button id="run" type="button">Reprocesar</button>
      <div id="runStatus" class="statusline"></div>
    </aside>
    <main>
      <div class="toolbar">
        <input id="search" type="search" placeholder="Buscar cliente, bloqueo, accion" />
        <select id="priority">
          <option value="">Prioridad</option>
          <option>Alta</option>
          <option>Media</option>
          <option>Baja</option>
        </select>
        <select id="status">
          <option value="">Estatus</option>
          <option>Requiere revision</option>
          <option>Sin documentos</option>
          <option>Sin razones</option>
          <option>Actualizado</option>
          <option>Listo para revisar</option>
        </select>
        <button id="refresh" class="secondary" type="button">Actualizar</button>
        <button id="openXlsx" class="secondary" type="button">Excel</button>
      </div>
      <div class="table-wrap">
        <table>
          <thead>
            <tr>
              <th>Cliente</th><th>Estatus</th><th>Prioridad</th><th>Bloqueo</th><th>Accion</th>
              <th>Resp.</th><th>Proxima</th><th>Periodo</th><th class="num">Docs</th>
              <th class="num">Cartera</th><th>Calidad</th><th class="num">Razones</th><th class="num">QA</th><th>Producto</th>
            </tr>
          </thead>
          <tbody id="rows"></tbody>
        </table>
      </div>
    </main>
    <section class="detail">
      <h1 id="clientTitle">Cliente</h1>
      <div id="clientSubtitle" class="stamp"></div>
      <div class="readonly">
        <div><b>Bloqueo</b><span id="roBlocker"></span></div>
        <div><b>Accion</b><span id="roAction"></span></div>
        <div><b>Cartera neta</b><span id="roPortfolio"></span></div>
        <div><b>Calidad cartera</b><span id="roPortfolioQuality"></span></div>
        <div><b>Base cartera</b><span id="roPortfolioBase"></span></div>
        <div><b>Alertas cartera</b><span id="roPortfolioAlerts"></span></div>
        <div><b>Facility</b><span id="roFacility"></span></div>
        <div><b>Contrato</b><span id="roContract"></span></div>
      </div>
      <div class="fields">
        <label><span>Responsable</span><input id="owner" class="edit" /></label>
        <label><span>Proxima accion</span><textarea id="nextAction" class="edit"></textarea></label>
        <label><span>Fecha actualizacion</span><input id="updateDate" class="edit" type="date" /></label>
        <label><span>Notas seguimiento</span><textarea id="notes" class="edit"></textarea></label>
        <button id="save" type="button">Guardar</button>
      </div>
      <div id="saveStatus" class="statusline"></div>
    </section>
  </div>
  <script>
    const processes = [
      {
        name: "Dashboard Comercial",
        line: "Comercial",
        detail: "KPIs, pipeline y cartera",
      },
      {
        name: "CRM Comercial",
        line: "Comercial",
        detail: "Clientes y seguimiento",
      },
      {
        name: "Monitoreo",
        line: "Linea de vida",
        detail: "Clientes, alertas y bloqueos",
      },
      {
        name: "Linea de Analisis",
        line: "Analisis",
        detail: "Benchmark, consolidacion y Z Core",
      },
      {
        name: "MI Quality",
        line: "Data Quality",
        detail: "Ingestion, validacion y QA",
      },
    ];
    const state = { rows: [], selected: null };
    const byId = (id) => document.getElementById(id);
    const clean = (value) => value == null ? "" : String(value);
    const cls = (value) => clean(value).split(" ")[0] || "";
    const num = (value) => Number(value || 0).toLocaleString("en-US");
    const money = (value) => {
      if (value === "" || value == null) return "";
      return Number(value || 0).toLocaleString("en-US", { maximumFractionDigits: 0 });
    };

    async function api(path, options) {
      const response = await fetch(path, options);
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || response.statusText);
      return data;
    }

    function metric(label, value) {
      return `<div class="metric"><span>${label}</span><strong>${num(value)}</strong></div>`;
    }

    function renderMetrics(summary) {
      byId("metrics").innerHTML = [
        metric("Clientes", summary.clients),
        metric("Alta", summary.high),
        metric("Cartera neta", summary.netPortfolio),
        metric("Cartera revisar", summary.loanTapeReview),
        metric("Razones revisar", summary.ratioReview),
        metric("QA revisar", summary.qaReview),
      ].join("");
    }

    function renderProcesses() {
      byId("processes").innerHTML = processes.map((process) => `
        <div class="process" title="${process.detail}">
          <strong>${process.name}</strong>
          <span>${process.line}</span>
        </div>
      `).join("");
    }

    function filteredRows() {
      const q = byId("search").value.trim().toLowerCase();
      const priority = byId("priority").value;
      const status = byId("status").value;
      return state.rows.filter((row) => {
        if (priority && row["Prioridad"] !== priority) return false;
        if (status && row["Estatus"] !== status) return false;
        if (!q) return true;
        return ["Cliente", "Bloqueo principal", "Accion sugerida", "Responsable", "Proxima accion", "Producto", "Calidad cartera", "Alertas cartera", "Base cartera"]
          .some((key) => clean(row[key]).toLowerCase().includes(q));
      });
    }

    function renderRows() {
      const rows = filteredRows();
      byId("rows").innerHTML = rows.map((row) => {
        const selected = state.selected && state.selected["Cliente"] === row["Cliente"] ? " selected" : "";
        return `<tr class="${selected}" data-client="${clean(row["Cliente"])}">
          <td>${clean(row["Cliente"])}</td>
          <td><span class="pill ${cls(row["Estatus"])}">${clean(row["Estatus"])}</span></td>
          <td><span class="pill ${cls(row["Prioridad"])}">${clean(row["Prioridad"])}</span></td>
          <td>${clean(row["Bloqueo principal"])}</td>
          <td>${clean(row["Accion sugerida"])}</td>
          <td>${clean(row["Responsable"])}</td>
          <td>${clean(row["Proxima accion"])}</td>
          <td>${clean(row["Ultimo periodo"])}</td>
          <td class="num">${num(row["Docs"])}</td>
          <td class="num">${money(row["Cartera neta"])}</td>
          <td><span class="pill ${cls(row["Calidad cartera"])}">${clean(row["Calidad cartera"])}</span></td>
          <td class="num">${num(row["Razones revisar"])}</td>
          <td class="num">${num(row["QA revisar"])}</td>
          <td>${clean(row["Producto"])}</td>
        </tr>`;
      }).join("");
    }

    function scheduleRenderRows() {
      clearTimeout(state.renderTimer);
      state.renderTimer = setTimeout(renderRows, 80);
    }

    function selectClient(client) {
      const row = state.rows.find((item) => item["Cliente"] === client) || state.rows[0];
      state.selected = row || null;
      if (!row) return;
      byId("clientTitle").textContent = clean(row["Cliente"]);
      byId("clientSubtitle").textContent = `${clean(row["Estatus"])} / ${clean(row["Prioridad"])} / ${clean(row["Ultimo periodo"])}`;
      byId("roBlocker").textContent = clean(row["Bloqueo principal"]);
      byId("roAction").textContent = clean(row["Accion sugerida"]);
      byId("roPortfolio").textContent = money(row["Cartera neta"]);
      byId("roPortfolioQuality").innerHTML = `<span class="pill ${cls(row["Calidad cartera"])}">${clean(row["Calidad cartera"])}</span>`;
      byId("roPortfolioBase").textContent = clean(row["Base cartera"]);
      byId("roPortfolioAlerts").textContent = clean(row["Alertas cartera"]);
      byId("roFacility").textContent = clean(row["Facility"]) || clean(row["Facility ID"]);
      const link = clean(row["Link contrato"]);
      byId("roContract").innerHTML = link ? `<a href="${link}" target="_blank" rel="noreferrer">Abrir</a>` : "";
      byId("owner").value = clean(row["Responsable"]);
      byId("nextAction").value = clean(row["Proxima accion"]);
      byId("updateDate").value = clean(row["Fecha actualizacion"]).slice(0, 10);
      byId("notes").value = clean(row["Notas seguimiento"]);
      byId("saveStatus").textContent = "";
      renderRows();
    }

    async function load() {
      byId("stamp").textContent = "Cargando...";
      const data = await api("/api/crm");
      state.rows = data.rows;
      renderMetrics(data.summary);
      byId("stamp").textContent = data.workbookUpdated ? `Workbook: ${data.workbookUpdated}` : "";
      renderRows();
      selectClient(state.selected?.["Cliente"] || state.rows[0]?.["Cliente"]);
    }

    async function save() {
      if (!state.selected) return;
      byId("save").disabled = true;
      byId("saveStatus").textContent = "Guardando...";
      try {
        const payload = {
          client: state.selected["Cliente"],
          responsable: byId("owner").value,
          proxima_accion: byId("nextAction").value,
          fecha_actualizacion: byId("updateDate").value,
          seguimiento_notas: byId("notes").value,
        };
        await api("/api/followups", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(payload),
        });
        Object.assign(state.selected, {
          "Responsable": payload.responsable,
          "Proxima accion": payload.proxima_accion,
          "Fecha actualizacion": payload.fecha_actualizacion,
          "Notas seguimiento": payload.seguimiento_notas,
        });
        byId("saveStatus").textContent = "Guardado.";
        renderRows();
      } catch (error) {
        byId("saveStatus").textContent = error.message;
      } finally {
        byId("save").disabled = false;
      }
    }

    async function runPipeline() {
      byId("run").disabled = true;
      byId("runStatus").textContent = "Procesando...";
      try {
        const data = await api("/api/run", { method: "POST" });
        byId("runStatus").textContent = data.message;
        await load();
      } catch (error) {
        byId("runStatus").textContent = error.message;
      } finally {
        byId("run").disabled = false;
      }
    }

    byId("rows").addEventListener("click", (event) => {
      const row = event.target.closest("tr[data-client]");
      if (row) selectClient(row.dataset.client);
    });
    byId("search").addEventListener("input", scheduleRenderRows);
    byId("priority").addEventListener("change", renderRows);
    byId("status").addEventListener("change", renderRows);
    byId("refresh").addEventListener("click", load);
    byId("save").addEventListener("click", save);
    byId("run").addEventListener("click", runPipeline);
    byId("openXlsx").addEventListener("click", () => api("/api/open-workbook", { method: "POST" }));
    renderProcesses();
    load().catch((error) => byId("stamp").textContent = error.message);
  </script>
</body>
</html>
"""


def _json_response(handler, status, payload):
    body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
    handler.send_response(status)
    handler.send_header("Content-Type", "application/json; charset=utf-8")
    handler.send_header("Cache-Control", "no-store")
    handler.send_header("Content-Length", str(len(body)))
    handler.end_headers()
    handler.wfile.write(body)


def _read_body(handler):
    length = int(handler.headers.get("Content-Length", "0") or "0")
    raw = handler.rfile.read(length).decode("utf-8") if length else "{}"
    return json.loads(raw)


def _cell_value(value):
    if value is None:
        return ""
    if hasattr(value, "isoformat"):
        return value.isoformat()[:10]
    return value


def read_crm_rows():
    if not WORKBOOK_PATH.exists():
        raise FileNotFoundError(f"Workbook not found: {WORKBOOK_PATH}")
    workbook = load_workbook(WORKBOOK_PATH, read_only=True, data_only=True)
    try:
      sheet = workbook["CRM Clientes"]
      headers = [_cell_value(cell.value) for cell in next(sheet.iter_rows(min_row=1, max_row=1))]
      rows = []
      for row in sheet.iter_rows(min_row=2, values_only=True):
          record = {headers[index]: _cell_value(value) for index, value in enumerate(row) if index < len(headers)}
          if record.get("Cliente"):
              rows.append(record)
      return rows
    finally:
      workbook.close()


def read_crm_payload():
    stat = WORKBOOK_PATH.stat()
    if CRM_CACHE["payload"] is not None and CRM_CACHE["mtime_ns"] == stat.st_mtime_ns:
        return CRM_CACHE["payload"]
    rows = read_crm_rows()
    updated = time.strftime("%Y-%m-%d %H:%M:%S", time.localtime(stat.st_mtime))
    payload = {
        "rows": rows,
        "summary": summarize(rows),
        "workbookUpdated": updated,
        "version": APP_VERSION,
    }
    CRM_CACHE.update({"mtime_ns": stat.st_mtime_ns, "payload": payload})
    return payload


def summarize(rows):
    net_portfolio = 0
    loan_tape_review = 0
    for row in rows:
        try:
            net_portfolio += float(row.get("Cartera neta") or 0)
        except (TypeError, ValueError):
            pass
        if row.get("Calidad cartera") in {"Revisar", "Sin cartera"}:
            loan_tape_review += 1
    return {
        "clients": len(rows),
        "high": sum(1 for row in rows if row.get("Prioridad") == "Alta"),
        "netPortfolio": net_portfolio,
        "loanTapeReview": loan_tape_review,
        "ratioReview": sum(int(row.get("Razones revisar") or 0) for row in rows),
        "qaReview": sum(int(row.get("QA revisar") or 0) for row in rows),
    }


def load_followups():
    rows = []
    if FOLLOWUPS_PATH.exists():
        with FOLLOWUPS_PATH.open("r", encoding="utf-8", newline="") as handle:
            reader = csv.DictReader(handle, delimiter="\t")
            for row in reader:
                rows.append({column: row.get(column, "") for column in FOLLOWUP_COLUMNS})
    return rows


def save_followup(update):
    client = str(update.get("client", "")).strip()
    if not client:
        raise ValueError("Missing client")
    rows = load_followups()
    by_client = {row["client"]: row for row in rows if row.get("client")}
    current = by_client.get(client, {"client": client})
    for column in FOLLOWUP_COLUMNS[1:]:
        current[column] = str(update.get(column, "") or "")
    by_client[client] = current
    ordered_clients = [row["client"] for row in rows if row.get("client")]
    if client not in ordered_clients:
        ordered_clients.append(client)
    FOLLOWUPS_PATH.parent.mkdir(parents=True, exist_ok=True)
    temp_path = FOLLOWUPS_PATH.with_suffix(".tmp")
    with temp_path.open("w", encoding="utf-8", newline="") as handle:
        writer = csv.DictWriter(handle, fieldnames=FOLLOWUP_COLUMNS, delimiter="\t", lineterminator="\n")
        writer.writeheader()
        for item in ordered_clients:
            writer.writerow({column: by_client[item].get(column, "") for column in FOLLOWUP_COLUMNS})
    temp_path.replace(FOLLOWUPS_PATH)


class Handler(BaseHTTPRequestHandler):
    def log_message(self, format, *args):
        return

    def do_GET(self):
        route = urlparse(self.path).path
        if route == "/":
            body = HTML.encode("utf-8")
            self.send_response(200)
            self.send_header("Content-Type", "text/html; charset=utf-8")
            self.send_header("Cache-Control", "no-store")
            self.send_header("X-CRM-Version", APP_VERSION)
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)
            return
        if route == "/api/crm":
            try:
                _json_response(self, 200, read_crm_payload())
            except Exception as exc:
                _json_response(self, 500, {"error": str(exc)})
            return
        _json_response(self, 404, {"error": "Not found"})

    def do_POST(self):
        route = urlparse(self.path).path
        if route == "/api/followups":
            try:
                save_followup(_read_body(self))
                _json_response(self, 200, {"ok": True})
            except Exception as exc:
                _json_response(self, 400, {"error": str(exc)})
            return
        if route == "/api/run":
            try:
                result = subprocess.run(
                    [str(RUN_SCRIPT)],
                    cwd=str(ROOT),
                    text=True,
                    capture_output=True,
                    timeout=900,
                    check=False,
                )
                if result.returncode:
                    _json_response(self, 500, {"error": result.stderr or result.stdout or "Pipeline failed"})
                else:
                    CRM_CACHE.update({"mtime_ns": None, "payload": None})
                    lines = [line for line in result.stdout.splitlines() if line.strip()]
                    _json_response(self, 200, {"message": lines[-1] if lines else "Procesado."})
            except Exception as exc:
                _json_response(self, 500, {"error": str(exc)})
            return
        if route == "/api/open-workbook":
            try:
                subprocess.Popen(["open", str(WORKBOOK_PATH)])
                _json_response(self, 200, {"ok": True})
            except Exception as exc:
                _json_response(self, 500, {"error": str(exc)})
            return
        _json_response(self, 404, {"error": "Not found"})


def main():
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 8765
    server = ThreadingHTTPServer(("127.0.0.1", port), Handler)
    print(f"http://127.0.0.1:{port}")
    server.serve_forever()


if __name__ == "__main__":
    main()
