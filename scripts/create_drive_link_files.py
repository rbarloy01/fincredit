import html
import re
import unicodedata
from pathlib import Path

import pandas as pd


ROOT = Path("/Users/syscap/Documents/New project 2")
MANIFEST_PATH = ROOT / "outputs/drive_staging/drive_staging_manifest.xlsx"
DRIVE_BASE = Path("/Users/syscap/Library/CloudStorage/GoogleDrive-rbarron@syscap.com.mx/My Drive/EEFF_Covenants_Source")


def slug(text):
    text = "" if text is None else str(text)
    text = unicodedata.normalize("NFKD", text)
    text = "".join(ch for ch in text if not unicodedata.combining(ch))
    text = re.sub(r"[^A-Za-z0-9]+", "_", text).strip("_")
    return text or "sin_valor"


def webloc(url):
    escaped = html.escape(str(url), quote=True)
    return f"""<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>URL</key>
    <string>{escaped}</string>
</dict>
</plist>
"""


def main():
    df = pd.read_excel(MANIFEST_PATH)
    created = []
    for _, row in df.iterrows():
        client = slug(row["cliente"])
        period = slug(row["periodo"])
        doc_type = slug(row["tipo_documento"])
        folder = DRIVE_BASE / client
        folder.mkdir(parents=True, exist_ok=True)
        link_name = f"{int(row['catalog_id']):04d}_{period}_{doc_type}.webloc"
        link_path = folder / link_name
        link_path.write_text(webloc(row["drive_source_link"]))
        created.append(str(link_path))

    index_path = DRIVE_BASE / "_control" / "link_files_created.csv"
    pd.DataFrame({"link_file": created}).to_csv(index_path, index=False)
    print(f"created={len(created)}")
    print(index_path)


if __name__ == "__main__":
    main()
