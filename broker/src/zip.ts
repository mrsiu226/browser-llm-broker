import { deflateRawSync } from "node:zlib";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";

// ---- minimal ZIP writer (deflate), enough to package the extension folder
const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; }
  return t;
})();
const crc32 = (buf: Buffer) => { let c = 0xffffffff; for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };

function zip(files: { name: string; data: Buffer; mtime: Date }[]): Buffer {
  const parts: Buffer[] = [];
  const central: Buffer[] = [];
  let offset = 0;
  for (const f of files) {
    const name = Buffer.from(f.name, "utf8");
    const comp = deflateRawSync(f.data);
    const crc = crc32(f.data);
    const d = f.mtime;
    const time = (d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1);
    const date = ((d.getFullYear() - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate();
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(20, 4); local.writeUInt16LE(0x0800, 6); local.writeUInt16LE(8, 8);
    local.writeUInt16LE(time, 10); local.writeUInt16LE(date, 12); local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(comp.length, 18); local.writeUInt32LE(f.data.length, 22); local.writeUInt16LE(name.length, 26);
    parts.push(local, name, comp);
    const cd = Buffer.alloc(46);
    cd.writeUInt32LE(0x02014b50, 0); cd.writeUInt16LE(20, 4); cd.writeUInt16LE(20, 6); cd.writeUInt16LE(0x0800, 8); cd.writeUInt16LE(8, 10);
    cd.writeUInt16LE(time, 12); cd.writeUInt16LE(date, 14); cd.writeUInt32LE(crc, 16);
    cd.writeUInt32LE(comp.length, 20); cd.writeUInt32LE(f.data.length, 24); cd.writeUInt16LE(name.length, 28);
    cd.writeUInt32LE(offset, 42);
    central.push(cd, name);
    offset += local.length + name.length + comp.length;
  }
  const cdBuf = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(files.length, 8); end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(cdBuf.length, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...parts, cdBuf, end]);
}

// ---- extension packaging
function extensionDir(): string | null {
  const candidates = [
    process.env.EXTENSION_DIR,
    fileURLToPath(new URL("../extension", import.meta.url)),     // Docker image: /app/extension
    fileURLToPath(new URL("../../extension", import.meta.url)),  // repo checkout: <repo>/extension
  ].filter(Boolean) as string[];
  return candidates.find((d) => existsSync(join(d, "manifest.json"))) ?? null;
}

function walk(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory() ? walk(join(dir, e.name)) : e.name.startsWith(".") ? [] : [join(dir, e.name)]);
}

let cache: { key: string; zip: Buffer; version: string; name: string } | null = null;

export function extensionPackage() {
  const dir = extensionDir();
  if (!dir) return null;
  const files = walk(dir).sort();
  const key = files.map((f) => `${f}:${statSync(f).mtimeMs}`).join("|");
  if (cache?.key === key) return cache;
  const version = JSON.parse(readFileSync(join(dir, "manifest.json"), "utf8")).version as string;
  const top = "browser-llm-broker-extension";
  const data = zip(files.map((f) => ({ name: `${top}/${relative(dir, f).split(sep).join("/")}`, data: readFileSync(f), mtime: statSync(f).mtime })));
  cache = { key, zip: data, version, name: `browser-llm-broker-extension-v${version}.zip` };
  return cache;
}
