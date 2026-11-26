// CertVault 表格图片层（excel.js）
// 职责：Excel 导出时把截图嵌进 xlsx、导入时把 xlsx 里的截图取回来。
// 依赖：core.js（CSV_HEADER）、vendor/exceljs.min.js（window.ExcelJS）、store.imageBlob / addImages。
// 约束：classic script；不写模板字符串把 JSON 拼错；失败不抛到界面，由调用方兜底。
(function () {
  'use strict';
  const coreApi = window.CVCore;
  if (!coreApi) return;

  const CSV_HEADER = coreApi.CSV_HEADER;
  const PHOTO_DEFAULT_COLS = 4; // 无截图时也留 4 列，空模板照着填
  const PHOTO_MAX = 8; // 与 app 端「每条最多 8 张截图」一致（2026-11 由 4 提到 8）
  const PHOTO_W = 116;
  const PHOTO_H = 87;
  const ROW_H = 78;
  const COL_WIDTHS = [26, 34, 20, 16, 16, 14, 10, 34, 12];

  const THIN = {
    top: { style: 'thin', color: { argb: 'FFD8DEE6' } },
    left: { style: 'thin', color: { argb: 'FFD8DEE6' } },
    bottom: { style: 'thin', color: { argb: 'FFD8DEE6' } },
    right: { style: 'thin', color: { argb: 'FFD8DEE6' } },
  };

  function hasExcelJs() {
    return typeof window.ExcelJS !== 'undefined' && window.ExcelJS && window.ExcelJS.Workbook;
  }

  function text(value) {
    if (value === null || value === undefined) return '';
    return String(value);
  }

  function mimeOf(ext) {
    const e = String(ext || '').toLowerCase();
    if (e === 'jpg' || e === 'jpeg') return 'image/jpeg';
    if (e === 'gif') return 'image/gif';
    if (e === 'webp') return 'image/webp';
    return 'image/png';
  }

  function extOf(fileName, mime) {
    const m = String(mime || '').toLowerCase();
    if (m.indexOf('jpeg') >= 0 || m.indexOf('jpg') >= 0) return 'jpeg';
    if (m.indexOf('gif') >= 0) return 'gif';
    const name = String(fileName || '').toLowerCase();
    if (/\.jpe?g$/.test(name)) return 'jpeg';
    if (/\.gif$/.test(name)) return 'gif';
    return 'png';
  }

  function keyOf(url, account) {
    return text(url).trim().toLowerCase() + '|' + text(account).trim().toLowerCase();
  }

  function toBytes(value) {
    if (!value) return null;
    if (value instanceof Uint8Array) return value;
    if (value instanceof ArrayBuffer) return new Uint8Array(value);
    if (ArrayBuffer.isView(value)) return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
    return null;
  }

  async function loadBytes(source) {
    const direct = toBytes(source && source.bytes);
    if (direct && direct.length) return direct;
    const file = source && source.file;
    const name = String((source && source.name) || (file && file.name) || '');
    if (file && /\.xlsx$/i.test(name)) {
      const buf = await file.arrayBuffer();
      return new Uint8Array(buf);
    }
    return null;
  }

  function bodyBytes(bytes) {
    // ExcelJS 内部会做 zip 解压，传入独立的 ArrayBuffer 片段最稳
    return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
  }

  /**
   * 导出 xlsx（数据 9 列 + 截图 N 列，N 取各记录截图数最大值并夹在 4..8，截图按行内嵌）
   * @param {object[]} records
   * @param {object} store 用于读取截图；无 store（演示模式）时不嵌图
   * @param {string} sheetName
   * @returns {Promise<Uint8Array|null>} ExcelJS 不可用时返回 null
   */
  async function exportWorkbook(records, store, sheetName) {
    if (!hasExcelJs()) return null;
    const list = Array.isArray(records) ? records : [];
    const wb = new window.ExcelJS.Workbook();
    wb.creator = 'CertVault';
    wb.created = new Date();
    const ws = wb.addWorksheet(sheetName || 'CA 台账', { views: [{ state: 'frozen', ySplit: 1 }] });
    let maxShots = 0;
    list.forEach(function (rec) {
      const n = rec && Array.isArray(rec.images) ? Math.min(rec.images.length, PHOTO_MAX) : 0;
      if (n > maxShots) maxShots = n;
    });
    const photoCols = Math.max(PHOTO_DEFAULT_COLS, Math.min(PHOTO_MAX, maxShots));
    const photoHeaders = [];
    for (let i = 1; i <= photoCols; i += 1) photoHeaders.push('截图 ' + i);

    const columns = COL_WIDTHS.map(function (w) { return { width: w }; });
    photoHeaders.forEach(function () { columns.push({ width: 18 }); });
    ws.columns = columns;

    const head = ws.addRow(CSV_HEADER.concat(photoHeaders));
    head.height = 24;
    head.eachCell(function (cell) {
      cell.font = { bold: true, size: 11, color: { argb: 'FF3B2E12' } };
      cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFF0E1C0' } };
      cell.alignment = { vertical: 'middle', horizontal: 'left' };
      cell.border = THIN;
    });

    list.forEach(function (rec) {
      const row = ws.addRow([
        text(rec.name), text(rec.url), text(rec.account), text(rec.password), text(rec.caPassword),
        text(rec.expiry), rec.remindDays === null || rec.remindDays === undefined || rec.remindDays === '' ? '' : Number(rec.remindDays),
        text(rec.note), text(rec.region),
      ]);
      row.height = 20;
      for (let c = 1; c <= CSV_HEADER.length; c += 1) {
        const cell = row.getCell(c);
        cell.font = { size: 10.5, color: { argb: 'FF1F2937' } };
        cell.alignment = { vertical: 'middle', horizontal: 'left', wrapText: c === 8 };
        cell.border = THIN;
        if (c === 7) {
          cell.numFmt = '0';
        } else {
          cell.numFmt = '@';
        }
      }
    });

    if (store && list.length) {
      for (let i = 0; i < list.length; i += 1) {
        const rec = list[i];
        const shots = rec && Array.isArray(rec.images) ? rec.images.slice(0, PHOTO_MAX) : [];
        if (!shots.length) continue;
        let placed = 0;
        for (const meta of shots) {
          let blob = null;
          try {
            blob = await store.imageBlob(rec.id, meta && meta.file);
          } catch (err) {
            blob = null;
          }
          if (!blob || typeof blob.arrayBuffer !== 'function') continue;
          const buffer = await blob.arrayBuffer();
          const extension = extOf(meta.file, blob.type);
          let imageId = null;
          try {
            imageId = wb.addImage({ buffer: buffer, extension: extension });
          } catch (err) {
            imageId = null;
          }
          if (imageId === null) continue;
          const anchorCol = CSV_HEADER.length + placed;
          ws.addImage(imageId, {
            tl: { col: anchorCol, row: i + 1, colOff: 5, rowOff: 5 },
            br: { col: anchorCol + 1, row: i + 2, colOff: -5, rowOff: -5 },
            editAs: 'twoCell',
          });
          placed += 1;
        }
        if (placed) {
          ws.getRow(i + 2).height = ROW_H;
          ws.getRow(i + 2).commit();
        }
      }
    }

    const out = await wb.xlsx.writeBuffer();
    return toBytes(out);
  }

  /**
   * 从导入文件里取出截图（只认数据列右侧「截图 n」列上的浮动图片）
   * @returns {Promise<{row:number,name:string,key:string,images:{buffer:ArrayBuffer,extension:string}[]}[]>}
   */
  async function readImportImages(source) {
    if (!hasExcelJs()) return [];
    const bytes = await loadBytes(source);
    if (!bytes) return [];
    const wb = new window.ExcelJS.Workbook();
    try {
      await wb.xlsx.load(bodyBytes(bytes));
    } catch (err) {
      return [];
    }
    const ws = wb.worksheets && wb.worksheets.length ? wb.worksheets[0] : null;
    if (!ws || typeof ws.getImages !== 'function') return [];
    const pictures = ws.getImages();
    if (!pictures || !pictures.length) return [];

    const headerCells = [];
    ws.getRow(1).eachCell(function (cell, colNumber) {
      headerCells[colNumber - 1] = String(cell.text === null || cell.text === undefined ? '' : cell.text).trim();
    });
    const urlIndex = headerCells.indexOf('网址');
    const accountIndex = headerCells.indexOf('账户');
    const nameIndex = headerCells.indexOf('平台名称');

    const grouped = new Map();
    pictures.forEach(function (picture) {
      const tl = picture && picture.range ? picture.range.tl : null;
      if (!tl) return;
      const rowNumber = Math.floor(Number(tl.nativeRow) || 0) + 1;
      const colIndex = Math.floor(Number(tl.nativeCol) || 0);
      if (rowNumber < 2) return;
      if (colIndex < CSV_HEADER.length) return; // 数据列上的图不当截图
      const mediaId = Number(picture.imageId);
      let media = null;
      try {
        media = wb.getImage(mediaId);
      } catch (err) {
        media = null;
      }
      if (!media || !media.buffer) return;
      const entry = grouped.get(rowNumber) || [];
      entry.push({ col: colIndex, buffer: media.buffer, extension: media.extension || 'png' });
      grouped.set(rowNumber, entry);
    });
    if (!grouped.size) return [];

    const rows = [];
    grouped.forEach(function (entry, rowNumber) {
      entry.sort(function (a, b) { return a.col - b.col; });
      const url = urlIndex >= 0 ? ws.getCell(rowNumber, urlIndex + 1).text : '';
      const account = accountIndex >= 0 ? ws.getCell(rowNumber, accountIndex + 1).text : '';
      const name = nameIndex >= 0 ? ws.getCell(rowNumber, nameIndex + 1).text : '';
      rows.push({
        row: rowNumber,
        name: String(name || '').trim(),
        key: keyOf(url, account),
        images: entry.slice(0, PHOTO_MAX).map(function (item) {
          return { buffer: item.buffer, extension: item.extension };
        }),
      });
    });
    rows.sort(function (a, b) { return a.row - b.row; });
    return rows;
  }

  /**
   * 把截图写进对应记录
   * @returns {Promise<{records:object[],count:number}>}
   */
  async function attachImages(rows, records, store) {
    const list = Array.isArray(records) ? records.slice() : [];
    const out = { records: list, count: 0 };
    if (!store || !Array.isArray(rows) || !rows.length) return out;
    const byKey = new Map();
    const byName = new Map();
    list.forEach(function (rec, index) {
      const key = keyOf(rec.url, rec.account);
      if (key !== '|' && !byKey.has(key)) byKey.set(key, index);
      const name = text(rec.name).trim();
      if (name && !byName.has(name)) byName.set(name, index);
    });
    for (const item of rows) {
      if (!item || !item.images || !item.images.length) continue;
      let index;
      if (item.key && item.key !== '|') index = byKey.get(item.key);
      if (index === undefined && item.name) index = byName.get(item.name);
      if (index === undefined) continue;
      const rec = list[index];
      const files = [];
      item.images.forEach(function (img, i) {
        try {
          files.push(new File([img.buffer], 'import-' + (i + 1) + '.' + (img.extension === 'jpeg' ? 'jpg' : img.extension), { type: mimeOf(img.extension) }));
        } catch (err) {
          // 浏览器不支持 File 构造时跳过
        }
      });
      if (!files.length) continue;
      let metas = [];
      try {
        metas = await store.addImages(rec.id, files);
      } catch (err) {
        metas = [];
      }
      if (!metas.length) continue;
      const existing = Array.isArray(rec.images) ? rec.images : [];
      list[index] = Object.assign({}, rec, { images: existing.concat(metas) });
      out.count += metas.length;
    }
    return out;
  }

  window.CVExcel = {
    hasExcelJs: hasExcelJs,
    exportWorkbook: exportWorkbook,
    readImportImages: readImportImages,
    attachImages: attachImages,
    PHOTO_MAX: PHOTO_MAX,
    PHOTO_DEFAULT_COLS: PHOTO_DEFAULT_COLS,
    photoHeaders: function (count) {
      const n = Math.max(PHOTO_DEFAULT_COLS, Math.min(PHOTO_MAX, Number(count) || 0));
      const out = [];
      for (let i = 1; i <= n; i += 1) out.push('截图 ' + i);
      return out;
    },
  };
})();
