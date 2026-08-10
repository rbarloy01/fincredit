import re
import time
import unicodedata
import urllib.request
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


def drive_file_id(url):
    match = re.search(r"/file/d/([^/]+)", str(url))
    if match:
        return match.group(1)
    match = re.search(r"[?&]id=([^&]+)", str(url))
    return match.group(1) if match else None


def direct_url(file_id):
    return f"https://drive.google.com/uc?export=download&id={file_id}"


def download(url, path):
    req = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0"})
    with urllib.request.urlopen(req, timeout=120) as response:
        data = response.read()
    path.write_bytes(data)
    return len(data)


def main():
    df = pd.read_excel(MANIFEST_PATH)
    statuses = []
    for _, row in df.iterrows():
        client_folder = DRIVE_BASE / slug(row["cliente"])
        client_folder.mkdir(parents=True, exist_ok=True)
        path = client_folder / row["suggested_filename"]
        file_id = drive_file_id(row["drive_source_link"])
        status = "exists" if path.exists() and path.stat().st_size > 1024 else "pending"
        error = ""
        size = path.stat().st_size if path.exists() else 0
        if status == "pending":
            try:
                size = download(direct_url(file_id), path)
                status = "downloaded"
                time.sleep(0.2)
            except Exception as exc:
                status = "failed"
                error = str(exc)
        statuses.append(
            {
                **row.to_dict(),
                "local_drive_path": str(path),
                "download_status": status,
                "download_error": error,
                "bytes": size,
            }
        )
        print(f"{row['catalog_id']}: {status} {size} {path.name}")

    out = pd.DataFrame(statuses)
    out_path = DRIVE_BASE / "_control" / "download_manifest.xlsx"
    csv_path = DRIVE_BASE / "_control" / "download_manifest.csv"
    out.to_excel(out_path, index=False)
    out.to_csv(csv_path, index=False)
    print(out_path)


if __name__ == "__main__":
    main()
