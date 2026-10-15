import fs from 'node:fs';

// Minimal streaming ZIP writer. Files are stored uncompressed ("stored" method), which keeps
// CPU usage flat and lets us send an exact Content-Length, because sizes and CRC-32 checksums
// are already known from the upload. Archives above 4 GiB (ZIP64) are not supported.

const MAX_ZIP32 = 0xffffffff;
const UTF8_FLAG = 0x0800;

export function zipSupported(files) {
  const total = files.reduce((sum, f) => sum + f.size, 0);
  const overhead = files.reduce((sum, f) => sum + 30 + 46 + Buffer.byteLength(f.name) * 2, 22);
  return files.length > 0 && files.length < 0xffff && total + overhead < MAX_ZIP32;
}

/** Writes with backpressure; rejects if the client goes away instead of waiting forever. */
function writeChunk(out, chunk) {
  if (out.destroyed) return Promise.reject(new Error('client disconnected'));
  if (out.write(chunk)) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const done = (err) => {
      out.off('drain', onDrain);
      out.off('close', onClose);
      if (err) reject(err);
      else resolve();
    };
    const onDrain = () => done();
    const onClose = () => done(new Error('client disconnected'));
    out.on('drain', onDrain);
    out.on('close', onClose);
  });
}

function dosDateTime(date) {
  const time = (date.getHours() << 11) | (date.getMinutes() << 5) | Math.floor(date.getSeconds() / 2);
  const day = ((date.getFullYear() - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate();
  return { time, day };
}

/** Makes names unique inside the archive ("a.txt", "a (2).txt", ...). */
function uniqueNames(files) {
  const seen = new Set();
  return files.map((file) => {
    let name = file.name;
    const dot = name.lastIndexOf('.');
    const base = dot > 0 ? name.slice(0, dot) : name;
    const ext = dot > 0 ? name.slice(dot) : '';
    for (let n = 2; seen.has(name.toLowerCase()); n++) name = `${base} (${n})${ext}`;
    seen.add(name.toLowerCase());
    return name;
  });
}

/**
 * @param entries [{ name, size, crc32, path }]
 * @returns {{ size: number, write(stream): Promise<void> }}
 */
export function createZip(entries, date = new Date()) {
  const { time, day } = dosDateTime(date);
  const names = uniqueNames(entries).map((n) => Buffer.from(n, 'utf8'));

  const locals = [];
  const centrals = [];
  let offset = 0;

  entries.forEach((entry, i) => {
    const name = names[i];
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4); // version needed
    local.writeUInt16LE(UTF8_FLAG, 6);
    local.writeUInt16LE(0, 8); // stored
    local.writeUInt16LE(time, 10);
    local.writeUInt16LE(day, 12);
    local.writeUInt32LE(entry.crc32 >>> 0, 14);
    local.writeUInt32LE(entry.size, 18);
    local.writeUInt32LE(entry.size, 22);
    local.writeUInt16LE(name.length, 26);
    local.writeUInt16LE(0, 28);
    locals.push(Buffer.concat([local, name]));

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4); // version made by
    central.writeUInt16LE(20, 6); // version needed
    central.writeUInt16LE(UTF8_FLAG, 8);
    central.writeUInt16LE(0, 10);
    central.writeUInt16LE(time, 12);
    central.writeUInt16LE(day, 14);
    central.writeUInt32LE(entry.crc32 >>> 0, 16);
    central.writeUInt32LE(entry.size, 20);
    central.writeUInt32LE(entry.size, 24);
    central.writeUInt16LE(name.length, 28);
    // extra length, comment length, disk number, internal + external attributes stay 0
    central.writeUInt32LE(offset, 42);
    centrals.push(Buffer.concat([central, name]));

    offset += 30 + name.length + entry.size;
  });

  const centralSize = centrals.reduce((sum, b) => sum + b.length, 0);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(centralSize, 12);
  end.writeUInt32LE(offset, 16);

  return {
    size: offset + centralSize + end.length,
    async write(out) {
      for (let i = 0; i < entries.length; i++) {
        await writeChunk(out, locals[i]);
        for await (const chunk of fs.createReadStream(entries[i].path)) await writeChunk(out, chunk);
      }
      out.end(Buffer.concat([...centrals, end]));
    },
  };
}
