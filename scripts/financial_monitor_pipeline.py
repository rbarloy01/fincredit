import argparse
import hashlib
import json
import re
import signal
import time
import unicodedata
from pathlib import Path

import pandas as pd
import pdfplumber
from openpyxl.styles import Alignment, Border, Font, PatternFill, Side
from openpyxl.utils import get_column_letter
from openpyxl.worksheet.datavalidation import DataValidation


WORKSPACE = Path(__file__).resolve().parents[1]
DEFAULT_CLIENTS_ROOT = Path(
    "/Users/syscap/Library/CloudStorage/GoogleDrive-rbarron@syscap.com.mx/Shared drives/"
    "Axcess - Crédito y Riesgo/1. Clientes/2. Activos & Prospectos"
)
MAPPING_PATH = WORKSPACE / "config/account_mapping_memory.tsv"
CLIENT_METADATA_PATH = WORKSPACE / "config/client_metadata_template.tsv"
OUTPUT_DIR = WORKSPACE / "outputs/financial_monitor"
CACHE_DIR = WORKSPACE / "outputs/.cache/pdf_accounts"
AMOUNT_RE = r"\(?-?\s*(?:\d+\s+)?\d{1,3}(?:\s*,\s*\d{3})+(?:\.\d+)?\)?|\(?-?\s*\d+(?:\.\d+)?\)?"
PAGE_TIMEOUT_SECONDS = 18
SUPPORTED_SUFFIXES = {".pdf", ".xlsx", ".xls", ".webloc"}
EXTRACTABLE_SUFFIXES = {".pdf", ".xlsx", ".xls"}
MONTHS = {
    "ene": "01",
    "enero": "01",
    "feb": "02",
    "febrero": "02",
    "mar": "03",
    "marzo": "03",
    "abr": "04",
    "abril": "04",
    "may": "05",
    "mayo": "05",
    "jun": "06",
    "junio": "06",
    "jul": "07",
    "julio": "07",
    "ago": "08",
    "agosto": "08",
    "sep": "09",
    "sept": "09",
    "septiembre": "09",
    "oct": "10",
    "octubre": "10",
    "nov": "11",
    "noviembre": "11",
    "dic": "12",
    "diciembre": "12",
}
REQUIRED_TOTAL_LABELS = [
    "TOTAL ACTIVO",
    "TOTAL PASIVO",
    "TOTAL CAPITAL CONTABLE",
    "TOTAL INGRESOS",
    "TOTAL COSTO DE VENTAS",
    "UTLIDAD (PÉRDIDA) BRUTA",
    "UTILIDAD (PÉRDIDA) BRUTA",
    "TOTAL GASTOS DE OPERACIÓN",
    "UTILIDAD (PÉRDIDA) EN OPERACIÓN",
    "UTLIDAD (PÉRDIDA) EN OPERACIÓN",
    "UTILIDAD (PÉRDIDA) NETA",
]


class PageTimeout(Exception):
    pass


def timeout_handler(signum, frame):
    raise PageTimeout(f"page extraction timed out after {PAGE_TIMEOUT_SECONDS}s")


def normalize(text):
    text = "" if text is None else str(text)
    text = unicodedata.normalize("NFKD", text)
    text = "".join(ch for ch in text if not unicodedata.combining(ch))
    text = text.lower()
    text = re.sub(r"[^a-z0-9]+", " ", text)
    return re.sub(r"\s+", " ", text).strip()


def clean_number(value):
    if value is None:
        return None
    value = str(value).replace(" ", "")
    if value in {"", "-"}:
        return 0.0
    negative = value.startswith("(") and value.endswith(")")
    value = value.strip("()").replace(",", "")
    try:
        number = float(value)
    except ValueError:
        return None
    return -number if negative else number


def money_candidates(text):
    text = "" if text is None else str(text)
    text = re.sub(r"-?\d+(?:\.\d+)?%", " ", text)
    return re.findall(AMOUNT_RE, text)


def first_money_after_label(line, label):
    match = re.search(re.escape(label), line, re.I)
    if not match:
        return None
    candidates = money_candidates(line[match.end() :])
    return clean_number(candidates[0]) if candidates else None


def period_from_name(path):
    match = re.search(r"(\d{6})", path.name)
    if not match:
        name = normalize(path.name)
        month_match = re.search(
            r"\b(ene|enero|feb|febrero|mar|marzo|abr|abril|may|mayo|jun|junio|jul|julio|ago|agosto|sep|sept|septiembre|oct|octubre|nov|noviembre|dic|diciembre)\b\s*(20\d{2})\b",
            name,
        )
        if month_match:
            return f"{month_match.group(2)}-{MONTHS[month_match.group(1)]}-01"
        return ""
    token = match.group(1)
    return f"20{token[:2]}-{token[2:4]}-{token[4:6]}"


def classify_statement(path):
    name = normalize(path.name)
    if re.search(r"\bbg\b|balance|situacion financiera", name):
        return "BG"
    if re.search(r"\ber\b|estado de resultados|resultados", name):
        return "ER"
    if re.search(r"\bef\b|eeff|estados financieros", name):
        return "EF"
    return "UNKNOWN"


def classify_source_quality(path):
    name = normalize(path.name)
    suffix = path.suffix.lower()
    if "modelo" in name or "proyeccion" in name or "proyecciones" in name:
        return "projection_or_model"
    if "sat" in name or "declaracion" in name or "declaracion anual" in name:
        return "tax_statement"
    if "dictamin" in name or "firmado" in name:
        return "signed_or_audited"
    if suffix in {".xlsx", ".xls"}:
        return "spreadsheet"
    if suffix == ".webloc":
        return "drive_link"
    if suffix == ".pdf":
        return "pdf_text_or_table"
    return "unknown"


def infer_statement_frequency(path):
    name = normalize(path.name)
    if "mensual" in name:
        return "Mensual"
    if "acumulado" in name or re.search(r"\bef\b|eeff|estados financieros", name):
        return "Mensual Acumulado"
    if re.search(r"dictamin|anual|sat|declaracion", name):
        return "Anual"
    return ""


def infer_unit_scale(path, text=""):
    haystack = normalize(f"{path.name} {text[:1000]}")
    if re.search(r"miles de pesos|cifras en miles|en miles", haystack):
        return 1000
    if re.search(r"millones de pesos|cifras en millones|en millones", haystack):
        return 1000000
    return 1


def log_step(label, start=None):
    if start is None:
        print(f"[pipeline] {label}", flush=True)
        return time.perf_counter()
    elapsed = time.perf_counter() - start
    print(f"[pipeline] {label} ({elapsed:.1f}s)", flush=True)
    return elapsed


def cache_path_for(path, max_pages, max_file_mb):
    resolved = str(Path(path).expanduser())
    key = hashlib.sha1(f"{resolved}|pages={max_pages}|mb={max_file_mb}".encode("utf-8")).hexdigest()
    return CACHE_DIR / f"{key}.json"


def file_fingerprint(path):
    stat = Path(path).stat()
    return {"path": str(path), "size": stat.st_size, "mtime_ns": stat.st_mtime_ns}


def read_pdf_cache(path, max_pages, max_file_mb):
    cache_path = cache_path_for(path, max_pages, max_file_mb)
    if not cache_path.exists():
        return None
    try:
        payload = json.loads(cache_path.read_text())
        if payload.get("fingerprint") == file_fingerprint(path):
            return payload
    except (OSError, json.JSONDecodeError):
        return None
    return None


def write_pdf_cache(path, max_pages, max_file_mb, rows, error):
    CACHE_DIR.mkdir(parents=True, exist_ok=True)
    payload = {
        "fingerprint": file_fingerprint(path),
        "rows": rows,
        "error": error,
    }
    cache_path_for(path, max_pages, max_file_mb).write_text(json.dumps(payload, ensure_ascii=False))


def client_financial_dir(clients_root, client):
    return clients_root / client / "1. Data Room/3. Información Financiera/1. Estados Financieros"


def client_root_dir(clients_root, client):
    direct = clients_root / client
    if direct.exists():
        return direct
    if not clients_root.exists():
        return direct
    target = normalize(client)
    for candidate in clients_root.iterdir():
        if candidate.is_dir() and normalize(candidate.name) == target:
            return candidate
    return direct


def find_financial_dirs(clients_root, client):
    root = client_root_dir(clients_root, client)
    direct = client_financial_dir(clients_root, client)
    dirs = []
    if direct.exists():
        dirs.append(direct)
    if root.exists():
        has_flat_financial_files = any(path.is_file() and path.suffix.lower() in SUPPORTED_SUFFIXES for path in root.iterdir())
        if has_flat_financial_files and root not in dirs:
            dirs.append(root)
        for path in root.rglob("1. Estados Financieros"):
            if "3. Información Financiera" in str(path) and path not in dirs:
                dirs.append(path)
    return dirs


def scan_credit_line_evidence(clients_root, clients):
    rows = []
    transaction_markers = re.compile(r"(transacciones|contratos|term sheets|monitoreo)", re.I)
    credit_markers = re.compile(r"(contrato|car[aá]tula|pagare|pagar[eé]|cesi[oó]n|term sheet)", re.I)
    high_signal = re.compile(r"(contrato|car[aá]tula|pagare|pagar[eé]|term sheet)", re.I)
    amount_markers = re.compile(r"(\$|m\b|mxn|usd|cp|lp)", re.I)
    allowed_suffixes = {".pdf", ".docx", ".xlsx", ".xls"}
    for client in clients:
        root = client_root_dir(clients_root, client)
        if not root.exists():
            rows.append({"client": client, "credit_line_found": False, "evidence_type": "missing_client_dir", "path": str(root), "filename": "", "confidence": 0.0})
            continue
        for path in root.rglob("*"):
            if not path.is_file():
                continue
            if path.suffix.lower() not in allowed_suffixes:
                continue
            path_text = str(path)
            if not transaction_markers.search(path_text):
                continue
            name = path.name
            if not high_signal.search(name):
                continue
            if not credit_markers.search(name) and not credit_markers.search(path_text):
                continue
            confidence = 0.65
            if "3. Contratos" in path_text:
                confidence += 0.2
            if amount_markers.search(path_text):
                confidence += 0.1
            rows.append(
                {
                    "client": client,
                    "credit_line_found": True,
                    "evidence_type": "drive_transaction_file",
                    "path": path_text,
                    "filename": name,
                    "confidence": min(confidence, 0.95),
                }
            )
    return pd.DataFrame(rows)


def load_client_metadata(path):
    if not path or not Path(path).exists():
        return pd.DataFrame()
    if str(path).lower().endswith((".xlsx", ".xls")):
        metadata = pd.read_excel(path)
    else:
        metadata = pd.read_csv(path, sep="\t")
    if "client" not in metadata.columns:
        raise ValueError("Client metadata must include a 'client' column.")
    metadata["client"] = metadata["client"].astype(str)
    return metadata


def enrich_with_client_metadata(df, metadata):
    if df.empty or metadata.empty:
        return df
    metadata_cols = [col for col in metadata.columns if col != "client"]
    return df.merge(metadata[["client", *metadata_cols]], on="client", how="left")


def discover_documents(clients_root, clients, from_period="", to_period="", max_documents=0, metadata=None, include_undated=False):
    rows = []
    for client in clients:
        financial_dirs = find_financial_dirs(clients_root, client)
        if not financial_dirs:
            base = client_financial_dir(clients_root, client)
            rows.append(
                {
                    "client": client,
                    "path": str(base),
                    "filename": "",
                    "period": "",
                    "statement": "MISSING_DIR",
                    "status": "missing_financial_dir",
                }
            )
            continue
        for base in financial_dirs:
            for path in base.rglob("*"):
                if path.suffix.lower() not in SUPPORTED_SUFFIXES:
                    continue
                statement = classify_statement(path)
                if statement == "UNKNOWN":
                    continue
                period = period_from_name(path)
                if not include_undated and not period:
                    continue
                if from_period and period and period < from_period:
                    continue
                if to_period and period and period > to_period:
                    continue
                rows.append(
                    {
                        "client": client,
                        "path": str(path),
                        "filename": path.name,
                        "file_size_bytes": path.stat().st_size if path.exists() else None,
                        "period": period,
                        "statement": statement,
                        "source_quality": classify_source_quality(path),
                        "statement_frequency": infer_statement_frequency(path),
                        "unit_scale": infer_unit_scale(path),
                        "pair_key": f"{client}|{period}",
                        "status": "indexed" if path.suffix.lower() in EXTRACTABLE_SUFFIXES else "link_only",
                    }
                )
    df = pd.DataFrame(rows)
    if not df.empty:
        df = df.sort_values(["client", "period", "statement", "filename"])
    if max_documents and len(df) > max_documents:
        df = df.groupby("client", group_keys=False).tail(max(1, max_documents // max(1, len(clients))))
    return enrich_with_client_metadata(df, metadata if metadata is not None else pd.DataFrame())


def pair_label_value_tables(tables):
    rows = []
    index = 0
    while index < len(tables) - 1:
        labels = tables[index]
        values = tables[index + 1]
        labels_are_single = labels and max(len(row) for row in labels if row) == 1
        values_have_amounts = values and max(len(row) for row in values if row) >= 1
        if labels_are_single and values_have_amounts:
            for row_index in range(min(len(labels), len(values))):
                label = (labels[row_index][0] or "").strip()
                amount_cell = values[row_index][0] if values[row_index] else ""
                value = clean_number(amount_cell)
                if label and value is not None:
                    rows.append(
                        {
                            "raw_label": label,
                            "value": value,
                            "raw_value": amount_cell,
                            "source_method": "pdf_table_pair",
                        }
                    )
            index += 2
        else:
            index += 1
    return rows


def extract_pdf_accounts(document, max_pages=5, max_file_mb=8):
    rows = []
    path = Path(document["path"])
    try:
        if path.stat().st_size > max_file_mb * 1024 * 1024:
            return [], f"skipped_heavy_pdf_mb={path.stat().st_size / 1024 / 1024:.1f}"
        with pdfplumber.open(path) as pdf:
            full_text = []
            total_pages = len(pdf.pages)
            if total_pages > max_pages:
                return [], f"skipped_heavy_pdf_pages={total_pages}"
            for page_no, page in enumerate(pdf.pages, start=1):
                signal.signal(signal.SIGALRM, timeout_handler)
                signal.alarm(PAGE_TIMEOUT_SECONDS)
                try:
                    page_text = page.extract_text() or ""
                except PageTimeout as exc:
                    rows.append(
                        {
                            "raw_label": "ERROR",
                            "value": None,
                            "raw_value": str(exc),
                            "source_method": "extract_error",
                            "page": page_no,
                        }
                    )
                    continue
                finally:
                    signal.alarm(0)
                full_text.append(page_text)
                signal.alarm(PAGE_TIMEOUT_SECONDS)
                try:
                    tables = page.extract_tables() or []
                except PageTimeout as exc:
                    rows.append(
                        {
                            "raw_label": "ERROR",
                            "value": None,
                            "raw_value": str(exc),
                            "source_method": "extract_error",
                            "page": page_no,
                        }
                    )
                    tables = []
                except Exception:
                    tables = []
                finally:
                    signal.alarm(0)
                for account in pair_label_value_tables(tables):
                    account.update({"page": page_no})
                    rows.append(account)
            text = "\n".join(full_text)
    except Exception as exc:
        return [], str(exc)

    for label in REQUIRED_TOTAL_LABELS:
        for line in text.splitlines():
            if label.lower() in line.lower():
                value = first_money_after_label(line, label)
                if value is not None:
                    rows.append(
                        {
                            "raw_label": label,
                            "value": value,
                            "raw_value": line,
                            "source_method": "pdf_text_total",
                            "page": None,
                        }
                    )
                break
    return rows, ""


def extract_pdf_accounts_cached(document, max_pages=5, max_file_mb=8, refresh_cache=False):
    path = Path(document["path"])
    if not refresh_cache:
        cached = read_pdf_cache(path, max_pages, max_file_mb)
        if cached is not None:
            return cached.get("rows", []), cached.get("error", ""), True
    rows, error = extract_pdf_accounts(document, max_pages=max_pages, max_file_mb=max_file_mb)
    try:
        write_pdf_cache(path, max_pages, max_file_mb, rows, error)
    except OSError:
        pass
    return rows, error, False


def extract_accounts(documents, max_pages=5, max_file_mb=8, refresh_cache=False):
    account_rows = []
    cache_hits = 0
    pdf_count = 0
    for _, document in documents.iterrows():
        if Path(document["path"]).suffix.lower() != ".pdf":
            continue
        pdf_count += 1
        rows, error, cache_hit = extract_pdf_accounts_cached(
            document,
            max_pages=max_pages,
            max_file_mb=max_file_mb,
            refresh_cache=refresh_cache,
        )
        cache_hits += int(cache_hit)
        if error:
            account_rows.append(
                {
                    **document.to_dict(),
                    "raw_label": "",
                    "normalized_label": "",
                    "value": None,
                    "raw_value": "",
                    "page": None,
                    "source_method": "error",
                    "extract_error": error,
                }
            )
            continue
        for row in rows:
            unit_scale = document.get("unit_scale", 1) or 1
            account_rows.append(
                {
                    **document.to_dict(),
                    "raw_label": row["raw_label"],
                    "normalized_label": normalize(row["raw_label"]),
                    "value": row["value"] * unit_scale if row["value"] is not None else None,
                    "original_value": row["value"],
                    "unit_scale_applied": unit_scale,
                    "raw_value": row["raw_value"],
                    "page": row["page"],
                    "source_method": row["source_method"],
                    "source_ref": f"{document.get('path')}#page={row['page']}" if row.get("page") else str(document.get("path")),
                    "extract_error": "",
                }
            )
    accounts = pd.DataFrame(account_rows)
    accounts.attrs["pdf_count"] = pdf_count
    accounts.attrs["cache_hits"] = cache_hits
    return accounts


def load_mapping_memory():
    mapping = pd.read_csv(MAPPING_PATH, sep="\t")
    mapping["normalized_label"] = mapping["raw_label"].map(normalize)
    return mapping


def build_mapping_index(mapping):
    priority = {"approved": 0, "proxy": 1}
    ordered = mapping.copy()
    ordered["_status_rank"] = ordered["status"].map(priority).fillna(9)
    ordered = ordered.sort_values(["_status_rank", "confidence"], ascending=[True, False])
    index = {}
    for row in ordered.to_dict("records"):
        label = row["normalized_label"]
        keys = [(label, row["client"]), (label, "*")]
        if row["entity_type"] == "generic":
            keys.append((label, "__generic__"))
        for key in keys:
            index.setdefault(key, row)
    return index


def map_accounts(accounts, mapping):
    if accounts.empty:
        mapped_df = accounts.copy()
        for col, default in {
            "concept": "",
            "mapping_confidence": 0.0,
            "mapping_status": "unmapped",
            "mapping_notes": "",
        }.items():
            mapped_df[col] = default
        return mapped_df
    mapping_index = build_mapping_index(mapping)
    mapped = []
    for _, account in accounts.iterrows():
        label = account["normalized_label"]
        candidate = (
            mapping_index.get((label, account["client"]))
            or mapping_index.get((label, "*"))
            or mapping_index.get((label, "__generic__"))
        )
        if candidate is None:
            concept = ""
            confidence = 0.0
            mapping_status = "unmapped"
            mapping_notes = ""
        else:
            concept = candidate["concept"]
            confidence = candidate["confidence"]
            mapping_status = candidate["status"]
            mapping_notes = "" if pd.isna(candidate.get("notes")) else candidate.get("notes")
        mapped.append(
            {
                **account.to_dict(),
                "concept": concept,
                "mapping_confidence": confidence,
                "mapping_status": mapping_status,
                "mapping_notes": mapping_notes,
            }
        )
    mapped_df = pd.DataFrame(mapped)
    mapped_df.attrs.update(accounts.attrs)
    return mapped_df


def best_concepts(mapped):
    usable = mapped[mapped["concept"].fillna("").ne("")].copy()
    if usable.empty:
        return pd.DataFrame()
    usable["rank"] = usable["mapping_confidence"].fillna(0)
    usable = usable.sort_values(["client", "period", "concept", "rank"], ascending=[True, True, True, False])
    return usable.drop_duplicates(["client", "period", "concept"], keep="first")


def value(concepts, client, period, concept):
    subset = concepts[
        concepts["client"].eq(client) & concepts["period"].eq(period) & concepts["concept"].eq(concept)
    ]
    if subset.empty:
        return None
    return subset.iloc[0]["value"]


def calc_ratio(numerator, denominator):
    if numerator is None or denominator in (None, 0):
        return None
    return numerator / denominator


def client_meta_for(concepts, client):
    subset = concepts[concepts["client"].eq(client)]
    if subset.empty:
        return {}
    row = subset.iloc[0]
    return {col: row[col] for col in subset.columns if col in {
        "tipo_entidad_juridica",
        "antiguedad_operativa",
        "producto_principal",
        "segmento_objetivo",
        "modelo_fondeo",
        "cobertura_geografica",
        "canal_originacion",
        "etapa_madurez",
        "ticket_promedio_rango",
        "tipo_estado_financiero",
        "anios_informacion_financiera",
        "se_otorgo_credito",
        "contrato_drive_path",
        "contrato_drive_link",
    }}


def ratio_policy(ratio_name, meta):
    product = normalize(meta.get("producto_principal", ""))
    entity = normalize(meta.get("tipo_entidad_juridica", ""))
    notes = []
    status_override = None
    if ratio_name in {"Cobertura de Deuda", "ICAP Ajustado"}:
        status_override = "needs_review"
        notes.append("Definicion depende de tipo de entidad/producto.")
    if ratio_name in {"Tasa Activa", "Margen Financiero"} and "arrendamiento" in product:
        status_override = "needs_review"
        notes.append("Producto arrendamiento: validar si ingresos por rentas se tratan como intereses/ingreso financiero.")
    if ratio_name == "ICAP" and entity in {"sofom", "sofipo"}:
        notes.append("Validar si ICAP regulatorio requiere metodologia distinta a capital contable / activo.")
        status_override = "needs_review"
    return status_override, " ".join(notes)


def pairing_qa(documents):
    if documents.empty:
        return pd.DataFrame()
    valid = documents[documents["status"].eq("indexed") & documents["period"].fillna("").ne("")]
    rows = []
    for (client, period), group in valid.groupby(["client", "period"]):
        statements = sorted(set(group["statement"].dropna()))
        rows.append(
            {
                "client": client,
                "period": period,
                "check": "statement_pairing",
                "difference": "",
                "status": "ok" if {"BG", "ER"}.issubset(set(statements)) or "EF" in statements else "needs_review",
                "details": ", ".join(statements),
            }
        )
    return pd.DataFrame(rows)


def calculate_ratios(concepts):
    rows = []
    qa_rows = []
    for client in sorted(concepts["client"].dropna().unique()):
        meta = client_meta_for(concepts, client)
        for period in sorted(concepts[concepts["client"].eq(client)]["period"].dropna().unique()):
            total_activo = value(concepts, client, period, "total_activo")
            total_pasivo = value(concepts, client, period, "total_pasivo")
            total_capital = value(concepts, client, period, "total_capital_contable")
            balance_diff = None
            if total_activo is not None and total_pasivo is not None and total_capital is not None:
                balance_diff = total_activo - total_pasivo - total_capital
            qa_status = "ok" if balance_diff is not None and abs(balance_diff) <= 1 else "needs_review"
            qa_rows.append(
                {
                    "client": client,
                    "period": period,
                    "check": "total_activo = total_pasivo + total_capital_contable",
                    "difference": balance_diff,
                    "status": qa_status,
                    "details": "",
                }
            )

            cartera_neta = None
            arr = value(concepts, client, period, "clientes_arrendamiento")
            fac = value(concepts, client, period, "clientes_factoraje")
            est = value(concepts, client, period, "estimacion_preventiva")
            if arr is not None or fac is not None:
                cartera_neta = (arr or 0) + (fac or 0) + (est or 0)

            deuda = (value(concepts, client, period, "fondeadores_cp") or 0) + (
                value(concepts, client, period, "fondeadores_lp") or 0
            )
            if deuda == 0:
                deuda = (value(concepts, client, period, "deuda_cp_proxy") or 0) + (
                    value(concepts, client, period, "deuda_lp_proxy") or 0
                )
                deuda_note = "Deuda usa proxy; validar."
            else:
                deuda_note = ""

            activos_productivos = None
            efectivo = value(concepts, client, period, "efectivo_inversiones")
            otros = concepts[
                concepts["client"].eq(client)
                & concepts["period"].eq(period)
                & concepts["concept"].eq("otros_activos_generadores")
            ]["value"].sum()
            dep = concepts[
                concepts["client"].eq(client)
                & concepts["period"].eq(period)
                & concepts["concept"].eq("depreciacion_activos_productivos")
            ]["value"].sum()
            if efectivo is not None or cartera_neta is not None or otros:
                activos_productivos = (efectivo or 0) + (cartera_neta or 0) + otros + dep

            specs = [
                ("Margen Operativo", value(concepts, client, period, "utilidad_operacion"), value(concepts, client, period, "ingresos_totales"), "utilidad_operacion / ingresos_totales", "calculated", ""),
                ("Margen Neto", value(concepts, client, period, "utilidad_neta"), value(concepts, client, period, "ingresos_totales"), "utilidad_neta / ingresos_totales", "calculated", ""),
                ("ROE", value(concepts, client, period, "utilidad_neta"), total_capital, "utilidad_neta / total_capital_contable", "calculated", ""),
                ("ROA", value(concepts, client, period, "utilidad_neta"), total_activo, "utilidad_neta / total_activo", "calculated", ""),
                ("Tasa Pasiva", value(concepts, client, period, "gastos_financieros"), deuda, "gastos_financieros / deuda", "calculated", deuda_note),
                ("Apalancamiento", deuda, total_activo, "deuda / total_activo", "calculated", deuda_note),
                ("ICAP", total_capital, total_activo, "total_capital_contable / total_activo", "calculated", ""),
                ("ICAP Ajustado", total_capital, cartera_neta, "total_capital_contable / cartera_neta", "needs_review", "Cartera neta derivada; validar definicion."),
                ("Cobertura de Deuda", activos_productivos, total_pasivo, "activos_productivos / total_pasivo", "needs_review", "Activos productivos derivado; validar definicion."),
            ]
            for name, numerator, denominator, formula, base_status, note in specs:
                result = calc_ratio(numerator, denominator)
                missing = []
                if numerator is None:
                    missing.append("numerador")
                if denominator in (None, 0):
                    missing.append("denominador")
                status = base_status
                notes = [note] if note else []
                policy_status, policy_note = ratio_policy(name, meta)
                if policy_status:
                    status = policy_status
                if policy_note:
                    notes.append(policy_note)
                if qa_status != "ok":
                    status = "needs_review"
                    notes.append("QA balance no ok.")
                if missing:
                    status = "needs_review"
                    notes.append("Inputs faltantes: " + ", ".join(missing))
                if result is not None and abs(result) > 10:
                    status = "needs_review"
                    notes.append("Resultado > 10x; validar.")
                rows.append(
                    {
                        "client": client,
                        "period": period,
                        "ratio": name,
                        "numerator": numerator,
                        "denominator": denominator,
                        "result": result,
                        "result_pct": None if result is None else result * 100,
                        "formula": formula,
                        "review_status": status,
                        "review_notes": " ".join(notes),
                        **meta,
                    }
                )
    return pd.DataFrame(rows), pd.DataFrame(qa_rows)


def golden_sample_scaffold(ratios):
    if ratios.empty:
        return pd.DataFrame()
    sample = ratios[["client", "period", "ratio", "result", "formula", "review_status"]].copy()
    sample = sample.sort_values(["client", "period", "ratio"]).groupby(["client", "period"]).head(5)
    sample["manual_expected_result"] = ""
    sample["manual_expected_pct"] = ""
    sample["reviewer"] = ""
    sample["approval_status"] = "pending"
    sample["review_notes"] = ""
    return sample


def _first_nonblank(series, default=""):
    if series is None:
        return default
    cleaned = [value for value in series.tolist() if pd.notna(value) and str(value).strip()]
    return cleaned[0] if cleaned else default


def build_crm_clients(documents, ratios, qa):
    clients = set()
    if not documents.empty and "client" in documents:
        clients.update(documents["client"].dropna().astype(str))
    if not ratios.empty and "client" in ratios:
        clients.update(ratios["client"].dropna().astype(str))
    if not qa.empty and "client" in qa:
        clients.update(qa["client"].dropna().astype(str))

    rows = []
    for client in sorted(clients):
        doc_client = documents[documents["client"].eq(client)] if not documents.empty else pd.DataFrame()
        ratio_client = ratios[ratios["client"].eq(client)] if not ratios.empty else pd.DataFrame()
        qa_client = qa[qa["client"].eq(client)] if not qa.empty and "client" in qa else pd.DataFrame()

        periods = sorted(doc_client["period"].dropna().astype(str).unique()) if "period" in doc_client else []
        latest_period = periods[-1] if periods else ""
        ratio_review = int(ratio_client["review_status"].eq("needs_review").sum()) if "review_status" in ratio_client else 0
        qa_review = int(qa_client["status"].eq("needs_review").sum()) if "status" in qa_client else 0
        documents_found = len(doc_client)
        status = "Listo para revisar"
        priority = "Media"
        if documents_found == 0:
            status = "Sin documentos"
            priority = "Alta"
        elif ratio_review or qa_review:
            status = "Requiere revision"
            priority = "Alta"
        elif ratio_client.empty:
            status = "Sin razones"
            priority = "Media"
        else:
            status = "Actualizado"
            priority = "Baja"

        rows.append(
            {
                "Cliente": client,
                "Estatus": status,
                "Prioridad": priority,
                "Responsable": "",
                "Proxima accion": "",
                "Fecha actualizacion": "",
                "Ultimo periodo": latest_period,
                "Docs": documents_found,
                "Periodos": len(periods),
                "Razones": len(ratio_client),
                "Razones revisar": ratio_review,
                "QA revisar": qa_review,
                "Credito": _first_nonblank(doc_client.get("se_otorgo_credito")),
                "Producto": _first_nonblank(doc_client.get("producto_principal")),
                "Tipo EEFF": _first_nonblank(doc_client.get("tipo_estado_financiero")),
                "Link contrato": _first_nonblank(doc_client.get("contrato_drive_link")),
                "Notas": _first_nonblank(doc_client.get("notes")),
            }
        )
    return pd.DataFrame(rows)


def build_inicio(crm, documents, accounts, concepts, ratios, qa):
    if crm.empty:
        return pd.DataFrame(
            [
                {"Seccion": "Estado", "Metrica": "Clientes", "Valor": 0, "Detalle": "No se encontraron clientes en la corrida."},
                {"Seccion": "Siguiente paso", "Metrica": "Carga", "Valor": "", "Detalle": "Revisar ruta de clientes y volver a ejecutar."},
            ]
        )
    return pd.DataFrame(
        [
            {"Seccion": "Estado", "Metrica": "Clientes", "Valor": len(crm), "Detalle": "Filas en CRM Clientes."},
            {"Seccion": "Estado", "Metrica": "Actualizados", "Valor": int(crm["Estatus"].eq("Actualizado").sum()), "Detalle": "Sin alertas de razones ni QA."},
            {"Seccion": "Estado", "Metrica": "Requieren revision", "Valor": int(crm["Estatus"].eq("Requiere revision").sum()), "Detalle": "Tienen razones o QA por validar."},
            {"Seccion": "Estado", "Metrica": "Sin documentos", "Valor": int(crm["Estatus"].eq("Sin documentos").sum()), "Detalle": "No se indexaron estados financieros."},
            {"Seccion": "Pipeline", "Metrica": "Documentos", "Valor": len(documents), "Detalle": "Archivos financieros indexados."},
            {"Seccion": "Pipeline", "Metrica": "Cuentas extraidas", "Valor": len(accounts), "Detalle": "Renglones leidos desde PDFs/Excel."},
            {"Seccion": "Pipeline", "Metrica": "Conceptos mapeados", "Valor": len(concepts), "Detalle": "Cuentas normalizadas para calculo."},
            {"Seccion": "Pipeline", "Metrica": "Razones", "Valor": len(ratios), "Detalle": "Razones financieras calculadas."},
            {
                "Seccion": "Pipeline",
                "Metrica": "QA pendientes",
                "Valor": int(qa["status"].eq("needs_review").sum()) if not qa.empty and "status" in qa else 0,
                "Detalle": "Checks que requieren revision.",
            },
        ]
    )


def build_update_guide(output_path):
    return pd.DataFrame(
        [
            {"Paso": 1, "Accion": "Editar clientes", "Detalle": "Actualiza config/client_metadata_template.tsv para campos permanentes como producto, credito, contrato y notas."},
            {"Paso": 2, "Accion": "Agregar documentos", "Detalle": "Coloca estados financieros en la carpeta del cliente o en el staging de Drive usado por la corrida."},
            {"Paso": 3, "Accion": "Reprocesar", "Detalle": "Ejecuta scripts/run_finmonitor_prod.sh o corre financial_monitor_pipeline.py con --clients y --output."},
            {"Paso": 4, "Accion": "Revisar CRM Clientes", "Detalle": "Filtra Prioridad Alta, llena Responsable / Proxima accion / Fecha actualizacion y atiende Razones revisar / QA revisar."},
            {"Paso": 5, "Accion": "Auditar detalle", "Detalle": f"El archivo objetivo actual es {output_path}. Las hojas tecnicas quedan despues del CRM."},
        ]
    )


def style_workbook(writer):
    header_fill = PatternFill("solid", fgColor="16324F")
    header_font = Font(color="FFFFFF", bold=True)
    title_fill = PatternFill("solid", fgColor="0F172A")
    panel_fill = PatternFill("solid", fgColor="EAF2F8")
    border = Border(bottom=Side(style="thin", color="C9D6E2"))
    status_fills = {
        "ok": PatternFill("solid", fgColor="D9EAD3"),
        "calculated": PatternFill("solid", fgColor="D9EAD3"),
        "extracted": PatternFill("solid", fgColor="D9EAD3"),
        "actualizado": PatternFill("solid", fgColor="D9EAD3"),
        "listo para revisar": PatternFill("solid", fgColor="D9EAD3"),
        "needs_review": PatternFill("solid", fgColor="FFF2CC"),
        "requiere revision": PatternFill("solid", fgColor="FFF2CC"),
        "sin razones": PatternFill("solid", fgColor="FFF2CC"),
        "unmapped": PatternFill("solid", fgColor="F4CCCC"),
        "error": PatternFill("solid", fgColor="F4CCCC"),
        "sin documentos": PatternFill("solid", fgColor="F4CCCC"),
        "alta": PatternFill("solid", fgColor="F4CCCC"),
        "media": PatternFill("solid", fgColor="FFF2CC"),
        "baja": PatternFill("solid", fgColor="D9EAD3"),
    }
    for ws in writer.book.worksheets:
        if ws.max_row < 1:
            continue
        ws.sheet_view.showGridLines = False
        ws.freeze_panes = "A2"
        ws.auto_filter.ref = ws.dimensions
        for cell in ws[1]:
            cell.fill = header_fill
            cell.font = header_font
            cell.border = border
            cell.alignment = Alignment(wrap_text=True, vertical="center")
        headers = [cell.value for cell in ws[1]]
        for col_idx, header in enumerate(headers, start=1):
            letter = get_column_letter(col_idx)
            width = 14
            if header in {"path", "source_ref", "raw_value", "review_notes", "mapping_notes", "details", "contrato_drive_path", "contrato_drive_link", "proxima_accion", "detalle", "Link contrato", "Proxima accion", "Detalle"}:
                width = 44
            elif header in {"filename", "raw_label", "formula", "notas", "Notas"}:
                width = 32
            elif header in {"client", "cliente", "Cliente", "period", "ratio", "concept", "estatus_crm", "producto_principal", "Estatus", "Producto"}:
                width = 20
            elif header in {"responsable", "Responsable", "prioridad", "Prioridad", "ultimo_periodo", "fecha_actualizacion", "Ultimo periodo", "Fecha actualizacion", "Tipo EEFF"}:
                width = 18
            ws.column_dimensions[letter].width = width
        for row in ws.iter_rows(min_row=2):
            for cell in row:
                cell.alignment = Alignment(wrap_text=cell.column_letter in {"E", "P", "Q"}, vertical="top")
                if isinstance(cell.value, float):
                    cell.number_format = '#,##0.00;[Red](#,##0.00);-'
                if headers[cell.column - 1] in {"review_status", "status", "mapping_status", "source_method", "estatus_crm", "prioridad", "Estatus", "Prioridad"}:
                    fill = status_fills.get(str(cell.value).lower())
                    if fill:
                        cell.fill = fill
        if ws.title in {"Inicio", "CRM Clientes", "Actualizar"}:
            for cell in ws[1]:
                cell.fill = title_fill
        if ws.title == "Inicio":
            ws.column_dimensions["A"].width = 18
            ws.column_dimensions["B"].width = 24
            ws.column_dimensions["C"].width = 14
            ws.column_dimensions["D"].width = 56
            for row_idx in range(2, ws.max_row + 1):
                ws.cell(row_idx, 1).fill = panel_fill
                ws.cell(row_idx, 1).font = Font(bold=True, color="16324F")
                ws.cell(row_idx, 3).number_format = '#,##0'
        if ws.title == "CRM Clientes":
            for col_idx in range(8, 13):
                for row_idx in range(2, ws.max_row + 1):
                    ws.cell(row_idx, col_idx).number_format = '#,##0'
            for col_idx in range(4, 7):
                for row_idx in range(2, ws.max_row + 1):
                    ws.cell(row_idx, col_idx).font = Font(color="0000FF")
                    ws.cell(row_idx, col_idx).fill = PatternFill("solid", fgColor="FFF2CC")
            if ws.max_row >= 2:
                priority = DataValidation(type="list", formula1='"Alta,Media,Baja"', allow_blank=True)
                status = DataValidation(type="list", formula1='"Actualizado,Listo para revisar,Requiere revision,Sin razones,Sin documentos"', allow_blank=False)
                ws.add_data_validation(priority)
                ws.add_data_validation(status)
                priority.add(f"C2:C{ws.max_row}")
                status.add(f"B2:B{ws.max_row}")
        if ws.title == "Actualizar":
            ws.column_dimensions["A"].width = 10
            ws.column_dimensions["B"].width = 24
            ws.column_dimensions["C"].width = 100
            for row in ws.iter_rows(min_row=2):
                row[2].alignment = Alignment(wrap_text=True, vertical="top")
                ws.row_dimensions[row[0].row].height = 36


def export_workbook(path, documents, accounts, concepts, ratios, qa, mapping, credit_evidence):
    crm = build_crm_clients(documents, ratios, qa)
    inicio = build_inicio(crm, documents, accounts, concepts, ratios, qa)
    update_guide = build_update_guide(path)
    audit = pd.DataFrame(
        [
            {"category": "documents", "detail": "indexed", "count": len(documents)},
            {"category": "accounts", "detail": "extracted", "count": len(accounts)},
            {"category": "accounts", "detail": "pdfs_seen", "count": accounts.attrs.get("pdf_count", 0)},
            {"category": "accounts", "detail": "pdf_cache_hits", "count": accounts.attrs.get("cache_hits", 0)},
            {"category": "concepts", "detail": "mapped", "count": len(concepts)},
            {"category": "ratios", "detail": "total", "count": len(ratios)},
            {"category": "ratios", "detail": "calculated", "count": int(ratios["review_status"].eq("calculated").sum()) if not ratios.empty else 0},
            {"category": "ratios", "detail": "needs_review", "count": int(ratios["review_status"].eq("needs_review").sum()) if not ratios.empty else 0},
            {"category": "qa", "detail": "ok", "count": int(qa["status"].eq("ok").sum()) if not qa.empty else 0},
            {"category": "qa", "detail": "needs_review", "count": int(qa["status"].eq("needs_review").sum()) if not qa.empty else 0},
            {"category": "credit_evidence", "detail": "files_found", "count": len(credit_evidence)},
        ]
    )
    with pd.ExcelWriter(path, engine="openpyxl") as writer:
        inicio.to_excel(writer, sheet_name="Inicio", index=False)
        crm.to_excel(writer, sheet_name="CRM Clientes", index=False)
        update_guide.to_excel(writer, sheet_name="Actualizar", index=False)
        ratios.to_excel(writer, sheet_name="Razones", index=False)
        qa.to_excel(writer, sheet_name="QA", index=False)
        documents.to_excel(writer, sheet_name="Documentos", index=False)
        concepts.to_excel(writer, sheet_name="Conceptos", index=False)
        accounts.to_excel(writer, sheet_name="Cuentas Extraidas", index=False)
        credit_evidence.to_excel(writer, sheet_name="Credit Evidence", index=False)
        golden_sample_scaffold(ratios).to_excel(writer, sheet_name="Golden Sample", index=False)
        audit.to_excel(writer, sheet_name="Auditoria", index=False)
        mapping.to_excel(writer, sheet_name="Mapping Memory", index=False)
        style_workbook(writer)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--profile", choices=["default", "prod"], default="default")
    parser.add_argument("--clients-root", default=str(DEFAULT_CLIENTS_ROOT))
    parser.add_argument("--clients", default="Ventus", help="Comma-separated client folder names")
    parser.add_argument("--client-metadata", default=str(CLIENT_METADATA_PATH))
    parser.add_argument("--from-period", default="2025-01-01")
    parser.add_argument("--to-period", default="")
    parser.add_argument("--max-documents", type=int, default=40)
    parser.add_argument("--max-pages-per-pdf", type=int, default=5)
    parser.add_argument("--max-file-mb", type=int, default=8)
    parser.add_argument("--include-undated", action="store_true")
    parser.add_argument("--refresh-cache", action="store_true", help="Ignore cached PDF extraction results.")
    parser.add_argument("--skip-credit-evidence", action="store_true", help="Skip broader Drive scan for credit contract evidence.")
    parser.add_argument("--output", default=str(OUTPUT_DIR / "financial_monitor_pipeline.xlsx"))
    args = parser.parse_args()

    if args.profile == "prod":
        if args.clients_root == str(DEFAULT_CLIENTS_ROOT):
            args.clients_root = (
                "/Users/syscap/Library/CloudStorage/GoogleDrive-rbarron@syscap.com.mx/Shared drives/"
                "Axcess - Crédito y Riesgo/1. Clientes/3. Cerrados, Dormant & Rechazados"
            )
        args.skip_credit_evidence = True
        args.max_pages_per_pdf = min(args.max_pages_per_pdf, 5)
        args.max_file_mb = min(args.max_file_mb, 8)

    started = log_step("starting")
    clients_root = Path(args.clients_root)
    clients = [client.strip() for client in args.clients.split(",") if client.strip()]
    metadata = load_client_metadata(args.client_metadata)
    OUTPUT_DIR.mkdir(parents=True, exist_ok=True)

    step = log_step("discovering documents")
    documents = discover_documents(
        clients_root,
        clients,
        from_period=args.from_period,
        to_period=args.to_period,
        max_documents=args.max_documents,
        metadata=metadata,
        include_undated=args.include_undated,
    )
    log_step(f"discovered documents={len(documents)}", step)

    if args.skip_credit_evidence:
        credit_evidence = pd.DataFrame()
    else:
        step = log_step("scanning credit evidence")
        credit_evidence = scan_credit_line_evidence(clients_root, clients)
        log_step(f"credit evidence rows={len(credit_evidence)}", step)

    step = log_step("extracting PDF accounts")
    accounts = extract_accounts(
        documents,
        max_pages=args.max_pages_per_pdf,
        max_file_mb=args.max_file_mb,
        refresh_cache=args.refresh_cache,
    )
    log_step(
        f"extracted accounts={len(accounts)} pdfs={accounts.attrs.get('pdf_count', 0)} cache_hits={accounts.attrs.get('cache_hits', 0)}",
        step,
    )

    step = log_step("mapping and calculating")
    mapping = load_mapping_memory()
    mapped_accounts = map_accounts(accounts, mapping)
    concepts = best_concepts(mapped_accounts)
    ratios, qa = calculate_ratios(concepts) if not concepts.empty else (pd.DataFrame(), pd.DataFrame())
    pair_qa = pairing_qa(documents)
    if not pair_qa.empty:
        qa = pd.concat([qa, pair_qa], ignore_index=True)
    log_step(f"mapped concepts={len(concepts)} ratios={len(ratios)}", step)

    step = log_step("exporting workbook")
    export_workbook(Path(args.output), documents, mapped_accounts, concepts, ratios, qa, mapping, credit_evidence)
    log_step(f"exported {args.output}", step)
    log_step("finished", started)
    print(args.output)
    print(f"documents={len(documents)} accounts={len(mapped_accounts)} concepts={len(concepts)} ratios={len(ratios)}")


if __name__ == "__main__":
    main()
