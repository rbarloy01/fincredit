export interface ReservedDownloadTarget {
  win: Window | null;
}

export function reserveDownloadTarget(): ReservedDownloadTarget {
  let win: Window | null = null;
  try {
    win = window.open('', '_blank');
    if (win) {
      win.document.write(`
        <!doctype html>
        <html>
          <head><title>Preparando descarga</title></head>
          <body style="font-family: system-ui, sans-serif; padding: 24px; color: #0f172a;">
            <h1 style="font-size: 18px; margin: 0 0 8px;">Preparando descarga...</h1>
            <p style="font-size: 14px; color: #64748b; margin: 0;">El archivo se abrirá automáticamente cuando termine de generarse.</p>
          </body>
        </html>
      `);
      win.document.close();
    }
  } catch {
    win = null;
  }
  return { win };
}

export function deliverDownloadToReservedTarget(target: ReservedDownloadTarget | undefined, href: string, filename: string) {
  if (!target?.win || target.win.closed) return false;
  try {
    const escapedHref = href.replace(/"/g, '&quot;');
    const escapedFilename = filename.replace(/"/g, '&quot;');
    target.win.document.open();
    target.win.document.write(`
      <!doctype html>
      <html>
        <head><title>Descarga lista</title></head>
        <body style="font-family: system-ui, sans-serif; padding: 24px; color: #0f172a;">
          <h1 style="font-size: 18px; margin: 0 0 8px;">Descarga lista</h1>
          <p style="font-size: 14px; color: #64748b;">Si no inició automáticamente, usa el botón.</p>
          <a
            id="download"
            href="${escapedHref}"
            download="${escapedFilename}"
            style="display: inline-block; margin-top: 12px; padding: 10px 14px; border-radius: 10px; background: #4f46e5; color: white; text-decoration: none; font-weight: 700;"
          >Descargar archivo</a>
          <script>
            setTimeout(function () {
              document.getElementById('download').click();
            }, 50);
          </script>
        </body>
      </html>
    `);
    target.win.document.close();
    return true;
  } catch {
    return false;
  }
}
