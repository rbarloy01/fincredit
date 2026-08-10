import json
import re
import sys
import unicodedata
from pathlib import Path

import pandas as pd
import pdfplumber


ROOT = Path("/Users/syscap/Documents/New project 2")
CATALOG_PATH = ROOT / "outputs/catalogo_eeff_filtrado/Catalogo_EEFF_filtrado_sin_modelo_financiero.xlsx"
DICTIONARY_PATH = ROOT / "outputs/covenant_dictionary/covenant_definitions.json"
OUT_DIR = ROOT / "outputs/covenant_pilot"
DOC_DIR = OUT_DIR / "documents"
TEXT_DIR = OUT_DIR / "text"


def normalize(text):
    text = "" if text is None else str(text)
    text = unicodedata.normalize("NFKD", text)
    text = "".join(ch for ch in text if not unicodedata.combining(ch))
    text = text.lower()
    text = re.sub(r"[^a-z0-9]+", " ", text)
    return re.sub(r"\s+", " ", text).strip()


def drive_file_id(url):
    match = re.search(r"/file/d/([^/]+)", str(url))
    if match:
        return match.group(1)
    match = re.search(r"[?&]id=([^&]+)", str(url))
    return match.group(1) if match else None


def extract_pdf_text(path):
    pages = []
    with pdfplumber.open(path) as pdf:
        for page_no, page in enumerate(pdf.pages, start=1):
            text = page.extract_text(x_tolerance=1, y_tolerance=3) or ""
            tables = page.extract_tables() or []
            table_lines = []
            for table in tables:
                for row in table:
                    table_lines.append(" | ".join("" if cell is None else str(cell) for cell in row))
            pages.append(
                {
                    "page": page_no,
                    "text": text,
                    "tables_text": "\n".join(table_lines),
                    "chars": len(text),
                    "tables": len(tables),
                }
            )
    return pages


def number_from_line(line):
    candidates = re.findall(r"-?\(?\d[\d,]*(?:\.\d+)?\)?", line)
    if not candidates:
        return None
    raw = candidates[-1]
    negative = raw.startswith("(") and raw.endswith(")")
    raw = raw.replace("(", "").replace(")", "").replace(",", "")
    try:
        value = float(raw)
    except ValueError:
        return None
    return -value if negative else value


def build_aliases(definitions):
    aliases = {}
    for key, meta in definitions["concepts"].items():
        terms = [meta.get("description", ""), key.replace("_", " ")]
        terms.extend(meta.get("synonyms", []))
        aliases[key] = sorted({normalize(term) for term in terms if term}, key=len, reverse=True)
    return aliases


def map_concepts(pages, aliases):
    rows = []
    for page in pages:
        combined = "\n".join([page.get("text", ""), page.get("tables_text", "")])
        for raw_line in combined.splitlines():
            line_norm = normalize(raw_line)
            if not line_norm:
                continue
            for concept, terms in aliases.items():
                matched = next((term for term in terms if term and term in line_norm), None)
                if not matched:
                    continue
                value = number_from_line(raw_line)
                confidence = 0.82 if value is not None else 0.45
                rows.append(
                    {
                        "page": page["page"],
                        "raw_label": raw_line[:500],
                        "normalized_concept": concept,
                        "matched_alias": matched,
                        "value": value,
                        "confidence": confidence,
                        "review_status": "needs_review" if confidence < 0.8 else "extracted",
                    }
                )
    return rows


def concept_values(extracted_rows):
    values = {}
    for row in extracted_rows:
        if row["value"] is None:
            continue
        concept = row["normalized_concept"]
        current = values.get(concept)
        if current is None or row["confidence"] > current["confidence"]:
            values[concept] = row
    return values


def calculate_ratios(definitions, values):
    ratio_rows = []
    env = {key: row["value"] for key, row in values.items()}
    for ratio in definitions["ratios"]:
        missing = [c for c in ratio["required_concepts"] if c not in env]
        review_required = False
        review_reason = ""
        if "activos_productivos" in ratio["required_concepts"]:
            review_required = True
            review_reason = "Activos productivos requiere validacion por tipo de entidad."
        if missing:
            ratio_rows.append(
                {
                    "ratio": ratio["name"],
                    "key": ratio["key"],
                    "formula": ratio["formula"],
                    "result": None,
                    "missing_concepts": ", ".join(missing),
                    "review_status": "needs_review",
                    "review_reason": review_reason or "Faltan conceptos requeridos.",
                }
            )
            continue
        try:
            result = eval(ratio["formula"], {"__builtins__": {}}, env)
        except Exception as exc:
            ratio_rows.append(
                {
                    "ratio": ratio["name"],
                    "key": ratio["key"],
                    "formula": ratio["formula"],
                    "result": None,
                    "missing_concepts": "",
                    "review_status": "needs_review",
                    "review_reason": f"Error calculando formula: {exc}",
                }
            )
            continue
        ratio_rows.append(
            {
                "ratio": ratio["name"],
                "key": ratio["key"],
                "formula": ratio["formula"],
                "result": result,
                "missing_concepts": "",
                "review_status": "needs_review" if review_required else "calculated",
                "review_reason": review_reason,
            }
        )
    return ratio_rows


def main(limit=10, source_folder=None):
    OUT_DIR.mkdir(parents=True, exist_ok=True)
    DOC_DIR.mkdir(parents=True, exist_ok=True)
    TEXT_DIR.mkdir(parents=True, exist_ok=True)

    definitions = json.loads(DICTIONARY_PATH.read_text())
    aliases = build_aliases(definitions)
    catalog = pd.read_excel(CATALOG_PATH, sheet_name="Catalogo Filtrado")
    sample = catalog[catalog["Formato"].str.upper().eq("PDF")].head(limit).copy()

    documents = []
    all_concepts = []
    all_ratios = []

    for _, row in sample.iterrows():
        doc_id = int(row["#"])
        file_id = drive_file_id(row["Enlace"])
        filename = f"{doc_id:04d}_{normalize(row['Cliente'])}_{normalize(row['Fecha / Período'])}.pdf"
        local_path = (Path(source_folder) / filename) if source_folder else DOC_DIR / filename
        status = "pending"
        error = ""
        pages = []
        try:
            if not local_path.exists():
                raise FileNotFoundError(
                    "Archivo no encontrado localmente. Este piloto no descarga desde Drive por default; "
                    "usa una carpeta Drive sincronizada o pasa una ruta local con los PDFs."
                )
            pages = extract_pdf_text(local_path)
            (TEXT_DIR / f"{local_path.stem}.json").write_text(json.dumps(pages, ensure_ascii=False, indent=2))
            status = "extracted"
        except Exception as exc:
            status = "failed"
            error = str(exc)

        doc_record = {
            "document_id": doc_id,
            "cliente": row["Cliente"],
            "tipo_documento": row["Tipo de Documento"],
            "periodo": row["Fecha / Período"],
            "formato": row["Formato"],
            "enlace": row["Enlace"],
            "local_path": str(local_path) if local_path.exists() else "",
            "status": status,
            "error": error,
            "pages": len(pages),
        }
        documents.append(doc_record)

        extracted = map_concepts(pages, aliases) if pages else []
        for concept_row in extracted:
            concept_row.update({k: doc_record[k] for k in ["document_id", "cliente", "periodo", "tipo_documento", "enlace"]})
            all_concepts.append(concept_row)

        ratios = calculate_ratios(definitions, concept_values(extracted))
        for ratio_row in ratios:
            ratio_row.update({k: doc_record[k] for k in ["document_id", "cliente", "periodo", "tipo_documento", "enlace"]})
            all_ratios.append(ratio_row)

    pd.DataFrame(documents).to_csv(OUT_DIR / "documents.csv", index=False)
    pd.DataFrame(all_concepts).to_csv(OUT_DIR / "extracted_concepts.csv", index=False)
    pd.DataFrame(all_ratios).to_csv(OUT_DIR / "calculated_ratios.csv", index=False)

    with pd.ExcelWriter(OUT_DIR / "covenant_pilot_results.xlsx", engine="openpyxl") as writer:
        pd.DataFrame(documents).to_excel(writer, sheet_name="Documentos", index=False)
        pd.DataFrame(all_concepts).to_excel(writer, sheet_name="Conceptos Extraidos", index=False)
        pd.DataFrame(all_ratios).to_excel(writer, sheet_name="Ratios Calculados", index=False)

    print(json.dumps({
        "documents": len(documents),
        "concepts": len(all_concepts),
        "ratios": len(all_ratios),
        "output": str(OUT_DIR / "covenant_pilot_results.xlsx")
    }, ensure_ascii=False))


if __name__ == "__main__":
    arg_limit = int(sys.argv[1]) if len(sys.argv) > 1 else 10
    arg_source_folder = sys.argv[2] if len(sys.argv) > 2 else None
    main(arg_limit, arg_source_folder)
