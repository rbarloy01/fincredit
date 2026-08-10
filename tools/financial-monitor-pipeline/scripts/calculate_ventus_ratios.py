import re
from pathlib import Path

import pandas as pd
import pdfplumber


BASE = Path("/Users/syscap/Library/CloudStorage/GoogleDrive-rbarron@syscap.com.mx/Shared drives/Axcess - Crédito y Riesgo/1. Clientes/2. Activos & Prospectos/Ventus/1. Data Room/3. Información Financiera/1. Estados Financieros")
OUT = Path("/Users/syscap/Documents/New project 2/outputs/financial_ratios")
OUT.mkdir(parents=True, exist_ok=True)

AMOUNT_RE = r"\(?-?\s*(?:\d+\s+)?\d{1,3}(?:\s*,\s*\d{3})+(?:\.\d+)?\)?|\(?-?\s*\d+(?:\.\d+)?\)?"


def clean_number(s):
    if s is None:
        return None
    s = str(s).replace(" ", "")
    if s in {"-", ""}:
        return 0.0
    neg = s.startswith("(") and s.endswith(")")
    s = s.strip("()").replace(",", "")
    try:
        n = float(s)
    except ValueError:
        return None
    return -n if neg else n


def money_candidates(text):
    text = "" if text is None else str(text)
    text = re.sub(r"-?\d+(?:\.\d+)?%", " ", text)
    return re.findall(AMOUNT_RE, text)


def extract_first_amount(line):
    # Handles OCR/text extraction like "5 ,342,457" as well as "(1,841,701)".
    matches = money_candidates(line)
    if not matches:
        return None
    return clean_number(matches[-2] if len(matches) > 1 and "%" in line else matches[-1])


def extract_amount_after_label(text, label):
    for line in text.splitlines():
        if label.lower() not in line.lower():
            continue
        tail = line[re.search(re.escape(label), line, re.I).end():]
        matches = money_candidates(tail)
        if matches:
            return clean_number(matches[0]), line
    return None, ""


def pair_label_value_tables(tables):
    rows = {}
    raw = {}
    i = 0
    while i < len(tables) - 1:
        labels = tables[i]
        values = tables[i + 1]
        labels_are_single = labels and max(len(r) for r in labels if r) == 1
        values_have_amounts = values and max(len(r) for r in values if r) >= 1
        if labels_are_single and values_have_amounts:
            n = min(len(labels), len(values))
            for idx in range(n):
                label = (labels[idx][0] or "").strip()
                amount_cell = values[idx][0] if values[idx] else ""
                amount = clean_number(amount_cell)
                if label and amount is not None:
                    rows[label] = amount
                    raw[label] = f"{label} | {amount_cell}"
            i += 2
        else:
            i += 1
    return rows, raw


def find_label_value(rows, raw, *labels):
    for label in labels:
        for key, value in rows.items():
            if key.strip().lower() == label.strip().lower():
                return value, raw.get(key, key)
    for label in labels:
        for key, value in rows.items():
            if label.strip().lower() in key.strip().lower():
                return value, raw.get(key, key)
    return None, ""


def text_from_pdf(path):
    with pdfplumber.open(path) as pdf:
        return "\n".join(page.extract_text() or "" for page in pdf.pages)


def period_from_name(path):
    m = re.search(r"(\d{6})", path.name)
    if not m:
        return path.stem
    yymmdd = m.group(1)
    return f"20{yymmdd[:2]}-{yymmdd[2:4]}-{yymmdd[4:6]}"


def parse_bg(path):
    text = text_from_pdf(path)
    all_rows = {}
    all_raw = {}
    with pdfplumber.open(path) as pdf:
        for page in pdf.pages:
            rows, raw = pair_label_value_tables(page.extract_tables() or [])
            all_rows.update(rows)
            all_raw.update(raw)
    vals = {}
    source = {}
    label_map = {
        "efectivo_inversiones": ("Efectivo y Equivalentes (Inversiones)", "Bancos"),
        "clientes_arrendamiento": ("Clientes Arrendamiento",),
        "clientes_factoraje": ("Clientes Factoraje",),
        "estimacion_preventiva": ("Estimación de cuentas incobrables",),
        "maquinaria_equipo": ("Maquinaria y equipo",),
        "equipo_transporte": ("Equipo de Transporte", "Automóviles, autobuses, camiones de carga"),
        "depreciacion_acumulada": ("Depreciación acumulada de activos fijos",),
        "fondeadores_cp": ("Fondeadores a corto plazo",),
        "fondeadores_lp": ("Fondeadores a largo plazo",),
        "acreedores_cp_proxy": ("Acreedores diversos a corto plazo",),
        "cuentas_por_pagar_lp_proxy": ("Cuentas por pagar a largo plazo",),
    }
    for key, labels in label_map.items():
        vals[key], source[key] = find_label_value(all_rows, all_raw, *labels)
    if vals.get("fondeadores_lp") is None:
        vals["fondeadores_lp"], source["fondeadores_lp"] = extract_amount_after_label(text, "Fondeadores a largo plazo")

    total_specs = {
        "total_pasivo": "TOTAL PASIVO",
        "total_capital_contable": "TOTAL CAPITAL CONTABLE",
        "total_activo": "TOTAL ACTIVO",
    }
    for key, label in total_specs.items():
        vals[key], source[key] = extract_amount_after_label(text, label)
    return vals, source


def parse_er(path):
    text = text_from_pdf(path)
    all_rows = {}
    all_raw = {}
    with pdfplumber.open(path) as pdf:
        for page in pdf.pages:
            rows, raw = pair_label_value_tables(page.extract_tables() or [])
            all_rows.update(rows)
            all_raw.update(raw)
    vals = {}
    source = {}
    for key, label in {
        "ingresos_totales": "TOTAL INGRESOS",
        "costo_ventas": "TOTAL COSTO DE VENTAS",
        "utilidad_bruta": "UTLIDAD (PÉRDIDA) BRUTA",
        "gastos_operacion": "TOTAL GASTOS DE OPERACIÓN",
        "utilidad_operacion": "UTILIDAD (PÉRDIDA) EN OPERACIÓN",
        "gastos_financieros": "GASTOS FINANCIEROS",
        "productos_financieros": "PRODUCTOS FINANCIEROS",
        "intereses_a_favor": "INTERESES A FAVOR",
        "utilidad_neta": "UTILIDAD (PÉRDIDA) NETA",
    }.items():
        if key in {"gastos_financieros", "productos_financieros", "intereses_a_favor"}:
            vals[key], source[key] = find_label_value(all_rows, all_raw, label)
        else:
            vals[key], source[key] = extract_amount_after_label(text, label)
    # Specific commission income in this Ventus ER.
    commission_income = 0.0
    commission_lines = []
    for line in text.splitlines():
        if re.search(r"INGRESOS COMISI[oó]N|INGRESOS COMISIONES", line, re.I):
            n = extract_first_amount(line)
            if n:
                commission_income += n
                commission_lines.append(line)
    vals["ingresos_por_comisiones"] = commission_income
    source["ingresos_por_comisiones"] = " | ".join(commission_lines)
    return vals, source


def ratio(n, d):
    if n is None or d in (None, 0):
        return None
    return n / d


def status_with_period_qa(base_status, period_qa_ok, missing_inputs, extra_note=""):
    notes = []
    status = base_status
    if not period_qa_ok:
        status = "needs_review"
        notes.append("Balance QA no cuadra para el periodo.")
    if missing_inputs:
        status = "needs_review"
        notes.append("Inputs faltantes: " + ", ".join(missing_inputs))
    if extra_note:
        notes.append(extra_note)
    return status, " ".join(notes)


def main():
    files = list(BASE.rglob("*.pdf"))
    bg_files = {period_from_name(p): p for p in files if re.search(r"\bBG\b|Estado de Situaci", p.name, re.I)}
    er_files = {period_from_name(p): p for p in files if re.search(r"\bER\b|Estado de Result", p.name, re.I)}
    periods = sorted(set(bg_files) & set(er_files))
    # Keep first pass focused on latest 2026/2025 periods with clean BG+ER pairs.
    periods = [p for p in periods if p >= "2025-01-01"][-18:]

    account_rows = []
    ratio_rows = []
    qa_rows = []
    for period in periods:
        bg_vals, bg_src = parse_bg(bg_files[period])
        er_vals, er_src = parse_er(er_files[period])
        vals = {**bg_vals, **er_vals}
        src = {**bg_src, **er_src}
        balance_diff = None
        if vals.get("total_activo") is not None and vals.get("total_pasivo") is not None and vals.get("total_capital_contable") is not None:
            balance_diff = vals["total_activo"] - vals["total_pasivo"] - vals["total_capital_contable"]
        period_qa_ok = balance_diff is not None and abs(balance_diff) <= 1
        qa_rows.append({
            "cliente": "Ventus",
            "periodo": period,
            "check": "total_activo = total_pasivo + total_capital_contable",
            "diferencia": balance_diff,
            "status": "ok" if period_qa_ok else "needs_review",
            "documento_bg": str(bg_files[period]),
        })

        cartera_neta = None
        if vals.get("clientes_arrendamiento") is not None or vals.get("clientes_factoraje") is not None:
            cartera_neta = (vals.get("clientes_arrendamiento") or 0) + (vals.get("clientes_factoraje") or 0) + (vals.get("estimacion_preventiva") or 0)
        otros_activos_generadores = (vals.get("maquinaria_equipo") or 0) + (vals.get("equipo_transporte") or 0) + (vals.get("depreciacion_acumulada") or 0)
        activos_productivos = (vals.get("efectivo_inversiones") or 0) + (cartera_neta or 0) + otros_activos_generadores
        deuda_fondeadores = (vals.get("fondeadores_cp") or 0) + (vals.get("fondeadores_lp") or 0)
        deuda_status = "calculated"
        deuda_note = ""
        if deuda_fondeadores == 0:
            deuda_fondeadores = (vals.get("acreedores_cp_proxy") or 0) + (vals.get("cuentas_por_pagar_lp_proxy") or 0)
            deuda_status = "needs_review"
            deuda_note = "No se encontraron Fondeadores CP/LP; usa Acreedores diversos CP + Cuentas por pagar LP como proxy."

        derived = {
            "cartera_neta": cartera_neta,
            "otros_activos_generadores": otros_activos_generadores,
            "activos_productivos": activos_productivos,
            "deuda_fondeadores": deuda_fondeadores,
        }
        for k, v in {**vals, **derived}.items():
            account_rows.append({
                "cliente": "Ventus",
                "periodo": period,
                "concepto": k,
                "valor": v,
                "fuente": src.get(k, "derivado"),
                "documento_bg": str(bg_files[period]),
                "documento_er": str(er_files[period]),
                "review_status": "needs_review" if k in {"otros_activos_generadores", "activos_productivos"} else "extracted",
            })

        denominator = vals.get("ingresos_totales")
        ratio_specs = [
            ("Margen Financiero", vals.get("utilidad_bruta"), denominator, ["utilidad_bruta", "ingresos_totales"], "utilidad_bruta / ingresos_totales", "needs_review", "Usa utilidad bruta como proxy de margen financiero ajustado para arrendadora."),
            ("Margen Operativo", vals.get("utilidad_operacion"), denominator, ["utilidad_operacion", "ingresos_totales"], "utilidad_operacion / ingresos_totales", "calculated", ""),
            ("Margen Neto", vals.get("utilidad_neta"), denominator, ["utilidad_neta", "ingresos_totales"], "utilidad_neta / ingresos_totales", "calculated", ""),
            ("Rentabilidad Operativa", vals.get("gastos_operacion"), denominator, ["gastos_operacion", "ingresos_totales"], "gastos_operacion / ingresos_totales", "needs_review", "No separa gastos por comisiones; usa total gastos de operacion."),
            ("ROE", vals.get("utilidad_neta"), vals.get("total_capital_contable"), ["utilidad_neta", "total_capital_contable"], "utilidad_neta / total_capital_contable", "calculated", ""),
            ("ROA", vals.get("utilidad_neta"), vals.get("total_activo"), ["utilidad_neta", "total_activo"], "utilidad_neta / total_activo", "calculated", ""),
            ("Tasa Activa", vals.get("productos_financieros") or vals.get("intereses_a_favor"), cartera_neta, ["productos_financieros_o_intereses_a_favor", "cartera_neta"], "productos_financieros / cartera_neta", "needs_review", "Ventus no reporta ingreso por intereses como principal; se usa productos financieros si existe."),
            ("Tasa Pasiva", vals.get("gastos_financieros"), deuda_fondeadores, ["gastos_financieros", "deuda_fondeadores"], "gastos_financieros / fondeadores_cp_lp", deuda_status, deuda_note),
            ("Apalancamiento", deuda_fondeadores, vals.get("total_activo"), ["deuda_fondeadores", "total_activo"], "fondeadores_cp_lp / total_activo", deuda_status, deuda_note),
            ("ICAP", vals.get("total_capital_contable"), vals.get("total_activo"), ["total_capital_contable", "total_activo"], "total_capital_contable / total_activo", "calculated", ""),
            ("ICAP Ajustado", vals.get("total_capital_contable"), cartera_neta, ["total_capital_contable", "cartera_neta"], "total_capital_contable / cartera_neta", "needs_review", "Cartera neta calculada desde clientes arrendamiento/factoraje menos estimacion."),
            ("Cobertura de Deuda", activos_productivos, vals.get("total_pasivo"), ["activos_productivos", "total_pasivo"], "activos_productivos / total_pasivo", "needs_review", "Activos productivos incluye efectivo, cartera neta y activos fijos productivos netos."),
        ]
        for name, numerator, denominator_value, inputs, formula, base_status, base_note in ratio_specs:
            value = ratio(numerator, denominator_value)
            missing = []
            if numerator is None:
                missing.append(inputs[0])
            if denominator_value in (None, 0):
                missing.append(inputs[1])
            status, note = status_with_period_qa(base_status, period_qa_ok, missing, base_note)
            if value is not None and abs(value) > 10:
                status = "needs_review"
                note = (note + " " if note else "") + "Resultado > 10x; validar denominador y definicion."
            ratio_rows.append({
                "cliente": "Ventus",
                "periodo": period,
                "razon": name,
                "numerador": numerator,
                "denominador": denominator_value,
                "resultado": value,
                "resultado_pct": value if value is None else value * 100,
                "formula_usada": formula,
                "inputs": ", ".join(inputs),
                "review_status": status,
                "nota_revision": note,
                "documento_bg": str(bg_files[period]),
                "documento_er": str(er_files[period]),
            })

    output = OUT / "razones_financieras_ventus_piloto.xlsx"
    ratios_df = pd.DataFrame(ratio_rows)
    accounts_df = pd.DataFrame(account_rows)
    qa_df = pd.DataFrame(qa_rows)
    audit_rows = []
    audit_rows.append({"categoria": "periodos", "detalle": "periodos procesados", "conteo": len(periods)})
    audit_rows.append({"categoria": "ratios", "detalle": "ratios totales", "conteo": len(ratios_df)})
    for status, count in ratios_df["review_status"].value_counts().items():
        audit_rows.append({"categoria": "ratios_por_status", "detalle": status, "conteo": int(count)})
    for reason, count in ratios_df[ratios_df["review_status"].eq("needs_review")].groupby("razon").size().sort_values(ascending=False).items():
        audit_rows.append({"categoria": "needs_review_por_razon", "detalle": reason, "conteo": int(count)})
    audit_rows.append({"categoria": "qa_balance", "detalle": "periodos ok", "conteo": int(qa_df["status"].eq("ok").sum())})
    audit_rows.append({"categoria": "qa_balance", "detalle": "periodos needs_review", "conteo": int(qa_df["status"].eq("needs_review").sum())})
    audit_df = pd.DataFrame(audit_rows)

    with pd.ExcelWriter(output, engine="openpyxl") as writer:
        ratios_df.to_excel(writer, sheet_name="Razones", index=False)
        accounts_df.to_excel(writer, sheet_name="Cuentas Fuente", index=False)
        qa_df.to_excel(writer, sheet_name="QA", index=False)
        audit_df.to_excel(writer, sheet_name="Auditoria", index=False)
    print(output)
    print(f"periods={len(periods)} ratios={len(ratio_rows)} accounts={len(account_rows)}")


if __name__ == "__main__":
    main()
