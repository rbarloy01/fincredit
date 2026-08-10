import re
import unicodedata
from pathlib import Path

import pandas as pd


ROOT = Path("/Users/syscap/Documents/New project 2")
CATALOG_PATH = ROOT / "outputs/catalogo_eeff_filtrado/Catalogo_EEFF_filtrado_sin_modelo_financiero.xlsx"
OUT_DIR = ROOT / "outputs/drive_staging"


def slug(text):
    text = "" if text is None else str(text)
    text = unicodedata.normalize("NFKD", text)
    text = "".join(ch for ch in text if not unicodedata.combining(ch))
    text = re.sub(r"[^A-Za-z0-9]+", "_", text).strip("_")
    return text or "sin_valor"


def extension(fmt):
    value = str(fmt).lower()
    if "pdf" in value:
        return "pdf"
    if "xlsx" in value or "sheet" in value:
        return "xlsx"
    return slug(fmt).lower()


def main():
    OUT_DIR.mkdir(parents=True, exist_ok=True)
    df = pd.read_excel(CATALOG_PATH, sheet_name="Catalogo Filtrado")

    rows = []
    for _, row in df.iterrows():
        ext = extension(row["Formato"])
        client = slug(row["Cliente"])
        period = slug(row["Fecha / Período"])
        doc_type = slug(row["Tipo de Documento"])
        filename = f"{int(row['#']):04d}_{client}_{period}_{doc_type}.{ext}"
        rows.append(
            {
                "catalog_id": int(row["#"]),
                "cliente": row["Cliente"],
                "periodo": row["Fecha / Período"],
                "tipo_documento": row["Tipo de Documento"],
                "formato": row["Formato"],
                "drive_source_link": row["Enlace"],
                "suggested_drive_folder": f"EEFF_Covenants_Source/{client}",
                "suggested_filename": filename,
                "expected_drive_path": f"EEFF_Covenants_Source/{client}/{filename}",
                "processing_status": "pending_file_in_drive_folder",
                "notes": "",
            }
        )

    staged = pd.DataFrame(rows)
    staged.to_csv(OUT_DIR / "drive_staging_manifest.csv", index=False)
    with pd.ExcelWriter(OUT_DIR / "drive_staging_manifest.xlsx", engine="openpyxl") as writer:
        staged.to_excel(writer, sheet_name="Drive Staging", index=False)

    readme = """# EEFF Covenants Source

Use this as the Drive folder structure for source files.

1. Create a Google Drive folder named `EEFF_Covenants_Source`.
2. Inside it, create one folder per client using `suggested_drive_folder`.
3. Place or shortcut each source document using `suggested_filename`.
4. Keep `drive_staging_manifest.xlsx` as the control file.

The extraction pipeline should read from the synced/mounted Drive folder and should not duplicate all PDFs into the local project.
"""
    (OUT_DIR / "README.md").write_text(readme)
    print(OUT_DIR / "drive_staging_manifest.xlsx")


if __name__ == "__main__":
    main()
